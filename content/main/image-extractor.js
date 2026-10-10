// image-extractor.js (MAIN world, document_start, right after phantom-messages.js)
// Shows images that tools return (MCP/ComfyUI etc.) as full-size galleries. claude.ai draws them only
// as small thumbnails in the "Used <tool>" row; its own image search is drawn large, from a timeline
// group holding one display-card block whose display_content is an image_gallery. So after every tool
// run with result images we add groups of that shape (QolBardHost: snapshots, history pages, live
// updates), each carrying up to the user's per-gallery limit of the run's images. See
// docs/bard-rework.md, "Image galleries".
//
// A gallery group takes the same index as the run's last group: claude.ai draws a group that shares
// an index after the native one (ours keep their own order), so nothing else in the message has to be
// renumbered (which a streaming message couldn't do anyway: its later groups haven't arrived yet).
// Adjacent galleries merge into one strip of at most 3 images, so split galleries are kept apart by
// an inline text group holding a zero-width space: real text to the renderer (trim() keeps U+200B),
// invisible on screen, nothing to strip from copied or read-aloud text.
//
// Settings: mirrored to localStorage by content/isolated/image-gallery.js (they live in ISOLATED,
// and load after the first snapshot).
(function () {
	'use strict';
	const log = createLogger('ImageGallery');

	const CONFIG_KEY = 'claude_qol_image_gallery';
	const DIMS_CACHE_KEY = 'claude_qol_image_dims_cache';
	const FALLBACK_DIMS = { width: 1024, height: 1024 };
	const ZERO_WIDTH_SPACE = String.fromCharCode(0x200B); // the gallery break, see above

	function galleryConfig() {
		const defaults = { enabled: true, limitEnabled: false, limit: 3 };
		try {
			return { ...defaults, ...JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}') };
		} catch (e) {
			return defaults;
		}
	}

	// Images per gallery: Infinity without a limit. claude.ai shows at most 3 of a gallery inline (its
	// viewer pages through all of them), so the limit is how users get every image on screen.
	function galleryLimit() {
		const { limitEnabled, limit } = galleryConfig();
		return limitEnabled && limit >= 1 ? Math.floor(limit) : Infinity;
	}

	// ======== Image sizes ========
	// The gallery lays its tiles out by each image's size, which result_images don't carry. In order:
	// the size measured on an earlier load (cached by URL), the tool's own width/height or aspect-ratio
	// input, else a square placeholder while the preview is measured for next time. Never waits: the
	// snapshot shouldn't stall on image loads.

	const dimsCache = (() => {
		try {
			return new Map(Object.entries(JSON.parse(localStorage.getItem(DIMS_CACHE_KEY) || '{}')));
		} catch (e) {
			return new Map();
		}
	})();
	const measuring = new Set();

	function measure(url) {
		if (measuring.has(url)) return;
		measuring.add(url);
		const img = new Image();
		img.onload = () => {
			if (img.naturalWidth && img.naturalHeight) {
				dimsCache.set(url, { width: img.naturalWidth, height: img.naturalHeight });
				try {
					localStorage.setItem(DIMS_CACHE_KEY, JSON.stringify(Object.fromEntries(dimsCache)));
				} catch (e) { /* quota: measured again next load */ }
			}
		};
		img.src = url;
	}

	// Named aspect-ratio presets some image tools take instead of pixel sizes.
	const ASPECT_PRESETS = { square: [1, 1], portrait: [3, 4], landscape: [4, 3], tall: [9, 16], wide: [16, 9] };

	// An aspect-ratio value as {width, height}: a preset name ("wide"), "W:H" / "WxH" / "W/H", or a number.
	function aspectToDims(value) {
		if (typeof value === 'number' && value > 0) return { width: Math.round(value * 1000), height: 1000 };
		if (typeof value !== 'string') return null;
		const key = value.trim().toLowerCase();
		if (ASPECT_PRESETS[key]) return { width: ASPECT_PRESETS[key][0], height: ASPECT_PRESETS[key][1] };
		const m = key.match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/);
		return m && +m[1] > 0 && +m[2] > 0 ? { width: +m[1], height: +m[2] } : null;
	}

	// The tool's input as the row shows it (input_display.table: { label, value } rows, labels from the
	// tool's own schema): width/height, or an aspect ratio.
	function dimsFromInput(block) {
		const rows = block.input_display?.table?.rows ?? [];
		const value = (pattern) => rows.find(r => pattern.test(r.label ?? ''))?.value;
		const width = parseFloat(value(/^(image[\s_]?)?width$/i)), height = parseFloat(value(/^(image[\s_]?)?height$/i));
		if (width > 0 && height > 0) return { width, height };
		return aspectToDims(value(/aspect[\s_]?ratio/i));
	}

	function dimsFor(url, block) {
		const cached = dimsCache.get(url);
		if (cached) return cached;
		measure(url);
		return dimsFromInput(block) ?? FALLBACK_DIMS;
	}

	// ======== Galleries ========

	// conversationId -> { groups: Map(id -> { message_id, index, run }), runs: Map(run -> Map(blockId -> entries)) }.
	// Live updates carry only what changed, so a run's earlier images (and a block's group) come from here.
	const conversations = new Map();

	function stateFor(conversationId, reset) {
		if (reset || !conversations.has(conversationId)) conversations.set(conversationId, { groups: new Map(), runs: new Map() });
		return conversations.get(conversationId);
	}

	// i18n-core.js loads after this file: a snapshot can't, in practice, arrive before it does, but
	// fall back to English rather than throw (and lose the snapshot's galleries) if one ever did.
	const text = (key, english) => (typeof localize === 'function' ? localize(key) : english);

	const absolute = (url) => new URL(url, location.origin).href;
	const isOurs = (id) => typeof id === 'string' && id.includes('_qolgallery_');

	// One image_gallery item. Width scaled to 3840 (as the legacy injection did), so it's drawn full width.
	function galleryImage(url, dims, i) {
		const height = Math.round(dims.height * 3840 / dims.width);
		return { id: `img_${i + 1}`, url, thumbnail_url: url, title: text('images.generated_image', 'Generated image'), width: 3840, height, thumbnail_width: 3840, thumbnail_height: height };
	}

	// The gallery groups and blocks for one run, its images in order (by their group's current index,
	// then their block's), split by the user's limit.
	function buildRun(runId, run, anchor, knownGroups) {
		const groupIndex = (image) => knownGroups.get(image.groupId)?.index ?? 0;
		const images = [...run.values()].flat().sort((a, b) => groupIndex(a) - groupIndex(b) || a.blockIndex - b.blockIndex);
		const limit = galleryLimit();
		const groups = [], blocks = [];
		for (let start = 0, n = 0; start < images.length; start += limit, n++) {
			const chunk = images.slice(start, start + limit);
			const suffix = `${runId.replace(/^dgrp_/, '')}_${n}`;
			const groupId = `dgrp_qolgallery_${suffix}`;
			const label = chunk.length > 1 ? text('images.generated_images', 'Generated images') : text('images.generated_image', 'Generated image');
			if (n > 0) {
				groups.push({ id: `dgrp_qolgallery_break_${suffix}`, message_id: anchor.message_id, index: anchor.index, style: 'GROUP_STYLE_INLINE', is_complete: true });
				blocks.push({ id: `cblk_qolgallery_break_${suffix}`, display_group_id: `dgrp_qolgallery_break_${suffix}`, is_complete: true, text: ZERO_WIDTH_SPACE, text_format: { style: 'STYLE_MARKDOWN' } });
			}
			groups.push({ id: groupId, message_id: anchor.message_id, index: anchor.index, style: 'GROUP_STYLE_TIMELINE', summary: label, is_complete: true, summary_source: 'TITLE_SOURCE_LIFECYCLE' });
			blocks.push({
				id: `cblk_qolgallery_${suffix}`, display_group_id: groupId, is_complete: true, state: 'CONTENT_BLOCK_STATE_COMPLETE',
				title: label, icon: { builtin: { type: 'BUILTIN_ICON_TYPE_IMAGE' } }, title_source: 'TITLE_SOURCE_AUTHORED',
				row_kind: 'TOOL_ROW_KIND_DISPLAY_CARD', input_visibility: 'INPUT_VISIBILITY_SHOWN',
				tool_display_name: 'qol_image_gallery', tool_use_id: `toolu_qolgallery_${suffix}`,
				display_content: { image_gallery: { images: chunk.map(({ url, dims }, i) => galleryImage(url, dims, start + i)) } },
			});
		}
		return { groups, blocks };
	}

	// Adds (or refreshes) the galleries of every run this update brings images for. A snapshot starts
	// the conversation's state over; history pages and live updates add to it.
	function addGalleries(update, ctx, reset) {
		if (!ctx.conversationId || !galleryConfig().enabled) return false;
		const state = stateFor(ctx.conversationId, reset);
		const touched = new Set();
		const ownGroups = (update.display_groups ?? []).filter(g => !isOurs(g.id));
		for (const g of ownGroups) {
			const entry = { message_id: g.message_id, index: g.index ?? 0, run: g.run_anchor_group_id || g.id };
			// A run that already has a gallery and gains a group (or one moves) re-anchors it after its new end.
			if (state.runs.has(entry.run) && state.groups.get(g.id)?.index !== entry.index) touched.add(entry.run);
			state.groups.set(g.id, entry);
		}

		for (const block of update.content_blocks ?? []) {
			if (!block.result_images?.length || isOurs(block.id)) continue;
			const group = state.groups.get(block.display_group_id);
			if (!group) continue;
			if (!state.runs.has(group.run)) state.runs.set(group.run, new Map());
			state.runs.get(group.run).set(block.id, block.result_images.map(img => {
				const url = absolute(img.url);
				return { url, dims: dimsFor(url, block), groupId: block.display_group_id, blockIndex: block.index ?? 0 };
			}));
			touched.add(group.run);
		}
		if (!touched.size) return false;

		const groups = update.display_groups ??= [];
		const blocks = update.content_blocks ??= [];
		for (const runId of touched) {
			// Shown after the run's last group (the highest index among its groups).
			const anchor = [...state.groups.values()].filter(g => g.run === runId).reduce((a, b) => (b.index > a.index ? b : a));
			const built = buildRun(runId, state.runs.get(runId), anchor, state.groups);
			for (const g of built.groups) {
				const at = groups.findIndex(x => x.id === g.id);
				if (at >= 0) groups[at] = g; else groups.push(g);
			}
			for (const b of built.blocks) {
				const at = blocks.findIndex(x => x.id === b.id);
				if (at >= 0) blocks[at] = b; else blocks.push(b);
			}
		}
		return true;
	}

	QolBardHost.onSnapshot((update, ctx) => addGalleries(update, ctx, true), { label: 'image-gallery' });
	QolBardHost.onHistoryPage((update, ctx) => addGalleries(update, ctx, false), { label: 'image-gallery' });
	QolBardHost.onLiveUpdate((update, ctx) => addGalleries(update, ctx, false), { label: 'image-gallery' });
	log('image galleries', galleryConfig().enabled ? 'on' : 'off');
})();
