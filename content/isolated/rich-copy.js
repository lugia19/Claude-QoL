// rich-copy.js (ISOLATED world)
// "Copy as rich text" next to Claude's native copy actions: a button beside the Copy button of
// content blocks like email drafts, and an item after "Copy as Markdown" in an artifact's menu.
// Both click the native copy, and the main-world interceptor converts the markdown to HTML.
// Everything is matched by icon glyph, testid and structure, never by (localized) text.

(function () {
	'use strict';

	const RICH_COPY_CLASS = 'qol-rich-copy-btn';

	const RICH_COPY_SVG = `<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="flex-shrink: 0;"><path d="M12.5 3A1.5 1.5 0 0 1 14 4.5V6h1.5A1.5 1.5 0 0 1 17 7.5v8a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 6 15.5V14H4.5A1.5 1.5 0 0 1 3 12.5v-8A1.5 1.5 0 0 1 4.5 3zm1.5 9.5a1.5 1.5 0 0 1-1.5 1.5H7v1.5a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5v-8a.5.5 0 0 0-.5-.5H14zM4.5 4a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5v-8a.5.5 0 0 0-.5-.5z"/><rect x="5.5" y="6.5" width="5" height="1" rx="0.5"/><rect x="5.5" y="9" width="5" height="1" rx="0.5"/><rect x="5.5" y="11.5" width="3" height="1" rx="0.5"/></svg>`;

	const CHECK_SVG = `<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="flex-shrink: 0;"><path d="M15.3 5.3a1 1 0 0 1 1.4 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 1.4-1.4L8 12.58l7.3-7.3z"/></svg>`;

	// claude.ai's icon font glyph for "copy". Duplicate uses it too, so it's never enough alone.
	const COPY_ICON_GLYPH = '';

	function iconGlyph(el) {
		return el.querySelector('[data-cds="Icon"]')?.textContent ?? '';
	}

	// Swap the icon for ours and the first text (the label) for `label`. Icon first, so its glyph
	// isn't the text node that gets relabeled.
	function restyleClone(clone, label) {
		const iconEl = clone.querySelector('[data-cds="Icon"]');
		if (iconEl) {
			iconEl.innerHTML = RICH_COPY_SVG;
		} else {
			clone.insertAdjacentHTML('afterbegin', RICH_COPY_SVG);
		}
		const labelNode = [...clone.querySelectorAll('span')]
			.flatMap((span) => [...span.childNodes])
			.find((node) => node.nodeType === Node.TEXT_NODE && node.nodeValue.trim());
		if (labelNode) labelNode.nodeValue = label;
		clone.classList.add(RICH_COPY_CLASS);
		clone.removeAttribute('id');
		clone.removeAttribute('data-testid');
		clone.removeAttribute('data-state');
	}

	async function copyAsRichText(nativeCopy, richBtn = null) {
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

		nativeCopy.click();

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
			if (!richBtn) return; // a menu item: the menu is already gone
			const original = richBtn.innerHTML;
			richBtn.innerHTML = CHECK_SVG;
			setTimeout(() => { richBtn.innerHTML = original; }, 1500);
		} else {
			showClaudeAlert(localize('common.error'), localize('richcopy.copy_failed', { error: result.error || localize('richcopy.unknown_error') }));
		}
	}

	// ======== Content blocks (email drafts and the like) ========

	// The labeled Copy button of a content block's action row. Not the message toolbar's (it
	// already copies HTML) and not a code block's (code isn't markdown).
	function isBlockCopyButton(btn) {
		if (btn.classList.contains(RICH_COPY_CLASS)) return false;
		if (iconGlyph(btn) !== COPY_ICON_GLYPH) return false;
		if (btn.dataset.testid === 'action-bar-copy') return false;
		if (btn.closest('[data-cds="MessageActions"]')) return false;
		if (btn.closest('[role="group"]')?.querySelector('pre')) return false;
		return true;
	}

	function injectBlockButtons() {
		for (const copyBtn of document.querySelectorAll('button[data-cds="Button"]')) {
			if (!isBlockCopyButton(copyBtn)) continue;

			// Sit next to the whole split dropdown when the copy button lives inside one.
			const anchor = copyBtn.closest('[data-cds="SplitDropdownButton"]') || copyBtn;
			if (anchor.parentElement?.querySelector('.' + RICH_COPY_CLASS)) continue;

			const btn = copyBtn.cloneNode(true);
			// Not "Copy" again right next to the native one.
			restyleClone(btn, localize('richcopy.copy_rich_text_label'));
			btn.setAttribute('aria-label', localize('richcopy.copy_as_rich_text'));
			btn.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				copyAsRichText(copyBtn, btn);
			});
			createClaudeTooltip(btn, localize('richcopy.copy_as_rich_text'));
			anchor.insertAdjacentElement('afterend', btn);
		}
	}

	// ======== Artifact menu ========

	// The artifact's title menu (the only one with frame-title-menu-* items): its "Copy as
	// Markdown" is the copy-glyph item without a testid (Duplicate shares the glyph, but has one).
	function injectMenuItem(menu) {
		if (!menu.querySelector('[data-testid^="frame-title-menu-"]')) return;
		if (menu.querySelector('.' + RICH_COPY_CLASS)) return;
		const copyItem = [...menu.querySelectorAll('[role="menuitem"]:not([data-testid])')]
			.find((item) => iconGlyph(item) === COPY_ICON_GLYPH);
		if (!copyItem) return;

		const item = copyItem.cloneNode(true);
		restyleClone(item, localize('richcopy.copy_as_rich_text'));
		// The menu only highlights the items it knows about.
		item.addEventListener('pointerenter', () => item.setAttribute('data-highlighted', ''));
		item.addEventListener('pointerleave', () => item.removeAttribute('data-highlighted'));
		item.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			copyAsRichText(copyItem); // closes the menu, like the native item
		});
		copyItem.insertAdjacentElement('afterend', item);
	}

	// claude.ai mounts menus in #portal-root; watching only that stays cheap while a reply streams.
	// Re-attached if the page ever replaces the element.
	function injectMenuItems() {
		for (const menu of document.querySelectorAll('#portal-root [role="menu"]')) injectMenuItem(menu);
	}
	const portalObserver = new MutationObserver(injectMenuItems);
	let observedPortalRoot = null;

	function watchMenus() {
		const portalRoot = document.getElementById('portal-root');
		if (!portalRoot || portalRoot === observedPortalRoot) return;
		portalObserver.disconnect();
		portalObserver.observe(portalRoot, { childList: true, subtree: true });
		observedPortalRoot = portalRoot;
		injectMenuItems(); // a menu that was already open when observing started
	}

	function initialize() {
		setInterval(() => {
			injectBlockButtons();
			watchMenus();
		}, 1000);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initialize);
	} else {
		initialize();
	}
})();
