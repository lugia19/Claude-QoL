// message-ui.js
// Message DOM helpers, virtualized-list navigation and MessageButtonBar. No IIFE - shared global context.

const messageUiLog = createLogger('MessageUI');

function findMessageControls(messageElement) {
	// Find the message container (the .group element's parent)
	const messageContainer = messageElement.closest('.group')?.parentElement?.parentElement;
	if (!messageContainer) return null;

	// New UI: the role="toolbar" element is itself the justify-between flex row
	// that directly contains the action buttons. Matched by data-cds, not aria-label: claude.ai
	// localizes the label. Placeholder [data-cds="MessageActions"] rows without role="toolbar" exist too.
	const toolbar = messageContainer.querySelector('[role="toolbar"][data-cds="MessageActions"]');
	if (toolbar) return toolbar;

	// Legacy UI: role="group" wrapper with a .justify-between child.
	const actionsGroup = messageContainer.querySelector('[role="group"][aria-label="Message actions"]');
	return actionsGroup?.querySelector('.justify-between') ?? null;
}

// Retrieve all message elements from the UI
function getUIMessages() {
	const assistantMessages = Array.from(document.querySelectorAll('.font-claude-response, .\\!font-claude-response, [data-testid="assistant-message"]'))
		.filter(el => !el.classList.contains('text-text-300'));
	const userMessages = Array.from(document.querySelectorAll('.font-user-message, .\\!font-user-message, [data-testid="user-message"]'));

	// Sort by document order. Do NOT interleave by index: the message list is
	// virtualized, so the rendered window is an arbitrary slice that can start
	// with either sender, and index-pairing silently goes off by one.
	//
	// NOTE: the result is NOT contiguous. The virtualizer permanently pins the last
	// human and last assistant rows (lastHumanMessageRef / lastAssistantMessageRef),
	// so this is really "the current window PLUS the tail". Don't do positional work on
	// it: identify rows by their data-turn-key (see MESSAGE IDENTITY), or by data-index.
	const allMessages = [...userMessages, ...assistantMessages].sort((a, b) =>
		(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);

	return {
		assistantMessages,
		userMessages,
		allMessages
	};
}

// ======== MESSAGE IDENTITY ========
// Every message row carries data-turn-key, rendered by claude.ai itself and updated in place when a
// version switch changes what the row shows. User rows: the message's uuid. Assistant rows: their
// uuid, except the original reply to a send made in the merged experience, which is keyed
// "<parent user uuid>-hub-reply"; that one is the lowest-index assistant child of the parent
// (verified against the page's own data, docs/bard-rework.md "Message identity in the DOM").
// The key is read live from the row, never cached, so it can't go stale.

const HUB_REPLY_SUFFIX = '-hub-reply';

// The [data-turn-key] element of the row containing el (a message, its toolbar, a button), or null.
function turnRowOf(el) {
	return el?.closest?.('[data-turn-key]') ?? null;
}

// The original reply to every user message, from the whole tree: parent uuid -> reply uuid.
function _originalReplies(tree) {
	const best = new Map();
	for (const msg of tree) {
		if (msg.sender === 'human' || !msg.parent_message_uuid) continue;
		const current = best.get(msg.parent_message_uuid);
		const earlier = !current
			|| (msg.index ?? 0) < (current.index ?? 0)
			|| ((msg.index ?? 0) === (current.index ?? 0) && String(msg.created_at) < String(current.created_at));
		if (earlier) best.set(msg.parent_message_uuid, msg);
	}
	return new Map([...best].map(([parent, msg]) => [parent, msg.uuid]));
}

// key -> message uuid, or null. `tree` must be every message of the conversation
// (conversationData.chat_messages, getMessages(true)), not a branch: after a client-side version
// switch, the row on screen can be off the server's current branch.
function turnKeyResolver(tree) {
	const originals = _originalReplies(tree);
	return (key) => {
		if (!key) return null;
		if (!key.endsWith(HUB_REPLY_SUFFIX)) return key;
		return originals.get(key.slice(0, -HUB_REPLY_SUFFIX.length)) ?? null;
	};
}

function uuidForTurnKey(key, tree) {
	return turnKeyResolver(tree)(key);
}

// The mounted row element showing uuid, or null.
function rowForUuid(uuid, tree) {
	if (!uuid) return null;
	const own = document.querySelector(`[data-turn-key="${CSS.escape(uuid)}"]`);
	if (own) return own;
	const msg = tree.find(m => m.uuid === uuid);
	if (!msg || msg.sender === 'human' || !msg.parent_message_uuid) return null;
	const hubKey = msg.parent_message_uuid + HUB_REPLY_SUFFIX;
	if (_originalReplies(tree).get(msg.parent_message_uuid) !== uuid) return null;
	return document.querySelector(`[data-turn-key="${CSS.escape(hubKey)}"]`);
}

// The uuid of the message whose row contains el (for click handlers). Plain keys need nothing else;
// a "-hub-reply" key loads the conversation (getData caches per instance: pass one you already
// have) to apply the tree rule. null if el isn't in a message row.
async function messageUuidOfElement(el, conversation = null) {
	const key = turnRowOf(el)?.getAttribute('data-turn-key');
	if (!key) return null;
	if (!key.endsWith(HUB_REPLY_SUFFIX)) return key;
	const conv = conversation ?? new ClaudeConversation(getOrgId(), getConversationId());
	const data = await conv.getData();
	return uuidForTurnKey(key, data.chat_messages ?? []);
}

// A user message element's uuid: user rows are always keyed by their own uuid.
function resolveUserMessageUuid(userElement) {
	return turnRowOf(userElement)?.getAttribute('data-turn-key') ?? null;
}

// ======== VIRTUALIZED MESSAGE LIST ========
// claude.ai renders the conversation through a virtualizer: only a window of
// messages around the viewport exists in the DOM, everything else is a spacer.
// Anything that needs an off-screen message has to drive the scroll container
// until the virtualizer renders it.
//
// The ordering signal is each row's data-turn-key (see MESSAGE IDENTITY), NOT the virtualizer's
// data-index: both the target and the on-screen rows are looked up in the same rendered branch, so
// the offset introduced by prepended phantom messages cancels out.

// Walk up from a rendered message row to the scroll container.
function getMessageScroller() {
	let el = document.querySelector('div.group\\/message-row');
	while (el) {
		const overflowY = getComputedStyle(el).overflowY;
		if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 5) {
			return el;
		}
		el = el.parentElement;
	}
	return null;
}

