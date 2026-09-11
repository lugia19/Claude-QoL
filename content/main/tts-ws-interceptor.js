// tts-ws-interceptor.js  (MAIN world, document_start)
//
// Hijacks claude.ai's native "Read aloud" WebSocket so our own TTS provider's audio plays
// through the native player. The native button opens:
//   wss://claude.ai/api/ws/text_to_speech/text_stream?output_format=pcm_16000&voice=...
// and speaks to it with JSON frames:
//   {"type":"text_chunk","text":"..."}  (one or more; together = full message text)
//   {"type":"close_stream"}             (text done)
//   {"type":"keep_alive"}               (every 4s)
// The server is expected to reply with raw 16kHz mono s16le PCM as arraybuffer frames, then a
// single string frame {"type":"SpeechComplete"}, after which native calls ws.close() itself.
//
// When the selected provider is a premium one (elevenlabs/openai) we return a FakeWebSocket that
// never touches the network: it collects the text, asks the ISOLATED world to synthesize, streams
// the returned PCM back as arraybuffer frames, then emits SpeechComplete. Native handles all
// playback / pause / resume / stop / button state. When the provider is 'claude' (or TTS isn't
// configured) we pass through to the real WebSocket so native TTS plays normally.
(function () {
	'use strict';

	const OrigWS = window.WebSocket;
	let hijack = false; // pushed from the ISOLATED world; false until told otherwise

	// --- config sync with ISOLATED (tts.js) ---
	window.addEventListener('message', (e) => {
		if (e.source !== window || !e.data) return;
		if (e.data.type === 'TTS_HIJACK_CONFIG') hijack = !!e.data.hijack;
	});
	// Ask for the current config (covers the case where ISOLATED loaded before we did).
	window.postMessage({ type: 'TTS_HIJACK_CONFIG_REQUEST' }, '*');

	// --- routing of synthesis results back to the owning socket ---
	const liveSockets = new Map(); // requestId -> FakeWebSocket
	window.addEventListener('message', (e) => {
		if (e.source !== window || !e.data) return;
		const sock = liveSockets.get(e.data.requestId);
		if (!sock) return; // late frame from an aborted/closed request -> drop
		if (e.data.type === 'TTS_SYNTH_PCM') sock._emitBinary(e.data.chunk);
		else if (e.data.type === 'TTS_SYNTH_DONE' || e.data.type === 'TTS_SYNTH_ERROR') sock._emitComplete();
	});

	class FakeWebSocket extends EventTarget {
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
			try { this._handlers[type]?.call(this, ev); } catch (err) { console.error('[QOL-TTS] handler error', err); }
			this.dispatchEvent(ev);
		}

		send(data) {
			let msg;
			try { msg = JSON.parse(data); } catch { return; } // native only sends JSON strings
			if (msg.type === 'text_chunk') {
				this._chunks.push(msg.text ?? '');
			} else if (msg.type === 'close_stream') {
				let text = this._chunks.join('');
				// Strip our own injected markers (phantom-messages.js, image-extractor.js) before synthesis.
				text = text
					.replace(/====PHANTOM_MESSAGE====/g, '')
					.replace(/====UUID:[a-f0-9-]+====/gi, '')
					.replace(/====GALLERY_BREAK====/g, '');
				const conversationId = (typeof getConversationId === 'function') ? getConversationId() : null;
				window.postMessage({ type: 'TTS_SYNTH_REQUEST', requestId: this._requestId, text, conversationId }, '*');
			}
			// keep_alive: ignore
		}

		_emitBinary(ab) {
			if (this._closed) return;
			// Native sets binaryType='arraybuffer'; deliver the ArrayBuffer as-is.
			this._fire('message', { data: ab });
		}

		_emitComplete() {
			if (this._closed) return;
			this._fire('message', { data: JSON.stringify({ type: 'SpeechComplete' }) });
			// Native calls close() itself after receiving SpeechComplete.
		}

		close(code, reason) {
			if (this._closed) return;
			this._closed = true;
			this.readyState = 3; // CLOSED
			liveSockets.delete(this._requestId);
			// Tell ISOLATED to abort any in-flight synthesis for this request (saves API calls).
			window.postMessage({ type: 'TTS_SYNTH_ABORT', requestId: this._requestId }, '*');
			this._fire('close', { wasClean: true, code: code || 1000, reason: reason || '' });
		}
	}

	function WSProxy(url, protocols) {
		try {
			if (hijack && typeof url === 'string' && url.includes('/text_to_speech/')) {
				return new FakeWebSocket(url);
			}
		} catch (e) {
			console.error('[QOL-TTS] WS hijack decision failed, passing through', e);
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
