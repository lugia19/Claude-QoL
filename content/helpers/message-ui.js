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
	const assistantMessages = Array.from(document.querySelectorAll('.font-claude-response, .\\!font-claude-response'))
		.filter(el => !el.classList.contains('text-text-300'));
	const userMessages = Array.from(document.querySelectorAll('.font-user-message, .\\!font-user-message, [data-testid="user-message"]'));

	// Sort by document order. Do NOT interleave by index: the message list is
	// virtualized, so the rendered window is an arbitrary slice that can start
	// with either sender, and index-pairing silently goes off by one.
	//
	// NOTE: the result is NOT contiguous. The virtualizer permanently pins the last
	// human and last assistant rows (lastHumanMessageRef / lastAssistantMessageRef),
	// so this is really "the current window PLUS the tail". Anything doing positional
	// work on it must check adjacency — see areMessagesAdjacent().
	const allMessages = [...userMessages, ...assistantMessages].sort((a, b) =>
		(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);

	return {
		assistantMessages,
		userMessages,
		allMessages
	};
}

// ======== VIRTUALIZED MESSAGE LIST ========
// claude.ai renders the conversation through a virtualizer: only a window of
// messages around the viewport exists in the DOM, everything else is a spacer.
// Anything that needs an off-screen message has to drive the scroll container
// until the virtualizer renders it.
//
// The ordering signal used here is the data-message-uuid markers injected by
// phantom-messages.js, NOT the virtualizer's own data-index. Both the target and
// the on-screen anchors are then looked up in the same branch array, so the
// offset introduced by prepended phantom messages cancels out, and none of this
// depends on the virtualizer's attribute names.

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

// Two message elements are "adjacent" if they are actually next to each other on
// screen. Needed because the virtualizer keeps the tail of the conversation
// mounted forever, so the element following the last row of the current window is
// the pinned last message, hundreds of entries away.
function areMessagesAdjacent(a, b) {
	if (!a || !b) return false;
	const scroller = getMessageScroller();
	const limit = scroller ? scroller.clientHeight * 1.5 : 1200;
	const rectA = a.getBoundingClientRect();
	const rectB = b.getBoundingClientRect();
	const gap = rectB.top >= rectA.top ? rectB.top - rectA.bottom : rectA.top - rectB.bottom;
	return gap < limit;
}

// The tagged row we are actually looking at, as its position in `positions`
// (uuid -> branch index). Used to tell which side of the scroll range a target is on.
//
// Nearest-by-distance rather than a distance cutoff, deliberately. The virtualizer
// keeps rows mounted that are nowhere near the viewport (it pins the tail of the
// conversation), so the mounted set can't be trusted wholesale — but any fixed cutoff
// is guessing: measured window rows reach 4.4 viewports away on this conversation
// because single messages are routinely taller than the viewport. Taking the closest
// row needs no threshold, can't discard a legitimate row, and doesn't care *why*
// anything else is mounted.
function getNearestAnchor(positions) {
	const scroller = getMessageScroller();
	if (!scroller) return null;
	const viewportTop = scroller.getBoundingClientRect().top;

	let nearest = null;
	for (const el of document.querySelectorAll('[data-message-uuid]')) {
		const position = positions.get(el.getAttribute('data-message-uuid'));
		if (position === undefined) continue; // not on this branch (e.g. a phantom)
		const distance = Math.abs(el.getBoundingClientRect().top - viewportTop);
		if (!nearest || distance < nearest.distance) nearest = { position, distance };
	}
	return nearest;
}

