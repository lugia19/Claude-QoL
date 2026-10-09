// phantom-messages.js (MAIN world, document_start, right after full-load.js)
// Shows "phantom messages", a QoL fork's copy of the source chat's history (stored encrypted in
// ISOLATED, databases.js), above the new chat's real messages. See docs/bard-rework.md, "Phantom messages".
//
// On the merged experience that means patching what StreamTimeline sends (QolBardHost):
// - every snapshot gets the phantoms as messages with negative indexes, each with its display groups
//   and content blocks, and the real root(s) re-parented under the last phantom;
// - live updates and history pages only need the re-parenting (a root arriving later, or the new root
//   an edit of the first real message creates);
// - a send whose parent is a phantom (editing the first real message) gets parent "" (a new root),
//   which the server accepts; with a phantom parent it fails with stale_parent.
// Phantoms get page ids of their own (claude-api.js's phantomMessageId: a marker prefix), so a stylesheet
// dims their rows and hides their toolbars by data-turn-key alone. No markers in the text.
//
// The phantoms come from ISOLATED over the bridge, so only conversations listed in
// localStorage[claude_qol_phantom_ids] (databases.js keeps it current) wait for them.
(function () {
	'use strict';


	const log = createLogger('PhantomMessages');

	const prepared = new Map(); // conversationId -> promise of { update, lastId, ids } or null
	// conversationId -> built phantoms a snapshot has carried to the page. Only those may be used to
	// re-parent later roots: a parent the page never received would cut the message off.
	const ready = new Map();

	// Synchronous, so a chat without phantoms is never held.
	function mayHavePhantoms(conversationId) {
		try {
			if (JSON.parse(localStorage.getItem(PHANTOM_IDS_KEY) || '[]').includes(conversationId)) return true;
			// Very old forks, not migrated to IndexedDB yet (claude-api.js's getPhantomMessages does that).
			return legacyPhantomKeys(conversationId).some(key => localStorage.getItem(key));
		} catch (e) {
			return false;
		}
	}

	// ======== Building the phantoms ========

	const textOf = (item) => typeof item?.text === 'string' ? item.text : '';

	// A tool_result's text, whatever shape its content has.
	function resultText(result) {
		if (!result) return '';
		if (typeof result.content === 'string') return result.content;
		return (result.content ?? []).map(textOf).filter(Boolean).join('\n');
	}

	// A tool_result's images as result_images: image_gallery items (the legacy image-extractor.js, image search) and
	// bare image items (MCP tools), the latter by url or, failing that, by file uuid in this org.
	function resultImages(result, orgId) {
		if (!Array.isArray(result?.content)) return [];
		const images = [];
		for (const item of result.content) {
			if (item.type === 'image_gallery') {
				for (const image of item.images ?? []) {
					if (image.url) images.push({ url: image.url, thumbnail_url: image.thumbnail_url || image.url });
				}
			} else if (item.type === 'image') {
				const url = item.url || item.preview_url || (item.file_uuid && orgId ? `/api/${orgId}/files/${item.file_uuid}/preview` : null);
				if (url) images.push({ url, thumbnail_url: item.thumbnail_url || url });
			}
		}
		return images;
	}

	// Legacy files (files_v2: ClaudeFile.toApiFormat) and text attachments as Message.attachments.
	function attachmentsOf(json) {
		const out = [];
		for (const file of json.files_v2 ?? json.files ?? []) {
			const isImage = file.file_kind === 'image';
			const url = file.preview_url ?? file.preview_asset?.url ?? file.document_asset?.url ?? null;
			const thumbnail = file.thumbnail_url ?? file.thumbnail_asset?.url ?? null;
			out.push({
				id: file.file_uuid ?? crypto.randomUUID(),
				file_name: file.file_name ?? 'file',
				...(isImage ? { media_type: 'image/*', file_kind: 'FILE_KIND_IMAGE' } : { file_kind: 'FILE_KIND_DOCUMENT' }),
				...(url ? { url } : {}),
				...(thumbnail ? { thumbnail_url: thumbnail } : {}),
			});
		}
		for (const attachment of json.attachments ?? []) {
			out.push({ id: `${json.uuid}-attachment-${out.length}`, file_name: attachment.file_name ?? 'attachment.txt' });
		}
		return out;
	}

	// One phantom (legacy history JSON) as a Message plus its display groups and content blocks.
	// Text becomes inline markdown, each tool_use (with its tool_result) a timeline tool row. Thinking
	// is left out: claude.ai doesn't show it any more.
	function buildPhantom(json, conversationId, orgId, index, parentId, out) {
		const id = json.uuid;
		const isUser = json.sender === 'human';
		const attachments = attachmentsOf(json);
		out.messages.push({
			id, conversation_id: conversationId,
			role: isUser ? 'ROLE_USER' : 'ROLE_ASSISTANT',
			index, is_complete: true,
			created_at: json.created_at || new Date(0).toISOString(),
			...(parentId ? { parent_message_id: parentId } : {}),
			...(isUser ? {} : { stop_reason: 'STOP_REASON_END_TURN' }),
			...(attachments.length ? { attachments } : {}),
		});

		const results = new Map((json.content ?? []).filter(c => c.type === 'tool_result').map(c => [c.tool_use_id, c]));
		let groupIndex = 0;
		const addGroup = (style, extra, blocks) => {
			const groupId = `dgrp_qolphantom_${id}_${groupIndex}`;
			out.display_groups.push({ id: groupId, message_id: id, style, is_complete: true, ...(groupIndex ? { index: groupIndex } : {}), ...extra });
			blocks.forEach((fields, i) => out.content_blocks.push({ id: `cblk_qolphantom_${id}_${groupIndex}_${i}`, display_group_id: groupId, is_complete: true, ...(i ? { index: i } : {}), ...fields }));
			groupIndex++;
		};

		const items = json.content?.length ? json.content : [{ type: 'text', text: json.text ?? '' }];
		for (const item of items) {
			if (item.type === 'text' && textOf(item)) {
				addGroup('GROUP_STYLE_INLINE', {}, [{ text: item.text, text_format: { style: 'STYLE_MARKDOWN' } }]);
			} else if (item.type === 'tool_use') {
				const name = item.name || 'tool';
				const input = item.input === undefined ? '' : (typeof item.input === 'string' ? item.input : JSON.stringify(item.input));
				const result = resultText(results.get(item.id));
				const images = resultImages(results.get(item.id), orgId);
				addGroup('GROUP_STYLE_TIMELINE', { summary: `Used ${name}`, summary_source: 'TITLE_SOURCE_LIFECYCLE' }, [{
					title: `Used ${name}`, icon: { builtin: { type: 'BUILTIN_ICON_TYPE_WRENCH' } }, state: 'CONTENT_BLOCK_STATE_COMPLETE',
					tool_display_name: name, title_verb: 'Used', title_object: name, row_kind: 'TOOL_ROW_KIND_GENERIC',
					input_summary: input.slice(0, 300), input_summary_kind: 'INPUT_SUMMARY_KIND_TEXT', input_visibility: 'INPUT_VISIBILITY_SHOWN',
					...(result ? { text: result, text_format: { style: 'STYLE_PLAIN' } } : {}),
					...(images.length ? { result_images: images } : {}),
					tool_use_id: item.id || `toolu_qolphantom_${id}_${groupIndex}`,
				}]);
			}
		}
		if (!groupIndex) addGroup('GROUP_STYLE_INLINE', {}, [{ text: ' ', text_format: { style: 'STYLE_MARKDOWN' } }]);
	}

	// The phantoms as a ConversationUpdate fragment: claude-api.js's pagePhantoms chain (page ids, so
	// they never collide with the source chat's real messages and every phantom row is recognisable by
	// its prefix; plus the acknowledgement), with negative indexes.
	function buildPhantoms(conversationId, orgId, phantoms) {
		const chain = pagePhantoms(phantoms);
		const out = { messages: [], display_groups: [], content_blocks: [] };
		chain.forEach((json, i) => buildPhantom(json, conversationId, orgId, i - chain.length, i ? json.parent_message_uuid : null, out));
		return { update: out, lastId: chain.at(-1).uuid };
	}

	// ======== Getting the phantoms ========

	async function fileText(attachment) {
		const response = await fetch(attachment.url);
		if (!response.ok) throw new Error(`${attachment.file_name}: ${response.status}`);
		return await response.text();
	}

	// A QoL fork's first message carries chatlog.txt (and summary_chunk_N.txt), enough to rebuild the
	// phantoms when none are stored, e.g. on another device. The snapshot lists the root's attachments.
	const chatlogRoot = (snapshot) => (snapshot.messages ?? []).find(m => m.role === 'ROLE_USER' && !m.parent_message_id && m.attachments?.some(a => a.file_name === 'chatlog.txt'));

	async function reconstruct(snapshot) {
		const root = chatlogRoot(snapshot);
		if (!root) return null;
		const chatlog = await fileText(root.attachments.find(a => a.file_name === 'chatlog.txt'));
		if (!chatlog.startsWith('[CLEXP:MSG_HEADER:')) return null;
		const summaries = await Promise.all(root.attachments
			.filter(a => /^summary_chunk_\d+\.txt$/.test(a.file_name))
			.sort((a, b) => parseInt(a.file_name.match(/\d+/)[0]) - parseInt(b.file_name.match(/\d+/)[0]))
			.map(fileText));
		const rebuilt = ClaudeConversation.fromChatlog(chatlog, summaries);
		if (!rebuilt) return null;
		const messages = (await rebuilt.getMessages()).map(m => m.toHistoryJSON());
		log.warn(`no stored phantoms for ${root.conversation_id}, rebuilt ${messages.length} from chatlog.txt`);
		return messages;
	}

	function prepare(conversationId, orgId, snapshot) {
		if (!prepared.has(conversationId)) {
			const pending = (async () => {
				// Always ask the database first, even when the mirror doesn't list the chat (it may not
				// exist yet right after an update): a rebuild from chatlog.txt is lossier than what's
				// stored, and would be stored over it.
				const stored = await getPhantomMessages(conversationId);
				// undefined: the database didn't answer. Rebuilding now could store over a real record.
				if (stored === undefined) throw new Error('the phantom database did not answer');
				const phantoms = stored?.length ? stored : await reconstruct(snapshot);
				if (!phantoms?.length) return null;
				if (!stored?.length) await storePhantomMessages(conversationId, phantoms);
				const built = buildPhantoms(conversationId, orgId, phantoms);
				log(`${built.update.messages.length} phantom messages for ${conversationId}`);
				return built;
			})().catch((e) => {
				log.error(`phantom messages for ${conversationId} failed:`, e);
				prepared.delete(conversationId); // try again on the next snapshot
				return null;
			});
			prepared.set(conversationId, pending);
		}
		return prepared.get(conversationId);
	}

	// Phantoms worth waiting for: stored ones, or a fork's chatlog.txt on the root to rebuild them from.
	const worthWaiting = (conversationId, snapshot) => prepared.has(conversationId) || mayHavePhantoms(conversationId) || !!chatlogRoot(snapshot);

	// ======== Patches ========

	function reparentRoots(update, built) {
		let changed = false;
		for (const message of update.messages ?? []) {
			if (message.parent_message_id || isPhantomId(message.id)) continue;
			message.parent_message_id = built.lastId;
			changed = true;
		}
		return changed;
	}

	QolBardHost.onSnapshot(async function phantomMessages(update, ctx) {
		if (!ctx.conversationId || !worthWaiting(ctx.conversationId, update)) return false;
		const result = await ctx.within(prepare(ctx.conversationId, ctx.orgId, update));
		if (!result) {
			log.warn(`phantoms for ${ctx.conversationId} took too long; this snapshot goes through without them`);
			return false;
		}
		const built = result.value;
		if (!built) return false;
		const known = new Set((update.messages ?? []).map(m => m.id));
		if (!known.has(built.lastId)) {
			const copy = structuredClone(built.update);
			(update.messages ??= []).push(...copy.messages);
			(update.display_groups ??= []).push(...copy.display_groups);
			(update.content_blocks ??= []).push(...copy.content_blocks);
		}
		reparentRoots(update, built);
		ready.set(ctx.conversationId, built);
		return true;
	}, { label: 'phantom-messages' });

	// Only phantoms a snapshot already carried: live updates and history pages never wait (a stalled
	// rebuild would hold every frame behind them).
	const reparentLater = (update, ctx) => {
		const built = ready.get(ctx.conversationId);
		return built ? reparentRoots(update, built) : false;
	};
	QolBardHost.onLiveUpdate(reparentLater, { label: 'phantom-messages' });
	QolBardHost.onHistoryPage(reparentLater, { label: 'phantom-messages' });

	// Any phantom parent (in practice the last one: editing the first real message) means a new root;
	// the server rejects a phantom parent (stale_parent).
	QolBardHost.onSend(function phantomParent(send) {
		if (!isPhantomId(send.parent_message_id)) return false;
		send.parent_message_id = '';
		log('send from a phantom: sent as a new root');
		return true;
	}, { label: 'phantom-messages' });

	// ======== DOM ========

	// Phantom rows (a phantom assistant's "<phantom parent>-hub-reply" key has the prefix too): dimmed,
	// toolbar hidden. Added to <html>, since <head> doesn't exist yet at document_start. The prefix is
	// claude-api.js's PHANTOM_ID_PREFIX, spelled out: that file loads after this one.
	const phantomStyle = document.createElement('style');
	phantomStyle.textContent = `
		[data-turn-key^="fffffffe-"] { filter: brightness(0.7); }
		[data-turn-key^="fffffffe-"] [role="toolbar"][data-cds="MessageActions"] { display: none !important; }
	`;
	document.documentElement.appendChild(phantomStyle);
})();
