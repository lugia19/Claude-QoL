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
(function () {
	'use strict';

	if (localStorage.getItem('claude_qol_full_load') === '0') return;

	const TREE_TTL_MS = 5 * 60 * 1000;
	const MAX_TREES = 3;
	const RPC = '/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/ReadConversation';

	// logger.js loads after this file: until it has, log calls go nowhere (and aren't cached).
	const silent = Object.assign(() => { }, { warn() { }, error() { } });
	let loggerInstance = null;
	const logger = () => loggerInstance ?? (typeof createLogger === 'function' ? (loggerInstance = createLogger('FullLoad')) : silent);

	const trees = new Map(); // conversationId -> { at, promise of the full ConversationUpdate or null }

	// The whole conversation, from ReadConversation. Shared by concurrent snapshots, reused for a few
	// minutes: a reconnect's snapshot carries anything new itself (see fillSnapshot).
	function fullTree(ctx) {
		// Drop expired trees, and keep at most a few: each one holds a whole decoded conversation.
		for (const [id, entry] of trees) if (Date.now() - entry.at >= TREE_TTL_MS) trees.delete(id);
		const cached = trees.get(ctx.conversationId);
		if (cached) return cached.promise;
		while (trees.size >= MAX_TREES) trees.delete(trees.keys().next().value);
		const net = ClaudeExtNet;
		const startedAt = performance.now();
		const promise = QolBardHost.rawFetch(RPC, {
			method: 'POST',
			headers: {
				'content-type': 'application/proto',
				'connect-protocol-version': '1',
				'x-organization-uuid': ctx.orgId,
				'anthropic-client-platform': 'web_claude_ai',
			},
			body: net.encodeBard('ReadConversationRequest', { conversation_id: ctx.conversationId, display_language: ctx.displayLanguage || 'en-US' }),
		}).then(async (response) => {
			if (!response.ok) throw new Error(`ReadConversation ${response.status}`);
			const bytes = new Uint8Array(await response.arrayBuffer());
			const update = net.decodeBard('ReadConversationResponse', bytes, { keepUnknown: true }).update ?? null;
			logger()(`full tree for ${ctx.conversationId}: ${update?.messages?.length ?? 0} messages, ${bytes.length} bytes, ${Math.round(performance.now() - startedAt)}ms`);
			return update;
		}).catch((e) => {
			logger().warn(`no full load for ${ctx.conversationId}, the page keeps paging:`, e);
			return null;
		});
		trees.set(ctx.conversationId, { at: Date.now(), promise });
		return promise;
	}

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
		const tree = await fullTree(ctx);
		if (!tree) return false; // the snapshot goes through as it came, and the page keeps paging
		fillSnapshot(update, tree);
		return true;
	}, { label: 'full-load' });
})();