// User messages carry no marker of their own (injecting into their content would corrupt
// the native edit box), so identify one through the assistant message beside it.
//
// Tries both sides on purpose, regardless of which way the caller intends to travel: at a
// window edge only one neighbour is rendered, and keying off travel direction means the
// arrow pointing at the missing side silently does nothing. `messages` must be the branch
// as rendered — see ClaudeConversation.getRenderedMessages.
function resolveUserMessageUuid(userElement, messages) {
	const { assistantMessages } = getUIMessages();
	const uuidOf = el => {
		let node = el;
		while (node && !node.hasAttribute('data-message-uuid')) node = node.parentElement;
		return node?.getAttribute('data-message-uuid') ?? null;
	};

	// The reply below it: its parent is the message we want.
	const reply = assistantMessages.find(el =>
		userElement.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
	if (reply && areMessagesAdjacent(userElement, reply)) {
		const apiReply = messages.find(msg => msg.uuid === uuidOf(reply));
		if (apiReply?.parent_message_uuid) return apiReply.parent_message_uuid;
	}

	// Otherwise the message above it: we want its human child on this branch.
	const parent = assistantMessages.filter(el =>
		userElement.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING).pop();
	if (parent && areMessagesAdjacent(parent, userElement)) {
		const parentUuid = uuidOf(parent);
		const child = parentUuid && messages.find(msg =>
			msg.parent_message_uuid === parentUuid && msg.sender === 'human');
		if (child) return child.uuid;
	}

	return null;
}

let _revealInFlight = false;

// Callers fire shortly after a reload (bookmark / "Go to Message"), when the
// conversation may not be mounted or tagged yet.
async function _waitForMessageList(timeoutMs = 10000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (getMessageScroller() && document.querySelector('[data-message-uuid]')) return true;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return false;
}

// Scroll a message into view by uuid, rendering it first if the virtualizer has
// it unmounted. Works for human messages too, even though only assistant rows
// carry a uuid, by anchoring on the adjacent assistant message.
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
		const findRendered = () => document.querySelector(`[data-message-uuid="${uuid}"]`);

		// Already on screen — nothing to hunt for.
		const alreadyThere = findRendered();
		if (alreadyThere) return _settleOnMessage(alreadyThere, 0, highlight);

		const conv = conversation ?? new ClaudeConversation(getOrgId(), getConversationId());
		const messages = await conv.getRenderedMessages();
		const positions = new Map(messages.map((msg, i) => [msg.uuid, i]));
		const targetPosition = positions.get(uuid);
		if (targetPosition === undefined) return null;

		// Human messages have no marker of their own, so aim at the assistant
		// reply below them (or, for an unanswered last message, the assistant
		// above) and step back onto the human row once it is rendered.
		let anchorUuid = uuid;
		let step = 0;
		if (messages[targetPosition].sender === 'human') {
			const child = messages[targetPosition + 1];
			if (child && child.sender !== 'human') {
				anchorUuid = child.uuid;
				step = -1;
			} else {
				const parent = messages[targetPosition - 1];
				if (!parent) return null;
				anchorUuid = parent.uuid;
				step = 1;
			}
		}

		const scroller = getMessageScroller();
		if (!scroller) return null;
		const findAnchor = () => document.querySelector(`[data-message-uuid="${anchorUuid}"]`);
		const anchorPosition = positions.get(anchorUuid);

		if (strategy === 'step') {
			// Nearby target: walk toward it. Falls back to bracketing if the guess that it
			// was close turns out to be wrong.
			const arrived = await _stepTowardAnchor(scroller, findAnchor, positions, anchorPosition);
			if (!arrived) await _bracketTowardAnchor(scroller, findAnchor, positions, anchorPosition, maxProbes);
		} else {
			await _bracketTowardAnchor(scroller, findAnchor, positions, anchorPosition, maxProbes);
		}

		const anchorElement = findAnchor();
		if (!anchorElement) return null;
		return _settleOnMessage(anchorElement, step, highlight);
	} catch (error) {
		messageUiLog.error('revealMessageByUuid failed:', error);
		return null;
	} finally {
		_revealInFlight = false;
	}
}

// Tagging can lag a freshly mounted window by a frame or two.
async function _awaitNearestAnchor(positions, attempts = 6) {
	let nearest = getNearestAnchor(positions);
	for (let wait = 0; !nearest && wait < attempts; wait++) {
		await new Promise(resolve => setTimeout(resolve, 100));
		nearest = getNearestAnchor(positions);
	}
	return nearest;
}

async function _awaitAnchorChange(positions, previousPosition, attempts = 14) {
	for (let wait = 0; wait < attempts; wait++) {
		await new Promise(resolve => setTimeout(resolve, 50));
		if (getNearestAnchor(positions)?.position !== previousPosition) return;
	}
}

// 'step' strategy — for a target the caller knows is nearby (the adjacent message).
// Nudge half a viewport at a time in its direction. A couple of small scrolls beats
// bracketing a 400,000px range, and it lands the same way a human would scroll there.
// Returns whether it arrived.
async function _stepTowardAnchor(scroller, findAnchor, positions, targetPosition, maxSteps = 12) {
	for (let step = 0; step < maxSteps; step++) {
		if (findAnchor()) return true;

		const nearest = await _awaitNearestAnchor(positions);
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
async function _bracketTowardAnchor(scroller, findAnchor, positions, targetPosition, maxProbes) {
	let low = 0;
	let high = Math.max(0, scroller.scrollHeight - scroller.clientHeight);

	for (let probe = 0; probe < maxProbes; probe++) {
		if (findAnchor()) return true;

		const nearest = await _awaitNearestAnchor(positions);
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
		await _awaitAnchorChange(positions, nearest.position);
	}
	return !!findAnchor();
}

// Find the message element one `step` away from `anchorElement` in document order
// (-1 for the human message above an assistant row).
function _neighbourOf(anchorElement, step) {
	const { allMessages } = getUIMessages();
	const index = allMessages.findIndex(el => el === anchorElement || anchorElement.contains(el));
	const neighbour = index === -1 ? null : allMessages[index + step];
	return neighbour && areMessagesAdjacent(anchorElement, neighbour) ? neighbour : null;
}

// Centre the message and flash it. `step` walks to a neighbouring message.
async function _settleOnMessage(anchorElement, step, highlight) {
	let target = anchorElement;

	if (step !== 0) {
		// Bring the anchor on screen before looking for the neighbour. The
		// neighbour is the message we actually want, but it can still be unmounted
		// just past the window edge — the virtualizer only mounts rows around the
		// viewport, so the anchor has to be in view before its neighbour exists.
		anchorElement.scrollIntoView({ block: 'center' });
		for (let wait = 0; wait < 10; wait++) {
			await new Promise(resolve => setTimeout(resolve, 50));
			const neighbour = _neighbourOf(anchorElement, step);
			if (neighbour) { target = neighbour; break; }
		}
	}

	// Instant, not smooth: smooth-scrolling across a virtualized list unmounts
	// rows mid-flight and the scroll lands nowhere.
	//
	// Centre short messages, but align tall ones to the top — messages are
	// routinely twice the viewport height, and centring those drops you into the
	// middle of the text instead of at its start.
	const scroller = getMessageScroller();
	const fitsOnScreen = !scroller || target.getBoundingClientRect().height <= scroller.clientHeight;
	target.scrollIntoView({ block: fitsOnScreen ? 'center' : 'start' });

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
