// claude_api.js

const apiLog = createLogger('API');

const MAX_FILES_PER_MESSAGE = 18;

// ======== DB accessors (auto-detect isolated vs MAIN world) ========
// ISOLATED uses databases.js directly; MAIN asks it over ClaudeExtBridge (served by db-serve.js).
// A failed or unanswered call resolves undefined, while a handler's own "nothing stored" is null:
// most callers treat both as nothing, but whoever would overwrite stored data must tell them apart.
async function _dbCall(type, data) {
	try {
		return await ClaudeExtBridge.call('qol', type, data, { timeout: 5000 });
	} catch (e) {
		apiLog.warn(`${type} failed:`, e.message);
		return undefined;
	}
}

async function _convCacheGet(uuid) {
	const cache = window.ClaudeSearchShared?.conversationCache;
	if (cache) return await cache.get(uuid);

	return await _dbCall('CONV_CACHE_GET', { uuid }) || null;
}

async function _convCachePut(uuid, updatedAt, data) {
	const cache = window.ClaudeSearchShared?.conversationCache;
	if (cache) { await cache.put(uuid, updatedAt, data); return; }

	_dbCall('CONV_CACHE_PUT', { uuid, updatedAt, data }); // not awaited: a cache write shouldn't hold up the caller
}

async function storePhantomMessages(conversationId, messages) {
	const store = window.ClaudeSearchShared?.storePhantomMessages;
	if (store) { await store(conversationId, messages); return; }

	await _dbCall('PHANTOM_STORE', { conversationId, messages });
}

// Phantom messages as history JSON (ClaudeMessage.toHistoryJSON); null when none are stored, and
// (MAIN only) undefined when the database couldn't be asked.
async function getPhantomMessages(conversationId) {
	// Very old forks kept them in the page's localStorage: move them to IndexedDB on first read.
	for (const key of legacyPhantomKeys(conversationId)) {
		const legacy = localStorage.getItem(key);
		if (!legacy) continue;
		const messages = JSON.parse(legacy);
		await storePhantomMessages(conversationId, messages);
		legacyPhantomKeys(conversationId).forEach(k => localStorage.removeItem(k));
		return messages;
	}

	const get = window.ClaudeSearchShared?.getPhantomMessages;
	if (get) return await get(conversationId);

	return await _dbCall('PHANTOM_GET', { conversationId });
}

const ROOT_MESSAGE_UUID = "00000000-0000-4000-8000-000000000000";

// On the page, phantom messages carry ids of their own (phantom-messages.js): UUID-shaped, derived from
// the stored message's uuid (stable across snapshots), with a marker first group no real id has.
// Phantoms keep their source chat's uuids, so without this they'd collide with that chat's real
// messages. The page never sends them anywhere (a send from a phantom is rewritten).
const PHANTOM_ID_PREFIX = 'fffffffe-';
const phantomMessageId = (uuid) => PHANTOM_ID_PREFIX + uuid.slice(PHANTOM_ID_PREFIX.length);
// Also true for a phantom row's "<id>-hub-reply" turn key.
const isPhantomId = (id) => typeof id === 'string' && id.startsWith(PHANTOM_ID_PREFIX);

// Where phantoms live besides IndexedDB: the ids of conversations that have some, mirrored to the
// page's localStorage by databases.js (phantom-messages.js reads it synchronously), and the keys very
// old forks stored the phantoms themselves under.
const PHANTOM_IDS_KEY = 'claude_qol_phantom_ids';
const legacyPhantomKeys = (conversationId) => [`phantom_messages_${conversationId}`, `fork_history_${conversationId}`];

const PHANTOM_ACK_TEXT = 'Acknowledged - end of previous conversation.';

// The phantoms (history JSON) as the page shows them, in order from the root: page ids, each parented
// to the one before (the first to ROOT_MESSAGE_UUID), and, when the chain ends on a user message, an
// assistant acknowledgement after it (as the legacy version did, and the fork's handshake expects).
function pagePhantoms(phantomJson) {
	const chain = phantomJson.map(msg => ({ ...msg, uuid: phantomMessageId(msg.uuid) }));
	const last = phantomJson.at(-1);
	if (last?.sender === 'human') {
		chain.push({
			uuid: `${PHANTOM_ID_PREFIX}0000-4000-8000-${last.uuid.slice(-12)}`,
			sender: 'assistant', text: PHANTOM_ACK_TEXT, content: [{ type: 'text', text: PHANTOM_ACK_TEXT }], created_at: last.created_at,
		});
	}
	chain.forEach((msg, i) => { msg.parent_message_uuid = i ? chain[i - 1].uuid : ROOT_MESSAGE_UUID; });
	return chain;
}

// Conversation data with the phantoms spliced onto the front, the way the page sees them: the real
// roots hang off the last phantom, so a parent-chain walk returns the whole thing in order. Leaves
// data untouched (it may be a cached payload).
function stitchPhantomMessages(data, phantomJson) {
	if (!phantomJson?.length) return data;
	const lastId = phantomJson.at(-1).uuid;
	const realMessages = (data.chat_messages || []).map(msg => msg.parent_message_uuid === ROOT_MESSAGE_UUID ? { ...msg, parent_message_uuid: lastId } : msg);
	return { ...data, chat_messages: [...phantomJson, ...realMessages] };
}

async function clearPhantomMessages(conversationId) {
	const clear = window.ClaudeSearchShared?.clearPhantomMessages;
	if (clear) { await clear(conversationId); return; }

	await _dbCall('PHANTOM_CLEAR', { conversationId });
}

async function bustReactQueryCache() {
	return new Promise((resolve) => {
		const request = indexedDB.open('keyval-store');
		request.onsuccess = (event) => {
			const db = event.target.result;
			const tx = db.transaction('keyval', 'readwrite');
			tx.objectStore('keyval').delete('react-query-cache');
			tx.oncomplete = () => {
				db.close();
				resolve();
			};
			tx.onerror = () => {
				db.close();
				resolve();
			};
		};
		request.onerror = () => resolve();
	});
}
bustReactQueryCache();

// Shared streaming freshness check.
// Fetches apiUrl, reads the conversation header (everything before "chat_messages") and
// compares updated_at *and* current_leaf_message_uuid with cachedEntry.
// Returns { data, fromCache } on success, null on failure.
// fetchFn allows callers to pass in the real (unpatched) fetch.
async function streamingFreshnessCheck(apiUrl, cachedEntry, fetchFn = fetch) {
	const response = await fetchFn(apiUrl);
	if (!response.ok) return null;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let accumulated = '';
	// The header is normally ~1KB, but the settings blob (enabled_mcp_tools) can push it past
	// 12KB. This cap is only a safety valve: overshoot it and we fall through to the full read.
	const MAX_HEADER_BYTES = 131072;

	try {
		let chatMsgIdx = -1;
		while (accumulated.length < MAX_HEADER_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			accumulated += decoder.decode(value, { stream: true });

			chatMsgIdx = accumulated.indexOf('"chat_messages"');
			if (chatMsgIdx !== -1) break;
		}

		if (chatMsgIdx !== -1) {
			const header = accumulated.substring(0, chatMsgIdx);
			const updatedAt = header.match(/"updated_at"\s*:\s*"([^"]+)"/)?.[1];
			const leaf = header.match(/"current_leaf_message_uuid"\s*:\s*"([^"]+)"/)?.[1];

			// The leaf has to match too. Switching branches does not bump updated_at, so a
			// timestamp check on its own keeps serving whichever branch was selected when the
			// entry was cached — which is the branch a linear export then walks.
			if (updatedAt && leaf &&
				cachedEntry.updated_at >= updatedAt &&
				cachedEntry.data?.current_leaf_message_uuid === leaf) {
				reader.cancel();
				return { data: cachedEntry.data, fromCache: true };
			}
		}

		// Cache stale, or the header didn't yield both fields — read remaining stream
		const chunks = [accumulated];
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(decoder.decode(value, { stream: true }));
		}
		chunks.push(decoder.decode()); // flush

		const data = JSON.parse(chunks.join(''));
		if (data.updated_at) {
			_convCachePut(data.uuid || cachedEntry.uuid, data.updated_at, data);
		}
		return { data, fromCache: false };
	} catch (e) {
		reader.cancel();
		return null;
	}
}

