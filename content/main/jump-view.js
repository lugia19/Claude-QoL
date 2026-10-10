// jump-view.js (MAIN world, document_start, right after branch-arrows.js)
// A jump (bookmarks, chat search, Go to latest / longest: jumpToMessage in message-ui.js) shows another
// branch for one page load, like claude.ai's own version arrows: the server's leaf never moves. The
// jump leaves { conversationId, leafId } in sessionStorage and reloads; this reads and deletes it at
// once (so a later reload is back to latest) and rewrites conversation.current_leaf_message_id in that
// conversation's snapshots, which makes the page load on that branch. Upgraded chats can't move
// their leaf at all, so this is the only way to show another branch there.
//
// A send from the jumped view would go to the server's real leaf (the page sends no parent), so while
// jumped every send_message and warm_turn for the conversation is refused (QolBardHost.guardSend). The
// banner, the input blocking and "Continue from here" / "Fork from here" are navigation.js's; it
// watches <html data-qol-jump-view="<conversation id>">, set here while the view lasts, and acts only
// while that conversation is open.
//
// The view lasts for the page's life: leaving the chat and coming back restores the page's cached
// state (still the jumped branch) without a new snapshot. It ends on a live update with a message we
// haven't seen (a send from elsewhere: the page follows it to its branch).
// See docs/bard-rework.md, "Branches and navigation".
(function () {
	'use strict';

	const JUMP_KEY = 'claude_qol_jump_view';
	const ATTRIBUTE = 'data-qol-jump-view';
	const LEAF_ATTRIBUTE = 'data-qol-jump-leaf'; // for getRenderedMessages (claude-api.js)
	const log = createLogger('JumpView');

	let jump = null; // { conversationId, leafId }
	try {
		jump = JSON.parse(sessionStorage.getItem(JUMP_KEY));
		sessionStorage.removeItem(JUMP_KEY);
	} catch (e) { /* storage unavailable or not JSON: no jump */ }
	if (!jump?.conversationId || !jump?.leafId) jump = null;

	const seen = new Set(); // message ids of the jumped conversation

	function end(why) {
		if (!jump) return;
		log(`jump view of ${jump.conversationId} ended: ${why}`);
		jump = null;
		seen.clear();
		document.documentElement.removeAttribute(ATTRIBUTE);
		document.documentElement.removeAttribute(LEAF_ATTRIBUTE);
	}

	const isJumped = (ctx) => !!jump && ctx.conversationId === jump.conversationId;

	QolBardHost.onSnapshot(function jumpView(update, ctx) {
		if (!isJumped(ctx)) return false;
		const messages = update.messages ?? [];
		if (!update.conversation || !messages.some(m => m.id === jump.leafId)) {
			end('the jumped leaf is not in the snapshot');
			return false;
		}
		for (const m of messages) seen.add(m.id);
		update.conversation.current_leaf_message_id = jump.leafId;
		document.documentElement.setAttribute(ATTRIBUTE, jump.conversationId);
		document.documentElement.setAttribute(LEAF_ATTRIBUTE, jump.leafId);
		return true;
	}, { label: 'jump-view' });

	QolBardHost.onHistoryPage(function jumpViewHistory(update, ctx) {
		if (isJumped(ctx)) for (const m of update.messages ?? []) seen.add(m.id);
		return false;
	}, { label: 'jump-view' });

	QolBardHost.onLiveUpdate(function jumpViewLive(update, ctx) {
		if (isJumped(ctx) && (update.messages ?? []).some(m => !seen.has(m.id))) end('a new message arrived');
		return false;
	}, { label: 'jump-view' });

	QolBardHost.guardSend(ctx => (isJumped(ctx) ? 'QoL: sending is paused while viewing an earlier version.' : null), { label: 'jump-view' });

	// full-load.js loads whole conversations for jumped snapshots even when its setting is off: the
	// jumped branch can be outside the window the page loads.
	globalThis.QolJumpView = { isJumped: conversationId => !!jump && conversationId === jump.conversationId };
})();
