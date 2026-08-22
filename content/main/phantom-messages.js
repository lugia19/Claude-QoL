// phantom-messages.js
'use strict';

const PHANTOM_PREFIX = 'phantom_messages_';
const OLD_FORK_PREFIX = 'fork_history_';
const PHANTOM_MARKER = '====PHANTOM_MESSAGE====';
const UUID_MARKER_PREFIX = '====UUID:';
const UUID_MARKER_SUFFIX = '====';

// ==== STORAGE FUNCTIONS ====
// storePhantomMessages, getPhantomMessages, clearPhantomMessages are defined in claude-api.js
// They auto-detect isolated vs MAIN world and use the postMessage bridge when needed.

// Wrap the raw accessor with localStorage migration and ClaudeMessage hydration
const _rawGetPhantomMessages = getPhantomMessages;

getPhantomMessages = async function (conversationId) {
	// Check localStorage first and migrate if found
	const oldKey = `${OLD_FORK_PREFIX}${conversationId}`;
	const newKey = `${PHANTOM_PREFIX}${conversationId}`;

	const orgId = getOrgId();
	const conversation = new ClaudeConversation(orgId, conversationId);

	const localData = localStorage.getItem(newKey) || localStorage.getItem(oldKey);
	if (localData) {
		console.log(`[QOL-PhantomMessages] Migrating ${conversationId} to IndexedDB`);
		const messagesJson = JSON.parse(localData);
		const messages = messagesJson.map(json => new ClaudeMessage(conversation, json));
		await storePhantomMessages(conversationId, messages);
		localStorage.removeItem(newKey);
		localStorage.removeItem(oldKey);
		return messages;
	}

	// Get from IndexedDB via accessor
	const messagesJson = await _rawGetPhantomMessages(conversationId);
	if (messagesJson) {
		return messagesJson.map(json => new ClaudeMessage(conversation, json));
	}
	return null;
};

// ==== FETCH INTERCEPTOR ====
const originalFetch = window.fetch;
window.fetch = async (...args) => {
	const [input, config] = args;

	let url;
	if (input instanceof URL) {
		url = input.href;
	} else if (typeof input === 'string') {
		url = input;
	} else if (input instanceof Request) {
		url = input.url;
	}

	if (url && url.includes('skip_uuid_injection=true')) {
		return originalFetch(...args);
	}

	// Check if this is a conversation data request
	if (url &&
		url.includes('/chat_conversations/') &&
		url.includes('rendering_mode=messages') &&
		(!config || config.method === 'GET' || !config.method)) {

		const urlParts = url.split('/');
		const conversationIdIndex = urlParts.findIndex(part => part === 'chat_conversations') + 1;
		const conversationId = urlParts[conversationIdIndex]?.split('?')[0];

		if (conversationId) {
			const response = await originalFetch(...args);
			const conversationData = await response.json();

			let phantomMessages = await getPhantomMessages(conversationId);

			if (!phantomMessages || phantomMessages.length === 0) {
				const firstHuman = conversationData.chat_messages?.find(m => m.sender === 'human');
				if (firstHuman) {
					const attachments = firstHuman.attachments || [];

					const chatlogAtt = attachments.find(
						a => a.file_name === 'chatlog.txt' &&
							a.extracted_content?.startsWith('[CLEXP:MSG_HEADER:')
					);

					if (chatlogAtt) {
						console.warn('No phantom messages found for conversation, attempting reconstruction from attachments');
						const summaryTexts = attachments
							.filter(a => a.file_name?.match(/^summary_chunk_\d+\.txt$/))
							.sort((a, b) => {
								const numA = parseInt(a.file_name.match(/\d+/)[0]);
								const numB = parseInt(b.file_name.match(/\d+/)[0]);
								return numA - numB;
							})
							.map(a => a.extracted_content);

						const reconstructed = ClaudeConversation.fromChatlog(
							chatlogAtt.extracted_content,
							summaryTexts
						);

						if (reconstructed) {
							const messages = await reconstructed.getMessages();
							const messagesJson = messages.map(m => m.toHistoryJSON());
							await storePhantomMessages(conversationId, messagesJson);
							phantomMessages = messages;
						}
					}
				}
			}

			if (phantomMessages && phantomMessages.length > 0) {
				injectPhantomMessages(conversationData, phantomMessages);
			}

			injectUUIDMarkers(conversationData);

			return new Response(JSON.stringify(conversationData), {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers
			});
		}
	}

	// Check if this is a completion request
	if (url && url.includes('/completion') && config && config.method === 'POST') {
		const urlParts = url.split('/');
		const conversationIdIndex = urlParts.findIndex(part => part === 'chat_conversations') + 1;
		const conversationId = urlParts[conversationIdIndex]?.split('?')[0];

		if (conversationId) {
			const phantomMessages = await getPhantomMessages(conversationId);

			if (phantomMessages && phantomMessages.length > 0) {
				const lastPhantomUuid = phantomMessages[phantomMessages.length - 1].uuid;

				let body;
				try {
					body = JSON.parse(config.body);
				} catch (e) {
					return originalFetch(...args);
				}

				if (body.parent_message_uuid === lastPhantomUuid) {
					console.log('Fixing parent_message_uuid from phantom to root for completion request');
					body.parent_message_uuid = "00000000-0000-4000-8000-000000000000";

					const newConfig = {
						...config,
						body: JSON.stringify(body)
					};

					return originalFetch(input, newConfig);
				}
			}
		}
	}

	return originalFetch(...args);
};

