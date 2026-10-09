// db-serve.js (ISOLATED world, document_start)
// Answers MAIN's database calls (claude-api.js's _dbCall) from the very start of the page load.
// databases.js runs at document_idle, and a bridge call that arrives before anyone serves is lost:
// MAIN would wait out _dbCall's 5 s timeout, and phantom-messages.js holds the first StreamTimeline
// snapshot for that answer. So this serves right away and each handler waits for databases.js, which
// hands over its API through resolveQolDb().
//
// Page scripts share MAIN and can call these too: serve only what MAIN needs.
'use strict';

let resolveQolDb;
const qolDbReady = new Promise(resolve => { resolveQolDb = resolve; });

ClaudeExtBridge.serve('qol', {
	handlers: {
		CONV_CACHE_GET: async ({ uuid }) => (await qolDbReady).conversationCache.get(uuid),
		CONV_CACHE_PUT: async ({ uuid, updatedAt, data }) => { await (await qolDbReady).conversationCache.put(uuid, updatedAt, data); },
		PHANTOM_GET: async ({ conversationId }) => (await qolDbReady).getPhantomMessages(conversationId),
		PHANTOM_STORE: async ({ conversationId, messages }) => { await (await qolDbReady).storePhantomMessages(conversationId, messages); },
		PHANTOM_CLEAR: async ({ conversationId }) => { await (await qolDbReady).clearPhantomMessages(conversationId); },
	}
});