// The row we are actually looking at, as its position in the rendered branch (positionOf: row
// element -> index, or undefined). Used to tell which side of the scroll range a target is on.
//
// Nearest-by-distance rather than a distance cutoff, deliberately. The virtualizer
// keeps rows mounted that are nowhere near the viewport (it pins the tail of the
// conversation), so the mounted set can't be trusted wholesale — but any fixed cutoff
// is guessing: measured window rows reach 4.4 viewports away on this conversation
// because single messages are routinely taller than the viewport. Taking the closest
// row needs no threshold, can't discard a legitimate row, and doesn't care *why*
// anything else is mounted.
function getNearestAnchor(positionOf) {
	const scroller = getMessageScroller();
	if (!scroller) return null;
	const viewportTop = scroller.getBoundingClientRect().top;

	let nearest = null;
	for (const el of document.querySelectorAll('[data-turn-key]')) {
		const position = positionOf(el);
		if (position === undefined) continue; // not on this branch
		const distance = Math.abs(el.getBoundingClientRect().top - viewportTop);
		if (!nearest || distance < nearest.distance) nearest = { position, distance };
	}
	return nearest;
}

let _revealInFlight = false;

// Callers fire shortly after a reload (bookmark / "Go to Message"), when the
// conversation may not be mounted yet.
async function _waitForMessageList(timeoutMs = 10000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (getMessageScroller() && document.querySelector('[data-turn-key]')) return true;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return false;
}

// Scroll a message (user or assistant) into view by uuid, rendering it first if the virtualizer
// has it unmounted.
//
// Pass `conversation` if you already have one — getData caches per instance, so it saves
// a refetch. It deliberately takes the conversation rather than a message array: the
// positions have to come from getRenderedMessages(), and handing in a plain branch made
// it too easy to pass a phantom-free list and silently break forked chats.
//
// `strategy` picks how to get there:
//   'search' (default) — target could be anywhere; binary-search the scroll range.
//   'step'             — caller knows it's adjacent; walk toward it, falling back to
//                        'search' if that assumption turns out wrong.
// Returns the revealed element, or null.
async function revealMessageByUuid(uuid, { highlight = true, conversation = null, strategy = 'search', maxProbes = 12 } = {}) {
	if (!uuid || _revealInFlight) return null;
	_revealInFlight = true;
	try {
		if (!await _waitForMessageList()) return null;

		// After a load the list pins its tail until the user scrolls: any scroll of ours snaps back to
		// the bottom on the next frame. A (synthetic, so inert) wheel event counts as the user scrolling.
		getMessageScroller()?.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }));

		const conv = conversation ?? new ClaudeConversation(getOrgId(), getConversationId());
		const tree = (await conv.getData()).chat_messages ?? [];
		const findTarget = () => rowForUuid(uuid, tree);

		// Already on screen — nothing to hunt for.
		const alreadyThere = findTarget();
		if (alreadyThere) return await _settleOnMessage(alreadyThere, highlight);

		const messages = await conv.getRenderedMessages();
		const positions = new Map(messages.map((msg, i) => [msg.uuid, i]));
		const targetPosition = positions.get(uuid);
		if (targetPosition === undefined) return null;
		const resolve = turnKeyResolver(tree);
		const positionOf = (row) => positions.get(resolve(row.getAttribute('data-turn-key')));

		const scroller = getMessageScroller();
		if (!scroller) return null;

		if (strategy === 'step') {
			// Nearby target: walk toward it. Falls back to bracketing if the guess that it
			// was close turns out to be wrong.
			const arrived = await _stepTowardAnchor(scroller, findTarget, positionOf, targetPosition);
			if (!arrived) await _bracketTowardAnchor(scroller, findTarget, positionOf, targetPosition, maxProbes);
		} else {
			await _bracketTowardAnchor(scroller, findTarget, positionOf, targetPosition, maxProbes);
		}

		const target = findTarget();
		if (!target) return null;
		return await _settleOnMessage(target, highlight);
	} catch (error) {
		messageUiLog.error('revealMessageByUuid failed:', error);
		return null;
	} finally {
		_revealInFlight = false;
	}
}

