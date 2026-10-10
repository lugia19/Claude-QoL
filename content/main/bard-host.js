// bard-host.js (MAIN world, document_start)
// The one interceptor for claude.ai's merged-experience API (Connect-RPC,
// anthropic.bard.api.v1alpha.ConversationService). Features never wrap these RPCs themselves: they
// register patches here, and the host wraps each call once, decodes each relevant frame or body once
// (keeping unknown fields), runs every patch on the same object in registration order, and encodes
// once, and only if a patch changed something. See docs/bard-rework.md, "Interceptor host".
//
//   QolBardHost.onSnapshot(fn)     every StreamTimeline update with replace_all_state: the first one,
//                                  and reconnects (which can bring a fresh snapshot)
//   QolBardHost.onLiveUpdate(fn)   other StreamTimeline updates carrying messages, display groups or
//                                  content blocks
//   QolBardHost.onHistoryPage(fn)  ReadConversationHistoryResponse.update (scrolling up)
//   QolBardHost.onSend(fn)         PerformAction's send_message, before it leaves
//   QolBardHost.guardSend(fn)      fn(ctx) before every send_message and warm_turn (ctx.action says
//                                  which); a string return refuses it: the host answers the page with
//                                  a Connect error and nothing is sent. The one thing here that fails
//                                  closed, so keep guards to refusing (jump-view.js).
//   QolBardHost.observe(fn)        read-only: every StreamTimeline event the server sends (no heartbeats)
//
// A patch is fn(target, ctx), may be async, edits target in place and returns true when it changed
// it. ctx = { source: 'stream' | 'history' | 'action', orgId, conversationId } (streams also carry
// displayLanguage, the page's display_language). Snapshot patches also get ctx.within(promise), for
// anything they must wait for: it resolves to { value } or, once the snapshot's shared wait budget
// (SNAPSHOT_WAIT_MS, across all its patches) is spent, to null; the snapshot and every frame behind it
// are held meanwhile. Registration takes an optional { label } for logs. Everything fails open: a throwing patch is logged and skipped, an undecodable
// frame or body goes through as it came.
//
// QoL's own calls (MAIN world) that must see the server's data go through QolBardHost.rawFetch, the
// fetch this file wrapped. ReadConversation is never patched.
//
// Loads right after net.js and bard-schema.js, at the front of the MAIN group: Firefox doesn't
// guarantee MAIN-world scripts run before the page's, so the wrapper must be in place early. Only the
// logger loads before it; page.js is looked up when used.
//
// Also records whether the active account is on the merged experience, for qolAccountMode()
// (toolbox-ui.js).
(function () {
	'use strict';

	// Load-order diagnostics, on the performance clock: when the wrapper went in, and when it first
	// saw each RPC method. A first StreamTimeline long after load (a reconnect) means the page's first
	// call went out before the host was in place (Firefox doesn't guarantee MAIN scripts run first).
	const diagnostics = { loadedAt: performance.now(), firstSeen: {} };
	const SERVICE_PATH = '/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/';
	const KILL_SWITCH = 'claude_qol_bard_host_off';
	const MODE_KEY = 'claude_qol_account_mode'; // read by qolAccountMode() (toolbox-ui.js) too
	const SNAPSHOT_WAIT_MS = 15000; // see ctx.within; the largest full-load trees measured took 0.7-2.4 s
	const MODE_TTL_MS = 60 * 60 * 1000; // re-probe hourly: the rollout moves accounts over without warning

	const net = () => globalThis.ClaudeExtNet;
	const log = createLogger('BardHost');

	const patches = { snapshot: [], liveUpdate: [], historyPage: [], send: [], sendGuard: [] };
	const observers = [];

	function register(list, fn, { label } = {}) {
		if (typeof fn !== 'function') throw new TypeError('QolBardHost: a patch must be a function');
		list.push({ fn, label: label || fn.name || 'anonymous patch' });
	}

	// Runs the patches in order; true if any reported a change.
	async function runPatches(list, target, ctx) {
		let changed = false;
		for (const { fn, label } of list) {
			try {
				if (await fn(target, ctx) === true) changed = true;
			} catch (e) {
				log.error(`${label} threw (${ctx.source}, ${ctx.conversationId ?? 'no conversation'}):`, e);
			}
		}
		return changed;
	}

	function notify(event, ctx) {
		for (const { fn, label } of observers) {
			try {
				fn(event, ctx);
			} catch (e) {
				log.error(`${label} threw:`, e);
			}
		}
	}

	// ======== request helpers ========

	function orgOf(input, init) {
		const headers = init?.headers ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined);
		return new Headers(headers || {}).get('x-organization-uuid');
	}

	// A request body we can read without consuming it (connect-web sends Uint8Array bodies), or null.
	function bodyBytes(init) {
		const body = init?.body;
		if (body instanceof Uint8Array) return body;
		if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
		if (body instanceof ArrayBuffer) return new Uint8Array(body);
		return null;
	}

	// Gunzipped. Only byte bodies: reading a stream body would consume it.
	const plainBody = (init) => bodyBytes(init) ? net().readProtoRequestBody(init) : null;

	// ctx.within for one snapshot: every patch's waits share one deadline.
	function waitBudget(ms) {
		const deadline = performance.now() + ms;
		return async (promise) => {
			let timer;
			const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - performance.now())); });
			try {
				return await Promise.race([Promise.resolve(promise).then(value => ({ value })), timeout]);
			} finally {
				clearTimeout(timer);
			}
		};
	}

	const hasContent = (update) => !!(update.messages?.length || update.display_groups?.length || update.content_blocks?.length);

	// ======== StreamTimeline ========

	async function wrapTimeline(thisArg, input, init) {
		const n = net();
		const ctx = { source: 'stream', orgId: orgOf(input, init), conversationId: null, displayLanguage: null };
		try {
			const frame = n.splitConnectFrames(bodyBytes(init) ?? new Uint8Array(0))[0];
			if (frame) {
				const payload = frame.flags & 1 ? await n.gunzipBytes(frame.payload) : frame.payload;
				const request = n.decodeBard('StreamTimelineRequest', payload);
				ctx.conversationId = request.conversation_id ?? null;
				ctx.displayLanguage = request.display_language || null;
			}
		} catch (e) {
			log.warn('could not read the StreamTimeline request:', e);
		}

		const response = await rawFetch.call(thisArg, input, init);
		if (!response.ok || !response.body) return response;

		const { response: rewritten } = n.rewriteConnectResponse(response, async (frame) => {
			if (frame.endStream) return undefined;
			let decoded;
			try {
				decoded = n.decodeBard('StreamTimelineResponse', frame.payload, { keepUnknown: true });
			} catch (e) {
				log.warn('undecodable StreamTimeline frame, passed through:', e);
				return undefined;
			}
			const event = decoded.event;
			if (!event || event.heartbeat) return undefined;
			notify(event, ctx);
			const update = event.update;
			if (!update) return undefined;
			const list = update.replace_all_state ? patches.snapshot : hasContent(update) ? patches.liveUpdate : null;
			if (!list?.length) return undefined;
			const patchCtx = update.replace_all_state ? { ...ctx, within: waitBudget(SNAPSHOT_WAIT_MS) } : ctx;
			return await runPatches(list, update, patchCtx) ? n.encodeBard('StreamTimelineResponse', decoded) : undefined;
		}, { onError: (e) => log.error('StreamTimeline rewrite error:', e) });
		log(`wrapped StreamTimeline for ${ctx.conversationId ?? 'unknown conversation'}`);
		return rewritten;
	}

	// ======== ReadConversationHistory ========

	async function wrapHistory(thisArg, input, init) {
		const n = net();
		const ctx = { source: 'history', orgId: orgOf(input, init), conversationId: null };
		try {
			const body = await plainBody(init);
			if (body) ctx.conversationId = n.decodeBard('ReadConversationHistoryRequest', body).conversation_id ?? null;
		} catch (e) {
			log.warn('could not read the ReadConversationHistory request:', e);
		}

		const response = await rawFetch.call(thisArg, input, init);
		if (!response.ok) return response;
		try {
			const decoded = n.decodeBard('ReadConversationHistoryResponse', new Uint8Array(await response.clone().arrayBuffer()), { keepUnknown: true });
			if (decoded.update && await runPatches(patches.historyPage, decoded.update, ctx)) {
				return n.protoResponse(response, n.encodeBard('ReadConversationHistoryResponse', decoded));
			}
		} catch (e) {
			log.warn('ReadConversationHistory left unpatched:', e);
		}
		return response;
	}

	// ======== PerformAction ========

	async function wrapAction(thisArg, input, init) {
		const n = net();
		let request = null;
		try {
			const body = await plainBody(init);
			if (body) request = n.decodeBard('PerformActionRequest', body, { keepUnknown: true });
		} catch (e) {
			log.warn('could not read the PerformAction request, sent as is:', e);
		}
		const ctx = { source: 'action', orgId: orgOf(input, init), conversationId: request?.header?.conversation_id ?? null };
		const action = request?.send_message ? 'send_message' : request?.warm_turn ? 'warm_turn' : null;
		if (action) {
			for (const { fn, label } of patches.sendGuard) {
				let reason = null;
				try {
					reason = fn({ ...ctx, action });
				} catch (e) {
					log.error(`${label} threw (${action}, ${ctx.conversationId ?? 'no conversation'}):`, e);
				}
				if (typeof reason !== 'string') continue;
				log(`${label} refused a ${action} in ${ctx.conversationId}: ${reason}`);
				return new Response(JSON.stringify({ code: 'failed_precondition', message: reason }), {
					status: 400, headers: { 'content-type': 'application/json' },
				});
			}
		}
		let finalInit = init;
		if (request?.send_message) {
			if (await runPatches(patches.send, request.send_message, ctx)) {
				try {
					finalInit = n.withProtoRequestBody(init, n.encodeBard('PerformActionRequest', request));
				} catch (e) {
					log.error('could not re-encode the patched send, sent as is:', e);
				}
			}
		}
		return rawFetch.call(thisArg, input, finalInit);
	}

	// ======== the fetch wrapper ========

	const rawFetch = window.fetch;
	const needs = {
		StreamTimeline: () => patches.snapshot.length || patches.liveUpdate.length || observers.length,
		ReadConversationHistory: () => patches.historyPage.length,
		PerformAction: () => patches.send.length || patches.sendGuard.length,
	};
	const wrappers = { StreamTimeline: wrapTimeline, ReadConversationHistory: wrapHistory, PerformAction: wrapAction };

	window.fetch = function (input, init) {
		let method = null;
		try {
			const path = new URL(net().getFetchUrl(input)).pathname;
			if (path.startsWith(SERVICE_PATH)) method = path.slice(SERVICE_PATH.length);
		} catch (e) { /* not a URL we handle */ }
		if (!method) return rawFetch.apply(this, arguments);
		diagnostics.firstSeen[method] ??= performance.now();
		const pending = wrappers[method] && needs[method]() && !net().isKillSwitchOn(KILL_SWITCH)
			? wrappers[method](this, input, init)
			: rawFetch.apply(this, arguments);
		const orgId = orgOf(input, init);
		pending.then(response => noteMode(orgId, response), () => { });
		return pending;
	};

	// ======== account mode ========

	function readModes() {
		try {
			return JSON.parse(localStorage.getItem(MODE_KEY)) || {};
		} catch (e) {
			return {};
		}
	}

	function setMode(orgId, mode) {
		if (!orgId) return;
		const all = readModes();
		if (all[orgId]?.mode === mode && Date.now() - all[orgId].at < MODE_TTL_MS / 2) return;
		all[orgId] = { mode, at: Date.now() };
		try {
			localStorage.setItem(MODE_KEY, JSON.stringify(all));
		} catch (e) { /* storage unavailable: the probe runs again next load */ }
	}

	// Any successful RPC means the account is on the merged experience. Failures prove nothing on
	// their own (a 403 can be about one conversation): only the probe below decides "legacy". Noted in
	// memory too, so most RPCs don't touch localStorage.
	const notedAt = new Map(); // orgId -> when this page last recorded 'merged'
	function noteMode(orgId, response) {
		if (!response?.ok || !orgId || Date.now() - (notedAt.get(orgId) ?? 0) < MODE_TTL_MS / 2) return;
		notedAt.set(orgId, Date.now());
		setMode(orgId, 'merged');
	}

	// Once per org and hour: legacy accounts get 403 permission_denied ("not included in your current
	// plan") from every RPC. Sent from the page, so the RPC Origin check passes.
	async function probeMode() {
		const orgId = typeof getActiveOrgId === 'function' ? getActiveOrgId() : null;
		if (!orgId) return;
		const known = readModes()[orgId];
		if (known && Date.now() - known.at < MODE_TTL_MS) return;
		try {
			const response = await rawFetch(...ClaudeExtNet.bardRpcRequest('GetNewConversationDefaults', orgId, '{}'));
			if (response.ok) {
				setMode(orgId, 'merged');
			} else if (response.status === 403 && (await response.json().catch(() => null))?.code === 'permission_denied') {
				setMode(orgId, 'legacy');
				log('this account is not on the merged experience');
			}
		} catch (e) {
			log.warn('account mode probe failed:', e);
		}
	}
	setTimeout(probeMode, 2000); // after page.js has loaded and the page's own first requests

	globalThis.QolBardHost = {
		onSnapshot: (fn, opts) => register(patches.snapshot, fn, opts),
		onLiveUpdate: (fn, opts) => register(patches.liveUpdate, fn, opts),
		onHistoryPage: (fn, opts) => register(patches.historyPage, fn, opts),
		onSend: (fn, opts) => register(patches.send, fn, opts),
		guardSend: (fn, opts) => register(patches.sendGuard, fn, opts),
		observe: (fn, opts) => register(observers, fn, opts),
		rawFetch: (...args) => rawFetch.apply(window, args),
		diagnostics,
	};
})();
