// Opus encoder for the "Read aloud" hijack (content/main/tts-ws-interceptor.js).
// opus-encoder.wasm is libopus-encoder.wasm.min.wasm from opus-encdec 0.1.1
// (https://github.com/mmig/opus-encdec, MIT; libopus is BSD, both in LICENSE.md), unmodified. Its
// Emscripten glue isn't vendored: it compiles code with new Function, which claude.ai's CSP forbids. This
// loader instantiates the module directly instead. The import/export names below are that build's
// minified ones (from its glue's asmLibraryArg and asm["..."] lines), so they only fit that exact file.
(function () {
	'use strict';
	const OPUS_APPLICATION_AUDIO = 2049;
	const OPUS_SET_BITRATE_REQUEST = 4002;
	const MAX_PACKET_SIZE = 4000;
	let modulePromise = null;

	async function instantiate(wasmBinary) {
		let memory = null;
		const unsupported = () => { throw new Error('libopus called an unsupported import'); };
		const { instance } = await WebAssembly.instantiate(wasmBinary, {
			a: {
				a: () => 0, // fd_write (stdio; libopus doesn't print)
				b: () => 0, // fd_seek
				c: unsupported, // abort
				d: () => 0, // fd_close
				// emscripten_memcpy_big. Block body: returning copyWithin's array would make wasm convert it
				// to a number, stringifying the whole heap.
				e: (dest, src, num) => { new Uint8Array(memory.buffer).copyWithin(dest, src, src + num); },
				f: () => 0, // emscripten_resize_heap: the heap is fixed-size, report failure
			},
		});
		const e = instance.exports;
		memory = e.g;
		e.h(); // __wasm_call_ctors
		return {
			memory,
			create: e.i, // opus_encoder_create(Fs, channels, application, *error)
			encodeFloat: e.j, // opus_encode_float(st, *pcm, frame_size, *data, max_data_bytes)
			ctl: e.k, // opus_encoder_ctl(st, request, *varargs)
			destroy: e.l, // opus_encoder_destroy(st)
			malloc: e.p,
			free: e.q,
		};
	}

	// QolOpus.createEncoder(wasmBinary, sampleRate, channels) -> { encode(Int16Array frame) -> Uint8Array
	// packet, free() }. A frame is 20 ms (sampleRate / 50 samples per channel); each call returns one raw
	// Opus packet (no container).
	globalThis.QolOpus = {
		async createEncoder(wasmBinary, sampleRate, channels, bitrate = 32000) {
			modulePromise ??= instantiate(wasmBinary);
			const lib = await modulePromise;
			const scratch = lib.malloc(4);
			const encoder = lib.create(sampleRate, channels, OPUS_APPLICATION_AUDIO, scratch);
			const error = new Int32Array(lib.memory.buffer, scratch, 1)[0];
			if (!encoder || error) { lib.free(scratch); throw new Error(`opus_encoder_create failed (${error})`); }
			new Int32Array(lib.memory.buffer, scratch, 1)[0] = bitrate;
			lib.ctl(encoder, OPUS_SET_BITRATE_REQUEST, scratch);
			lib.free(scratch);
			const frameLength = sampleRate / 50 * channels;
			const inPtr = lib.malloc(frameLength * 4);
			const outPtr = lib.malloc(MAX_PACKET_SIZE);
			return {
				encode(frame) {
					if (frame.length !== frameLength) throw new Error(`Opus frames are ${frameLength} samples`);
					const input = new Float32Array(lib.memory.buffer, inPtr, frameLength);
					for (let i = 0; i < frameLength; i++) input[i] = frame[i] / 32768;
					const length = lib.encodeFloat(encoder, inPtr, frameLength / channels, outPtr, MAX_PACKET_SIZE);
					if (length < 0) throw new Error(`Opus encode error ${length}`);
					return new Uint8Array(lib.memory.buffer).slice(outPtr, outPtr + length);
				},
				free() {
					lib.destroy(encoder);
					lib.free(inPtr);
					lib.free(outPtr);
				},
			};
		},
	};
})();