class ClaudeConversation {
	constructor(orgId, conversationId = null) {
		this.orgId = orgId;
		this.conversationId = conversationId;
		this.created = conversationId ? true : false;
		this.lastGetDataFromCache = false;
		this.accountFeatureSettings = null;
		this._pendingCreateParams = null;
	}

	// Prepare a new conversation locally. No server call: the first sendMessageAndWaitForResponse
	// creates it (with this id, model and project), then names it.
	prepareNew(name, model = null, projectUuid = null, accountFeatureSettings = null) {
		if (this.conversationId) {
			throw new Error('Conversation already exists');
		}

		this.conversationId = this.generateUuid();
		this.accountFeatureSettings = accountFeatureSettings;

		this._pendingCreateParams = { name: name || '' };
		if (model) this._pendingCreateParams.model = model;
		if (projectUuid) this._pendingCreateParams.project_uuid = projectUuid;

		this.conversationData = {
			uuid: this.conversationId,
			name: name || '',
			model: model,
			chat_messages: [],
			project: projectUuid ? { uuid: projectUuid } : null,
		};

		return this.conversationId;
	}

	// Send a message and wait for Claude's reply; returns the reply as a ClaudeMessage. A string is a
	// plain prompt (options: model, parentMessageUuid); a ClaudeMessage brings its own files.
	async sendMessageAndWaitForResponse(promptOrMessage, options = {}) {
		if (!(promptOrMessage instanceof ClaudeMessage)) {
			const { model = null, parentMessageUuid = ROOT_MESSAGE_UUID } = options;
			return this._sendAndAwaitAssistant({
				text: promptOrMessage,
				parentMessageUuid,
				model,
				timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				locale: accountLocale(),
				attachments: [],
				inlineAttachments: [],
			});
		}

		const msg = promptOrMessage;
		const send = msg.toSendMessage();
		if (options.model) send.model = options.model;
		if (send.attachments.length <= MAX_FILES_PER_MESSAGE) return this._sendAndAwaitAssistant(send);

		// Too many files for one message: intermediate "filler" sends carry only a file chunk and a
		// placeholder text; the final send carries the real text, the inline attachments and the
		// last chunk.
		const chunks = [];
		for (let i = 0; i < send.attachments.length; i += MAX_FILES_PER_MESSAGE) {
			chunks.push(send.attachments.slice(i, i + MAX_FILES_PER_MESSAGE));
		}
		let parentUuid = send.parentMessageUuid;
		for (let i = 0; i < chunks.length - 1; i++) {
			const fillerAsst = await this._sendAndAwaitAssistant({
				...send,
				text: `[Forking chat in progress -> Uploading file batch ${i + 1}/${chunks.length} — please reply with "ok" so the next batch can be sent. Context will be in the last batch.]`,
				parentMessageUuid: parentUuid,
				attachments: chunks[i],
				inlineAttachments: [],
			});
			parentUuid = fillerAsst.uuid;
		}
		return this._sendAndAwaitAssistant({ ...send, parentMessageUuid: parentUuid, attachments: chunks[chunks.length - 1] });
	}

	async _patchAccountSettingsIfNeeded() {
		if (!this.accountFeatureSettings) return null;

		const account = await getAccountSettings();
		const current = account.settings || account;

		const desired = this.accountFeatureSettings;
		const needsPatch =
			(desired.preview_feature_uses_artifacts !== (current.preview_feature_uses_artifacts === true)) ||
			(desired.enabled_monkeys_in_a_barrel !== (current.enabled_monkeys_in_a_barrel === true));

		if (!needsPatch) return null;

		await updateAccountSettings({
			preview_feature_uses_artifacts: desired.preview_feature_uses_artifacts,
			enabled_monkeys_in_a_barrel: desired.enabled_monkeys_in_a_barrel,
		});

		return {
			preview_feature_uses_artifacts: current.preview_feature_uses_artifacts === true,
			enabled_monkeys_in_a_barrel: current.enabled_monkeys_in_a_barrel === true,
		};
	}

