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
// Phantom rows are found by their data-turn-key (the phantom's uuid, or "<phantom>-hub-reply" for a
// reply), dimmed, and have their toolbar hidden. No markers in the text.
//
// The phantoms come from ISOLATED over the bridge, so only conversations listed in
// localStorage[claude_qol_phantom_ids] (databases.js keeps it current) wait for them.
(function () {
	'use strict';

	const PHANTOM_IDS_KEY = 'claude_qol_phantom_ids';
	const WAIT_MS = 6000; // the snapshot (and every frame behind it) waits at most this long
	const ACK_TEXT = 'Acknowledged - end of previous conversation.';
	const GALLERY_BREAK_MARKER = '====GALLERY_BREAK===='; // injected by image-extractor.js between galleries

	// logger.js loads after this file: until it has, log calls go nowhere (and aren't cached).
	const silent = Object.assign(() => { }, { warn() { }, error() { } });
	let loggerInstance = null;
	const logger = () => loggerInstance ?? (typeof createLogger === 'function' ? (loggerInstance = createLogger('PhantomMessages')) : silent);

	const prepared = new Map(); // conversationId -> promise of { update, lastId, ids } or null
	const phantomRowKeys = new Set(); // data-turn-key values of phantom rows, any conversation
	const lastPhantomIds = new Set(); // ids a send must not use as its parent

	// Synchronous, so a chat without phantoms is never held.
	function mayHavePhantoms(conversationId) {
		try {
			if (JSON.parse(localStorage.getItem(PHANTOM_IDS_KEY) || '[]').includes(conversationId)) return true;
			// Very old forks, not migrated to IndexedDB yet (claude-api.js's getPhantomMessages does that).
			return !!(localStorage.getItem(`phantom_messages_${conversationId}`) || localStorage.getItem(`fork_history_${conversationId}`));
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
	function buildPhantom(json, conversationId, index, parentId, out) {
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
				addGroup('GROUP_STYLE_TIMELINE', { summary: `Used ${name}`, summary_source: 'TITLE_SOURCE_LIFECYCLE' }, [{
					title: `Used ${name}`, icon: { builtin: { type: 'BUILTIN_ICON_TYPE_WRENCH' } }, state: 'CONTENT_BLOCK_STATE_COMPLETE',
					tool_display_name: name, title_verb: 'Used', title_object: name, row_kind: 'TOOL_ROW_KIND_GENERIC',
					input_summary: input.slice(0, 300), input_summary_kind: 'INPUT_SUMMARY_KIND_TEXT', input_visibility: 'INPUT_VISIBILITY_SHOWN',
					...(result ? { text: result, text_format: { style: 'STYLE_PLAIN' } } : {}),
					tool_use_id: item.id || `toolu_qolphantom_${id}_${groupIndex}`,
				}]);
			}
		}
		if (!groupIndex) addGroup('GROUP_STYLE_INLINE', {}, [{ text: ' ', text_format: { style: 'STYLE_MARKDOWN' } }]);
	}

	// The phantoms as a ConversationUpdate fragment, or null. A phantom chain ending on a user message
	// gets an assistant acknowledgement, as the legacy version did (and the fork's handshake expects).
	function buildPhantoms(conversationId, phantoms) {
		const chain = [...phantoms];
		if (chain.at(-1)?.sender === 'human') {
			chain.push({ uuid: `${chain.at(-1).uuid}-qol-ack`, sender: 'assistant', content: [{ type: 'text', text: ACK_TEXT }], created_at: chain.at(-1).created_at });
		}
		const out = { messages: [], display_groups: [], content_blocks: [] };
		chain.forEach((json, i) => buildPhantom(json, conversationId, i - chain.length, i ? chain[i - 1].uuid : null, out));
		return { update: out, lastId: chain.at(-1).uuid, ids: chain.map(json => json.uuid) };
	}

	// ======== Getting the phantoms ========

	async function fileText(attachment) {
		const response = await fetch(attachment.url);
		if (!response.ok) throw new Error(`${attachment.file_name}: ${response.status}`);
		return await response.text();
	}

	// No stored phantoms: a QoL fork's first message carries chatlog.txt (and summary_chunk_N.txt),
	// enough to rebuild them, e.g. on another device. The snapshot lists the root's attachments.
	async function reconstruct(snapshot) {
		const root = (snapshot.messages ?? []).find(m => m.role === 'ROLE_USER' && !m.parent_message_id && m.attachments?.some(a => a.file_name === 'chatlog.txt'));
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
		logger().warn(`no stored phantoms for ${root.conversation_id}, rebuilt ${messages.length} from chatlog.txt`);
		return messages;
	}

	function prepare(conversationId, snapshot) {
		if (!prepared.has(conversationId)) {
			prepared.set(conversationId, (async () => {
				const stored = mayHavePhantoms(conversationId) ? await getPhantomMessages(conversationId) : null;
				const phantoms = stored?.length ? stored : await reconstruct(snapshot);
				if (!phantoms?.length) return null;
				if (!stored?.length) await storePhantomMessages(conversationId, phantoms);
				const built = buildPhantoms(conversationId, phantoms);
				for (const phantomId of built.ids) {
					phantomRowKeys.add(phantomId);
					phantomRowKeys.add(`${phantomId}-hub-reply`);
				}
				lastPhantomIds.add(built.lastId);
				logger()(`${built.ids.length} phantom messages for ${conversationId}`);
				return built;
			})().catch((e) => {
				logger().error(`phantom messages for ${conversationId} failed:`, e);
				prepared.delete(conversationId); // try again on the next snapshot
				return null;
			}));
		}
		return prepared.get(conversationId);
	}

	// Phantoms worth waiting for: stored ones, or a fork's chatlog.txt on the root to rebuild them from.
	const worthWaiting = (conversationId, snapshot) => prepared.has(conversationId) || mayHavePhantoms(conversationId)
		|| (snapshot.messages ?? []).some(m => !m.parent_message_id && m.attachments?.some(a => a.file_name === 'chatlog.txt'));

	// ======== Patches ========

	function reparentRoots(update, built) {
		let changed = false;
		for (const message of update.messages ?? []) {
			if (message.parent_message_id || message.index < 0 || built.ids.includes(message.id)) continue;
			message.parent_message_id = built.lastId;
			changed = true;
		}
		return changed;
	}

	// The prepared phantoms if they're ready, without waiting (live updates and history pages).
	async function readyPhantoms(conversationId) {
		return prepared.has(conversationId) ? await prepared.get(conversationId) : null;
	}

	QolBardHost.onSnapshot(async function phantomMessages(update, ctx) {
		if (!ctx.conversationId || !worthWaiting(ctx.conversationId, update)) return false;
		let timer;
		const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), WAIT_MS); });
		const built = await Promise.race([prepare(ctx.conversationId, update), timeout]);
		clearTimeout(timer);
		if (built === 'timeout') {
			logger().warn(`phantoms for ${ctx.conversationId} took over ${WAIT_MS}ms; this snapshot goes through without them`);
			return false;
		}
		if (!built) return false;
		const known = new Set((update.messages ?? []).map(m => m.id));
		if (!known.has(built.lastId)) {
			const copy = structuredClone(built.update);
			(update.messages ??= []).push(...copy.messages);
			(update.display_groups ??= []).push(...copy.display_groups);
			(update.content_blocks ??= []).push(...copy.content_blocks);
		}
		reparentRoots(update, built);
		return true;
	}, { label: 'phantom-messages' });

	const reparentLater = async (update, ctx) => {
		const built = ctx.conversationId && await readyPhantoms(ctx.conversationId);
		return built ? reparentRoots(update, built) : false;
	};
	QolBardHost.onLiveUpdate(reparentLater, { label: 'phantom-messages' });
	QolBardHost.onHistoryPage(reparentLater, { label: 'phantom-messages' });

	QolBardHost.onSend(function phantomParent(send) {
		if (!lastPhantomIds.has(send.parent_message_id)) return false;
		send.parent_message_id = ''; // a new root: the server rejects a phantom parent (stale_parent)
		logger()('send from the last phantom: sent as a new root');
		return true;
	}, { label: 'phantom-messages' });

	// ======== DOM: dim phantom rows, hide their toolbars ========

	function stylePhantomRows() {
		if (!phantomRowKeys.size) return;
		for (const row of document.querySelectorAll('[data-turn-key]')) {
			if (!phantomRowKeys.has(row.getAttribute('data-turn-key')) || row.hasAttribute('data-qol-phantom')) continue;
			row.setAttribute('data-qol-phantom', '');
			row.style.filter = 'brightness(0.7)';
		}
		// Toolbars mount on hover, so hide them every pass.
		for (const row of document.querySelectorAll('[data-qol-phantom]')) {
			const controls = findMessageControls(row);
			if (controls) controls.style.display = 'none';
		}
	}

	// Gallery-break markers sit between injected image galleries (image-extractor.js; to be ported).
	// They also appear mid-stream, so they're hidden on every pass.
	function hideGalleryBreakMarkers() {
		const { allMessages } = getUIMessages();
		allMessages.forEach(container => {
			if (!container.textContent.includes(GALLERY_BREAK_MARKER)) return;
			container.querySelectorAll('p').forEach(p => {
				if (p.textContent.includes(GALLERY_BREAK_MARKER)) p.style.display = 'none';
			});
		});
	}

	// Strip gallery-break markers from copied text.
	const originalClipboardWrite = navigator.clipboard.write;
	navigator.clipboard.write = async (data) => {
		try {
			const item = data[0];
			if (!item) return originalClipboardWrite.call(navigator.clipboard, data);
			const types = {};
			for (const type of item.types) {
				const blob = await item.getType(type);
				if (type === 'text/plain' || type === 'text/html') {
					let text = (await blob.text()).replace(/====GALLERY_BREAK====/g, '');
					text = type === 'text/plain' ? text.replace(/\n{3,}/g, '\n\n').trim() : text.replace(/<p[^>]*>\s*<\/p>/gi, '');
					types[type] = new Blob([text], { type });
				} else {
					types[type] = blob;
				}
			}
			return originalClipboardWrite.call(navigator.clipboard, [new ClipboardItem(types)]);
		} catch (error) {
			logger().error('Error cleaning clipboard text:', error);
			return originalClipboardWrite.call(navigator.clipboard, data);
		}
	};

	// The message list is virtualized, so rows mount continuously while scrolling. Observer callbacks
	// run before paint, so a mounting phantom row is dimmed in the same frame. The interval reattaches
	// the observer after SPA navigation replaces the container.
	let observedContainer = null;
	let messageObserver = null;
	let passScheduled = false;

	function runPass() {
		stylePhantomRows();
		hideGalleryBreakMarkers();
	}

	function schedulePass() {
		if (passScheduled) return;
		passScheduled = true;
		requestAnimationFrame(() => {
			passScheduled = false;
			runPass();
		});
	}

	function syncMessageObserver() {
		const container = getMessageScroller();
		if (!container || container === observedContainer) {
			if (observedContainer && !observedContainer.isConnected) {
				messageObserver?.disconnect();
				observedContainer = null;
			}
			return;
		}
		messageObserver?.disconnect();
		messageObserver = new MutationObserver(schedulePass);
		messageObserver.observe(container, { childList: true, subtree: true });
		observedContainer = container;
		runPass();
	}

	setInterval(() => {
		syncMessageObserver();
		runPass();
	}, 300);
})();
