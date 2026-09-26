// header-buttons.js
// Top-right button injection: page layouts + ButtonBar. No IIFE - shared global context.

// ======== PAGE LAYOUTS ========
// Modular layout registry for button injection targets.
// Each layout has match() to detect the page, getAnchor() to find the DOM insertion point.
// Checked in order; first match() wins.
// Page layouts for top-right ButtonBar injection only.
// Each layout defines where the toolbox button container is anchored in the DOM.
// Code and cowork layouts must be checked before chat/home to avoid false matches.
const pageLayouts = {
	codeHome: {
		group: 'codeHome',
		match() { return !!window.location.pathname.match(/\/claude-code-desktop\/draft_/); },
		// Disabled for code web (aka claude.ai/code) for now due to being totally different.
		getAnchor() {
			const mainContent = document.getElementById('main-content');
			if (!mainContent) return null;
			return { parent: mainContent, referenceNode: null, mode: 'self-container' };
		},
	},
	codeChat: {
		group: 'codeChat',
		match() {
			return !!window.location.pathname.match(/\/claude-code-desktop\/session_/)
			//|| !!window.location.pathname.match(/\/code\//);	// Disable it on web for now.
		},
		getAnchor() {
			const sticky = document.querySelector('.sticky.top-0.z-20');
			if (!sticky) return null;
			const row = sticky.querySelector('.flex.items-center.gap-1');
			if (!row) return null;
			// Insert before the share/actions container (last child of the row)
			const actionsContainer = row.lastElementChild;
			return { parent: row, referenceNode: actionsContainer, mode: 'inline' };
		},
	},
	coworkHome: {
		group: 'coworkHome',
		match() {
			return window.location.pathname === '/task/new'
				&& !!document.querySelector('.dframe-pane-header');
		},
		getAnchor() {
			const header = document.querySelector('.dframe-pane-header');
			if (!header) return null;
			const actionsSlot = header.querySelector('#dframe-header-actions-slot');
			return { parent: header, referenceNode: actionsSlot || null, mode: 'inline' };
		},
	},
	coworkChat: {
		group: 'coworkChat',
		// Match only cowork chat sessions: cloud (/cowork/cse_...) and desktop local
		// (/cowork/local_...). Other /cowork/ paths (e.g. /cowork/project/...) must not match.
		match() { return /^\/cowork\/(cse_|local_)/.test(window.location.pathname); },
		getAnchor() {
			const actionsSlot = document.querySelector('#dframe-header-actions-slot');
			if (!actionsSlot) return null;
			return { parent: actionsSlot.parentElement, referenceNode: actionsSlot, mode: 'inline', fitToHeader: true };
		},
	},
	chatActions: {
		group: 'chat',
		match() {
			return isChatPage()
				&& !!document.querySelector('[data-testid="chat-actions"]');
		},
		getAnchor() {
			const chatActions = document.querySelector('[data-testid="chat-actions"]');
			if (!chatActions) return null;
			const isMobile = isMobileLayout();
			if (isMobile) {
				const header = chatActions.closest('header');
				if (header) {
					return { parent: header, referenceNode: null, mode: 'inline' };
				}
			}
			return { parent: chatActions.parentElement, referenceNode: chatActions, mode: 'inline', fitToHeader: true };
		},
	},
	chatWiggle: {
		group: 'chat',
		match() {
			const wiggle = document.querySelector('[data-testid="wiggle-controls-actions"]');
			return isChatPage()
				&& !document.querySelector('[data-testid="chat-actions"]')
				&& !!wiggle && !wiggle.closest('[inert]');
		},
		getAnchor() {
			const wiggle = document.querySelector('[data-testid="wiggle-controls-actions"]');
			if (!wiggle) return null;
			const actionsSlot = wiggle.closest('#dframe-header-actions-slot');
			if (actionsSlot) {
				return { parent: actionsSlot.parentElement, referenceNode: actionsSlot, mode: 'inline', fitToHeader: true };
			}
			const isMobile = isMobileLayout();
			if (isMobile) {
				return { parent: wiggle.parentElement, referenceNode: wiggle.nextElementSibling, mode: 'wiggle' };
			}
			return { parent: wiggle.parentElement.parentElement, referenceNode: null, mode: 'wiggle' };
		},
	},
	homeWeb: {
		group: 'home',
		match() {
			const isHome = isHomePage();
			if (!isHome) return false;
			if (document.querySelector('#dframe-header-actions-slot')) return true;
			const mainContent = document.getElementById('main-content');
			return !!mainContent?.querySelector('[class*="look-around"]');
		},
		getAnchor() {
			// New dframe layout: native buttons live in the header actions slot
			const actionsSlot = document.querySelector('#dframe-header-actions-slot');
			if (actionsSlot) {
				return { parent: actionsSlot.parentElement, referenceNode: actionsSlot, mode: 'inline' };
			}
			// Legacy layout: ghost button inside #main-content
			const mainContent = document.getElementById('main-content');
			const ghost = mainContent?.querySelector('[class*="look-around"]');
			if (!ghost) return null;
			const zHeader = ghost.closest('.z-header');
			if (!zHeader) return null;
			let ref = ghost;
			while (ref.parentElement !== zHeader) ref = ref.parentElement;
			return { parent: zHeader, referenceNode: ref, mode: 'inline' };
		},
	},
	homeDesktop: {
		group: 'home',
		match() {
			const isHome = isHomePage();
			return isHome && !!document.querySelector('.dframe-pane-header');
		},
		getAnchor() {
			const header = document.querySelector('.dframe-pane-header');
			if (!header) return null;
			const actionsSlot = header.querySelector('#dframe-header-actions-slot');
			return { parent: header, referenceNode: actionsSlot || null, mode: 'inline' };
		},
	},
	project: {
		group: 'project',
		match() {
			return isProjectPage();
		},
		getAnchor() {
			const nativeActions = document.querySelector('.flex.items-center.gap-1.ml-auto');
			if (!nativeActions) return null;
			const starWrapper = nativeActions.querySelector('[data-state]');
			return { parent: nativeActions, referenceNode: starWrapper || null, mode: 'inline' };
		},
	},
};

