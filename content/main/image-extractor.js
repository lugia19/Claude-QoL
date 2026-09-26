// image-extractor.js — Turns image tool results (MCP/ComfyUI etc.) into inline image galleries.
// MAIN world: rewrites the conversation GET on load and the completion stream live, splicing a
// synthetic image_search tool_use + tool_result (carrying an image_gallery) after each image result.
// Settings come from a localStorage mirror written by content/isolated/image-gallery.js.
'use strict';

// ==== Preview dimension resolution ====
// msg.files no longer carries preview_asset dimensions, so we load the built preview
// URL and read its natural size. Persist the results in localStorage keyed by
// file_uuid so reloading a long conversation doesn't re-measure every image.
const _IMG_DIMS_CACHE_KEY = 'claude_qol_image_dims_cache';

const _imageDimsCache = (() => {
	try {
		const raw = localStorage.getItem(_IMG_DIMS_CACHE_KEY);
		return raw ? new Map(Object.entries(JSON.parse(raw))) : new Map();
	} catch (e) {
		return new Map();
	}
})();

function _persistImageDims() {
	try {
		localStorage.setItem(_IMG_DIMS_CACHE_KEY, JSON.stringify(Object.fromEntries(_imageDimsCache)));
	} catch (e) { /* quota or serialization issue — non-fatal */ }
}

// ==== Conversations with generated images ====
// The live /completion wrapper is only installed for conversations known to contain
// generated images — flagged here by the load-time path when it finds bare-image
// tool_results. Re-piping the completion stream in JS causes visible streaming jank on
// some machines (root cause under investigation; see inject-stream-test.js), so every
// other conversation gets the native stream untouched. Tradeoff: a conversation's FIRST
// image only gets its gallery on reload, which also flags the conversation so later
// generations inject live.
const _IMG_CONVS_KEY = 'claude_qol_image_convs';

function _loadImageConvs() {
	try {
		const raw = localStorage.getItem(_IMG_CONVS_KEY);
		return raw ? JSON.parse(raw) : {};
	} catch (e) { return {}; }
}

function _conversationHasImages(convId) {
	if (!convId) return false;
	return !!_loadImageConvs()[convId];
}

function _markConversationHasImages(convId) {
	if (!convId) return;
	try {
		const map = _loadImageConvs();
		if (map[convId]) return;
		map[convId] = true;
		localStorage.setItem(_IMG_CONVS_KEY, JSON.stringify(map));
	} catch (e) { /* quota or serialization issue — non-fatal */ }
}

// ==== User settings ====
// Mirrored into localStorage by content/isolated/image-gallery.js (the settings bridge to
// the ISOLATED world isn't up yet when the conversation GET we rewrite fires). Absent mirror
// = defaults: inject, no per-gallery limit.
const _IMG_GALLERY_CONFIG_KEY = 'claude_qol_image_gallery';

function _galleryConfig() {
	const defaults = { enabled: true, limitEnabled: false, limit: 3 };
	try {
		const raw = localStorage.getItem(_IMG_GALLERY_CONFIG_KEY);
		return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
	} catch (e) { return defaults; }
}

// Images per gallery; Infinity when the user hasn't enabled a limit. The renderer only shows
// up to 3 images of a strip inline (see "Gallery building" below), so a higher limit just
// hides the rest — that's the user's call.
function _galleryLimit() {
	const { limitEnabled, limit } = _galleryConfig();
	return limitEnabled && limit >= 1 ? Math.floor(limit) : Infinity;
}

// Conversation ID from an API URL (covers /completion, /retry_completion, and the
// rendering_mode=messages conversation fetch).
function _convIdFromUrl(url) {
	return url.match(/chat_conversations\/([0-9a-f-]{8,})/)?.[1] || null;
}