	// One merged-experience action on this conversation (Connect's JSON codec, so it works from either
	// world without the protobuf schema). A 200 only means accepted: success or failure arrives on the
	// StreamTimeline as a mutation ack. The RPCs check Origin: a Firefox content script's own fetch
	// sends the extension's, so it uses the page's (content.fetch); elsewhere plain fetch already
	// sends claude.ai's.
	async _performAction(action) {
		const pageFetch = globalThis.content?.fetch?.bind(globalThis.content) ?? fetch;
		return pageFetch(...ClaudeExtNet.bardRpcRequest('PerformAction', this.orgId, JSON.stringify({
			header: {
				conversationId: this.conversationId,
				mutationId: { sessionId: `sess_qol${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, version: '1' },
			},
			...action,
		})));
	}

	// Sends one message through PerformAction's send_message (the legacy /completion endpoint refuses
	// upgraded chats with 409 conversation_upgraded), then waits for the reply in the conversation
	// tree. We choose both message ids, so the reply is known before it exists. On a new conversation
	// the send creates it (the header's conversation id is the one prepareNew chose); send_message
	// has no name, so the name is set after. `send` is { text, parentMessageUuid, model, timezone,
	// locale, attachments: [{ id, fileName, fileSize, mediaType }], inlineAttachments: [{ fileName,
	// fileSize, fileType, extractedContent }] }.
	async _sendAndAwaitAssistant(send) {
		const creating = !this.created;
		const createParams = this._pendingCreateParams;
		const settingsToRestore = creating ? await this._patchAccountSettingsIfNeeded() : null;

		try {
			const messageId = this.generateUuid();
			const assistantId = this.generateUuid();
			const model = send.model ?? createParams?.model ?? null;
			const sendMessage = {
				messageId,
				assistantMessageId: assistantId,
				text: send.text,
				timezone: send.timezone,
				locale: send.locale,
				attachments: send.attachments,
				inlineAttachments: send.inlineAttachments,
			};
			// Always explicit: left out, the server continues its own current leaf. "" is a new root
			// (what the root uuid meant to /completion), and also what a conversation's first send uses.
			const toRoot = !send.parentMessageUuid || send.parentMessageUuid === ROOT_MESSAGE_UUID;
			sendMessage.parentMessageId = toRoot ? '' : send.parentMessageUuid;
			if (model) sendMessage.model = { identifier: model };
			if (creating && createParams?.project_uuid) sendMessage.projectId = createParams.project_uuid;

			const response = await this._performAction({ sendMessage });
			if (!response.ok) {
				apiLog.error('send_message rejected:', response.status, await response.text().catch(() => ''));
				throw new Error('Failed to send message');
			}
			if (creating) {
				this.created = true;
				this._pendingCreateParams = null;
				if (createParams?.name) {
					await this._performAction({ renameConversation: { title: createParams.name } })
						.catch(e => apiLog.warn('Could not name the new conversation:', e));
				}
			}

			// The reply is done once the tree has it with a stop reason. A rejected send is only
			// reported on the stream, so: our message showing up in the tree means accepted, and then
			// the reply gets as long as it needs (a big-model summary of a long chat can take minutes;
			// the cap only stops a turn that died from hanging forever). Never showing up within a
			// minute means rejected. Polled with a plain fetch, not getData() (no conversation-cache
			// write per poll; a brand-new conversation can 404 for a moment), backing off so a long
			// turn doesn't re-download the tree every second.
			const treeUrl = `/api/organizations/${this.orgId}/chat_conversations/${this.conversationId}?tree=true&rendering_mode=messages&render_all_tools=true&consistency=strong`;
			const started = Date.now();
			let accepted = false;
			let interval = 1500;
			while (Date.now() - started < (accepted ? 20 * 60_000 : 60_000)) {
				await new Promise(r => setTimeout(r, interval));
				interval = Math.min(interval * 1.5, 8000);
				const tree = await fetch(treeUrl);
				if (!tree.ok) continue;
				const data = await tree.json();
				accepted ||= data.chat_messages?.some(m => m.uuid === messageId) ?? false;
				const reply = data.chat_messages?.find(m => m.uuid === assistantId);
				if (reply?.stop_reason) {
					this.conversationData = data;
					this._syncAccountFeatureSettings();
					return ClaudeMessage.fromHistoryJSON(this, reply);
				}
			}
			throw new Error(accepted ? 'The reply never finished' : 'The message was not accepted');
		} finally {
			if (settingsToRestore) {
				await updateAccountSettings(settingsToRestore);
			}
		}
	}

	// Upload file to code execution environment
	async uploadToCodeExecution(fileOrAttachmentOrBlob, fileName = null) {
		let blob, name;

		if (fileOrAttachmentOrBlob instanceof ClaudeFile) {
			// Downloaded once, below, where the MIME type gets fixed up.
			name = fileName ?? fileOrAttachmentOrBlob.file_name;
		} else if (fileOrAttachmentOrBlob instanceof ClaudeAttachment) {
			blob = new Blob([fileOrAttachmentOrBlob.extracted_content], { type: 'text/plain' });
			name = fileName ?? fileOrAttachmentOrBlob.file_name;
		} else if (fileOrAttachmentOrBlob instanceof Blob) {
			blob = fileOrAttachmentOrBlob;
			name = fileName ?? 'unnamed';
		} else {
			throw new Error('Expected ClaudeFile, ClaudeAttachment, or Blob');
		}

		// Ensure correct MIME type (for ClaudeFile and raw Blob cases)
		if (!blob || !blob.type || blob.type === 'application/octet-stream') {
			const mimeType = mime.getType(name) || blob?.type || 'application/octet-stream';
			const sourceBlob = blob ?? await fileOrAttachmentOrBlob.download();
			blob = new Blob([sourceBlob], { type: mimeType });
		}

		const formData = new FormData();
		formData.append('file', blob, name);

		const response = await fetch(
			`/api/organizations/${this.orgId}/conversations/${this.conversationId}/wiggle/upload-file`,
			{ method: 'POST', body: formData }
		);

		if (!response.ok) {
			throw new Error(`Failed to upload to code execution: ${response.statusText}`);
		}

		const result = await response.json();
		return new ClaudeCodeExecutionFile(result, this.orgId, this.conversationId);
	}


	_syncAccountFeatureSettings() {
		const s = this.conversationData?.settings;
		if (s) {
			this.accountFeatureSettings = {
				preview_feature_uses_artifacts: s.preview_feature_uses_artifacts === true,
				enabled_monkeys_in_a_barrel: s.enabled_monkeys_in_a_barrel === true,
			};
		}
	}

	// Lazy load conversation data (always fetches full tree)
	// Uses IndexedDB cache with streaming freshness check to avoid downloading large payloads.
	//
	// freshnessHint is { updated_at, current_leaf_message_uuid } for this conversation as the
	// server currently has it. chat_conversations_v2 carries both fields for every conversation
	// in one response, so a caller working through a list already knows them and we can settle
	// freshness locally instead of spending a request per conversation.
	async getData(forceRefresh = false, freshnessHint = null) {
		if (!this.created) {
			return this.conversationData;
		}

		if (this.conversationData && !forceRefresh) {
			return this.conversationData;
		}

		const apiUrl = `/api/organizations/${this.orgId}/chat_conversations/${this.conversationId}?tree=true&rendering_mode=messages&render_all_tools=true&consistency=strong`;

		// Try cache (unless forcing refresh)
		if (!forceRefresh) {
			try {
				const cachedEntry = await _convCacheGet(this.conversationId);
				if (cachedEntry) {
					if (freshnessHint) {
						if (cachedEntry.updated_at >= freshnessHint.updated_at &&
							cachedEntry.data?.current_leaf_message_uuid === freshnessHint.current_leaf_message_uuid) {
							this.lastGetDataFromCache = true;
							this.conversationData = cachedEntry.data;
							this._syncAccountFeatureSettings();
							return this.conversationData;
						}
						// Hint says stale — no point checking again over the wire.
					} else {
						const freshData = await this._streamingFreshnessCheck(apiUrl, cachedEntry);
						if (freshData) {
							this.conversationData = freshData;
							this._syncAccountFeatureSettings();
							return this.conversationData;
						}
					}
				}
			} catch (e) {
				// Cache miss or streaming check failed — fall through to normal fetch
			}
		}

		// Normal fetch path
		this.lastGetDataFromCache = false;
		const response = await fetch(apiUrl);
		if (!response.ok) {
			if (response.status === 404 && this.conversationData) {
				apiLog.error('getData: 404 on conversation that should exist, falling back to local data');
				return this.conversationData;
			}
			throw new Error('Failed to get conversation data');
		}
		this.conversationData = await response.json();
		this._syncAccountFeatureSettings();

		// Write to cache (fire-and-forget)
		if (this.conversationData.updated_at) {
			_convCachePut(this.conversationId, this.conversationData.updated_at, this.conversationData);
		}

		return this.conversationData;
	}

	async _streamingFreshnessCheck(apiUrl, cachedEntry) {
		const result = await streamingFreshnessCheck(apiUrl, cachedEntry);
		if (!result) return null;
		this.lastGetDataFromCache = result.fromCache;
		return result.data;
	}

	// Reconstruct the current trunk from full tree data: walk from current leaf to root
	_trunkFrom(data) {
		const allMessages = data.chat_messages || [];
		const messageMap = new Map(allMessages.map(msg => [msg.uuid, msg]));
		const trunk = [];
		let currentId = data.current_leaf_message_uuid;

		while (currentId && currentId !== ROOT_MESSAGE_UUID) {
			const msg = messageMap.get(currentId);
			if (!msg) break;
			trunk.push(msg);
			currentId = msg.parent_message_uuid;
		}

		trunk.reverse();
		return trunk.map(msg => ClaudeMessage.fromHistoryJSON(this, msg));
	}

	// Get messages - when tree=false, reconstructs the current trunk from full tree data.
	// Never includes phantom messages: use getRenderedMessages() when you need the list the UI is
	// actually showing.
	async getMessages(tree = false, forceRefresh = false) {
		const data = await this.getData(forceRefresh);

		if (tree) {
			return (data.chat_messages || []).map(msg => ClaudeMessage.fromHistoryJSON(this, msg));
		}

		return this._trunkFrom(data);
	}

	// The current branch as the UI renders it: phantom (forked-in) history first, then the
	// real messages. Anything that has to line up with what's on screen — locating a row,
	// counting positions — needs this rather than getMessages().
	async getRenderedMessages(forceRefresh = false) {
		const data = await this.getData(forceRefresh);

		let phantoms = null;
		try {
			phantoms = await getPhantomMessages(this.conversationId);
		} catch (error) {
			apiLog.error('Failed to load phantom messages:', error);
		}
		if (!phantoms?.length) return this._trunkFrom(data);

		// With the ids the page shows them under, so rows and positions line up. `data` stays
		// phantom-free (it's cached), so getMessages() keeps returning the real branch.
		return this._trunkFrom(stitchPhantomMessages(data, pagePhantoms(phantoms)));
	}

	// Find longest leaf from a message ID
	findLongestLeaf(startMessageId) {
		const messageMap = new Map();
		for (const msg of this.conversationData.chat_messages) {
			messageMap.set(msg.uuid, msg);
		}

		// Get all children of the message we're starting from
		const children = Array.from(messageMap.values()).filter(
			msg => msg.parent_message_uuid === startMessageId
		);
		// No children -> it's a leaf, just return
		if (children.length === 0) {
			const message = messageMap.get(startMessageId);
			return {
				leafId: startMessageId,
				depth: 0,
				timestamp: new Date(message.created_at).getTime()
			};
		}

		let longestPath = { leafId: null, depth: -1, timestamp: 0 };
		// For each child, find its longest leaf (recursion)
		for (const child of children) {
			const result = this.findLongestLeaf(child.uuid);
			const totalDepth = result.depth + 1;	//Account for the fact we're looking at the parent of this message
			// If this path is longer than the previous longest, or same length but newer, update
			if (totalDepth > longestPath.depth ||
				(totalDepth === longestPath.depth && result.timestamp > longestPath.timestamp)) {
				longestPath = {
					leafId: result.leafId,
					depth: totalDepth,
					timestamp: result.timestamp
				};
			}
		}

		return longestPath;
	}

	// Navigate to a specific leaf (it must have no children), then reload onto it.
	// Through the merged experience's set_current_leaf: the legacy PUT also moves the leaf, but the
	// StreamTimeline snapshot can keep serving the old one for a while after it, so the reload landed
	// on the wrong branch.
	async setCurrentLeaf(leafId) {
		const response = await this._performAction({ setCurrentLeaf: { currentLeafMessageId: leafId } });

		if (!response.ok) {
			throw new Error(`Failed to set current leaf (${response.status})`);
		}

		// Bust the react-query cache before reloading
		await bustReactQueryCache();
		location.reload();
	}

	// Delete conversation
	async delete() {
		const response = await fetch(`/api/organizations/${this.orgId}/chat_conversations/${this.conversationId}`, {
			method: 'DELETE'
		});

		if (!response.ok) {
			apiLog.error('Failed to delete conversation');
		}
	}

	// Extract text from message content (works with both raw JSON and ClaudeMessage)
	static extractMessageText(message) {
		// ClaudeMessage has .content array just like raw JSON, so same logic works
		if (!message.content || message.content.length === 0) return '';

		const textPieces = [];

		function extractFromContent(content) {
			if (content.text) {
				textPieces.push(content.text);
			}
			if (content.input) {
				textPieces.push(JSON.stringify(content.input));
			}
			if (content.content) {
				// Handle nested content array
				if (Array.isArray(content.content)) {
					for (const nestedContent of content.content) {
						extractFromContent(nestedContent);
					}
				}
				// Handle single nested content object
				else if (typeof content.content === 'object') {
					extractFromContent(content.content);
				}
			}
		}

		// Process all content items in the message
		for (const content of message.content) {
			extractFromContent(content);
		}

		return textPieces.join('\n');
	}

	static cleanupMessages(messages, conversation = null) {
		const conv = conversation || new ClaudeConversation(getOrgId(), null);
		const cleaned = [...messages];

		let i = 0;
		while (i < cleaned.length) {
			const msg = cleaned[i];
			const text = msg.content?.[0]?.text || '';

			if (text === '[Continued attachments from previous message]') {
				const expectedAckSender = msg.sender === 'human' ? 'assistant' : 'human';
				const prevMsg = cleaned[i - 1];
				const prevText = prevMsg?.content?.[0]?.text || '';

				const hasPrevAck = i > 0 &&
					prevMsg.sender === expectedAckSender &&
					prevText === 'Acknowledged.';

				if (hasPrevAck) {
					cleaned.splice(i - 1, 2);
					i--;
				} else {
					cleaned.splice(i, 1);
				}
			} else {
				i++;
			}
		}

		i = 0;
		while (i < cleaned.length - 1) {
			const current = cleaned[i];
			const next = cleaned[i + 1];

			if (current.sender === next.sender) {
				const fillerSender = current.sender === 'human' ? 'assistant' : 'human';
				const fillerText = fillerSender === 'assistant' ? 'Acknowledged.' : 'Continue.';

				const fillerMessage = new ClaudeMessage(conv);
				fillerMessage.uuid = crypto.randomUUID();
				fillerMessage.parent_message_uuid = current.uuid;
				fillerMessage.sender = fillerSender;
				fillerMessage.text = fillerText;
				fillerMessage.created_at = current.created_at || new Date().toISOString();

				next.parent_message_uuid = fillerMessage.uuid;

				cleaned.splice(i + 1, 0, fillerMessage);
				i += 2;
			} else {
				i++;
			}
		}

		return cleaned;
	}

	static buildChatlog(messages, { includeRoleLabels = false, includeHeader = false, cleanup = true, conversation = null } = {}) {
		if (includeRoleLabels && includeHeader) {
			throw new Error('buildChatlog: includeRoleLabels and includeHeader are mutually exclusive');
		}

		const finalMessages = cleanup
			? ClaudeConversation.cleanupMessages(messages, conversation)
			: messages;

		const separator = '\n\n';
		const messageParts = finalMessages.map(msg => {
			const role = msg.sender === 'human' ? '[User]' : '[Assistant]';
			const text = msg.toChatlogString();
			return includeRoleLabels ? `${role}\n${text}` : text;
		});

		const chatlogText = messageParts.join(separator);

		if (includeHeader) {
			const deltas = [0];
			for (let i = 1; i < messageParts.length; i++) {
				deltas.push(messageParts[i - 1].length + separator.length);
			}
			const header = `[CLEXP:MSG_HEADER:${deltas.join(',')}]`;
			return { text: header + '\n' + chatlogText, filename: 'chatlog.txt' };
		}

		return { text: chatlogText, filename: 'chatlog.txt' };
	}

	static parseChatlogHeader(chatlogText) {
		const match = chatlogText.match(/^\[CLEXP:MSG_HEADER:([^\]]+)\]\n/);
		if (!match) return null;

		const deltas = match[1].split(',').map(n => parseInt(n));
		const body = chatlogText.substring(match[0].length);

		const offsets = [];
		let pos = 0;
		for (const delta of deltas) {
			pos += delta;
			offsets.push(pos);
		}

		const messageTexts = [];
		for (let i = 0; i < offsets.length; i++) {
			const start = offsets[i];
			const end = i < offsets.length - 1 ? offsets[i + 1] - 2 : body.length;
			messageTexts.push(body.substring(start, end));
		}

		return messageTexts;
	}

	static fromChatlog(chatlogText, summaryTexts = []) {
		const messageTexts = ClaudeConversation.parseChatlogHeader(chatlogText);
		if (!messageTexts || messageTexts.length === 0) return null;

		const conv = new ClaudeConversation(getOrgId(), null);
		const timestamp = new Date().toISOString();
		const chatMessages = [];

		let parentId = '00000000-0000-4000-8000-000000000000';

		for (const summaryText of summaryTexts) {
			const userMsg = new ClaudeMessage(conv);
			userMsg.uuid = crypto.randomUUID();
			userMsg.parent_message_uuid = parentId;
			userMsg.sender = 'human';
			userMsg.created_at = timestamp;
			userMsg.content = [{ type: 'text', text: summaryText }];
			parentId = userMsg.uuid;
			chatMessages.push(userMsg.toHistoryJSON());

			const ackMsg = new ClaudeMessage(conv);
			ackMsg.uuid = crypto.randomUUID();
			ackMsg.parent_message_uuid = parentId;
			ackMsg.sender = 'assistant';
			ackMsg.created_at = timestamp;
			ackMsg.content = [{
				type: 'text',
				text: 'Acknowledged. I understand the context from the summary and am ready to continue our conversation.'
			}];
			parentId = ackMsg.uuid;
			chatMessages.push(ackMsg.toHistoryJSON());
		}

		for (let i = 0; i < messageTexts.length; i++) {
			const msg = new ClaudeMessage(conv);
			msg.uuid = crypto.randomUUID();
			msg.parent_message_uuid = parentId;
			msg.sender = i % 2 === 0 ? 'human' : 'assistant';
			msg.created_at = timestamp;

			let text = messageTexts[i];

			// Extract inline attachments
			const attachmentRegex = /\[CLEXP:ATT:([^\]]+)\]\n([\s\S]*?)\n\[\/CLEXP:ATT:\1\]/g;
			let match;
			while ((match = attachmentRegex.exec(text)) !== null) {
				msg.attachFile(ClaudeAttachment.fromText(match[2], match[1]));
			}

			text = text.replace(attachmentRegex, '').trim();
			msg.content = [{ type: 'text', text }];

			parentId = msg.uuid;
			chatMessages.push(msg.toHistoryJSON());
		}

		conv.conversationData = {
			chat_messages: chatMessages,
			current_leaf_message_uuid: chatMessages.at(-1).uuid,
			name: localize('ui.reconstructed_from_chatlog'),
			updated_at: timestamp
		};

		return conv;
	}

	generateUuid() {
		return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
			const r = Math.random() * 16 | 0;
			const v = c === 'x' ? r : (r & 0x3 | 0x8);
			return v.toString(16);
		});
	}
}

class ClaudeFile {
	constructor(apiData) {
		this.file_uuid = apiData.file_uuid;
		this.file_name = apiData.file_name;
		this.file_kind = apiData.file_kind; // 'image' | 'document'
		this.preview_asset = apiData.preview_asset || null;
		this.document_asset = apiData.document_asset || null;
		this.thumbnail_asset = apiData.thumbnail_asset || null;
		this.preview_url = apiData.preview_url || null;
		this.thumbnail_url = apiData.thumbnail_url || null;
		this.raw_data = apiData; // Store raw data for reference
	}

	getDownloadUrl() {
		// Try preview first (images)
		if (this.preview_asset?.url) {
			return this.preview_asset.url;
		}

		// Try document (PDFs, etc.)
		if (this.document_asset?.url) {
			return this.document_asset.url;
		}

		// Try direct URLs
		if (this.preview_url) {
			return this.preview_url;
		}

		// Last resort: thumbnail
		if (this.thumbnail_asset?.url) {
			return this.thumbnail_asset.url;
		}

		if (this.thumbnail_url) {
			return this.thumbnail_url;
		}

		return null;
	}

	async download() {
		const url = this.getDownloadUrl();
		if (!url) {
			return null;
		}

		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Failed to download file ${this.file_name}`);
		}

		return await response.blob();
	}


	toApiFormat() {
		return {
			file_uuid: this.file_uuid,
			file_name: this.file_name,
			file_kind: this.file_kind,
			preview_asset: this.preview_asset,
			document_asset: this.document_asset,
			thumbnail_asset: this.thumbnail_asset,
			preview_url: this.preview_url,
			thumbnail_url: this.thumbnail_url
		};
	}

	static async upload(orgId, blob, fileName) {
		const filenameMime = mime.getType(fileName) || 'application/octet-stream';
		const blobMime = blob.type && blob.type !== 'application/octet-stream' ? blob.type : null;

		// Prefer blob's actual MIME when it conflicts with filename-derived MIME.
		// This handles project knowledge search results where rendered PDF page
		// images (image/*) retain the original .pdf filename.
		let mimeType = filenameMime;
		if (blobMime && blobMime !== filenameMime) {
			const blobIsImage = blobMime.startsWith('image/');
			const filenameIsPdf = filenameMime === 'application/pdf';
			if (blobIsImage && filenameIsPdf) {
				apiLog.warn(`MIME mismatch for "${fileName}": blob is ${blobMime} but filename suggests ${filenameMime}. Using blob MIME.`);
				mimeType = blobMime;
				const ext = blobMime.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
				fileName = fileName.replace(/\.[^.]+$/, `.${ext}`);
			}
		}
		const typedBlob = new Blob([blob], { type: mimeType });

		// Direct upload for images and PDFs, conversion for other documents
		const isDirectUpload = mimeType.startsWith('image/') || mimeType === 'application/pdf';
		apiLog(`Uploading file "${fileName}" as ${isDirectUpload ? 'direct upload' : 'document conversion'} (MIME: ${mimeType})`);
		if (isDirectUpload) {
			// Regular file upload
			const formData = new FormData();
			formData.append('file', typedBlob, fileName);

			const response = await fetch(`/api/${orgId}/upload`, {
				method: 'POST',
				body: formData
			});

			if (!response.ok) {
				throw new Error(`Failed to upload file ${fileName}`);
			}

			const data = await response.json();
			return new ClaudeFile(data);
		} else {
			// Document conversion -> returns ClaudeAttachment
			const formData = new FormData();
			formData.append('file', typedBlob, fileName);

			const response = await fetch(`/api/organizations/${orgId}/convert_document`, {
				method: 'POST',
				body: formData
			});

			if (!response.ok) {
				throw new Error(`Failed to convert document ${fileName}`);
			}

			const data = await response.json();
			return new ClaudeAttachment(data);
		}
	}

	static fromJSON(json) {
		return new ClaudeFile(json);
	}
}

class ClaudeAttachment {
	constructor({ extracted_content, file_name, file_size, file_type }) {
		this.extracted_content = extracted_content;
		this.file_name = file_name;
		this.file_size = file_size;
		this.file_type = file_type;
	}

	toApiFormat() {
		return {
			extracted_content: this.extracted_content,
			file_name: this.file_name,
			file_size: this.file_size,
			file_type: this.file_type
		};
	}

	static fromText(text, fileName, fileType = 'text/plain') {
		return new ClaudeAttachment({
			extracted_content: text,
			file_name: fileName,
			file_size: text.length,
			file_type: fileType
		});
	}

	static fromJSON(json) {
		return new ClaudeAttachment(json);
	}
}

class ClaudeCodeExecutionFile {
	constructor(apiData, orgId, conversationId) {
		this.file_uuid = apiData.file_uuid;
		this.file_name = apiData.file_name;
		this.sanitized_name = apiData.sanitized_name;
		this.path = apiData.path; // "/mnt/user-data/uploads/..."
		this.size_bytes = apiData.size_bytes;
		this.file_kind = apiData.file_kind;
		this.created_at = apiData.created_at;

		// Asset properties (same as ClaudeFile)
		this.preview_asset = apiData.preview_asset || null;
		this.document_asset = apiData.document_asset || null;
		this.thumbnail_asset = apiData.thumbnail_asset || null;
		this.preview_url = apiData.preview_url || null;
		this.thumbnail_url = apiData.thumbnail_url || null;

		// Stored for download
		this.orgId = orgId;
		this.conversationId = conversationId;

		// For inline attachment mode (text files with code exec ON)
		this.extracted_content = apiData.extracted_content || null;
		this.force_attachment_mode = false;
	}

	getDownloadUrl() {
		// Prefer wiggle endpoint for code execution files
		if (this.orgId && this.conversationId && this.path) {
			return `/api/organizations/${this.orgId}/conversations/${this.conversationId}/wiggle/download-file?path=${encodeURIComponent(this.path)}`;
		}

		// Fall back to asset URLs
		if (this.preview_asset?.url) {
			return this.preview_asset.url;
		}
		if (this.document_asset?.url) {
			return this.document_asset.url;
		}
		if (this.preview_url) {
			return this.preview_url;
		}
		if (this.thumbnail_asset?.url) {
			return this.thumbnail_asset.url;
		}
		if (this.thumbnail_url) {
			return this.thumbnail_url;
		}

		return null;
	}

	async download() {
		const url = this.getDownloadUrl();
		if (!url) {
			throw new Error('Cannot download: missing orgId, conversationId, or path');
		}

		const response = await fetch(url);

		if (!response.ok) {
			throw new Error(`Failed to download file ${this.file_name}`);
		}

		return await response.blob();
	}

	toApiFormat() {
		return {
			file_uuid: this.file_uuid,
			file_name: this.file_name,
			sanitized_name: this.sanitized_name,
			path: this.path,
			size_bytes: this.size_bytes,
			file_kind: this.file_kind,
			created_at: this.created_at,
			preview_asset: this.preview_asset,
			document_asset: this.document_asset,
			thumbnail_asset: this.thumbnail_asset,
			preview_url: this.preview_url,
			thumbnail_url: this.thumbnail_url
		};
	}

	static fromJSON(json, orgId = null, conversationId = null) {
		return new ClaudeCodeExecutionFile(json, orgId, conversationId);
	}
}
async function addToZip(zip, filename, data) {
	if (data && typeof data.arrayBuffer === 'function') {
		const buf = await data.arrayBuffer();
		const bytes = new Uint8Array(buf);
		let binary = '';
		for (let i = 0; i < bytes.length; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		zip.file(filename, btoa(binary), { base64: true });
		return;
	}
	zip.file(filename, data);
}
// Unified file parsing - takes API data and returns appropriate class
function parseFileFromAPI(apiData, conversation = null) {
	// Code execution file - has path property
	if (apiData.path) {
		return ClaudeCodeExecutionFile.fromJSON(apiData, conversation?.orgId, conversation?.conversationId);
	}

	// Attachment - has extracted_content
	if (apiData.extracted_content !== undefined) {
		return ClaudeAttachment.fromJSON(apiData);
	}

	// Regular file - has file_uuid
	if (apiData.file_uuid) {
		return ClaudeFile.fromJSON(apiData);
	}

	throw new Error('Unknown file format');
}

class ClaudeMessage {
	constructor(conversation, historyJson = null) {
		this.conversation = conversation;

		// Core
		this.uuid = null;
		this.parent_message_uuid = '00000000-0000-4000-8000-000000000000';
		this.sender = 'human';
		this.index = 0;

		// Content (text is derived from content, not stored separately)
		this.content = [];

		// Timestamps
		this.created_at = null;
		this.updated_at = null;

		// Files
		this._files = [];

		// Other
		this.sync_sources = [];
		this.truncated = false;

		// Sending (defaults)
		this.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		this.locale = accountLocale();

		this.model = null;

		if (historyJson) {
			this._parseFromHistory(historyJson);
		}
	}

	get files() { return this._files; }

	_parseFromHistory(json) {
		this.uuid = json.uuid;
		this.parent_message_uuid = json.parent_message_uuid;
		this.sender = json.sender;
		this.index = json.index;
		this.content = json.content || [];
		this.created_at = json.created_at;
		this.updated_at = json.updated_at;
		this.truncated = json.truncated || false;
		this.sync_sources = json.sync_sources || [];

		// Parse files_v2 into file instances
		for (const f of json.files_v2 || []) {
			this.attachFile(parseFileFromAPI(f, this.conversation));
		}

		// Parse attachments
		for (const a of json.attachments || []) {
			this.attachFile(parseFileFromAPI(a, this.conversation));
		}

		// Parse files array (assistant messages often only have files here, not files_v2)
		// Deduplicate by file_uuid since human messages have files in both arrays
		const existingUuids = new Set(this._files.map(f => f.file_uuid).filter(Boolean));
		for (const f of json.files || []) {
			if (f.file_uuid && !existingUuids.has(f.file_uuid)) {
				this.attachFile(parseFileFromAPI(f, this.conversation));
			}
		}
	}

	// Helper to get/set text content for human messages
	get text() {
		const textBlocks = this.content.filter(c => c.type === 'text');
		return textBlocks.map(b => b.text).join('\n\n');
	}

	set text(value) {
		// Replace content with single text block
		this.content = [{ type: 'text', text: value }];
	}

	async addFile(input, filename = null, forceAttachmentMode = false) {
		const codeExecutionEnabled = this.conversation.accountFeatureSettings?.enabled_monkeys_in_a_barrel === true;

		// Let's make sure the input blob isn't a text file first...
		if (input instanceof Blob) {
			const isText = await isLikelyTextFile(input)
			if (isText) {
				const textContent = await input.text();
				input = textContent;
			}
		}

		// Handle string input (text content)
		if (typeof input === 'string') {
			const name = filename || 'text.txt';
			if (codeExecutionEnabled) {
				const blob = new Blob([input], { type: 'text/plain' });
				const result = await this.conversation.uploadToCodeExecution(blob, name);
				result.extracted_content = input;  // Store text content for inline attachment mode
				result.force_attachment_mode = forceAttachmentMode;
				this._files.push(result);
				return result;
			} else {
				const result = ClaudeAttachment.fromText(input, name);
				this._files.push(result);
				return result;
			}
		}

		// Handle Blob input (new file upload)
		if (input instanceof Blob) {
			const name = filename || 'file';
			if (codeExecutionEnabled) {
				const result = await this.conversation.uploadToCodeExecution(input, name);
				result.force_attachment_mode = forceAttachmentMode;
				this._files.push(result);
				return result;
			} else {
				const result = await ClaudeFile.upload(this.conversation.orgId, input, name);
				this._files.push(result);
				return result;
			}
		}

		// Handle existing file objects - re-upload to this conversation
		// (Files cannot be shared across conversations, they must be re-uploaded)
		if (input instanceof ClaudeFile ||
			input instanceof ClaudeCodeExecutionFile ||
			input instanceof ClaudeAttachment) {

			// Attachments don't need upload if code execution is off
			if (input instanceof ClaudeAttachment && !codeExecutionEnabled) {
				this._files.push(input);
				return input;
			}

			// Download and re-upload
			let blob, fileName, extractedContent = null;
			if (input instanceof ClaudeFile) {
				blob = await input.download();
				fileName = input.file_name;
			} else if (input instanceof ClaudeAttachment) {
				blob = new Blob([input.extracted_content], { type: 'text/plain' });
				fileName = input.file_name;
				extractedContent = input.extracted_content;  // Preserve text content
			} else if (input instanceof ClaudeCodeExecutionFile) {
				blob = await input.download();
				fileName = input.file_name;
				extractedContent = input.extracted_content;  // Preserve text content
			}

			let result;
			if (codeExecutionEnabled) {
				result = await this.conversation.uploadToCodeExecution(blob, fileName);
				if (extractedContent !== null) {
					result.extracted_content = extractedContent;  // Transfer to new file
				}
				result.force_attachment_mode = forceAttachmentMode;
			} else {
				result = await ClaudeFile.upload(this.conversation.orgId, blob, fileName);
			}
			this._files.push(result);
			return result;
		}

		throw new Error('addFile: unsupported input type');
	}

	removeFile(fileOrId) {
		// Accept either a string (uuid/filename) or a file object
		const id = typeof fileOrId === 'string'
			? fileOrId
			: (fileOrId.file_uuid || fileOrId.file_name);
		this._files = this._files.filter(f =>
			(f.file_uuid || f.file_name) !== id
		);
	}

	clearFiles() {
		this._files = [];
	}

	/**
	 * Attach an existing file object WITHOUT uploading.
	 *
	 * IMPORTANT: The file MUST already exist in this conversation.
	 * Use cases:
	 * - Phantom messages (visual display only, real files attached to latest message)
	 * - Editing messages (files already uploaded to this conversation)
	 * - Internal parsing (reconstructing from API/JSON)
	 *
	 * For files from OTHER conversations, use addFile() which will re-upload them.
	 * Files cannot be shared across conversations - they must be re-uploaded.
	 *
	 * For bulk replacement: use clearFiles() then loop with attachFile()
	 *
	 * @param {ClaudeFile|ClaudeCodeExecutionFile|ClaudeAttachment} fileObj - The file to attach
	 * @param {boolean|null} forceAttachmentMode - For ClaudeCodeExecutionFile only: override
	 *        the length-based decision for inline attachment mode. Set to true to force inline,
	 *        false to force reference-only, or null to use default length-based behavior.
	 */
	attachFile(fileObj, forceAttachmentMode = null) {
		if (!(fileObj instanceof ClaudeFile ||
			fileObj instanceof ClaudeCodeExecutionFile ||
			fileObj instanceof ClaudeAttachment)) {
			throw new Error('attachFile requires a file instance (ClaudeFile, ClaudeCodeExecutionFile, or ClaudeAttachment)');
		}
		this._files.push(fileObj);
		if (forceAttachmentMode !== null && fileObj instanceof ClaudeCodeExecutionFile) {
			fileObj.force_attachment_mode = forceAttachmentMode;
		}
		return fileObj;
	}

	removeToolCalls() {
		this.content = this.content.filter(item =>
			item.type !== 'tool_use' && item.type !== 'tool_result'
		);
	}

	// files_send: the file objects sent as attachments (the rest go inline, in `attachments`).
	_getFilesJSON() {
		const ATTACHMENT_CHAR_LIMIT = 15000;
		const files_v2 = [];
		const files_send = [];
		const files_history = [];
		const attachments = [];

		for (const f of this._files) {
			if (f instanceof ClaudeAttachment) {

				attachments.push(f.toApiFormat());
			} else if (f instanceof ClaudeCodeExecutionFile) {
				// Check if this should be inlined as attachment
				let shouldInline = false;
				if (f.extracted_content !== null) {
					shouldInline = f.force_attachment_mode ||
						f.extracted_content.length <= ATTACHMENT_CHAR_LIMIT;
				}

				if (shouldInline) {
					// Short text files: inline as attachment ONLY (not in files)
					attachments.push({
						extracted_content: f.extracted_content,
						file_name: f.file_name,
						file_size: f.extracted_content.length,
						file_type: 'text/plain'
					});
				} else {
					// Large files or non-text: include in files array
					const apiFormat = f.toApiFormat();
					files_v2.push(apiFormat);
					files_send.push(f);

					// Images go in files_history
					if (f.file_kind === 'image') {
						files_history.push(apiFormat);
					}
				}
			} else {
				// ClaudeFile
				const apiFormat = f.toApiFormat();
				files_v2.push(apiFormat);
				files_send.push(f);

				// Only images go in files_history
				if (f.file_kind === 'image') {
					files_history.push(apiFormat);
				}
			}
		}

		return { files_v2, files_send, files_history, attachments };
	}

	// toHistoryJSON - use files_history
	toHistoryJSON() {
		const { files_v2, files_history, attachments } = this._getFilesJSON();

		return {
			uuid: this.uuid,
			text: this.text,
			content: this.content,
			sender: this.sender,
			index: this.index,
			created_at: this.created_at,
			updated_at: this.updated_at,
			truncated: this.truncated,
			attachments,
			files: files_history,
			files_v2,
			sync_sources: this.sync_sources,
			parent_message_uuid: this.parent_message_uuid
		};
	}

	// This message as a send for ClaudeConversation._sendAndAwaitAssistant: uploaded files become
	// attachments (by file id), text files inline attachments.
	toSendMessage() {
		if (this.sender !== 'human') {
			throw new Error('Cannot send a non-human message');
		}

		const textBlocks = this.content.filter(c => c.type === 'text');
		if (textBlocks.length === 0) {
			throw new Error('Message has no text content');
		}
		if (textBlocks.length > 1) {
			throw new Error('Cannot send a message with multiple text blocks');
		}

		const { files_send, attachments } = this._getFilesJSON();

		return {
			text: textBlocks[0].text,
			parentMessageUuid: this.parent_message_uuid,
			timezone: this.timezone,
			locale: this.locale,
			model: this.model,
			attachments: files_send.map(f => ({
				id: f.file_uuid,
				fileName: f.file_name,
				fileSize: String(f.size_bytes ?? f.raw_data?.size_bytes ?? 0),
				mediaType: mime.getType(f.file_name) || 'application/octet-stream',
			})),
			inlineAttachments: attachments.map(a => ({
				fileName: a.file_name,
				fileSize: String(a.file_size ?? a.extracted_content.length),
				fileType: a.file_type || 'text/plain',
				extractedContent: a.extracted_content,
			})),
		};
	}

	//Does NOT do any filtering, remove unwanted content before calling this
	toChatlogString() {
		const parts = [];
		const allowedContentTypes = ['text', 'tool_use', 'tool_result'];

		// Format content
		for (const item of this.content) {
			if (!allowedContentTypes.includes(item.type)) continue;
			if (item.type === 'text') {
				parts.push(item.text);
			} else {
				parts.push(JSON.stringify(item));
			}
		}

		// Format files
		for (const f of this._files) {
			if (f instanceof ClaudeAttachment) {
				parts.push(`[CLEXP:ATT:${f.file_name}]\n${f.extracted_content}\n[/CLEXP:ATT:${f.file_name}]`);
			} else {
				parts.push(`[File: ${f.file_name} (${f.file_kind})]`);
			}
		}

		return parts.join('\n\n');
	}

	static fromHistoryJSON(conversation, json) {
		return new ClaudeMessage(conversation, json);
	}
}

// Save a blob as a download named filename.
function saveBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

class ClaudeProject {
	constructor(orgId, projectId) {
		this.orgId = orgId;
		this.projectId = projectId;
		this.projectData = null;
		this.cachedDocs = null;
		this.cachedFiles = null;
	}

	// Get project data
	async getData(forceRefresh = false) {
		if (!this.projectData || forceRefresh) {
			const response = await fetch(`/api/organizations/${this.orgId}/projects/${this.projectId}`);
			if (!response.ok) {
				throw new Error('Failed to fetch project data');
			}
			this.projectData = await response.json();
		}
		return this.projectData;
	}

	// Get syncs
	async getSyncs() {
		const response = await fetch(`/api/organizations/${this.orgId}/projects/${this.projectId}/syncs`);
		if (!response.ok) {
			throw new Error('Failed to fetch project syncs');
		}
		return await response.json();
	}

	// Get docs (attachments) - always fetch, but cache result
	async getDocs() {
		const response = await fetch(`/api/organizations/${this.orgId}/projects/${this.projectId}/docs`);
		if (!response.ok) {
			throw new Error('Failed to fetch project docs');
		}
		this.cachedDocs = await response.json();
		return this.cachedDocs;
	}

	// Get files - always fetch, but cache result
	async getFiles() {
		const response = await fetch(`/api/organizations/${this.orgId}/projects/${this.projectId}/files`);
		if (!response.ok) {
			throw new Error('Failed to fetch project files');
		}
		this.cachedFiles = await response.json();
		return this.cachedFiles;
	}

	// A project file's original bytes. The asset URLs in /files are previews: images come back as a
	// downscaled WebP, and only PDFs have their original as document_asset.
	contentsUrl(file) {
		return `/api/organizations/${this.orgId}/files/${file.file_uuid}/contents`;
	}

	// The name to save a doc (text knowledge, from /docs) under. Documents claude.ai converts to text on
	// upload (Word, Excel, PowerPoint, OpenDocument, RTF, EPUB) keep only that text, so they get ".txt"
	// added: their original name would promise a file the text isn't.
	static docFileName(doc) {
		const name = doc.file_name || 'document';
		return /\.(docx?|xlsx?|pptx?|od[tsp]|rtf|epub)$/i.test(name) ? `${name}.txt` : name;
	}

	// Download a doc: its text is already in the /docs response.
	async downloadAttachment(docId) {
		const doc = (this.cachedDocs ?? await this.getDocs()).find(d => d.uuid === docId);
		if (!doc) throw new Error(`Doc ${docId} not found`);
		saveBlob(new Blob([doc.content], { type: 'text/plain' }), ClaudeProject.docFileName(doc));
	}

	// Download a file (from /files) as uploaded.
	async downloadFile(fileId) {
		const file = (this.cachedFiles ?? await this.getFiles()).find(f => f.file_uuid === fileId);
		if (!file) throw new Error(`File ${fileId} not found`);
		const response = await fetch(this.contentsUrl(file));
		if (!response.ok) throw new Error(`Failed to download file ${fileId} (${response.status})`);
		saveBlob(await response.blob(), file.file_name);
	}
}


/**
 * Fetches account settings from the API.
 * Returns the full set of feature flags under `.settings` — this is the superset.
 * conversation.getData().settings is only a ~10-key subset and is missing flags like
 * enabled_melange entirely, so don't rely on it alone to detect enabled features.
 * Note the conversation-level values still win where they exist: they're a snapshot of
 * what the chat was created with, and a feature off at creation can't be enabled later.
 */
async function getAccountSettings() {
	const response = await fetch('/api/account');
	if (!response.ok) {
		throw new Error('Failed to fetch account settings');
	}
	return await response.json();
}

/**
 * Updates account settings via the API (PATCH).
 * Changes are account-wide and affect all new conversations until changed again.
 * @param {Object} settings - Settings to update
 */
async function updateAccountSettings(settings) {
	// Filter out read-only internal fields that the API rejects
	const filtered = Object.fromEntries(
		Object.entries(settings).filter(([key]) => !key.startsWith('internal_'))
	);
	const response = await fetch('https://claude.ai/api/account/settings', {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(filtered)
	});
	if (!response.ok) throw new Error('Failed to update account settings');
	return await response.json();
}

async function downloadFile(url) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to download from ${url}`);
	}
	return await response.blob();
}

async function downloadFiles(files) {
	const downloadedFiles = [];

	for (const file of files) {
		try {
			const blob = await downloadFile(file.url);
			downloadedFiles.push({
				data: blob,
				name: file.name,
				kind: file.kind,
				originalUuid: file.uuid
			});
		} catch (error) {
			apiLog.error(`Failed to download file ${file.name}:`, error);
		}
	}

	return downloadedFiles;
}

// Sync source processing
async function processSyncSource(orgId, syncsource) {
	const response = await fetch(`/api/organizations/${orgId}/sync/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			sync_source_config: syncsource?.config,
			sync_source_type: syncsource?.type
		})
	});

