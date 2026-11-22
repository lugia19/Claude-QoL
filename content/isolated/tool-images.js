// tool-images.js
// Shows the images that tools return (MCP/ComfyUI etc.) full size. claude.ai draws them only as small
// thumbnails in the tool's "Used <tool>" row (the row's [data-cds-row-media] slot); this restyles
// that slot so its images sit full width under the row's title, and loads each one's /preview (the
// full image) instead of its /thumbnail (300px). Several images in one row (one call returning
// several, or back-to-back calls folded into one row) wrap side by side, on narrow screens too, where
// claude.ai itself shows only the last one and a "+N" count. Clicking still opens claude.ai's own
// viewer: these are its elements, only restyled.
//
// Until 3.2.4 this was content/main/image-extractor.js, which added claude.ai's own image-gallery
// cards to the stream. claude.ai now drops gallery images whose URL is one of its own API paths
// (/api/, /v1/, ...), which every uploaded tool image is. See docs/bard-rework.md, "Tool images".
//
// Setting: "Show tool images full size" in the "Extension settings" gear modal (extension-settings.js),
// applied on load (saving reloads the page).
(function () {
	'use strict';
	const log = createLogger('ToolImages');

	const FILE_IMG = 'img[src*="/files/"]'; // an uploaded file's image (/api/<org>/files/<id>/...)
	const SLOT = `[data-cds-row-media]:has(${FILE_IMG})`;
	const ROW = `[data-cds-row]:has(> [data-cds-row-media] ${FILE_IMG})`; // :has() can't nest
	// The slot's elements are found by what they hold, not by depth: every div around the images
	// (the slot's wrapper, the strip, each image's own wrapper), the strip (its children are the
	// wrappers), and each image's wrapper (narrow screens hide all but the last).
	const CSS = `
		${ROW} { flex-wrap: wrap !important; }
		${ROW} > [id$="-text"] { max-width: calc(100% - 2rem); }
		${SLOT} { order: 99 !important; flex-basis: 100% !important; width: 100% !important; height: auto !important; margin: 0.5rem 0 0 !important; display: block !important; }
		${SLOT} span[aria-hidden="true"] { display: none !important; }
		${SLOT} div:has(button > ${FILE_IMG}) { display: block !important; height: auto !important; margin: 0 !important; }
		${SLOT} div:has(> div > button > ${FILE_IMG}) { display: flex !important; flex-wrap: wrap; gap: 0.5rem !important; }
		${SLOT} div:has(> button > ${FILE_IMG}) { display: contents !important; }
		[data-cds-row-media] button:has(> ${FILE_IMG}) { height: auto !important; max-width: min(100%, 28rem) !important; border-radius: 0.75rem !important; }
		[data-cds-row-media] button > ${FILE_IMG} { height: auto !important; width: 100% !important; max-width: 100% !important; }
	`;
	const THUMBNAIL = `[data-cds-row-media] ${FILE_IMG}[src$="/thumbnail"]`;

	function toPreview(img) {
		img.setAttribute('src', img.getAttribute('src').replace(/\/thumbnail$/, '/preview'));
	}

	// Swapped as the image is added (or its src set), before the browser fetches the thumbnail. React
	// sets src once per element, so the swap sticks; a remounted row is a new element, swapped again.
	function onMutations(records) {
		for (const record of records) {
			if (record.type === 'attributes') {
				if (record.target.matches(THUMBNAIL)) toPreview(record.target);
				continue;
			}
			for (const node of record.addedNodes) {
				if (node.nodeType !== Node.ELEMENT_NODE) continue;
				if (node.matches(THUMBNAIL)) toPreview(node);
				else node.querySelectorAll(THUMBNAIL).forEach(toPreview);
			}
		}
	}

	async function initialize() {
		if (!await settingsRegistry.get(SETTINGS_KEYS.TOOL_IMAGES.ENABLED)) {
			log('full-size tool images off');
			return;
		}
		const style = document.createElement('style');
		style.id = 'qol-tool-images';
		style.textContent = CSS;
		document.head.appendChild(style);
		document.querySelectorAll(THUMBNAIL).forEach(toPreview);
		new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
		log('full-size tool images on');
	}

	// Left behind by the gallery version (see above). Drop this after a few releases.
	try {
		localStorage.removeItem('claude_qol_image_dims');
	} catch (e) { /* storage unavailable */ }
	removeOrgMirrors('image_gallery');

	initialize();
})();