function getImageDimensions(fileUuid, url) {
	const cached = _imageDimsCache.get(fileUuid);
	if (cached) return Promise.resolve(cached);

	return new Promise((resolve) => {
		const fallback = { width: 1024, height: 1024 };
		const img = new Image();
		let settled = false;
		const finish = (dims, persist) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (persist) {
				_imageDimsCache.set(fileUuid, dims);
				_persistImageDims();
			}
			resolve(dims);
		};
		// Don't cache the fallback — a later load may succeed with real dimensions.
		const timer = setTimeout(() => finish(fallback, false), 5000);
		img.onload = () => finish({
			width: img.naturalWidth || fallback.width,
			height: img.naturalHeight || fallback.height
		}, true);
		img.onerror = () => finish(fallback, false);
		img.src = url;
	});
}

// Named aspect-ratio presets some image tools expose instead of raw pixel dimensions.
// We only use dims to set the gallery's aspect (width is always scaled to 3840), so a
// ratio is enough. Add more names/ratios here as other tools turn up in the logs.
const _ASPECT_PRESETS = {
	square: [1, 1],
	portrait: [3, 4],
	landscape: [4, 3],
	tall: [9, 16],
	wide: [16, 9]
};

// Turn an aspect_ratio value into a {width,height} carrying the right ratio. Handles named
// presets ("wide"), "W:H"/"WxH"/"W/H" strings ("16:9"), and a numeric ratio (1.777).
function aspectRatioToDims(val) {
	if (val == null) return null;
	if (typeof val === 'number' && val > 0) return { width: Math.round(val * 1000), height: 1000 };
	if (typeof val !== 'string') return null;
	const key = val.trim().toLowerCase();
	if (_ASPECT_PRESETS[key]) {
		const [w, h] = _ASPECT_PRESETS[key];
		return { width: w, height: h };
	}
	const m = key.match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/);
	if (m) {
		const w = parseFloat(m[1]), h = parseFloat(m[2]);
		if (w > 0 && h > 0) return { width: w, height: h };
	}
	return null;
}

// Try to read image dimensions directly out of stream data — the image content item itself
// or the generating tool_use input (image tools pass either raw width/height, or a named
// aspect_ratio like "wide"). Returns null if nothing usable is found, so callers fall back
// to the network measure. Non-aspect field names are guesses covering common tool shapes.
function extractDimsFromStream(imageItem, toolInput) {
	const tryPair = (w, h) => (w > 0 && h > 0) ? { width: Math.round(w), height: Math.round(h) } : null;
	imageItem = imageItem || {};
	toolInput = toolInput || {};
	return (
		tryPair(imageItem.width, imageItem.height) ||
		tryPair(imageItem.image_width, imageItem.image_height) ||
		tryPair(imageItem.preview_asset?.image_width, imageItem.preview_asset?.image_height) ||
		tryPair(imageItem.asset?.image_width, imageItem.asset?.image_height) ||
		tryPair(imageItem.dimensions?.width, imageItem.dimensions?.height) ||
		tryPair(toolInput.width, toolInput.height) ||
		tryPair(toolInput.image_width, toolInput.image_height) ||
		aspectRatioToDims(toolInput.aspect_ratio) ||
		aspectRatioToDims(imageItem.aspect_ratio) ||
		null
	);
}

// ==== Gallery building ====
// Shared by the live (SSE) and load-time (conversation JSON) injectors below. Facts about
// claude.ai's renderer these are built around (verified against the live site):
//  - Consecutive image_search tool_results get merged into ONE strip that shows at most 3
//    images and silently drops the rest — no "+N" tile. Native tool blocks in between do not
//    break the run.
//  - A text block with real content does break the run; empty / whitespace-only text blocks are
//    discarded by the renderer and split nothing.
//  - The strip for a run of tool blocks is only drawn once the run is closed by a non-tool block
//    (or the message ends).
// How many images share a gallery is the user's setting, see _galleryLimit().

// Text block placed between galleries so each renders as its own strip. Must be real text (see
// above), so it's a marker in the same family as ====UUID:...====: phantom-messages.js hides
// its <p> in the DOM and it is stripped from copied / read-aloud text alongside the other
// markers. Never sent to the server — injection is local.
const GALLERY_SEPARATOR_TEXT = '====GALLERY_BREAK====';

