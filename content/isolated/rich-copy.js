// rich-copy.js (ISOLATED world)
// Adds "Copy as Rich Text" buttons next to copy buttons on Claude's content blocks.
// Clicks the native copy button, then the main-world interceptor converts markdown to HTML.

(function () {
	'use strict';

	const RICH_COPY_CLASS = 'qol-rich-copy-btn';

	const RICH_COPY_SVG = `<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="flex-shrink: 0;"><path d="M12.5 3A1.5 1.5 0 0 1 14 4.5V6h1.5A1.5 1.5 0 0 1 17 7.5v8a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 6 15.5V14H4.5A1.5 1.5 0 0 1 3 12.5v-8A1.5 1.5 0 0 1 4.5 3zm1.5 9.5a1.5 1.5 0 0 1-1.5 1.5H7v1.5a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5v-8a.5.5 0 0 0-.5-.5H14zM4.5 4a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5v-8a.5.5 0 0 0-.5-.5z"/><rect x="5.5" y="6.5" width="5" height="1" rx="0.5"/><rect x="5.5" y="9" width="5" height="1" rx="0.5"/><rect x="5.5" y="11.5" width="3" height="1" rx="0.5"/></svg>`;

	const CHECK_SVG = `<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="flex-shrink: 0;"><path d="M15.3 5.3a1 1 0 0 1 1.4 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 1.4-1.4L8 12.58l7.3-7.3z"/></svg>`;

	const MESSAGE_ACTIONS_SELECTOR = '[role="toolbar"][aria-label="Message actions"], [role="group"][aria-label="Message actions"], [data-cds="MessageActions"]';

	function findContentBlockCopyButtons() {
		const results = [];
		const copyButtons = document.querySelectorAll('button[aria-label="Copy message"]');

		for (const btn of copyButtons) {
			if (btn.dataset.testid === 'action-bar-copy') continue;
			if (btn.closest(MESSAGE_ACTIONS_SELECTOR)) continue;
			if (btn.nextElementSibling?.classList.contains(RICH_COPY_CLASS)) continue;

			results.push(btn);
		}

		return results;
	}

	// Copy buttons in artifact/file action rows carry no aria-label or testid, just an
	// icon-font glyph and a "Copy" label. Never assume a split dropdown's primary button
	// is the copy one — that slot also holds actions like "Send via Gmail".
	const COPY_ICON_GLYPH = '\ue056';

	function isNativeCopyButton(btn) {
		if (btn.classList.contains(RICH_COPY_CLASS)) return false;
		if (btn.dataset.testid === 'action-bar-copy') return false;
		// The message action bar has its own copy button, handled above.
		if (btn.closest(MESSAGE_ACTIONS_SELECTOR)) return false;

		const label = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
		if (label && label !== 'copy') return false;

		const icon = btn.querySelector('[data-cds="Icon"]');
		if (icon && icon.textContent === COPY_ICON_GLYPH) return true;

		return (btn.textContent || '').trim().toLowerCase() === 'copy';
	}

	function findArtifactCopyButtons() {
		const results = [];

		for (const copyBtn of document.querySelectorAll('button[data-cds="Button"]')) {
			if (!isNativeCopyButton(copyBtn)) continue;

			// Sit next to the whole split dropdown when the copy button lives inside one.
			const anchor = copyBtn.closest('[data-cds="SplitDropdownButton"]') || copyBtn;
			const parent = anchor.parentElement;
			if (!parent) continue;
			if (parent.querySelector('.' + RICH_COPY_CLASS)) continue;

			results.push({ copyBtn, anchor });
		}

		return results;
	}

	async function copyAsRichText(nativeCopyBtn, richBtn) {
		window.postMessage({ type: 'rich-copy-activate' }, '*');

		await new Promise((resolve) => {
			const listener = (event) => {
				if (event.data.type === 'rich-copy-ready') {
					window.removeEventListener('message', listener);
					resolve();
				}
			};
			window.addEventListener('message', listener);
			setTimeout(() => {
				window.removeEventListener('message', listener);
				resolve();
			}, 100);
		});

		nativeCopyBtn.click();

		const result = await new Promise((resolve) => {
			const listener = (event) => {
				if (event.data.type === 'rich-copy-done' || event.data.type === 'rich-copy-error') {
					window.removeEventListener('message', listener);
					resolve(event.data);
				}
			};
			window.addEventListener('message', listener);
			setTimeout(() => {
				window.removeEventListener('message', listener);
				resolve({ type: 'rich-copy-error', error: localize('richcopy.timeout') });
			}, 2000);
		});

		if (result.type === 'rich-copy-done') {
			const original = richBtn.innerHTML;
			richBtn.innerHTML = CHECK_SVG;
			setTimeout(() => { richBtn.innerHTML = original; }, 1500);
		} else {
			showClaudeAlert(localize('common.error'), localize('richcopy.copy_failed', { error: result.error || localize('richcopy.unknown_error') }));
		}
	}

	function createRichCopyButton(nativeCopyBtn) {
		const btn = nativeCopyBtn.cloneNode(false);
		btn.className = nativeCopyBtn.className + ' ' + RICH_COPY_CLASS;
		btn.setAttribute('aria-label', localize('richcopy.copy_as_rich_text'));
		btn.removeAttribute('data-testid');

		const iconSpans = nativeCopyBtn.querySelectorAll(':scope > span');
		for (const span of iconSpans) {
			const clone = span.cloneNode(true);
			const iconEl = clone.querySelector('[data-cds="Icon"]');
			if (iconEl) {
				iconEl.innerHTML = RICH_COPY_SVG;
			}
			btn.appendChild(clone);
		}

		if (!btn.querySelector('svg')) {
			btn.innerHTML = RICH_COPY_SVG;
		}

		btn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			copyAsRichText(nativeCopyBtn, btn);
		});

		createClaudeTooltip(btn, localize('richcopy.copy_as_rich_text'));

		return btn;
	}

	function createArtifactRichCopyButton(copyBtn) {
		const btn = copyBtn.cloneNode(true);
		btn.className = copyBtn.className + ' ' + RICH_COPY_CLASS;

		const iconEl = btn.querySelector('[data-cds="Icon"]');
		if (iconEl) {
			iconEl.innerHTML = RICH_COPY_SVG;
		} else {
			btn.innerHTML = RICH_COPY_SVG;
		}

		// Relabel so it doesn't read as a second "Copy" right next to the native one.
		const labelNode = [...btn.querySelectorAll('span')]
			.flatMap((span) => [...span.childNodes])
			.find((node) => node.nodeType === Node.TEXT_NODE && node.nodeValue.trim());
		if (labelNode) {
			labelNode.nodeValue = localize('richcopy.copy_rich_text_label');
		}

		btn.setAttribute('aria-label', localize('richcopy.copy_as_rich_text'));
		btn.removeAttribute('data-testid');
		btn.removeAttribute('data-state');

		btn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			copyAsRichText(copyBtn, btn);
		});

		createClaudeTooltip(btn, localize('richcopy.copy_as_rich_text'));

		return btn;
	}

	function injectButtons() {
		const copyButtons = findContentBlockCopyButtons();
		for (const copyBtn of copyButtons) {
			const richBtn = createRichCopyButton(copyBtn);
			copyBtn.insertAdjacentElement('afterend', richBtn);
		}

		const artifactTargets = findArtifactCopyButtons();
		for (const { copyBtn, anchor } of artifactTargets) {
			const richBtn = createArtifactRichCopyButton(copyBtn);
			anchor.insertAdjacentElement('afterend', richBtn);
		}
	}

	function initialize() {
		setInterval(injectButtons, 1000);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initialize);
	} else {
		initialize();
	}
})();
