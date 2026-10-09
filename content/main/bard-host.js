// bard-host.js (MAIN world, document_start)
// The one interceptor for claude.ai's merged-experience API (Connect-RPC,
// anthropic.bard.api.v1alpha.ConversationService). Features never wrap these RPCs themselves: they
// register patches here, and the host wraps each call once, decodes each relevant frame or body once
// (keeping unknown fields), runs every patch on the same object in registration order, and encodes
// once, and only if a patch changed something. See docs/bard-rework.md, "Interceptor host".
//
//   QolBardHost.onSnapshot(fn)     every StreamTimeline update with replace_all_state: the first one,
//                                  reconnects (which can bring a fresh snapshot), and ones injected
//                                  through ctx.inject
//   QolBardHost.onLiveUpdate(fn)   other StreamTimeline updates carrying messages, display groups or
//                                  content blocks
//   QolBardHost.onHistoryPage(fn)  ReadConversationHistoryResponse.update (scrolling up)
//   QolBardHost.onSend(fn)         PerformAction's send_message, before it leaves
//   QolBardHost.observe(fn)        read-only: every StreamTimeline event the server sends (no heartbeats)
//
// A patch is fn(target, ctx), may be async, edits target in place and returns true when it changed
// it. ctx = { source: 'stream' | 'history' | 'action', orgId, conversationId, inject }. On streams,
// ctx.inject(event) adds a StreamEvent of our own (snapshots run through the onSnapshot patches
// first) and resolves false once the stream has ended. Registration takes an optional
// { label } for logs. Everything fails open: a throwing patch is logged and skipped, an undecodable
// frame or body goes through as it came.
//
// QoL's own calls (MAIN world) that must see the server's data go through QolBardHost.rawFetch, the
// fetch this file wrapped. ReadConversation is never patched.
//
// Loads right after net.js and bard-schema.js, at the front of the MAIN group: Firefox doesn't
// guarantee MAIN-world scripts run before the page's, so the wrapper must be in place early. Anything
// else it needs (the logger, page.js) is looked up when used.
//
// Also records whether the active account is on the merged experience: see accountMode().
(function () {
	'use strict';

	// Load-order diagnostics, on the performance clock: when the wrapper went in, and when it first
	// saw each RPC method. A first StreamTimeline long after load (a reconnect) means the page's first
	// call went out before the host was in place (Firefox doesn't guarantee MAIN scripts run first).
	const diagnostics = { loadedAt: performance.now(), firstSeen: {} };
	const SERVICE_PATH = '/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/';
	const KILL_SWITCH = 'claude_qol_bard_host_off';
	const MODE_KEY = 'claude_qol_account_mode'; // read by qolAccountMode() (toolbox-ui.js) too
	const MODE_TTL_MS = 60 * 60 * 1000; // re-probe hourly: the rollout moves accounts over without warning

	const net = () => globalThis.ClaudeExtNet;
	// logger.js loads after this file: until it has, log calls go nowhere (and aren't cached).
	const silent = Object.assign(() => { }, { warn() { }, error() { } });
	let loggerInstance = null;
	const logger = () => loggerInstance ?? (typeof createLogger === 'function' ? (loggerInstance = createLogger('BardHost')) : silent);

	const patches = { snapshot: [], liveUpdate: [], historyPage: [], send: [] };
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
				logger().error(`${label} threw (${ctx.source}, ${ctx.conversationId ?? 'no conversation'}):`, e);
			}
		}
		return changed;
	}

	function notify(event, ctx) {
		for (const { fn, label } of observers) {
			try {
				fn(event, ctx);
			} catch (e) {
				logger().error(`${label} threw:`, e);
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

	async function plainBody(init) {
		const bytes = bodyBytes(init);
		if (!bytes) return null;
		const n = net();
		return n.isGzipRequest(init) || n.isGzipBytes(bytes) ? n.gunzipBytes(bytes) : bytes;
	}

	const hasContent = (update) => !!(update.messages?.length || update.display_groups?.length || update.content_blocks?.length);

	// ======== StreamTimeline ========

	async function wrapTimeline(thisArg, input, init) {
		const n = net();
		const ctx = { source: 'stream', orgId: orgOf(input, init), conversationId: null, inject: null };
		try {
			const frame = n.splitConnectFrames(bodyBytes(init) ?? new Uint8Array(0))[0];
			if (frame) {
				const payload = frame.flags & 1 ? await n.gunzipBytes(frame.payload) : frame.payload;
				ctx.conversationId = n.decodeBard('StreamTimelineRequest', payload).conversation_id ?? null;
			}
		} catch (e) {
			logger().warn('could not read the StreamTimeline request:', e);
		}

		const response = await rawFetch.call(thisArg, input, init);
		noteMode(ctx.orgId, response);
		if (!response.ok || !response.body) return response;

		let ended = false; // the server closed this connection (it reconnects on a cadence)
		const { response: rewritten, inject } = n.rewriteConnectResponse(response, async (frame) => {
			if (frame.endStream) {
				ended = true;
				return undefined;
			}
			let decoded;
			try {
				decoded = n.decodeBard('StreamTimelineResponse', frame.payload, { keepUnknown: true });
			} catch (e) {
				logger().warn('undecodable StreamTimeline frame, passed through:', e);
				return undefined;
			}
			const event = decoded.event;
			if (!event || event.heartbeat) return undefined;
			notify(event, ctx);
			const update = event.update;
			if (!update) return undefined;
			const list = update.replace_all_state ? patches.snapshot : hasContent(update) ? patches.liveUpdate : null;
			if (!list?.length) return undefined;
			return await runPatches(list, update, ctx) ? n.encodeBard('StreamTimelineResponse', decoded) : undefined;
		}, { onError: (e) => logger().error('StreamTimeline rewrite error:', e) });

		// Only for this connection: once it has ended, inject the next connection's way (its ctx).
		ctx.inject = async (event) => {
			if (ended) return false;
			if (event?.update?.replace_all_state) await runPatches(patches.snapshot, event.update, ctx);
			return inject(net().encodeBard('StreamTimelineResponse', { event }));
		};
		logger()(`wrapped StreamTimeline for ${ctx.conversationId ?? 'unknown conversation'}`);
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
			logger().warn('could not read the ReadConversationHistory request:', e);
		}

		const response = await rawFetch.call(thisArg, input, init);
		noteMode(ctx.orgId, response);
		if (!response.ok) return response;
		try {
			const decoded = n.decodeBard('ReadConversationHistoryResponse', new Uint8Array(await response.clone().arrayBuffer()), { keepUnknown: true });
			if (decoded.update && await runPatches(patches.historyPage, decoded.update, ctx)) {
				return n.protoResponse(response, n.encodeBard('ReadConversationHistoryResponse', decoded));
			}
		} catch (e) {
			logger().warn('ReadConversationHistory left unpatched:', e);
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
			logger().warn('could not read the PerformAction request, sent as is:', e);
		}
		let finalInit = init;
		if (request?.send_message) {
			const ctx = { source: 'action', orgId: orgOf(input, init), conversationId: request.header?.conversation_id ?? null };
			if (await runPatches(patches.send, request.send_message, ctx)) {
				try {
					finalInit = n.withProtoRequestBody(init, n.encodeBard('PerformActionRequest', request));
				} catch (e) {
					logger().error('could not re-encode the patched send, sent as is:', e);
				}
			}
		}
		const response = await rawFetch.call(thisArg, input, finalInit);
		noteMode(orgOf(input, init), response);
		return response;
	}

	// ======== the fetch wrapper ========

	const rawFetch = window.fetch;
	const needs = {
		StreamTimeline: () => patches.snapshot.length || patches.liveUpdate.length || observers.length,
		ReadConversationHistory: () => patches.historyPage.length,
		PerformAction: () => patches.send.length,
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
		if (wrappers[method] && needs[method]() && !net().isKillSwitchOn(KILL_SWITCH)) {
			return wrappers[method](this, input, init);
		}
		const pending = rawFetch.apply(this, arguments);
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
	// their own (a 403 can be about one conversation): only the probe below decides "legacy".
	function noteMode(orgId, response) {
		if (response?.ok) setMode(orgId, 'merged');
	}

	// Once per org and hour: legacy accounts get 403 permission_denied ("not included in your current
	// plan") from every RPC. Sent from the page, so the RPC Origin check passes.
	async function probeMode() {
		const orgId = typeof getActiveOrgId === 'function' ? getActiveOrgId() : null;
		if (!orgId) return;
		const known = readModes()[orgId];
		if (known && Date.now() - known.at < MODE_TTL_MS) return;
		try {
			const response = await rawFetch(`${SERVICE_PATH}GetNewConversationDefaults`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'connect-protocol-version': '1', 'x-organization-uuid': orgId },
				body: '{}',
			});
			if (response.ok) {
				setMode(orgId, 'merged');
			} else if (response.status === 403 && (await response.json().catch(() => null))?.code === 'permission_denied') {
				setMode(orgId, 'legacy');
				logger()('this account is not on the merged experience');
			}
		} catch (e) {
			logger().warn('account mode probe failed:', e);
		}
	}
	setTimeout(probeMode, 2000); // after page.js has loaded and the page's own first requests

	globalThis.QolBardHost = {
		onSnapshot: (fn, opts) => register(patches.snapshot, fn, opts),
		onLiveUpdate: (fn, opts) => register(patches.liveUpdate, fn, opts),
		onHistoryPage: (fn, opts) => register(patches.historyPage, fn, opts),
		onSend: (fn, opts) => register(patches.send, fn, opts),
		observe: (fn, opts) => register(observers, fn, opts),
		rawFetch: (...args) => rawFetch.apply(window, args),
		diagnostics,
		// 'merged' | 'legacy' | 'unknown' for orgId (default: the active org).
		accountMode(orgId = typeof getActiveOrgId === 'function' ? getActiveOrgId() : null) {
			return readModes()[orgId]?.mode ?? 'unknown';
		},
	};
})();