	if (!response.ok) {
		apiLog.error(`Failed to process sync source: ${response.statusText}`);
		return null;
	}

	const result = await response.json();
	return result.uuid;
}

// Check if user is pro/free
async function getUserType(orgId) {
	const response = await fetch(`/api/bootstrap/${orgId}/statsig`, {
		method: 'GET',
		headers: { 'Content-Type': 'application/json' },
	});

	if (!response.ok) {
		apiLog.error('Failed to fetch user type');
		return 'unknown';
	}

	const data = await response.json();
	const orgType = data?.user?.custom?.orgType;
	return orgType === 'claude_free' ? 'free' : 'pro';
}

// UUID generator
function generateUuid() {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
		const r = Math.random() * 16 | 0;
		const v = c === 'x' ? r : (r & 0x3 | 0x8);
		return v.toString(16);
	});
}

// getActiveOrgId() (common/claude/page.js), for callers that can't do anything without an org.
function getOrgId() {
	const orgId = getActiveOrgId();
	if (!orgId) throw new Error('Could not find organization ID');
	return orgId;
}

// ======== Skills API (used for encryption key storage) ========

async function listSkills(orgId) {
	const response = await fetch(`/api/organizations/${orgId}/skills/list-skills`);
	if (!response.ok) {
		throw new Error(`Failed to list skills: ${response.statusText}`);
	}
	return await response.json();
}