// Gallery entries are { image, prompt }: the image_gallery item plus the generating prompt.
// Split into runs of at most _galleryLimit() (a single run when there is no limit).
function chunkGalleryEntries(entries) {
	const limit = _galleryLimit();
	const chunks = [];
	for (let i = 0; i < entries.length; i += limit) {
		chunks.push(entries.slice(i, i + limit));
	}
	return chunks;
}

// Label for a gallery's tool block: singular or plural by image count.
function generatedLabel(entries) {
	return entries.length > 1 ? localize('images.generated_images') : localize('images.generated_image');
}

// Result text for a gallery: names the prompt when every image in it came from the same one.
function galleryText(entries) {
	const prompts = new Set(entries.map((e) => e.prompt));
	const prompt = prompts.size === 1 ? [...prompts][0] : '';
	return prompt ? localize('images.generated_for', { prompt }) : generatedLabel(entries);
}

// image_gallery item for a generated image. Width is scaled to 3840 so it renders full-width.
function buildGalleryImage(fileUuid, imageUrl, dims, prompt) {
	const scale = 3840 / dims.width;
	const scaledW = Math.round(dims.width * scale);
	const scaledH = Math.round(dims.height * scale);
	return {
		id: fileUuid,
		url: imageUrl,
		thumbnail_url: imageUrl,
		title: prompt ? localize('images.generated_title', { prompt: prompt.substring(0, 100) }) : '',
		source: '',
		page_url: imageUrl,
		width: scaledW,
		height: scaledH,
		thumbnail_width: scaledW,
		thumbnail_height: scaledH
	};
}

// Synthetic image_search tool_use + tool_result pair in conversation-JSON shape. The renderer
// only draws a full gallery for tool_results named image_search.
function buildGalleryPair(entries) {
	const toolUseId = 'toolu_gallery_' + crypto.randomUUID().replace(/-/g, '').substring(0, 20);
	const timestamp = new Date().toISOString();
	return [
		{
			start_timestamp: timestamp,
			stop_timestamp: timestamp,
			type: 'tool_use',
			id: toolUseId,
			name: 'image_search',
			input: {},
			message: generatedLabel(entries)
		},
		{
			type: 'tool_result',
			tool_use_id: toolUseId,
			name: 'image_search',
			content: [
				{ type: 'text', text: galleryText(entries), uuid: crypto.randomUUID() },
				{ type: 'image_gallery', images: entries.map((e) => e.image), uuid: crypto.randomUUID(), is_expired: false }
			],
			is_error: false
		}
	];
}

// ==== DIAGNOSTICS ====
// Timing logs to pinpoint streaming stalls (our blocking measure, our injection build, or
// upstream). ON by default while diagnosing; disable with localStorage['claude_qol_img_diag']='0'.
function _imgDiagOn() {
	try { return localStorage.getItem('claude_qol_img_diag') !== '0'; } catch (e) { return true; }
}
function _diag(...a) { if (_imgDiagOn()) { try { console.log('[QOL-DIAG]', ...a); } catch (e) {} } }

