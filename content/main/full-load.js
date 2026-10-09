// full-load.js (MAIN world, document_start, right after bard-host.js)
// Loads every message of a conversation when it opens. claude.ai only loads the latest window (the
// StreamTimeline snapshot carries older_history_cursor) and pages older messages in while scrolling,
// so its own Ctrl+F, QoL's chat-search jumps, bookmarks and nav arrows can't reach unloaded messages.
//
// The page only grows its list from a snapshot (older messages in ordinary updates are ignored), so
// after each real snapshot this injects a second, synthetic one: the real snapshot without the cursor
// and floor, plus every message, display group and content block from ReadConversation. Reconnects
// bring fresh snapshots that would shrink the list again, so it repeats for each of them. Injected
// snapshots run through the other onSnapshot patches (bard-host.js), so features compose.
// See docs/bard-rework.md, "Loading every message".
//
// Setting: "Load whole conversations" (extension-settings.js), on by default, mirrored to
// localStorage[claude_qol_full_load] ('0' = off) because settings live in the ISOLATED world and load
// after the first snapshot. A change applies on the next page load.
(function () {
	'use strict';

	if (localStorage.getItem('claude_qol_full_load') === '0') return;

	const TREE_TTL_MS = 5 * 60 * 1000;
	const RPC = '/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/ReadConversation';

	// logger.js loads after this file: until it has, log calls go nowhere (and aren't cached).
	const silent = Object.assign(() => { }, { warn() { }, error() { } });
	let loggerInstance = null;
	const logger = () => loggerInstance ?? (typeof createLogger === 'function' ? (loggerInstance = createLogger('FullLoad')) : silent);

	const injected = new WeakSet(); // our synthetic snapshots, which must not trigger another round
	const trees = new Map(); // conversationId -> { at, promise of the full ConversationUpdate or null }

	// The whole conversation, from ReadConversation. Shared by concurrent snapshots, reused for a few
	// minutes: a reconnect's snapshot carries anything new itself (see buildSynthetic).
	function fullTree(ctx) {
		const cached = trees.get(ctx.conversationId);
		if (cached && Date.now() - cached.at < TREE_TTL_MS) return cached.promise;
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

	// The real snapshot, minus what tells the page there's more to page in, with every message.
	function buildSynthetic(snapshot, tree) {
		const synthetic = structuredClone(snapshot);
		delete synthetic.older_history_cursor;
		delete synthetic.baseline_floor_message_id;
		synthetic.messages = mergeById(tree.messages, snapshot.messages);
		synthetic.display_groups = mergeById(tree.display_groups, snapshot.display_groups);
		synthetic.content_blocks = mergeById(tree.content_blocks, snapshot.content_blocks);
		return synthetic;
	}

	QolBardHost.onSnapshot(function fullLoad(update, ctx) {
		if (injected.has(update) || !ctx.conversationId || !ctx.inject) return false;
		if (!update.older_history_cursor) return false; // the whole conversation is already in it
		// Registered first, so this is the snapshot before any other patch changed it; the synthetic
		// snapshot goes through those patches itself when injected.
		const snapshot = structuredClone(update);
		fullTree(ctx).then(async (tree) => {
			if (!tree) return;
			const synthetic = buildSynthetic(snapshot, tree);
			injected.add(synthetic);
			if (!await ctx.inject({ update: synthetic })) logger()('connection closed before the full load landed; the next snapshot retries');
		}).catch((e) => logger().error('full load failed:', e));
		return false; // the real snapshot goes through as it came; the full one follows it
	}, { label: 'full-load' });
})();