async function createSkill(orgId, name, description) {
	const response = await fetch(`/api/organizations/${orgId}/skills/create-simple-skill`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name, description, instructions: '' })
	});

	if (!response.ok) {
		const error = await response.json();
		throw new Error(error.message || 'Failed to create skill');
	}

	return await response.json();
}

async function disableSkill(orgId, skillId) {
	const response = await fetch(`/api/organizations/${orgId}/skills/disable-skill`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ skill_id: skillId })
	});

	if (!response.ok) {
		const error = await response.json();
		throw new Error(error.message || 'Failed to disable skill');
	}

	return await response.json();
}

async function isLikelyTextFile(file) {
	// First check browser-provided MIME type
	if (file.type && file.type.startsWith('text/')) {
		return true;
	}

	// Check MIME type from library
	const mimeType = mime.getType(file.name);
	if (mimeType) {
		// text/* types are obviously text
		if (mimeType.startsWith('text/')) {
			return true;
		}
		// Many code/data files have application/* types but are text
		const textLikeTypes = [
			'application/javascript',
			'application/json',
			'application/xml',
			'application/x-sh',
			'application/x-python',
			'application/x-ruby',
			'application/x-perl',
			'application/x-php',
			'application/sql',
			'application/graphql',
			'application/ld+json',
			'application/x-yaml',
			'application/toml',
		];
		if (textLikeTypes.includes(mimeType) || mimeType.endsWith('+xml') || mimeType.endsWith('+json')) {
			return true;
		}
	}

	// Fallback: Try to read first 1KB to check if it's text
	try {
		const slice = file.slice(0, 1024);
		const arrayBuffer = await slice.arrayBuffer();
		const bytes = new Uint8Array(arrayBuffer);

		// Check for null bytes (binary files often have these)
		for (let i = 0; i < bytes.length; i++) {
			if (bytes[i] === 0) {
				return false; // Likely binary
			}
		}

		// Check if most bytes are printable ASCII or common UTF-8
		let printableCount = 0;
		for (let i = 0; i < bytes.length; i++) {
			const byte = bytes[i];
			// Printable ASCII, tab, newline, carriage return, or valid UTF-8 start bytes
			if ((byte >= 32 && byte <= 126) || byte === 9 || byte === 10 || byte === 13 || byte >= 128) {
				printableCount++;
			}
		}

		// If >90% of bytes are printable, likely text
		return (printableCount / bytes.length) > 0.9;
	} catch (error) {
		apiLog.error('Error checking file type:', error);
		// Default to allowing it if we can't check
		return true;
	}
}

const CLAUDE_MODELS = [
	{ value: 'claude-opus-5-5', label: 'Opus 5.5' },
	{ value: 'claude-fable-5-1', label: 'Fable 5.1' },
	{ value: 'claude-opus-5', label: 'Opus 5' },
	{ value: 'claude-fable-5', label: 'Fable 5' },
	{ value: 'claude-sonnet-5', label: 'Sonnet 5' },
	{ value: 'claude-opus-4-8', label: 'Opus 4.8' },
	{ value: 'claude-opus-4-7', label: 'Opus 4.7' },
	{ value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
	{ value: 'claude-opus-4-6', label: 'Opus 4.6' },
	{ value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
	{ value: 'claude-3-opus-20240229', label: 'Opus 3' },
]

const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
const FAST_MODEL = 'claude-haiku-5-5';