// ==== LIVE SSE INJECTION ====
// During a streaming completion, MCP/ComfyUI image tools stream back as a bare
// tool_result content block (content: [{type:"image", file_uuid}, ...]) which the
// renderer draws as a tiny "Tool result" thumbnail. The renderer only draws a full
// gallery when a tool_result's name === "image_search", so — mirroring the load-time
// injector below — we splice a synthetic image_search tool_use + tool_result (carrying
// an image_gallery) into the stream right after each such block. Content blocks are
// keyed by a sequential integer index, so every later event's index is bumped by the
// number of blocks injected so far (+2 per gallery pair, +1 per separator). This is purely
// a live/visual upgrade; on reload the load-time path re-injects from the conversation
// JSON (with real measured dimensions).
function createImageInjectingStream(sourceBody, orgId) {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();

	let buffer = '';
	let indexOffset = 0;
	const toolUseInputBuf = new Map();   // nativeIndex -> accumulated input_json_delta string
	const toolUseParsed = new Map();     // nativeIndex -> parsed tool_use input object
	const pendingInjections = new Map(); // tool_result nativeIndex -> [image items]
	let stripImageCount = 0;             // images in the strip the renderer is currently merging galleries into

	// Diagnostics: stream clock + inter-event gap tracking to catch stalls.
	const _streamStart = performance.now();
	let _lastEventAt = _streamStart;
	let _evtCount = 0;
	_diag(`stream opened @${new Date().toISOString()}`);

	const emit = (controller, text) => controller.enqueue(encoder.encode(text + '\n\n'));

	// Bump the single top-level "index":N in a passed-through event by the running offset.
	const applyOffset = (rawEvent) => {
		if (indexOffset === 0) return rawEvent;
		return rawEvent.replace(/"index":(\d+)/, (m, n) => `"index":${parseInt(n, 10) + indexOffset}`);
	};

	// SSE events for one synthetic image_search tool_use + tool_result pair, occupying the
	// block indices toolUseIndex and toolUseIndex + 1.
	const buildGalleryEvents = (toolUseIndex, entries) => {
		const toolResultIndex = toolUseIndex + 1;
		const toolUseId = 'toolu_gallery_' + crypto.randomUUID().replace(/-/g, '').substring(0, 20);
		const ts = new Date().toISOString();

		const toolUseBlock = {
			type: 'content_block_start',
			index: toolUseIndex,
			content_block: {
				type: 'tool_use',
				id: toolUseId,
				name: 'image_search',
				input: {},
				message: generatedLabel(entries),
				integration_name: null,
				integration_icon_url: null,
				icon_name: null,
				context: null,
				display_content: null,
				approval_options: null,
				approval_key: null,
				approval_key_legacy: null,
				is_mcp_app: null,
				mcp_server_url: null,
				start_timestamp: ts,
				stop_timestamp: null,
				flags: null
			}
		};

		const toolResultBlock = {
			type: 'content_block_start',
			index: toolResultIndex,
			content_block: {
				type: 'tool_result',
				tool_use_id: toolUseId,
				name: 'image_search',
				content: [
					{ text: galleryText(entries), type: 'text' },
					{ type: 'image_gallery', images: entries.map((e) => e.image) }
				],
				is_error: false,
				structured_content: null,
				meta: null,
				message: null,
				integration_name: null,
				mcp_server_url: null,
				integration_icon_url: null,
				icon_name: null,
				display_content: null,
				start_timestamp: ts,
				stop_timestamp: ts,
				flags: null
			}
		};

		return [
			`event: content_block_start\ndata: ${JSON.stringify(toolUseBlock)}`,
			`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: toolUseIndex, stop_timestamp: ts })}`,
			`event: content_block_start\ndata: ${JSON.stringify(toolResultBlock)}`,
			`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: toolResultIndex, stop_timestamp: ts })}`
		];
	};

	// SSE events for a GALLERY_SEPARATOR_TEXT text block at the given index. Mirrors how native
	// text streams — empty block start, the text as a delta, then stop — because the renderer
	// ignores text carried directly in content_block_start.
	const buildSeparatorEvents = (index) => {
		const ts = new Date().toISOString();
		return [
			`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'text', text: '', start_timestamp: ts, stop_timestamp: null, citations: [] } })}`,
			`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: GALLERY_SEPARATOR_TEXT } })}`,
			`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index, stop_timestamp: ts })}`
		];
	};

	// Build the events to inject after one native image tool_result. Each result gets its own
	// gallery as it arrives (grouping across results would mean holding images back); the
	// renderer merges adjacent galleries into one strip anyway, so this only tracks how full
	// that strip is. The strip is drawn only once a non-tool block closes the run, so the
	// separator goes out right after the gallery that fills it — that way the first three show
	// as soon as the third lands instead of waiting for the fourth result. Side effect: a
	// message with exactly 3 (6, …) images shows a trailing separator until the
	// post-completion refetch replaces the live layout with the load-time one.
	const buildInjectedEvents = async (toolResultNativeIndex, images, prompt, toolInput = {}) => {
		const firstIndex = toolResultNativeIndex + indexOffset + 1; // right after the native tool_result

		// Measure each preview (same helper + shared localStorage cache the load-time path
		// uses) so the gallery renders at the correct aspect immediately — no flash — and
		// so the later reload is instant. Awaiting here delays only the events around an
		// image result; the eager pump below keeps draining the socket meanwhile.
		const entries = await Promise.all(images.map(async (c) => {
			const imageUrl = `https://claude.ai/api/${orgId}/files/${c.file_uuid}/preview`;
			// Prefer dimensions carried in the stream (image item or generating tool_use input);
			// only fall back to the network measure when the stream doesn't provide them.
			let dims = extractDimsFromStream(c, toolInput);
			if (dims) {
				_diag(`dims from STREAM for ${c.file_uuid}`, dims);
				// Stream dims are aspect-only (e.g. 16:9); still measure the real preview in the
				// background (fire-and-forget) to warm the shared cache so the load-time path
				// re-injects at true pixel dimensions on the next reload.
				getImageDimensions(c.file_uuid, imageUrl).catch(() => {});
			} else {
				const _t0 = performance.now();
				dims = await getImageDimensions(c.file_uuid, imageUrl);
				_diag(`dims MEASURED (network, BLOCKING) for ${c.file_uuid} took ${Math.round(performance.now() - _t0)}ms`, dims);
			}
			return { image: buildGalleryImage(c.file_uuid, imageUrl, dims, prompt), prompt };
		}));

		const events = [];
		const limit = _galleryLimit();
		let nextIndex = firstIndex;
		while (entries.length) {
			// Fill whatever room the current strip has left before starting a new one.
			const chunk = entries.splice(0, limit - stripImageCount);
			events.push(...buildGalleryEvents(nextIndex, chunk));
			nextIndex += 2;
			stripImageCount += chunk.length;
			if (stripImageCount >= limit) {
				events.push(...buildSeparatorEvents(nextIndex));
				nextIndex += 1;
				stripImageCount = 0;
			}
		}
		return { events, addedBlocks: nextIndex - firstIndex };
	};

	// NOTE: this runs inside a TransformStream.transform(); a thrown error here would error
	// the whole stream and break Claude's response. The native event is always forwarded
	// first, and the injection logic below is wrapped so an unexpected failure can never
	// stop the native stream from flowing.
	const handleEvent = async (controller, rawEvent) => {
		if (!rawEvent.trim()) return;

		let parsed = null;
		const dataMatch = rawEvent.match(/(?:^|\n)data: (.*)$/);
		if (dataMatch) { try { parsed = JSON.parse(dataMatch[1]); } catch (e) { /* non-JSON event */ } }

		// Forward the native event first, with any accumulated index offset applied.
		emit(controller, applyOffset(rawEvent));

		// Diagnostics: flag stalls in the event flow (gap since previous event reached us).
		if (_imgDiagOn()) {
			const _now = performance.now();
			const _gap = _now - _lastEventAt;
			_lastEventAt = _now;
			_evtCount++;
			if (_gap > 150) _diag(`+${Math.round(_gap)}ms GAP before event #${_evtCount} (${parsed?.type || 'non-json'} @${parsed?.index ?? '-'})`);
		}

		if (!parsed || typeof parsed.index !== 'number') return;

		try {
			// Native text closes the current strip; the next gallery starts a fresh one.
			if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'text') {
				stripImageCount = 0;
			}

			// Accumulate the preceding tool_use's streamed input so we can recover its prompt.
			if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
				toolUseInputBuf.set(parsed.index, '');
			} else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta' && toolUseInputBuf.has(parsed.index)) {
				toolUseInputBuf.set(parsed.index, toolUseInputBuf.get(parsed.index) + (parsed.delta.partial_json || ''));
			} else if (parsed.type === 'content_block_stop' && toolUseInputBuf.has(parsed.index)) {
				try { toolUseParsed.set(parsed.index, JSON.parse(toolUseInputBuf.get(parsed.index) || '{}')); } catch (e) {}
				toolUseInputBuf.delete(parsed.index);
			}

			// Detect a bare-image tool_result (ComfyUI/MCP). Native image_search results carry
			// an image_gallery instead of bare image items, so they never match.
			if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_result') {
				const images = (parsed.content_block.content || []).filter((c) => c.type === 'image' && c.file_uuid);
				if (images.length > 0) pendingInjections.set(parsed.index, images);
			}

			// The tool_result start is immediately followed by its stop; inject right after it.
			if (parsed.type === 'content_block_stop' && pendingInjections.has(parsed.index)) {
				const images = pendingInjections.get(parsed.index);
				pendingInjections.delete(parsed.index);
				const toolInput = toolUseParsed.get(parsed.index - 1) || {};
				const prompt = toolInput.prompt || '';
				if (_imgDiagOn()) {
					_diag(`>>> injecting ${images.length} image(s) @index ${parsed.index}; toolInput keys=`, Object.keys(toolInput), 'aspect_ratio=', toolInput.aspect_ratio, 'w/h=', toolInput.width, toolInput.height);
					images.forEach((c, i) => _diag(`    image[${i}] keys=`, Object.keys(c), c));
				}
				const _tb = performance.now();
				const { events, addedBlocks } = await buildInjectedEvents(parsed.index, images, prompt, toolInput);
				_diag(`<<< buildInjectedEvents took ${Math.round(performance.now() - _tb)}ms (blocks the stream this long)`);
				for (const ev of events) emit(controller, ev);
				indexOffset += addedBlocks;
			}
		} catch (e) {
			// Injection is best-effort; never let it break the native stream.
			console.error('[QOL-ImageExtractor] injection error (native stream unaffected):', e);
		}
	};

	// Drain the source with an EAGER background pump rather than a lazy pull loop / pipeThrough.
	// The root problem with a JS stream wrapper: WE become the socket reader, and if we only read
	// when the consumer pulls us (as both the old pull-loop and a TransformStream/pipeThrough do),
	// any pause in Claude's renderer back-propagates through us, stops us reading the socket, TCP
	// flow-control kicks in, and the SERVER pauses sending — data then arrives in multi-second
	// bursts. The native fetch body avoids this by draining the socket eagerly in C++ and buffering
	// ahead of a slow reader. We replicate that here: a background pump in start() reads the source
	// as fast as it arrives and enqueues into our own (unbounded) buffer, so network delivery is
	// fully decoupled from the renderer's read cadence. The consumer then drains our buffer at will.
	const reader = sourceBody.getReader();
	let _cancelled = false;
	let _lastRead = _streamStart;
	let _chunkNo = 0;
	let _maxAhead = 0;

	return new ReadableStream({
		start(controller) {
			// Detached async pump — NOT returned, so the stream is "started" immediately and the
			// pump runs independently of the consumer (this is what makes reading eager).
			(async () => {
				try {
					while (!_cancelled) {
						const { done, value } = await reader.read();
						if (done) {
							buffer += decoder.decode();
							if (buffer.trim()) await handleEvent(controller, buffer);
							_diag(`stream done: ${_evtCount} events, ${_chunkNo} chunks, ${Math.round(performance.now() - _streamStart)}ms, maxQueuedAhead=${_maxAhead}`);
							controller.close();
							return;
						}
						const _bytes = value.byteLength;
						const _gap = performance.now() - _lastRead;
						const _p0 = performance.now();
						_chunkNo++;
						buffer += decoder.decode(value, { stream: true });
						let boundary;
						let _n = 0;
						while ((boundary = buffer.indexOf('\n\n')) !== -1) {
							const rawEvent = buffer.slice(0, boundary);
							buffer = buffer.slice(boundary + 2);
							await handleEvent(controller, rawEvent);
							_n++;
						}
						const _proc = performance.now() - _p0;
						_lastRead = performance.now();
						// desiredSize goes negative as we buffer ahead of the consumer; -desiredSize =
						// how many events we've queued that the renderer hasn't drained yet. Large is
						// FINE now (it means we're successfully decoupled and buffering ahead).
						const _ahead = controller.desiredSize == null ? 0 : Math.max(0, -controller.desiredSize);
						if (_ahead > _maxAhead) _maxAhead = _ahead;
						if (_imgDiagOn() && (_gap > 150 || _proc > 16 || _n > 8)) {
							_diag(`chunk#${_chunkNo}: ${_n} evt, ${_bytes}B | waitBeforeChunk=${Math.round(_gap)}ms | ourProcTime=${Math.round(_proc)}ms | queuedAhead=${_ahead}` +
								(_gap > 150 && _proc < 8 ? ' | NETWORK GAP (should now be rare)' : '') +
								(_proc > 16 ? ' | OUR processing (injection/measure)' : ''));
						}
					}
				} catch (e) {
					if (!_cancelled) { try { controller.error(e); } catch (_) {} }
				}
			})();
		},
		cancel(reason) {
			_cancelled = true;
			try { reader.cancel(reason); } catch (e) {}
		}
	});
}

