// jump-view.js (MAIN world, document_start, right after branch-arrows.js)
// A jump (bookmarks, chat search, Go to latest / longest: jumpToMessage in message-ui.js) shows another
// branch for one page load, like claude.ai's own version arrows: the server's leaf never moves. The
// jump leaves { conversationId, leafId } in sessionStorage and reloads; this reads and deletes it at
// once (so a later reload is back to latest) and rewrites conversation.current_leaf_message_id in that
// conversation's snapshots, which makes the page load on that branch. Upgraded chats can't move
// their leaf at all, so this is the only way to show another branch there. The jumped conversation is
// loaded whole (QolFullLoad.require, which also starts fetching its tree now): the jumped branch can be
// outside the window the page loads.
//
// A send from the jumped view would go to the server's real leaf (the page sends no parent), so while
// jumped every send_message and warm_turn for the conversation is refused (QolBardHost.guardSend). The
// banner, the input blocking and "Continue from here" / "Fork from here" are navigation.js's.
//
// The state is on <html>, for both worlds (read it with qolJumpedLeaf / qolJumpSettled, claude-api.js):
//   data-qol-jump-state  'pending' from document_start, then 'applied' once a snapshot carried the
//                        jumped leaf, or 'ended' (the jump was dropped, or ended later)
//   data-qol-jump-view   the jumped conversation's id, and data-qol-jump-leaf its leaf, while applied
//
// The view lasts for the page's life: leaving the chat and coming back restores the page's cached
// state (still the jumped branch) without a new snapshot. It ends on a live update with a message we
// haven't seen (a send from elsewhere: the page follows it to its branch).
// See docs/bard-rework.md, "Branches and navigation".
(function () {
	'use strict';

	const JUMP_KEY = 'claude_qol_jump_view';
	const root = document.documentElement;
	const log = createLogger('JumpView');

	let jump = null; // { conversationId, leafId }
	try {
		jump = JSON.parse(sessionStorage.getItem(JUMP_KEY));
		sessionStorage.removeItem(JUMP_KEY);
	} catch (e) { /* storage unavailable or not JSON: no jump */ }
	if (!jump?.conversationId || !jump?.leafId) jump = null;
	if (jump) {
		root.setAttribute('data-qol-jump-state', 'pending');
		QolFullLoad.require(jump.conversationId);
	}

	const seen = new Set(); // message ids of the jumped conversation

	function end(why) {
		if (!jump) return;
		log(`jump view of ${jump.conversationId} ended: ${why}`);
		QolFullLoad.release(jump.conversationId);
		jump = null;
		seen.clear();
		root.removeAttribute('data-qol-jump-view');
		root.removeAttribute('data-qol-jump-leaf');
		root.setAttribute('data-qol-jump-state', 'ended');
	}

	const isJumped = (conversationId) => !!jump && conversationId === jump.conversationId;

	QolBardHost.onSnapshot(function jumpView(update, ctx) {
		if (!isJumped(ctx.conversationId)) return false;
		const messages = update.messages ?? [];
		if (!update.conversation || !messages.some(m => m.id === jump.leafId)) {
			end('the jumped leaf is not in the snapshot');
			return false;
		}
		for (const m of messages) seen.add(m.id);
		update.conversation.current_leaf_message_id = jump.leafId;
		root.setAttribute('data-qol-jump-view', jump.conversationId);
		root.setAttribute('data-qol-jump-leaf', jump.leafId);
		root.setAttribute('data-qol-jump-state', 'applied');
		return true;
	}, { label: 'jump-view' });

	QolBardHost.onHistoryPage(function jumpViewHistory(update, ctx) {
		if (isJumped(ctx.conversationId)) for (const m of update.messages ?? []) seen.add(m.id);
		return false;
	}, { label: 'jump-view' });

	QolBardHost.onLiveUpdate(function jumpViewLive(update, ctx) {
		if (isJumped(ctx.conversationId) && (update.messages ?? []).some(m => !seen.has(m.id))) end('a new message arrived');
		return false;
	}, { label: 'jump-view' });

	QolBardHost.guardSend(ctx => (isJumped(ctx.conversationId) ? 'QoL: sending is paused while viewing an earlier version.' : null), { label: 'jump-view' });
})();