// "Go to" for any message in the tree (bookmarks, chat search, latest/longest). On the current branch
// it just scrolls there. Elsewhere it moves the current leaf there (`leafId`, or the longest leaf below
// the target) and reloads; chat-search.js's scrollToMessageByUuid reveals the target after the load.
// Returns false when the page is reloading (leave any loading modal up), true otherwise.
// Upgraded (workspace) chats can't move their leaf: jumps to another branch there are still to be
// implemented (docs/bard-rework.md, "Still open").
async function jumpToMessage(conversation, uuid, leafId = null) {
	await conversation.getData(true); // fresh: the leaf may have moved since the conversation was loaded
	const branch = await conversation.getMessages(false);
	if (branch.some(msg => msg.uuid === uuid)) {
		await revealMessageByUuid(uuid, { conversation });
		return true;
	}
	sessionStorage.setItem('message_uuid_to_find', uuid);
	await conversation.setCurrentLeaf(leafId ?? conversation.findLongestLeaf(uuid).leafId); // reloads
	return false;
}

// Rows can lag a freshly mounted window by a frame or two.
async function _awaitNearestAnchor(positionOf, attempts = 6) {
	let nearest = getNearestAnchor(positionOf);
	for (let wait = 0; !nearest && wait < attempts; wait++) {
		await new Promise(resolve => setTimeout(resolve, 100));
		nearest = getNearestAnchor(positionOf);
	}
	return nearest;
}

async function _awaitAnchorChange(positionOf, previousPosition, attempts = 14) {
	for (let wait = 0; wait < attempts; wait++) {
		await new Promise(resolve => setTimeout(resolve, 50));
		if (getNearestAnchor(positionOf)?.position !== previousPosition) return;
	}
}