function reorderKeys(obj, referenceObj) {
	const orderedObj = {};
	// First, add keys in the order they appear in referenceObj
	// If key is missing from obj, use the value from referenceObj
	for (const key of Object.keys(referenceObj)) {
		orderedObj[key] = key in obj ? obj[key] : referenceObj[key];
	}
	// Then add any remaining keys from obj that weren't in referenceObj
	for (const key of Object.keys(obj)) {
		if (!(key in orderedObj)) {
			orderedObj[key] = obj[key];
		}
	}
	return orderedObj;
}

function injectPhantomMessages(data, phantomMessages) {
	const timestamp = new Date().toISOString();
	const referenceMsg = data.chat_messages[0];

	// Add phantom marker as a separate content item for each message
	for (const msg of phantomMessages) {
		if (!msg.created_at) msg.created_at = timestamp;
		if (!msg.updated_at) msg.updated_at = timestamp;

		for (const item of msg.content) {
			if (!item.start_timestamp) item.start_timestamp = timestamp;
			if (!item.stop_timestamp) item.stop_timestamp = timestamp;
			if (!item.citations) item.citations = [];
		}

		msg.content.push({
			start_timestamp: timestamp,
			stop_timestamp: timestamp,
			type: "text",
			text: PHANTOM_MARKER,
			citations: []
		});
	}

	// If last phantom is human, add an ack message
	let lastPhantom = phantomMessages[phantomMessages.length - 1];
	if (lastPhantom && lastPhantom.sender === 'human') {
		const orgId = getOrgId();
		const conversation = new ClaudeConversation(orgId, null);
		const ackMessage = new ClaudeMessage(conversation);
		ackMessage.uuid = crypto.randomUUID();
		ackMessage.parent_message_uuid = lastPhantom.uuid;
		ackMessage.sender = 'assistant';
		ackMessage.created_at = timestamp;
		ackMessage.updated_at = timestamp;
		ackMessage.content = [
			{
				start_timestamp: timestamp,
				stop_timestamp: timestamp,
				type: "text",
				text: "Acknowledged - end of previous conversation.",
				citations: []
			},
			{
				start_timestamp: timestamp,
				stop_timestamp: timestamp,
				type: "text",
				text: PHANTOM_MARKER,
				citations: []
			}
		];
		phantomMessages.push(ackMessage);
		lastPhantom = ackMessage;
	}

	console.log(`Injecting ${phantomMessages.length} phantom messages into conversation`);

	// Convert to JSON for injection
	let phantomJson = phantomMessages.map(msg => msg.toHistoryJSON());

	// Reorder keys to match reference message format
	if (referenceMsg) {
		phantomJson = phantomJson.map(msg => reorderKeys(msg, referenceMsg));
	}

	// Rewire roots onto the last phantom, prepend, reindex. Shared with
	// ClaudeConversation.getRenderedMessages so both views of the list agree.
	stitchPhantomMessages(data, phantomJson);

	console.log('Updated chat messages with phantom messages:', data.chat_messages);
}

function injectUUIDMarkers(data) {
	const assistantMessages = data.chat_messages.filter(msg => msg.sender !== 'human');

	assistantMessages.forEach(msg => {
		const uuidMarker = UUID_MARKER_PREFIX + msg.uuid + UUID_MARKER_SUFFIX;
		msg.content.push({
			type: "text",
			text: uuidMarker
		});
	});
}


// Style phantom messages in the DOM
function stylePhantomMessages() {
	const { allMessages, userMessages } = getUIMessages();
	const userMessageSet = new Set(userMessages);

	allMessages.forEach(container => {
		const textContent = container.textContent || '';
		const hasMarker = textContent.includes(PHANTOM_MARKER);
		const isMarkedPhantom = container.hasAttribute('data-phantom-styled');

		if (hasMarker) {
			container.setAttribute('data-phantom-styled', 'true');
			removePhantomMarkerFromElement(container);
		}

		if (hasMarker || isMarkedPhantom) {
			if (container.parentElement && container.parentElement.parentElement) {
				container.parentElement.parentElement.style.filter = 'brightness(0.70)';
			}

			const controls = findMessageControls(container);
			if (controls) {
				controls.style.display = 'none';
			}
		}
	});
}

