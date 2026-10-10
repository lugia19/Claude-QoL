// full-load.js (MAIN world, document_start, right after bard-host.js)
// Loads every message of a conversation when it opens. claude.ai only loads the latest window (the
// StreamTimeline snapshot carries older_history_cursor) and pages older messages in while scrolling,
// so its own Ctrl+F, QoL's chat-search jumps, bookmarks and nav arrows can't reach unloaded messages.
//
// The page only grows its list from a snapshot (older messages in ordinary updates are ignored), so
// this rewrites each snapshot in place: without the cursor and floor, plus every message, display
// group and content block from ReadConversation. The snapshot waits for that tree (the host passes
// frames on in order, so later updates queue behind it rather than get lost); after the first one
// the tree is cached, so reconnect snapshots go through at once and never shrink the list.
// Rewriting in place rather than injecting a second snapshot matters: an injected snapshot made the
// page forget a version picked with the branch arrows on every reconnect.
// See docs/bard-rework.md, "Loading every message".
//
// Setting: "Load whole conversations" (extension-settings.js), on by default, mirrored to
// localStorage[claude_qol_full_load] ('0' = off) because settings live in the ISOLATED world and load
// after the first snapshot. A change applies on the next page load.
//
// QolFullLoad.require(conversationId) loads a conversation whole even with the setting off, and starts
// fetching its tree right away: jump-view.js calls it at document_start for a jump, whose branch can be
// outside the loaded window.
(function () {
	'use strict';

	const enabled = localStorage.getItem('claude_qol_full_load') !== '0';

	const TREE_TTL_MS = 5 * 60 * 1000;
	const MAX_TREES = 3;

	const log = createLogger('FullLoad');

	const trees = new Map(); // conversationId -> { at, language, promise of the full ConversationUpdate or null }
	const required = new Set(); // conversation ids loaded whole regardless of the setting

	// The whole conversation, from ReadConversation. Shared by concurrent snapshots, reused for a few
	// minutes: a reconnect's snapshot carries anything new itself (see fillSnapshot). A tree fetched in
	// another display language (a prefetch guesses it) is fetched again.
	function fullTree(orgId, conversationId, language) {
		// Drop expired trees, and keep at most a few: each one holds a whole decoded conversation.
		for (const [id, entry] of trees) if (Date.now() - entry.at >= TREE_TTL_MS) trees.delete(id);
		const cached = trees.get(conversationId);
		if (cached?.language === language) return cached.promise;
		trees.delete(conversationId);
		while (trees.size >= MAX_TREES) trees.delete(trees.keys().next().value);
		const net = ClaudeExtNet;
		const startedAt = performance.now();
		const body = net.encodeBard('ReadConversationRequest', { conversation_id: conversationId, display_language: language });
		const promise = QolBardHost.rawFetch(...net.bardRpcRequest('ReadConversation', orgId, body)).then(async (response) => {
			if (!response.ok) throw new Error(`ReadConversation ${response.status}`);
			const bytes = new Uint8Array(await response.arrayBuffer());
			const update = net.decodeBard('ReadConversationResponse', bytes, { keepUnknown: true }).update ?? null;
			log(`full tree for ${conversationId}: ${update?.messages?.length ?? 0} messages, ${bytes.length} bytes, ${Math.round(performance.now() - startedAt)}ms`);
			return update;
		}).catch((e) => {
			log.warn(`no full load for ${conversationId}, the page keeps paging:`, e);
			return null;
		});
		trees.set(conversationId, { at: Date.now(), language, promise });
		return promise;
	}

	// At document_start page.js hasn't loaded and no request has said the display language yet: the org
	// is the cookie getActiveOrgId() reads, the language the page's <html lang>.
	function prefetch(conversationId) {
		const orgId = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/)?.[1];
		if (orgId) fullTree(orgId, conversationId, document.documentElement.lang || 'en-US');
	}

	globalThis.QolFullLoad = {
		require(conversationId) {
			required.add(conversationId);
			prefetch(conversationId);
		},
	};

	// items from the tree, each replaced by the snapshot's own copy when it has one (fresher), plus the
	// snapshot's items the tree doesn't have yet.
	function mergeById(treeItems = [], snapshotItems = []) {
		const fresh = new Map(snapshotItems.map(item => [item.id, item]));
		const merged = treeItems.map(item => fresh.get(item.id) ?? item);
		const known = new Set(treeItems.map(item => item.id));
		for (const item of snapshotItems) if (!known.has(item.id)) merged.push(item);
		return merged;
	}

	// The snapshot, minus what tells the page there's more to page in, with every message.
	function fillSnapshot(snapshot, tree) {
		delete snapshot.older_history_cursor;
		delete snapshot.baseline_floor_message_id;
		snapshot.messages = mergeById(tree.messages, snapshot.messages);
		snapshot.display_groups = mergeById(tree.display_groups, snapshot.display_groups);
		snapshot.content_blocks = mergeById(tree.content_blocks, snapshot.content_blocks);
	}

	// Registered first, so the other onSnapshot patches see the full snapshot.
	QolBardHost.onSnapshot(async function fullLoad(update, ctx) {
		if (!ctx.conversationId || !update.older_history_cursor) return false; // nothing more to load
		if (!enabled && !required.has(ctx.conversationId)) return false;
		// Past the host's wait budget the snapshot goes through as it came (the page pages as usual), and
		// the tree still lands in the cache for the next snapshot. Most reconnects resume without one, so
		// that may be the next load.
		const result = await ctx.within(fullTree(ctx.orgId, ctx.conversationId, ctx.displayLanguage || 'en-US'));
		if (!result) {
			log.warn(`full tree for ${ctx.conversationId} took too long; this snapshot goes through windowed`);
			return false;
		}
		const tree = result.value;
		if (!tree) return false; // the snapshot goes through as it came, and the page keeps paging
		fillSnapshot(update, tree);
		return true;
	}, { label: 'full-load' });
})();
