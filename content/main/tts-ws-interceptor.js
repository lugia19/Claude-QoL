// tts-ws-interceptor.js  (MAIN world, document_start)
//
// Hijacks claude.ai's native "Read aloud" WebSocket so our own TTS provider's audio plays
// through the native player. The native button opens:
//   wss://claude.ai/api/ws/text_to_speech/text_stream?output_format=pcm_16000&voice=...
// and speaks to it with JSON frames:
//   {"type":"text_chunk","text":"..."}  (one or more; together = full message text)
//   {"type":"close_stream"}             (text done)
//   {"type":"keep_alive"}               (every 4s)
// The server replies with binary frames in the requested output_format, then a single string frame
// {"type":"SpeechComplete"}, after which native calls ws.close() itself. The page used to ask for
// pcm_16000 (raw 16kHz mono s16le); it now asks for opus_48000_32 and expects one raw Opus packet
// per frame (no container).
//
// When the selected provider is a premium one (elevenlabs/openai) we return a FakeWebSocket that
// never touches the network: it collects the text, asks the ISOLATED world to synthesize (providers
// always produce 16kHz mono s16le PCM), streams that back in the format the page asked for, then emits
// SpeechComplete. Opus is encoded here with the vendored libopus build (lib/opus/opus-encoder.js; WebCodecs
// can't encode Opus in Firefox), one 20 ms packet per frame; its .wasm comes from ISOLATED on first use,
// since claude.ai's CSP keeps this world from fetching extension files. Native handles all
// playback / pause / resume / stop / button state.
//
// When the provider is 'claude' (or TTS isn't configured) we pass through to the real WebSocket so
// native TTS plays normally, except in chats with per-chat options (actor mode, quotes only, a voice
// override): there a RelaySocket asks ISOLATED for a plan ([{ voice, language, text }]) and plays it
// through real sockets, one per segment, each the page's URL with its own voice= (and language=, for a
// voice of another language). The server limits concurrent sessions (a 4th open socket gets SpeechError
// rate_limit, close 4029), so at most two are open: the one playing and the next one, prefetching.
(function () {
	'use strict';
	const log = createLogger('TTSWebSocket');

	const OrigWS = window.WebSocket;
	let hijack = false; // pushed from the ISOLATED world; false until told otherwise
	let relayChats = new Set(); // conversation ids whose native reads go through a RelaySocket

	// --- config sync with ISOLATED (tts.js) ---
	window.addEventListener('message', (e) => {
		if (e.source !== window || e.origin !== window.location.origin || !e.data) return;
		if (e.data.type === 'TTS_HIJACK_CONFIG') {
			hijack = !!e.data.hijack;
			relayChats = new Set(e.data.relayChats || []);
		}
	});
	// Ask for the current config (covers the case where ISOLATED loaded before we did).
	window.postMessage({ type: 'TTS_HIJACK_CONFIG_REQUEST' }, window.location.origin);

	// --- the Opus encoder's .wasm, read by ISOLATED (tts.js) once and handed over ---
	let wasmPromise = null;
	function opusWasm() {
		wasmPromise ??= new Promise((resolve, reject) => {
			const onMessage = (e) => {
				if (e.source !== window || e.origin !== window.location.origin || e.data?.type !== 'TTS_OPUS_WASM') return;
				window.removeEventListener('message', onMessage);
				if (e.data.bytes) resolve(e.data.bytes);
				else reject(new Error(e.data.error || 'no Opus encoder'));
			};
			window.addEventListener('message', onMessage);
			window.postMessage({ type: 'TTS_OPUS_WASM_REQUEST' }, window.location.origin);
		});
		wasmPromise.catch(() => { wasmPromise = null; }); // a failure isn't cached
		return wasmPromise;
	}

	const OPUS_FRAME = 320; // 20 ms at 16 kHz

	// --- routing of ISOLATED's replies back to the owning socket ---
	const liveSockets = new Map(); // requestId -> FakeWebSocket | RelaySocket
	window.addEventListener('message', (e) => {
		if (e.source !== window || e.origin !== window.location.origin || !e.data) return;
		const sock = liveSockets.get(e.data.requestId);
		if (!sock) return; // late frame from an aborted/closed request -> drop
		if (e.data.type === 'TTS_SYNTH_PCM') sock._emitBinary?.(e.data.chunk);
		else if (e.data.type === 'TTS_SYNTH_DONE' || e.data.type === 'TTS_SYNTH_ERROR') sock._emitComplete?.();
		else if (e.data.type === 'TTS_PLAN') sock._play?.(e.data.segments || []);
	});

	// What the page sees of a socket: events, readyState, the text it sends. Subclasses decide what to do
	// with the text (_request) and with keep-alives.
	class SocketShell extends EventTarget {
		static CONNECTING = 0;
		static OPEN = 1;
		static CLOSING = 2;
		static CLOSED = 3;

		constructor(url) {
			super();
			this.url = url;
			this.readyState = 0; // CONNECTING
			this.binaryType = 'blob';
			this.protocol = '';
			this.extensions = '';
			this.bufferedAmount = 0;
			this._requestId = crypto.randomUUID();
			this._chunks = [];
			this._closed = false;
			this._handlers = {};
			// Opus unless the page asks for PCM.
			this._opus = !/output_format=pcm/.test(url);
			liveSockets.set(this._requestId, this);
			// Open asynchronously so native code can attach handlers first.
			queueMicrotask(() => {
				if (this._closed) return;
				this.readyState = 1; // OPEN
				this._fire('open');
			});
		}

		// on* accessors (native may use either these or addEventListener)
		set onopen(f) { this._handlers.open = f; }
		get onopen() { return this._handlers.open || null; }
		set onmessage(f) { this._handlers.message = f; }
		get onmessage() { return this._handlers.message || null; }
		set onclose(f) { this._handlers.close = f; }
		get onclose() { return this._handlers.close || null; }
		set onerror(f) { this._handlers.error = f; }
		get onerror() { return this._handlers.error || null; }

		_fire(type, init) {
			let ev;
			if (type === 'message') ev = new MessageEvent('message', init);
			else if (type === 'close') ev = new CloseEvent('close', init || { wasClean: true, code: 1000, reason: '' });
			else ev = new Event(type);
			try { this._handlers[type]?.call(this, ev); } catch (err) { log.error('handler error', err); }
			this.dispatchEvent(ev);
		}

		send(data) {
			let msg;
			try { msg = JSON.parse(data); } catch { return; } // native only sends JSON strings
			if (msg.type === 'text_chunk') this._chunks.push(msg.text ?? '');
			else if (msg.type === 'close_stream') this._request(this._chunks.join(''), getConversationId());
			else if (msg.type === 'keep_alive') this._keepAlive(data);
		}

		_keepAlive() { }

		_complete(audioMs) {
			if (this._closed) return;
			this._fire('message', { data: JSON.stringify({ type: 'SpeechComplete', audio_sent_ms: audioMs }) });
			// Native calls close() itself after receiving SpeechComplete.
		}

		close(code, reason) {
			if (this._closed) return;
			this._closed = true;
			this.readyState = 3; // CLOSED
			liveSockets.delete(this._requestId);
			// Tell ISOLATED to abort any in-flight work for this request (saves API calls).
			window.postMessage({ type: 'TTS_SYNTH_ABORT', requestId: this._requestId }, window.location.origin);
			this._fire('close', { wasClean: true, code: code || 1000, reason: reason || '' });
		}
	}

	// A premium provider's audio: ISOLATED synthesizes 16 kHz PCM, sent as is or encoded to Opus (Opus takes
	// the 16 kHz input as is, and its packets decode at 48 kHz whatever the input rate).
	class FakeWebSocket extends SocketShell {
		constructor(url) {
			super(url);
			this._encoder = this._opus ? opusWasm().then(bytes => QolOpus.createEncoder(bytes, 16000, 1)) : null;
			this._encoder?.catch(e => log.error('No Opus encoder, this reply stays silent:', e));
			this._work = Promise.resolve(); // encoding runs in order, after the encoder is ready
			this._pending = new Int16Array(0); // samples waiting for a full 20 ms frame
			this._samples = 0; // PCM samples received, for audio_sent_ms
			this._oddByte = null; // a sample split across two chunks
		}

		_request(text, conversationId) {
			window.postMessage({ type: 'TTS_SYNTH_REQUEST', requestId: this._requestId, text, conversationId }, window.location.origin);
		}

		_emitBinary(ab) {
			if (this._closed) return;
			if (!this._opus) {
				// Native sets binaryType='arraybuffer'; deliver the ArrayBuffer as-is.
				this._fire('message', { data: ab });
				return;
			}
			let bytes = new Uint8Array(ab);
			if (this._oddByte !== null) {
				const joined = new Uint8Array(bytes.length + 1);
				joined[0] = this._oddByte;
				joined.set(bytes, 1);
				bytes = joined;
				this._oddByte = null;
			}
			if (bytes.length % 2) {
				this._oddByte = bytes[bytes.length - 1];
				bytes = bytes.subarray(0, bytes.length - 1);
			}
			const samples = new Int16Array(bytes.slice().buffer);
			this._samples += samples.length;
			this._encodeLater(samples, false);
		}

		// Queue samples for encoding: whole 20 ms frames go out as packets, the rest waits for more audio
		// (or, at the end, is padded with silence into a last frame).
		_encodeLater(samples, final) {
			this._work = this._work.then(async () => {
				const encoder = await this._encoder;
				const joined = new Int16Array(this._pending.length + samples.length);
				joined.set(this._pending);
				joined.set(samples, this._pending.length);
				let offset = 0;
				for (; offset + OPUS_FRAME <= joined.length; offset += OPUS_FRAME) this._sendPacket(encoder, joined.subarray(offset, offset + OPUS_FRAME));
				this._pending = joined.slice(offset);
				if (final && this._pending.length) {
					const last = new Int16Array(OPUS_FRAME);
					last.set(this._pending);
					this._sendPacket(encoder, last);
					this._pending = new Int16Array(0);
				}
			}).catch(e => log.error('Opus encoding failed:', e));
		}

		_sendPacket(encoder, frame) {
			if (this._closed) return;
			this._fire('message', { data: encoder.encode(frame).buffer });
		}

		async _emitComplete() {
			if (this._closed) return;
			if (this._opus) {
				this._encodeLater(new Int16Array(0), true);
				await this._work;
			}
			this._complete(Math.round(this._samples / 16));
		}

		close(code, reason) {
			this._encoder?.then(encoder => encoder.free(), () => { });
			super.close(code, reason);
		}
	}

	// 160 ms of silence, sent while ISOLATED works out the plan (actor mode's attribution is an LLM
	// round-trip) so native's player doesn't give up: 8 frames of 20 ms, as PCM zeros or as Opus's
	// silent frame (TOC 0xF8: CELT fullband 20 ms mono, one frame; 0xFF 0xFE: silence).
	const PRIMER_FRAMES = 8;
	const PRIMER_MS = PRIMER_FRAMES * 20;
	const OPUS_SILENCE = [0xF8, 0xFF, 0xFE];

	// The page's socket URL with a segment's voice and language (each kept when null).
	function segmentUrl(url, { voice, language }) {
		const parsed = new URL(url);
		if (voice) parsed.searchParams.set('voice', voice);
		if (language) parsed.searchParams.set('language', language);
		return parsed.href;
	}

	// Native TTS, played from a plan: the page's own text and format, one real socket per segment. The
	// segments' frames are already in the format the page asked for, so they're forwarded untouched.
	class RelaySocket extends SocketShell {
		constructor(url, protocols) {
			super(url);
			this._protocols = protocols; // the page's, for every segment's socket
			this._real = new Set(); // open real sockets
		}

		_request(text, conversationId) {
			for (let i = 0; i < PRIMER_FRAMES; i++) {
				this._fire('message', { data: this._opus ? new Uint8Array(OPUS_SILENCE).buffer : new ArrayBuffer(OPUS_FRAME * 2) });
			}
			window.postMessage({ type: 'TTS_PLAN_REQUEST', requestId: this._requestId, text, conversationId }, window.location.origin);
		}

		_keepAlive(data) {
			for (const ws of this._real) if (ws.readyState === OrigWS.OPEN) ws.send(data);
		}

		// Opens a segment's socket right away; its frames wait in a buffer until attach() (prefetch).
		_open(segment) {
			const url = segmentUrl(this.url, segment);
			const ws = this._protocols === undefined ? new OrigWS(url) : new OrigWS(url, this._protocols);
			ws.binaryType = 'arraybuffer';
			this._real.add(ws);
			const frames = [];
			let deliver = (ab) => frames.push(ab);
			const result = new Promise(resolve => {
				ws.onopen = () => {
					ws.send(JSON.stringify({ type: 'text_chunk', text: segment.text }));
					ws.send(JSON.stringify({ type: 'close_stream' }));
				};
				ws.onmessage = (m) => {
					if (typeof m.data !== 'string') return deliver(m.data);
					let msg;
					try { msg = JSON.parse(m.data); } catch { return; }
					if (msg.type === 'SpeechComplete') resolve({ ms: msg.audio_sent_ms || 0 });
					else if (msg.type === 'SpeechError') resolve({ error: m.data });
				};
				ws.onclose = (c) => resolve({ code: c.code }); // a no-op once settled
			}).finally(() => {
				this._real.delete(ws);
				ws.close();
			});
			return {
				result,
				attach: (onFrame) => {
					frames.forEach(onFrame);
					deliver = onFrame;
				}
			};
		}

		async _play(segments) {
			if (this._closed || this._playing) return; // one plan per read
			this._playing = true;
			let total = 0;
			let next = segments.length ? this._open(segments[0]) : null;
			for (let i = 0; next; i++) {
				const current = next;
				next = i + 1 < segments.length ? this._open(segments[i + 1]) : null;
				current.attach(ab => { if (!this._closed) this._fire('message', { data: ab }); });
				const result = await current.result;
				if (this._closed) return;
				if (result.ms === undefined) {
					this._fail(result);
					return;
				}
				total += result.ms;
			}
			this._complete(PRIMER_MS + total);
		}

		// A segment ended without SpeechComplete: pass its SpeechError on (native ends the read and closes
		// us), or, if the socket just closed, close as it did. The prefetched socket is closed now either way.
		_fail({ error, code }) {
			log.warn('Relayed segment failed:', error || `closed with ${code}`);
			for (const ws of this._real) ws.close();
			if (error) this._fire('message', { data: error });
			else this.close(code || 1006);
		}

		close(code, reason) {
			for (const ws of this._real) ws.close();
			this._real.clear();
			super.close(code, reason);
		}
	}

	function WSProxy(url, protocols) {
		try {
			if (typeof url === 'string' && url.includes('/text_to_speech/')) {
				if (hijack) return new FakeWebSocket(url);
				if (relayChats.has(getConversationId())) return new RelaySocket(url, protocols);
			}
		} catch (e) {
			log.error('WS hijack decision failed, passing through', e);
		}
		return protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
	}
	// Preserve identity so `x instanceof WebSocket` still works for real sockets.
	WSProxy.prototype = OrigWS.prototype;
	WSProxy.CONNECTING = OrigWS.CONNECTING;
	WSProxy.OPEN = OrigWS.OPEN;
	WSProxy.CLOSING = OrigWS.CLOSING;
	WSProxy.CLOSED = OrigWS.CLOSED;

	window.WebSocket = WSProxy;
})();