function removePhantomMarkerFromElement(element) {
	// Markers are now separate content items rendered as their own <p> elements.
	// Just hide them — no textContent modification needed, avoids React DOM desync.
	const paragraphs = element.querySelectorAll('p');
	paragraphs.forEach(p => {
		if (p.textContent.includes(PHANTOM_MARKER)) {
			p.style.display = 'none';
		}
	});
}

// Add new function to extract and store UUIDs
function extractAndStoreUUIDs() {
	const { allMessages } = getUIMessages();
	allMessages.forEach(container => {
		const textContent = container.textContent || '';

		// Look for UUID marker using lastIndexOf
		const markerStart = textContent.lastIndexOf(UUID_MARKER_PREFIX);
		if (markerStart !== -1) {
			const uuidStart = markerStart + UUID_MARKER_PREFIX.length;
			const uuidEnd = textContent.indexOf(UUID_MARKER_SUFFIX, uuidStart);

			if (uuidEnd !== -1) {
				const uuid = textContent.substring(uuidStart, uuidEnd);

				// Put UUID on parent container instead of the message element itself
				const parentContainer = container?.parentElement?.parentElement?.parentElement;
				if (parentContainer) {
					parentContainer.setAttribute('data-message-uuid', uuid);
				}

				// Remove the marker from DOM
				removeUUIDMarkerFromElement(container);
			}
		}
	});
}

function removeUUIDMarkerFromElement(element) {
	// Markers are now separate content items rendered as their own <p> elements.
	// Just hide them — no textContent modification needed, avoids React DOM desync.
	const paragraphs = element.querySelectorAll('p');
	paragraphs.forEach(p => {
		if (p.textContent.includes(UUID_MARKER_PREFIX)) {
			p.style.display = 'none';
		}
	});
}


// ==== CLIPBOARD CLEANUP - Strip markers before copying ====
const originalClipboardWrite = navigator.clipboard.write;
navigator.clipboard.write = async (data) => {
	try {
		const item = data[0];
		if (!item) return originalClipboardWrite.call(navigator.clipboard, data);

		const types = {};

		for (const type of item.types) {
			const blob = await item.getType(type);

			if (type === 'text/plain' || type === 'text/html') {
				let text = await blob.text();

				// Strip phantom markers
				text = text.replace(/====PHANTOM_MESSAGE====/g, '');

				// Strip UUID markers
				text = text.replace(/====UUID:[a-f0-9-]+====/gi, '');

				// Clean up extra newlines/whitespace from removal
				if (type === 'text/plain') {
					text = text.replace(/\n{3,}/g, '\n\n').trim();
				} else {
					// For HTML, clean up empty paragraphs that might result
					text = text.replace(/<p[^>]*>\s*<\/p>/gi, '');
				}

				types[type] = new Blob([text], { type });
			} else {
				// Preserve other types as-is
				types[type] = blob;
			}
		}

		return originalClipboardWrite.call(navigator.clipboard, [new ClipboardItem(types)]);
	} catch (error) {
		console.error('[QOL-PhantomMessages] Error cleaning clipboard text:', error);
		return originalClipboardWrite.call(navigator.clipboard, data);
	}
};

// The message list is virtualized, so rows mount continuously while scrolling and
// each one arrives with its raw ====UUID:...==== marker visible. A poll can only
// hide it a tick later, which shows up as flashing text on every scroll; observer
// callbacks are delivered before paint, so they hide it in the same frame.
//
// The observer is a latency optimisation only. The interval below stays as the
// supervisor and reattaches it after SPA navigation replaces the container, so a
// dead observer degrades to the old polling behaviour rather than to broken.
let _observedContainer = null;
let _messageObserver = null;
let _passScheduled = false;

function runTaggingPass() {
	stylePhantomMessages();
	extractAndStoreUUIDs();
}

function schedulePass() {
	if (_passScheduled) return;
	_passScheduled = true;
	requestAnimationFrame(() => {
		_passScheduled = false;
		runTaggingPass();
	});
}

function syncMessageObserver() {
	// Scoped to the conversation scroll container (claude-styles.js) rather than
	// document.body, so streaming text elsewhere on the page can't churn it.
	const container = getMessageScroller();
	if (!container || container === _observedContainer) {
		if (_observedContainer && !_observedContainer.isConnected) {
			_messageObserver?.disconnect();
			_observedContainer = null;
		}
		return;
	}

	_messageObserver?.disconnect();
	_messageObserver = new MutationObserver(schedulePass);
	_messageObserver.observe(container, { childList: true, subtree: true });
	_observedContainer = container;
	runTaggingPass();
}

setInterval(() => {
	syncMessageObserver();
	runTaggingPass();
}, 300);