// 'step' strategy — for a target the caller knows is nearby (the adjacent message).
// Nudge half a viewport at a time in its direction. A couple of small scrolls beats
// bracketing a 400,000px range, and it lands the same way a human would scroll there.
// Returns whether it arrived.
async function _stepTowardAnchor(scroller, findAnchor, positionOf, targetPosition, maxSteps = 12) {
	for (let step = 0; step < maxSteps; step++) {
		if (findAnchor()) return true;

		const nearest = await _awaitNearestAnchor(positionOf);
		if (!nearest) return false;

		const from = scroller.scrollTop;
		const direction = targetPosition < nearest.position ? -1 : 1;
		scroller.scrollTop = from + direction * scroller.clientHeight * 0.9;
		if (Math.abs(scroller.scrollTop - from) < 1) return !!findAnchor(); // hit an end

		// Just give the virtualizer a beat to mount. Deliberately not waiting for the
		// nearest anchor to *change*: messages are often 2-3 screens tall, so a nudge this
		// size frequently leaves the same row nearest, and waiting for that signal burns
		// its whole timeout on most steps.
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return !!findAnchor();
}

// 'search' strategy — for a target that could be anywhere (a bookmark, a search hit).
// Binary search on scroll position: message heights vary far too much to convert a
// position into a pixel offset, but the nearest rendered row always says which side of
// the target we are on, which is enough to bracket it.
async function _bracketTowardAnchor(scroller, findAnchor, positionOf, targetPosition, maxProbes) {
	let low = 0;
	let high = Math.max(0, scroller.scrollHeight - scroller.clientHeight);

	for (let probe = 0; probe < maxProbes; probe++) {
		if (findAnchor()) return true;

		const nearest = await _awaitNearestAnchor(positionOf);
		if (!nearest) return false;

		// Re-bracket from where we actually ended up: the virtualizer revises its height
		// estimates (and sometimes scrollTop) as rows mount.
		if (targetPosition < nearest.position) {
			high = scroller.scrollTop;
		} else {
			low = scroller.scrollTop;
		}

		const next = Math.round((low + high) / 2);
		if (Math.abs(next - scroller.scrollTop) < 1) return !!findAnchor();

		scroller.scrollTop = next;
		await _awaitAnchorChange(positionOf, nearest.position);
	}
	return !!findAnchor();
}

// Centre the message and flash it.
async function _settleOnMessage(target, highlight) {
	// Instant, not smooth: smooth-scrolling across a virtualized list unmounts
	// rows mid-flight and the scroll lands nowhere.
	//
	// Centre short messages, but align tall ones to the top — messages are
	// routinely twice the viewport height, and centring those drops you into the
	// middle of the text instead of at its start.
	//
	// Rows that just mounted still get measured, and the virtualizer corrects
	// scrollTop for that over the next frames, which can undo our scroll: check
	// after a couple of frames and settle again if the target drifted off screen.
	const scroller = getMessageScroller();
	for (let attempt = 0; attempt < 3; attempt++) {
		const fitsOnScreen = !scroller || target.getBoundingClientRect().height <= scroller.clientHeight;
		target.scrollIntoView({ block: fitsOnScreen ? 'center' : 'start' });
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
		const rect = target.getBoundingClientRect();
		if (!target.isConnected || (rect.bottom > 0 && rect.top < window.innerHeight)) break;
	}

	if (highlight) {
		target.style.transition = 'background-color 0.3s';
		target.style.backgroundColor = '#2c84db4d';
		setTimeout(() => {
			if (target.isConnected) target.style.backgroundColor = '';
		}, 4000);
	}

	return target;
}

// ======== MESSAGE BUTTON BAR SINGLETON ========
// Manages per-message buttons (injected into message controls area).
// Callers register once; MessageButtonBar handles polling, injection, and ordering.
const MessageButtonBar = {
	ASSISTANT_BUTTON_PRIORITY: [
		'fork-button',
		'bookmark-button',
	],
	USER_BUTTON_PRIORITY: [
		'advanced-edit-button',
	],

	_registrations: new Map(),
	_pollInterval: null,

	register({ buttonClass, target, createFn, pages, shouldInject = null, insertFn = null }) {
		if (this._registrations.has(buttonClass)) return;
		this._registrations.set(buttonClass, { buttonClass, target, createFn, pages, shouldInject, insertFn });
		if (!this._pollInterval) {
			this._pollInterval = setInterval(() => this._tick(), 1000);
			this._tick();
		}
	},

	async _tick() {
		// Detect current page group (reuse ButtonBar's detection or detect independently)
		let group = ButtonBar.getCurrentGroup();
		if (!group) {
			// ButtonBar may not have ticked yet — detect independently
			for (const layout of Object.values(pageLayouts)) {
				if (layout.match()) { group = layout.group; break; }
			}
		}
		if (!group) return;

		const { assistantMessages, userMessages } = getUIMessages();

		for (const [buttonClass, reg] of this._registrations) {
			if (!reg.pages.includes(group)) continue;

			if (reg.shouldInject) {
				const allowed = await reg.shouldInject();
				if (!allowed) continue;
			}

			const messages = reg.target === 'assistant' ? assistantMessages : userMessages;
			const priorityArray = reg.target === 'assistant'
				? this.ASSISTANT_BUTTON_PRIORITY
				: this.USER_BUTTON_PRIORITY;

			for (const message of messages) {
				const container = findMessageControls(message);
				if (!container) continue;
				if (container.querySelector('.' + buttonClass)) continue;

				const button = reg.createFn();
				button.classList.add(buttonClass);

				if (reg.insertFn) {
					reg.insertFn(button, container);
				} else {
					this._defaultInsert(button, buttonClass, container, priorityArray);
				}
			}
		}
	},

	_defaultInsert(button, buttonClass, container, priorityArray) {
		let insertBefore = null;

		const currentPriority = priorityArray.indexOf(buttonClass);
		for (let i = currentPriority + 1; i < priorityArray.length; i++) {
			const lowerPriorityButton = container.querySelector('.' + priorityArray[i]);
			if (lowerPriorityButton) {
				insertBefore = lowerPriorityButton;
				break;
			}
		}

		// Fallback: insert before the copy button
		if (!insertBefore) {
			const copyButton = container.querySelector('[data-testid="action-bar-copy"]');
			if (copyButton) {
				insertBefore = copyButton;
			}
		}

		while (insertBefore && insertBefore.parentElement !== container) {
			insertBefore = insertBefore.parentElement;
		}

		if (insertBefore) {
			container.insertBefore(button, insertBefore);
		} else {
			container.insertBefore(button, container.firstElementChild);
		}
	},
};