// ==== FETCH INTERCEPTION — inject test markers into tool_use/thinking near image results ====

// When we rebuild a Response around bytes the browser has ALREADY decoded, we must not copy
// the transport/encoding headers of the original. The live completion SSE arrives with
// content-encoding: br (Brotli, decompressed by the network stack before our reader sees it);
// blindly copying that header labels our plain-text stream as Brotli. Same for content-length
// (describes the compressed original) and transfer-encoding.
function sanitizedHeaders(response) {
	const h = new Headers(response.headers);
	h.delete('content-encoding');
	h.delete('content-length');
	h.delete('transfer-encoding');
	return h;
}

const _imageExtractorOriginalFetch = window.fetch;
window.fetch = async (...args) => {
	const [input, config] = args;

	let url;
	if (input instanceof URL) url = input.href;
	else if (typeof input === 'string') url = input;
	else if (input instanceof Request) url = input.url;

	// Live streaming: inject galleries into the completion SSE stream as tool results arrive.
	if (url &&
		(url.includes('/completion') || url.includes('/retry_completion')) &&
		config?.method === 'POST') {

		if (!_galleryConfig().enabled) {
			_diag('wrapper skipped — gallery injection disabled in settings');
			return _imageExtractorOriginalFetch(...args);
		}

		// Only wrap conversations known to contain generated images (flagged by the
		// load-time path). Everything else gets the native stream, untouched — JS
		// re-piping janks streaming on some machines.
		const convId = _convIdFromUrl(url);
		if (!_conversationHasImages(convId)) {
			_diag('wrapper skipped — conversation has no image history', convId);
			return _imageExtractorOriginalFetch(...args);
		}

		const response = await _imageExtractorOriginalFetch(...args);
		if (!response.body) return response;

		// DIAGNOSTIC kill-switch: set localStorage['claude_qol_img_nowrap']='1' to bypass our
		// stream wrapper entirely (pass the native response straight through). Lets us A/B test
		// live whether the wrapper is the cause of the streaming jank — no rebuild needed.
		try {
			if (localStorage.getItem('claude_qol_img_nowrap') === '1') {
				_diag('WRAPPER BYPASSED (claude_qol_img_nowrap=1) — native stream passed through');
				return response;
			}
		} catch (e) { /* ignore */ }

		let orgId = null;
		try { orgId = getOrgId(); } catch (e) { /* no org id → cannot build preview URLs */ }
		if (!orgId) return response;

		try {
			const transformed = createImageInjectingStream(response.body, orgId);
			return new Response(transformed, {
				status: response.status,
				statusText: response.statusText,
				headers: sanitizedHeaders(response)
			});
		} catch (e) {
			console.error('[QOL-ImageExtractor] Failed to wrap completion stream, passing through:', e);
			return response;
		}
	}

	if (url &&
		url.includes('/chat_conversations/') &&
		url.includes('rendering_mode=messages') &&
		(!config || config.method === 'GET' || !config.method) &&
		_galleryConfig().enabled) {

		const response = await _imageExtractorOriginalFetch(...args);
		const data = await response.json();

		if (data?.chat_messages) {
			const convId = _convIdFromUrl(url);
			// Org ID for building preview URLs when msg.files is empty (new API shape).
			let orgId = null;
			try { orgId = getOrgId(); } catch (e) { /* fail soft — fall back to file URLs */ }

			for (const msg of data.chat_messages) {
				if (msg.sender === 'human') continue;
				const content = msg.content;
				if (!content) continue;

				// Build file lookup map (may be empty on the new API shape)
				const fileMap = new Map();
				for (const f of msg.files || []) {
					fileMap.set(f.file_uuid || f.uuid, f);
				}

				// Rebuild the content in one forward pass. Images from a run of tool_results are
				// queued and flushed — in generation order, _galleryLimit() per gallery, a
				// separator between galleries — right before the next text block (so the renderer
				// draws them after the collapsed tool run), or at the end of the message.
				// (An earlier version spliced galleries in backwards from a shared insertion point,
				// which reversed every such run. Don't go back to that.)
				const rebuilt = [];
				let pending = []; // gallery entries awaiting the next text block
				const flush = () => {
					chunkGalleryEntries(pending).forEach((chunk, n) => {
						if (n > 0) rebuilt.push({ type: 'text', text: GALLERY_SEPARATOR_TEXT, uuid: crypto.randomUUID() });
						rebuilt.push(...buildGalleryPair(chunk));
					});
					pending = [];
				};

				for (let i = 0; i < content.length; i++) {
					const item = content[i];
					if (item.type === 'text' && pending.length) flush();
					rebuilt.push(item);

					if (item.type !== 'tool_result') continue;
					if (!item.content?.some(c => c.type === 'image')) continue;

					// Flag on detection (not on successful gallery build) so future completions
					// in this conversation get the live wrapper even if this build fails.
					_markConversationHasImages(convId);

					// Prompt from the preceding tool_use, if any
					const precedingToolUse = i > 0 && content[i - 1].type === 'tool_use' ? content[i - 1] : null;
					const prompt = precedingToolUse?.input?.prompt || '';

					// Collect all image items from this tool_result. Resolve URL from the
					// file entry if present, otherwise build it ourselves, then measure
					// dimensions in parallel.
					const entries = await Promise.all(item.content.map(async (c) => {
						if (c.type !== 'image') return null;
						const file = fileMap.get(c.file_uuid);

						let imageUrl = file?.preview_url || file?.thumbnail_url;
						if (!imageUrl && orgId) {
							imageUrl = `https://claude.ai/api/${orgId}/files/${c.file_uuid}/preview`;
						}
						if (!imageUrl) return null; // no file entry and no orgId → cannot build

						// The API serves preview_url root-relative ("/api/.../preview"). The gallery
						// renderer treats images[].url as an external source and silently renders
						// nothing for a relative path, so always hand it an absolute URL.
						if (imageUrl.startsWith('/')) {
							imageUrl = new URL(imageUrl, location.origin).href;
						}

						// Prefer dimensions from the file asset; otherwise measure the preview.
						const asset = file?.preview_asset || file?.thumbnail_asset || {};
						let dims = { width: asset.image_width, height: asset.image_height };
						if (!dims.width || !dims.height) {
							dims = await getImageDimensions(c.file_uuid, imageUrl);
						}

						return { image: buildGalleryImage(c.file_uuid, imageUrl, dims, prompt), prompt };
					}));
					pending.push(...entries.filter(Boolean));
				}
				if (pending.length) flush();
				msg.content = rebuilt;
			}
		}

		return new Response(JSON.stringify(data), {
			status: response.status,
			statusText: response.statusText,
			headers: sanitizedHeaders(response)
		});
	}

	return _imageExtractorOriginalFetch(...args);
};

// Inject styles for the injected image galleries
(function () {
	const style = document.createElement('style');
	style.textContent = `
		/* Make injected inline image galleries full width */
		div.my-2 > button:has(> img[src*="/files/"][src$="/preview"]) {
			width: 85% !important;
			height: auto !important;
		}
		div.my-2 > button > img[src*="/files/"][src$="/preview"] {
			height: auto !important;
			object-fit: contain !important;
		}
	`;
	function appendStyle() {
		if (document.head) {
			document.head.appendChild(style);
		} else {
			document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
		}
	}
	appendStyle();
})();