// ======== BUTTON BAR SINGLETON ========
// All top right buttons must be in ISOLATED only!
// Callers register buttons once; ButtonBar handles polling, injection, ordering, and mobile.
const ButtonBar = {
	BUTTON_PRIORITY: [
		'image-gallery-button',
		'banner-watcher-button',
		'search-button',
		'navigation-button',
		'preset-switcher-button',
		'export-button',
		'tts-settings-button',
		'language-settings-button',
	],

	_registrations: new Map(),
	_mobileModalButtons: [],
	_pollInterval: null,
	_container: null,
	_currentGroup: null,
	// Buttons moved into the "More actions" menu because the header ran out of width (see
	// _fitToHeader). Insertion order is collapse order, so the last entry is the first to come back.
	// Each maps to the button's width when it was collapsed, which is what restoring it will cost.
	_overflowed: new Map(),
	_fitScope: null,
	_fitScopeGroup: null,
	_fitObservedHeader: null,
	_fitResizeObserver: null,
	_fitMutationObserver: null,
	_fitScheduled: false,

	getCurrentGroup() {
		return this._currentGroup;
	},

	updateTooltip(buttonClass, text) {
		const reg = this._registrations.get(buttonClass);
		if (reg) reg.tooltip = text;
		const button = this._container?.querySelector('.' + buttonClass);
		if (button?.tooltip) button.tooltip.updateText(text);
		const modalEntry = this._mobileModalButtons.find(b => b.class === buttonClass);
		if (modalEntry) modalEntry.tooltip = text;
	},

	register({ buttonClass, createFn, tooltip = '', forceDisplayOnMobile = false, pages, onInjected = null, menuVisible = null }) {
		if (this._registrations.has(buttonClass)) return;
		this._registrations.set(buttonClass, { buttonClass, createFn, tooltip, forceDisplayOnMobile, pages, onInjected, menuVisible });
		if (!this._pollInterval) {
			this._pollInterval = setInterval(() => this._tick(), 1000);
			this._tick();
		}
	},

	_detectLayout() {
		for (const [name, layout] of Object.entries(pageLayouts)) {
			if (layout.match()) {
				return { name, ...layout };
			}
		}
		return null;
	},

	_tick() {
		const layout = this._detectLayout();
		if (!layout) {
			document.querySelectorAll('.toolbox-buttons').forEach(el => el.remove());
			this._container = null;
			this._currentGroup = null;
			return;
		}

		this._currentGroup = layout.group;
		const anchor = layout.getAnchor();
		if (!anchor) return;

		this._cleanStaleContainers(anchor);
		this._ensureContainer(anchor);
		if (!this._container) return;

		// What overflowed belongs to one header on one page type. Going straight from one fitted
		// header to another (a narrow chat to a narrow cowork chat) keeps us in fit mode throughout,
		// so nothing else would clear it, and the next page would start with the last page's buttons
		// hidden - some of which it doesn't even have.
		const fitScope = this._container.parentElement;
		if (fitScope !== this._fitScope || layout.group !== this._fitScopeGroup) {
			this._fitScope = fitScope;
			this._fitScopeGroup = layout.group;
			this._overflowed.clear();
		}

		this._syncButtons(layout.group);

		if (anchor.mode === 'wiggle') {
			this._updateWigglePosition(anchor);
		} else if (anchor.mode === 'inline') {
			this._updateInlineOffset();
		}

		this._observeHeaderForFit(anchor);
		this._fitToHeader();
	},

	// ======== HEADER OVERFLOW ========
	// Inline, the buttons share a fixed-height header row with the page title, the page's own
	// actions, and anything other extensions put there. In a narrow window that row runs out of
	// width, and the title group is the only thing in it allowed to shrink. A narrow desktop window (a
	// side panel open, a half-screen window) isn't a mobile layout (see isMobileLayout), so all the
	// buttons stayed and squeezed the title to nothing. So collapse buttons into the "More actions"
	// menu, rightmost first, while anything in the row doesn't fit.
	//
	// "Doesn't fit" means squeezed: the row has no free width left, and a row child that is allowed
	// to shrink has content wider than its box, or has grown taller than the row. Both conditions
	// matter. Some of claude.ai's own controls overflow their boxes by a few pixels as a matter of
	// course (the new-chat page's actions slot does), and collapsing can't fix that - it would take
	// every button away for nothing. A shrink-0 child was never squeezed by us, and a row with slack
	// isn't short of width.
	//
	// It sees an ellipsised title only if the ellipsis is on that child itself, so claude.ai's normal
	// truncation of a long title doesn't trigger it - but content spilling out of a row child does,
	// whoever put it there. Claude Usage Tracker relies on this: it keeps its stats line's full width
	// claimed in the title group and lets it spill, and expects us to make room (see "How the two
	// extensions coordinate" in common/README.md).
	//
	// Opt-in per layout (`fitToHeader` on the anchor): only a header row shared with a title has
	// something worth making room for, and other anchors sit inside small native button clusters
	// where the row measurements mean nothing.

	_isHeaderFitMode(anchor) {
		return anchor?.mode === 'inline' && anchor.fitToHeader === true && !isMobileLayout();
	},

	_headerRowChildren(header) {
		return [...header.children].filter(child => {
			if (child === this._container) return false;
			const cs = getComputedStyle(child);
			return cs.display !== 'none' && cs.display !== 'contents'
				&& cs.position !== 'absolute' && cs.position !== 'fixed';
		});
	},

	_headerOverflows(header) {
		if (this._headerSlack(header) > 1) return false;
		const rowHeight = header.clientHeight;
		return this._headerRowChildren(header).some(child => {
			if ((parseFloat(getComputedStyle(child).flexShrink) || 0) === 0) return false;
			return child.scrollWidth > child.clientWidth + 1
				|| child.getBoundingClientRect().height > rowHeight + 1;
		});
	},

	// Width the row could still give up: its inner width minus everything that doesn't grow. A
	// growing child (claude.ai's draggable spacer) is only soaking up leftover space, so it counts
	// as free.
	_headerSlack(header) {
		const cs = getComputedStyle(header);
		const inner = header.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
		const gap = parseFloat(cs.columnGap) || 0;
		const children = [...this._headerRowChildren(header), this._container];
		const used = children
			.filter(child => child === this._container || (parseFloat(getComputedStyle(child).flexGrow) || 0) === 0)
			.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0);
		return inner - used - gap * Math.max(0, children.length - 1);
	},

	_fitToHeader() {
		const container = this._container;
		const header = container?.parentElement;
		const layout = this._detectLayout();
		const anchor = layout?.getAnchor();
		if (!header || !this._isHeaderFitMode(anchor)) {
			if (this._overflowed.size > 0) {
				this._overflowed.clear();
				if (layout) this._syncButtons(layout.group);
			}
			return;
		}

		const gap = parseFloat(getComputedStyle(container).columnGap) || 0;
		const collapsible = () => [...container.querySelectorAll('button')]
			// A button that isn't rendered (hidden by its own feature) frees nothing by collapsing.
			.filter(btn => !btn.classList.contains('more-actions-button') && btn.getBoundingClientRect().width > 0)
			.map(btn => [...this._registrations.keys()].find(cls => btn.classList.contains(cls)))
			.filter(Boolean);

		// Collapse, rightmost first, until the row fits or there is nothing left to collapse.
		let changed = false;
		while (this._headerOverflows(header)) {
			const visible = collapsible();
			if (visible.length === 0) break;
			const buttonClass = visible[visible.length - 1];
			const width = container.querySelector('.' + buttonClass).getBoundingClientRect().width;
			this._overflowed.set(buttonClass, width);
			this._syncButtons(layout.group);
			changed = true;
		}

		// Restore, last collapsed first, only when the row has room for the button - and, when it is
		// the last one out, counting the "More actions" button it lets us drop. The width test is what
		// keeps this from flapping: without it we would restore into an overflow, collapse again on the
		// next check, and repeat. Checked again afterwards in case the estimate was wrong.
		while (!changed && this._overflowed.size > 0) {
			const [buttonClass, width] = [...this._overflowed].pop();
			const moreButton = container.querySelector('.more-actions-button');
			const freed = this._overflowed.size === 1 && moreButton ? moreButton.getBoundingClientRect().width + gap : 0;
			if (this._headerSlack(header) + freed < width + gap) break;
			this._overflowed.delete(buttonClass);
			this._syncButtons(layout.group);
			if (this._headerOverflows(header)) {
				this._overflowed.set(buttonClass, width);
				this._syncButtons(layout.group);
				break;
			}
		}
	},

	// Re-fit as soon as the row changes rather than on the next 1s tick: on a resize, and when
	// anything outside our own container is added, removed or retexted.
	_observeHeaderForFit(anchor) {
		const header = this._isHeaderFitMode(anchor) ? this._container?.parentElement : null;
		if (header === this._fitObservedHeader) return;

		this._fitResizeObserver?.disconnect();
		this._fitMutationObserver?.disconnect();
		this._fitObservedHeader = header;
		if (!header) return;

		this._fitResizeObserver ??= new ResizeObserver(() => this._scheduleFit());
		this._fitMutationObserver ??= new MutationObserver(records => {
			// Our own collapses and restores mutate the container; reacting to them would loop.
			if (records.some(r => !this._container?.contains(r.target))) this._scheduleFit();
		});
		this._fitResizeObserver.observe(header);
		this._fitMutationObserver.observe(header, { childList: true, subtree: true, characterData: true });
	},

	_scheduleFit() {
		if (this._fitScheduled) return;
		this._fitScheduled = true;
		requestAnimationFrame(() => {
			this._fitScheduled = false;
			this._fitToHeader();
		});
	},

	_cleanStaleContainers(anchor) {
		document.querySelectorAll('.toolbox-buttons').forEach(el => {
			if (el !== this._container && el !== anchor.parent && el.parentElement !== anchor.parent) {
				el.remove();
			}
		});
	},

	_ensureContainer(anchor) {
		// Check if existing container is still in the DOM
		if (this._container && this._container.isConnected) {
			// Verify it's still in the right parent
			if (anchor.mode === 'self-container') {
				if (this._container.parentElement === anchor.parent) return;
			} else {
				if (this._container.parentElement === anchor.parent) return;
			}
			// Wrong parent — discard
			this._container.remove();
			this._container = null;
		}

		if (anchor.mode === 'self-container') {
			// Desktop homepage: container is a direct child of parent with special classes
			let container = anchor.parent.querySelector('.toolbox-buttons-home');
			if (!container) {
				container = document.createElement('div');
				container.className = 'toolbox-buttons-home toolbox-buttons absolute right-3 flex items-center gap-3.5';
				container.style.top = '0.625rem';
				anchor.parent.appendChild(container);
			}
			this._container = container;
		} else {
			let container = anchor.parent.querySelector(':scope > .toolbox-buttons');
			if (!container) {
				container = document.createElement('div');
				const isMobileChat = this._currentGroup === 'chat' && isMobileLayout();
				if (anchor.mode === 'wiggle') {
					if (isMobileChat) {
						container.className = 'toolbox-buttons flex items-center gap-1 pointer-events-auto self-end px-3 z-20 bg-bg-100 rounded-bl-lg';
						container.style.height = '2.25rem';
						container.style.marginTop = '-4px';
					} else {
						container.className = 'toolbox-buttons absolute top-0 z-20 flex items-center gap-1';
						container.style.height = '3rem';
					}
				} else {
					if (isMobileChat) {
						container.className = 'toolbox-buttons absolute top-full right-0 flex items-center gap-1 px-3 z-20 bg-bg-100 rounded-bl-lg';
						container.style.height = '2.25rem';
					} else {
						container.className = 'toolbox-buttons flex items-center justify-end gap-1';
					}
				}
				if (anchor.referenceNode) {
					anchor.parent.insertBefore(container, anchor.referenceNode);
				} else {
					anchor.parent.appendChild(container);
				}
			}
			this._container = container;
		}
	},

	_syncButtons(group) {
		const container = this._container;
		const isMobile = isMobileLayout();
		const isChatGroup = group === 'chat';

		// Remove buttons that don't belong to the current group - from the bar and from the menu, or
		// the menu keeps offering the previous page's actions.
		for (const [buttonClass, reg] of this._registrations) {
			if (!reg.pages.includes(group)) {
				const existing = container.querySelector('.' + buttonClass);
				if (existing) existing.remove();
			}
		}
		this._mobileModalButtons = this._mobileModalButtons.filter(b =>
			this._registrations.get(b.class)?.pages.includes(group));

		for (const [buttonClass, reg] of this._registrations) {
			// Check if this button should appear on this page type
			if (!reg.pages.includes(group)) continue;

			// Mobile handling: on chat pages, non-forced buttons go to "More actions" modal. So does
			// anything the header had no room for (see _fitToHeader).
			if ((isMobile && isChatGroup && !reg.forceDisplayOnMobile) || this._overflowed.has(buttonClass)) {
				// Remove from container if it exists
				const existing = container.querySelector('.' + buttonClass);
				if (existing) existing.remove();

				// Add to modal array if not already there
				if (!this._mobileModalButtons.find(b => b.class === buttonClass)) {
					this._mobileModalButtons.push({
						class: buttonClass,
						createFn: reg.createFn,
						tooltip: reg.tooltip
					});
					if (reg.onInjected) reg.onInjected(null);
				}
				continue;
			}

			// Desktop / forced mobile: show button directly
			// Remove from mobile modal if it was there
			const modalIndex = this._mobileModalButtons.findIndex(b => b.class === buttonClass);
			if (modalIndex !== -1) {
				this._mobileModalButtons.splice(modalIndex, 1);
			}

			// Add button if it doesn't exist
			if (!container.querySelector('.' + buttonClass)) {
				const button = reg.createFn();
				button.classList.add(buttonClass);

				if (reg.tooltip) {
					createClaudeTooltip(button, reg.tooltip);
				}

				container.appendChild(button);

				if (reg.onInjected) {
					reg.onInjected(button);
				}
			}
		}

		// Handle "More actions" button for mobile on chat pages, or for whatever the header overflowed
		if ((isMobile && isChatGroup || this._overflowed.size > 0) && this._mobileModalButtons.length > 0) {
			if (!container.querySelector('.more-actions-button')) {
				const moreButton = createClaudeButton(`
					<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
						<circle cx="8" cy="2" r="1.5"/>
						<circle cx="8" cy="8" r="1.5"/>
						<circle cx="8" cy="14" r="1.5"/>
					</svg>
				`, 'icon');
				moreButton.classList.add('more-actions-button');
				moreButton.onclick = () => this._showMoreActionsModal();
				createClaudeTooltip(moreButton, localize('ui.more_actions'));
				container.appendChild(moreButton);
			}
		} else {
			const moreBtn = container.querySelector('.more-actions-button');
			if (moreBtn) moreBtn.remove();
		}

		// The mobile spacing tracks the current mode rather than the one a button was created in: a
		// button made in the desktop layout stays in the bar when the window crosses into the mobile
		// one (a rotation, a resize), and vice versa.
		container.querySelectorAll('button').forEach(btn => btn.classList.toggle('-mx-1.5', isMobile));

		this._reorderButtons();
	},

	_reorderButtons() {
		const container = this._container;
		const currentButtons = Array.from(container.querySelectorAll('button'));

		const priorityButtons = [];
		for (const className of this.BUTTON_PRIORITY) {
			const button = currentButtons.find(btn => btn.classList.contains(className));
			if (button) priorityButtons.push(button);
		}

		const nonPriorityButtons = currentButtons.filter(btn =>
			!this.BUTTON_PRIORITY.some(className => btn.classList.contains(className)) &&
			!btn.classList.contains('more-actions-button')
		);

		const moreButton = currentButtons.find(btn => btn.classList.contains('more-actions-button'));

		const desiredOrder = [...priorityButtons, ...nonPriorityButtons];
		if (moreButton) desiredOrder.push(moreButton);

		const needsReordering = currentButtons.length !== desiredOrder.length ||
			!currentButtons.every((btn, index) => btn === desiredOrder[index]);

		if (needsReordering) {
			desiredOrder.forEach(button => container.appendChild(button));
		}
	},

	// The "Use incognito" ghost button is `fixed right-3` and lives in the content pane rather than
	// the header, so it takes up no space in the header's flex row and our rightmost button ends up
	// underneath it. It's the only overlay that needs compensating for, so target it directly — the
	// `look-around` class on its icon is the same handle homeWeb's legacy anchor uses.
	_updateInlineOffset() {
		const container = this._container;
		if (!container) return;

		container.style.marginRight = '';           // measure unshifted, so the result is idempotent

		const ghost = document.querySelector('[class*="look-around"]')?.closest('.fixed');
		if (!ghost) return;

		const rect = container.getBoundingClientRect();
		const ghostRect = ghost.getBoundingClientRect();
		if (!rect.width || !ghostRect.width) return;

		const overlap = rect.right - ghostRect.left;
		if (overlap > 0) container.style.marginRight = Math.ceil(overlap + 4) + 'px';
	},

	_updateWigglePosition(anchor) {
		if (isMobileLayout()) return;
		const wiggle = anchor.parent.querySelector('[data-testid="wiggle-controls-actions"]');
		if (wiggle && this._container) {
			this._container.style.right = (wiggle.offsetWidth + 4) + 'px';
		}
	},

	_showMoreActionsModal() {
		const modal = new ClaudeModal(localize('ui.more_actions_title'), '', true);

		const list = document.createElement('div');
		list.className = 'space-y-2';

		// In bar order: header overflow adds entries rightmost first.
		const barIndex = cls => {
			const i = this.BUTTON_PRIORITY.indexOf(cls);
			return i === -1 ? this.BUTTON_PRIORITY.length : i;
		};
		// A menu entry is rebuilt from createFn and never passed to onInjected, so a button that hides
		// itself (the banner watcher, with no active flags) can't do so here. Its menuVisible() says
		// whether it would currently be shown.
		const entries = this._mobileModalButtons
			.filter(btnInfo => this._registrations.get(btnInfo.class)?.menuVisible?.() ?? true)
			.sort((a, b) => barIndex(a.class) - barIndex(b.class));
		entries.forEach(btnInfo => {
			const button = btnInfo.createFn();
			const item = document.createElement('div');
			item.className = 'p-3 rounded bg-bg-200 border border-border-300 hover:bg-bg-300 cursor-pointer transition-colors flex items-center gap-3';

			const iconWrapper = document.createElement('div');
			iconWrapper.className = 'flex-shrink-0';
			iconWrapper.innerHTML = button.innerHTML;
			item.appendChild(iconWrapper);

			if (btnInfo.tooltip) {
				const label = document.createElement('span');
				label.className = 'text-text-100 flex-1';
				label.textContent = btnInfo.tooltip;
				item.appendChild(label);
			}

			item.onclick = () => {
				if (button.onclick) button.onclick();
				modal.destroy();
			};

			list.appendChild(item);
		});

		modal.setContent(list);
		modal.show();
	},
};
