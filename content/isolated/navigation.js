// navigation.js
(function () {
	'use strict';
	const log = createLogger('Navigation');

	const _NAV_KEY = SETTINGS_KEYS.NAVIGATION.BOOKMARKS;

	// #region  STORAGE MANAGEMENT
	// One-time migration from localStorage
	let _navMigrationDone = false;
	async function _migrateLocalStorageBookmarks() {
		if (_navMigrationDone) return;
		_navMigrationDone = true;
		const legacy = localStorage.getItem('navigation_bookmarks');
		if (!legacy) return;
		try {
			const parsed = JSON.parse(legacy);
			const current = await settingsRegistry.get(_NAV_KEY);
			// Only migrate if registry is empty (default)
			if (Object.keys(current).length === 0 && Object.keys(parsed).length > 0) {
				await settingsRegistry.set(_NAV_KEY, parsed);
			}
			localStorage.removeItem('navigation_bookmarks');
		} catch (e) {
			log.error('Failed to migrate bookmarks from localStorage:', e);
		}
	}

	async function getBookmarks(conversationId) {
		await _migrateLocalStorageBookmarks();
		const allBookmarks = await settingsRegistry.get(_NAV_KEY);
		return allBookmarks[conversationId] || {};
	}

	async function saveBookmarks(conversationId, bookmarks) {
		await _migrateLocalStorageBookmarks();
		const allBookmarks = await settingsRegistry.get(_NAV_KEY);
		allBookmarks[conversationId] = bookmarks;
		await settingsRegistry.set(_NAV_KEY, allBookmarks);
	}

	async function addBookmark(conversationId, name, leafUuid) {
		const bookmarks = await getBookmarks(conversationId);
		bookmarks[name] = leafUuid;
		await saveBookmarks(conversationId, bookmarks);
	}

	async function deleteBookmark(conversationId, name) {
		const bookmarks = await getBookmarks(conversationId);
		delete bookmarks[name];
		await saveBookmarks(conversationId, bookmarks);
	}

	// #endregion
	// #region  API HELPERS 
	async function getConversation() {
		const conversationId = getConversationId();
		if (!conversationId) {
			throw new Error('Not in a conversation');
		}

		const orgId = getOrgId();
		return new ClaudeConversation(orgId, conversationId);
	}

	// #endregion
	// #region  NAME INPUT MODAL 
	async function showNameInputModal(conversationId, currentLeafId) {
		const name = await showClaudePrompt(
			localize('nav.add_bookmark_title'),
			localize('nav.bookmark_name_label'),
			localize('nav.bookmark_name_placeholder'),
			'',
			async (value) => {
				if (!value) {
					return localize('nav.bookmark_name_required');
				}

				// Check for duplicate names
				const bookmarks = await getBookmarks(conversationId);
				if (bookmarks[value]) {
					return localize('nav.bookmark_name_exists');
				}

				return true;
			}
		);

		await addBookmark(conversationId, name, currentLeafId);
		return name;
	}

	// #endregion
	//#region TREE VIEW
	async function buildBookmarkTree(conversationId, conversation) {
		// Build message map
		const messages = await conversation.getMessages(true);
		const messageMap = new Map();
		for (const msg of messages) {
			messageMap.set(msg.uuid, msg);
		}

		// Get all bookmarks
		const bookmarks = await getBookmarks(conversationId);
		const bookmarkUuids = Object.values(bookmarks);

		// Build tree structure
		const tree = new Map();
		tree.set(ROOT_MESSAGE_UUID, []);

		// For each bookmark, find its parent bookmark
		for (const [name, bookmarkUuid] of Object.entries(bookmarks)) {
			let parentBookmarkUuid = ROOT_MESSAGE_UUID;
			let tempId = messageMap.get(bookmarkUuid)?.parent_message_uuid;

			// Walk up until we find another bookmark or hit root
			while (tempId && tempId !== ROOT_MESSAGE_UUID) {
				if (bookmarkUuids.includes(tempId)) {
					parentBookmarkUuid = tempId;
					break;
				}
				const parentMsg = messageMap.get(tempId);
				tempId = parentMsg?.parent_message_uuid;
			}

			// Add to tree
			if (!tree.has(parentBookmarkUuid)) {
				tree.set(parentBookmarkUuid, []);
			}
			tree.get(parentBookmarkUuid).push({
				name,
				uuid: bookmarkUuid
			});
		}

		// Calculate depth for each bookmark
		const bookmarkDepths = new Map();
		for (const bookmarkUuid of Object.values(bookmarks)) {
			let depth = 0;
			let tempId = bookmarkUuid;
			while (tempId && tempId !== ROOT_MESSAGE_UUID) {
				depth++;
				const msg = messageMap.get(tempId);
				tempId = msg?.parent_message_uuid;
			}
			bookmarkDepths.set(bookmarkUuid, depth);
		}

		return { tree, bookmarks, bookmarkDepths };
	}

	function renderBookmarkTree(tree, parentUuid, goTo, bookmarkDepths, conversationId, onDelete) {
		const children = tree.get(parentUuid) || [];
		if (children.length === 0) return null;

		// Sort children by depth from root
		children.sort((a, b) => bookmarkDepths.get(a.uuid) - bookmarkDepths.get(b.uuid));

		const container = document.createElement('div');
		container.className = 'bookmark-tree-children';

		for (let i = 0; i < children.length; i++) {
			const bookmark = children[i];
			const isLastChild = i === children.length - 1;

			// Wrapper for each bookmark + its children
			const bookmarkWrapper = document.createElement('div');
			bookmarkWrapper.className = 'bookmark-tree-node bookmark-tree-branch';
			if (isLastChild) {
				bookmarkWrapper.classList.add('last-child');
			}


			// Create bookmark item
			const item = document.createElement('div');
			item.className = 'inline-flex items-center gap-1 py-2 px-3 bg-bg-200 border border-border-300 hover:bg-bg-300 rounded transition-colors';

			// Create clickable content area
			const content = document.createElement('div');
			content.className = 'flex items-center gap-2 whitespace-nowrap cursor-pointer';

			const iconSpan = document.createElement('span');
			iconSpan.textContent = '📍';
			content.appendChild(iconSpan);

			const nameSpan = document.createElement('span');
			nameSpan.className = 'text-sm text-text-100';
			nameSpan.textContent = bookmark.name;
			content.appendChild(nameSpan);

			// Click handler for navigation
			content.onclick = () => goTo(localize('nav.navigating_to_bookmark'), bookmark.uuid);

			item.appendChild(content);

			// Delete button
			const deleteBtn = createClaudeButton('×', 'icon');
			deleteBtn.classList.remove('h-9', 'w-9');
			deleteBtn.classList.add('h-6', 'w-6', 'text-base', 'ml-1');
			deleteBtn.onclick = async (e) => {
				e.stopPropagation();
				const confirmed = await showClaudeConfirm(localize('nav.delete_bookmark_title'), localize('nav.delete_bookmark_confirm', { name: bookmark.name }));
				if (confirmed) {
					await deleteBookmark(conversationId, bookmark.name);
					onDelete();
				}
			};
			item.appendChild(deleteBtn);

			bookmarkWrapper.appendChild(item);

			// Recursively render children
			const childTree = renderBookmarkTree(tree, bookmark.uuid, goTo, bookmarkDepths, conversationId, onDelete);
			if (childTree) {
				bookmarkWrapper.appendChild(childTree);
			}

			container.appendChild(bookmarkWrapper);
		}

		return container;
	}

	// #endregion

	//#region MAIN NAVIGATION MODAL
	async function showNavigationModal() {
		const loading = createLoadingModal(localize('nav.loading_conversation'));
		loading.show();

		let conversation;
		try {
			conversation = await getConversation();
		} catch (error) {
			log.error('Failed to fetch conversation:', error);
			loading.setTitle(localize('common.error'));
			loading.setContent(localize('nav.load_conversation_failed'));
			loading.addConfirm(localize('shared.ok'));
			return;
		}

		const conversationId = getConversationId();
		const contentDiv = document.createElement('div');

		const goTo = (loadingText, uuid) => jumpToMessage(conversation, uuid, loadingText);

		contentDiv.appendChild(createLatestLongestRow(conversation));

		// Tree view container
		const treeContainer = document.createElement('div');
		treeContainer.className = 'max-h-[60vh] overflow-y-auto';
		contentDiv.appendChild(treeContainer);

		// Function to render the tree
		const renderTree = async () => {
			treeContainer.innerHTML = '';

			const { tree, bookmarks, bookmarkDepths } = await buildBookmarkTree(conversationId, conversation);

			// Check if there are any bookmarks
			if (Object.keys(bookmarks).length === 0) {
				const emptyMsg = document.createElement('div');
				emptyMsg.className = 'text-center text-text-400 py-8';
				emptyMsg.textContent = localize('nav.no_bookmarks');
				treeContainer.appendChild(emptyMsg);
				return;
			}

			// Create root node (unclickable)
			const rootNode = document.createElement('div');
			rootNode.className = 'inline-block py-2 px-3 bg-bg-300 border border-border-300 rounded opacity-60';
			rootNode.style.cursor = 'default';

			const rootContent = document.createElement('div');
			rootContent.className = 'flex items-center gap-2 whitespace-nowrap';

			const rootIcon = document.createElement('span');
			rootIcon.textContent = '🌳';
			rootContent.appendChild(rootIcon);

			const rootLabel = document.createElement('span');
			rootLabel.className = 'text-sm text-text-200';
			rootLabel.textContent = localize('nav.root');
			rootContent.appendChild(rootLabel);

			rootNode.appendChild(rootContent);
			treeContainer.appendChild(rootNode);

			// Render tree starting from root
			const treeContent = renderBookmarkTree(tree, ROOT_MESSAGE_UUID, goTo, bookmarkDepths, conversationId, renderTree);

			if (treeContent) {
				treeContainer.appendChild(treeContent);
			}
		};

		// Initial render
		await renderTree();

		// Close loading modal
		loading.destroy();

		// Create and show modal
		const modal = new ClaudeModal(localize('nav.navigation'), contentDiv);
		modal.addCancel(localize('common.close'));
		modal.modal.classList.remove('max-w-md');
		modal.modal.classList.add('max-w-2xl');
		modal.show();
	}
	// #endregion

	// #endregion
	// #region  BUTTON CREATION 
	function createNavigationButton() {
		const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<polygon points="3 11 22 2 13 21 11 13 3 11"></polygon>
		</svg>`;

		const button = createClaudeButton(svgContent, 'icon', showNavigationModal);

		return button;
	}

	// #endregion
	// #region  USER NAVIGATION BUTTONS (MessageButtonBar)
	function findMessageFromButton(button) {
		const actionsGroup = button.closest('[role="toolbar"][data-cds="MessageActions"], [role="group"][aria-label="Message actions"]');
		if (!actionsGroup) return null;
		const messageContainer = actionsGroup.closest('.group');
		if (!messageContainer) return null;
		return messageContainer.querySelector('[data-testid="user-message"], .font-user-message, .\\!font-user-message');
	}

	// Is the neighbouring user message already rendered? The virtualizer tags each row with
	// a data-index, so "is this really the adjacent one" is a structural question — compare
	// indices, no pixel thresholds. Indices are only ever compared against each other here,
	// never mapped onto the API list, so the phantom offset doesn't come into it.
	function findRenderedNeighbourUserMessage(messageElement, direction) {
		const indexOf = el => {
			const wrapper = el.closest('[data-index]');
			const value = wrapper && Number(wrapper.getAttribute('data-index'));
			return Number.isInteger(value) ? value : null;
		};

		const from = indexOf(messageElement);
		if (from === null) return null;

		let best = null;
		for (const candidate of getUIMessages().userMessages) {
			if (candidate === messageElement) continue;
			const at = indexOf(candidate);
			if (at === null) continue;
			const delta = (at - from) * direction;
			// Wrong side, or too far to be the neighbour — this is what excludes the
			// permanently pinned tail rows, which sit hundreds of entries away.
			if (delta <= 0 || delta > 3) continue;
			if (!best || delta < best.delta) best = { element: candidate, delta };
		}
		return best?.element ?? null;
	}

	// Reused across clicks: a fresh ClaudeConversation costs ~1.7s in getData (cache hit,
	// but still a freshness check on the whole payload), while a warm instance answers in
	// ~18ms. Rebuilt when the conversation changes, or when the branch turns out stale.
	let _navConversation = null;
	let _navConversationId = null;

	async function getCachedConversation(refresh = false) {
		const conversationId = getConversationId();
		if (refresh || !_navConversation || _navConversationId !== conversationId) {
			_navConversation = await getConversation();
			_navConversationId = conversationId;
		}
		return _navConversation;
	}

	// Jump to the previous (-1) or next (+1) user message.
	//
	// Jump to the previous (-1) or next (+1) user message. Usually the neighbour is already
	// on screen and this is a plain scroll with no API call at all. Only when it isn't do we
	// consult the branch and let revealMessageByUuid walk there ('step', since the target is
	// by definition adjacent — no reason to bracket the whole conversation).
	//
	// getRenderedMessages, not getMessages: positions must match what's on screen, which in
	// a forked chat includes the phantom history.
	async function navigateToAdjacentUserMessage(button, direction) {
		const messageElement = findMessageFromButton(button);
		if (!messageElement) return;

		const alreadyRendered = findRenderedNeighbourUserMessage(messageElement, direction);
		if (alreadyRendered) {
			alreadyRendered.scrollIntoView({ block: 'center' });
			return;
		}

		const clickedUuid = resolveUserMessageUuid(messageElement);
		if (!clickedUuid) return;

		let conversation = await getCachedConversation();
		let messages = await conversation.getRenderedMessages();

		// A cached branch goes stale as soon as new messages are sent — if the clicked
		// message isn't in it, rebuild once and retry.
		if (!messages.some(msg => msg.uuid === clickedUuid)) {
			conversation = await getCachedConversation(true);
			messages = await conversation.getRenderedMessages();
		}

		let cursor = messages.findIndex(msg => msg.uuid === clickedUuid);
		if (cursor === -1) return;
		do { cursor += direction; }
		while (cursor >= 0 && cursor < messages.length && messages[cursor].sender !== 'human');

		const target = messages[cursor];
		if (!target || target.sender !== 'human') return;

		await revealMessageByUuid(target.uuid, { highlight: false, conversation, strategy: 'step' });
	}

	function createNavUpButton() {
		const svgContent = `
		<div class="relative text-text-500 group-hover/btn:text-text-100">
			<div class="flex items-center justify-center transition-all" style="width: 20px; height: 20px;">
				<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" class="shrink-0" aria-hidden="true">
					<path d="M3.16011 13.8662C2.98312 13.7018 2.95129 13.4389 3.07221 13.2402L3.13374 13.1602L9.63377 6.16016C9.72836 6.05829 9.86101 6 9.99999 6C10.1043 6 10.2053 6.03247 10.289 6.0918L10.3662 6.16016L16.8662 13.1602C17.054 13.3625 17.0421 13.6783 16.8399 13.8662C16.6375 14.054 16.3217 14.0422 16.1338 13.8399L9.99999 7.2334L3.86616 13.8399L3.78999 13.9072C3.60085 14.0422 3.33709 14.0305 3.16011 13.8662Z"/>
				</svg>
			</div>
		</div>`;

		const button = createClaudeButton(svgContent, 'icon-message');
		button.type = 'button';
		button.setAttribute('aria-label', localize('nav.previous_user_message'));
		createClaudeTooltip(button, localize('nav.previous_user_message'));

		button.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			navigateToAdjacentUserMessage(button, -1);
		};

		return button;
	}

	function createNavDownButton() {
		const svgContent = `
		<div class="relative text-text-500 group-hover/btn:text-text-100">
			<div class="flex items-center justify-center transition-all" style="width: 20px; height: 20px;">
				<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" class="shrink-0" aria-hidden="true">
					<path d="M3.16011 6.13378C2.98312 6.29824 2.95129 6.5611 3.07221 6.75976L3.13374 6.83984L9.63377 13.8398C9.72836 13.9417 9.86101 14 9.99999 14C10.1043 14 10.2053 13.9675 10.289 13.9082L10.3662 13.8398L16.8662 6.83984C17.054 6.6375 17.0421 6.32166 16.8399 6.13378C16.6375 5.94599 16.3217 5.95783 16.1338 6.16015L9.99999 12.7666L3.86616 6.16015L3.78999 6.09277C3.60085 5.95776 3.33709 5.96954 3.16011 6.13378Z"/>
				</svg>
			</div>
		</div>`;

		const button = createClaudeButton(svgContent, 'icon-message');
		button.type = 'button';
		button.setAttribute('aria-label', localize('nav.next_user_message'));
		createClaudeTooltip(button, localize('nav.next_user_message'));

		button.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			navigateToAdjacentUserMessage(button, 1);
		};

		return button;
	}
	// #endregion

	// #region MESSAGE BOOKMARK
	function createBookmarkButton() {
		const svgContent = `
		<div class="relative text-text-500 group-hover/btn:text-text-100">
			<div class="flex items-center justify-center transition-all" style="width: 20px; height: 20px;">
				<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" class="shrink-0" aria-hidden="true">
					<path d="M5 3.5C5 2.67157 5.67157 2 6.5 2H13.5C14.3284 2 15 2.67157 15 3.5V17.5C15 17.6894 14.8909 17.8625 14.7211 17.9472C14.5513 18.0319 14.3483 18.0136 14.1963 17.9L10 14.6289L5.80371 17.9C5.65171 18.0136 5.44866 18.0319 5.27886 17.9472C5.10906 17.8625 5 17.6894 5 17.5V3.5ZM6.5 3C6.22386 3 6 3.22386 6 3.5V16.4198L9.69629 13.6C9.87278 13.4667 10.1272 13.4667 10.3037 13.6L14 16.4198V3.5C14 3.22386 13.7761 3 13.5 3H6.5Z"/>
				</svg>
			</div>
		</div>
	`;

		const button = createClaudeButton(svgContent, 'icon-message');
		button.type = 'button';
		button.setAttribute('data-state', 'closed');
		button.setAttribute('aria-label', localize('nav.bookmark_this_message'));

		createClaudeTooltip(button, localize('nav.bookmark_this_message'));

		button.onclick = async (e) => {
			e.preventDefault();
			e.stopPropagation();

			const messageUuid = await messageUuidOfElement(e.target);

			if (!messageUuid) {
				showClaudeAlert(localize('common.error'), localize('nav.message_uuid_not_found'));
				return;
			}

			const conversationId = getConversationId();

			try {
				await showNameInputModal(conversationId, messageUuid);
				showClaudeAlert(localize('nav.success_title'), localize('nav.bookmark_added'));
			} catch (error) {
				// User cancelled, do nothing
			}
		};

		return button;
	}
	// #endregion

	// #region  INITIALIZATION
	// ======== INJECT CSS ========
	function injectTreeStyles() {
		// Check if already injected
		if (document.getElementById('bookmark-tree-styles')) return;

		const style = document.createElement('style');
		style.id = 'bookmark-tree-styles';
		style.textContent = `
		/* Tree structure */
		.bookmark-tree-children {
			display: flex;
			flex-direction: column;
			margin-left: 2rem;
			margin-top: 1rem;  /* Add space between parent and children */
			gap: 0.5rem;
		}

		.bookmark-tree-branch {
			position: relative;
			padding-left: 2rem;
		}

		/* Vertical line */
		.bookmark-tree-branch::before {
			content: '';
			position: absolute;
			left: 0;
			top: 0;
			bottom: 0;
			width: 2px;
			background: var(--text-text-300, #ffffff);
		}

		/* Horizontal line */
		.bookmark-tree-branch::after {
			content: '';
			position: absolute;
			left: 0;
			top: 1.25rem;
			width: 1.5rem;
			height: 2px;
			background: var(--text-text-300, #ffffff);
		}

		/* Last child - stop vertical line at this node */
		.bookmark-tree-branch.last-child::before {
			bottom: auto;
			height: 1.25rem;
		}
	`;

		document.head.appendChild(style);
	}

	//#region EARLIER VERSIONS
	// Two ways to be on a version that isn't the chat's current one, one banner for both:
	// - claude.ai's own version arrows (client-only): it shows "You're viewing an earlier version" with
	//   Send disabled, and ours goes above it;
	// - a QoL jump (jumpToMessage; jump-view.js marks <html data-qol-jump-view="<conversation id>"> for
	//   that page load, kept when the user leaves and comes back, since the page then restores the
	//   jumped branch from its cache; we mirror it to data-qol-jump-active while that chat is open): the
	//   page thinks it's on the current version, so ours stands alone above the composer, claude.ai's is
	//   hidden (a hand flip back to the real latest would show it), and sending is blocked here (the
	//   input would send to the real leaf; jump-view.js also refuses the request itself).
	// The banner offers to continue the version on screen: normal chats move the current leaf to it and
	// reload; upgraded (workspace) chats can't move their leaf (their sandbox is shared across
	// branches), so they fork it instead. In a jump, "Back to latest" just reloads. See docs/bard-rework.md
	// (D7 and "Jumps").
	const EARLIER_VERSION = '[data-testid="hub-earlier-version-back"]';
	const JUMP_ATTRIBUTE = 'data-qol-jump-view';
	const JUMP_ACTIVE = 'data-qol-jump-active';
	// claude.ai's banner look (its Banner classes), with our accent instead of its grey ring.
	const BANNER_CLASS = 'flex items-center gap-xs py-md font-sans text-body font-normal px-md rounded-composer bg-surface-1 text-primary qol-version-banner';
	const bannersSeen = new WeakSet();
	const isJumped = () => {
		const jumped = document.documentElement.getAttribute(JUMP_ATTRIBUTE);
		return !!jumped && jumped === getConversationId();
	};

	// The leaf of the version on screen: the bottom row of the list once scrolled to the end. If it
	// somehow has children, follow the newest one down, as claude.ai does when showing a version.
	async function viewedLeaf(conversation) {
		const scroller = getMessageScroller();
		for (let i = 0; i < 3 && scroller; i++) {
			scroller.scrollTop = scroller.scrollHeight;
			await new Promise(r => setTimeout(r, 300));
		}
		const rows = [...document.querySelectorAll('[data-turn-key]')];
		const last = rows.reduce((a, b) => (b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a), rows[0]);
		const tree = (await conversation.getData()).chat_messages ?? [];
		let uuid = last && uuidForTurnKey(last.dataset.turnKey, tree);
		if (!uuid) return null;
		const children = Map.groupBy(tree, m => m.parent_message_uuid);
		for (let kids = children.get(uuid); kids?.length; kids = children.get(uuid)) {
			uuid = kids.reduce((a, b) => (b.index > a.index ? b : a)).uuid;
		}
		return uuid;
	}

	// The kit's buttons are h-9, too tall for a banner row.
	function bannerButton(label, variant, onClick) {
		const button = createClaudeButton(label, variant, onClick);
		button.className = button.className.replace(/\bh-9\b/, 'h-7').replace(/\bpx-4\b/, 'px-3').replace(/\bpy-2\b/, 'py-0') + ' text-sm shrink-0';
		return button;
	}

	async function continueHere(conversation) {
		const loadingModal = createLoadingModal(localize('nav.continuing'));
		loadingModal.show();
		try {
			const leaf = await viewedLeaf(conversation);
			if (!leaf) throw new Error('could not tell which version is on screen');
			await conversation.setCurrentLeaf(leaf); // reloads onto that version
		} catch (error) {
			log.error('Continue from here failed:', error);
			loadingModal.destroy();
			showClaudeAlert(localize('nav.navigation_error_title'), localize('nav.navigation_failed'));
		}
	}

	// The fork modal lives in MAIN (forking.js); it opens on the version's leaf.
	async function forkHere(conversation) {
		const leaf = await viewedLeaf(conversation).catch(() => null);
		if (!leaf) {
			showClaudeAlert(localize('nav.navigation_error_title'), localize('nav.navigation_failed'));
			return;
		}
		window.postMessage({ type: 'qol-fork-from', messageUuid: leaf }, window.location.origin);
	}

	async function createVersionBanner(jumped) {
		const conversation = await getConversation();
		const upgraded = !!(await conversation.getData()).workspace_upgraded;

		const banner = document.createElement('div');
		banner.className = BANNER_CLASS;
		// Wraps on narrow screens: the text keeps a readable width, the buttons drop below it together.
		Object.assign(banner.style, { marginBottom: '6px', border: '1px solid #2c84db', flexWrap: 'wrap' });
		const text = document.createElement('div');
		text.className = 'min-w-0';
		text.style.flex = '1 1 220px';
		text.textContent = localize(jumped ? 'nav.jump_view_text' : upgraded ? 'nav.continue_upgraded_text' : 'nav.continue_anyway_text');
		banner.appendChild(text);

		const buttons = document.createElement('div');
		buttons.className = 'flex gap-2 ml-auto';
		buttons.appendChild(upgraded
			? bannerButton(localize('fork.fork_from_here'), 'primary', () => forkHere(conversation))
			: bannerButton(localize('nav.continue_anyway_button'), 'primary', () => continueHere(conversation)));
		if (jumped) buttons.appendChild(bannerButton(localize('nav.back_to_latest'), 'secondary', () => location.reload()));
		banner.appendChild(buttons);
		return banner;
	}

	// Next to claude.ai's banner (hand flips): inside its dock card, above it, so it goes away with it.
	async function addFlipBanner(nativeBanner) {
		const banner = await createVersionBanner(false);
		if (nativeBanner.isConnected && !isJumped()) nativeBanner.before(banner);
	}

	// Alone above the composer for a jump, for as long as jump-view.js keeps the attribute.
	let jumpBanner = null;
	let jumpBannerPending = false;
	async function placeJumpBanner() {
		if (!isJumped()) {
			jumpBanner?.remove();
			jumpBanner = null;
			return;
		}
		if (jumpBanner?.isConnected || jumpBannerPending) return;
		const holder = document.querySelector('[data-composer-card-holder]');
		if (!holder) return;
		jumpBannerPending = true;
		try {
			jumpBanner ??= await createVersionBanner(true);
			if (isJumped()) holder.before(jumpBanner);
		} finally {
			jumpBannerPending = false;
		}
	}

	// While jumped: the input would send to the server's real leaf, and Retry / Edit would branch off
	// the hidden one, so they're blocked here (and refused by jump-view.js should anything get past).
	function blockSendingWhileJumped() {
		document.addEventListener('keydown', (e) => {
			if (!isJumped() || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
			if (!e.target.closest?.('[data-testid="chat-input"]')) return;
			e.preventDefault();
			e.stopImmediatePropagation();
		}, true);
		document.addEventListener('click', (e) => {
			if (!isJumped() || !e.target.closest?.('[data-testid="chat-input-send"]')) return;
			e.preventDefault();
			e.stopImmediatePropagation();
		}, true);
		const style = document.createElement('style');
		style.textContent = `
			html[${JUMP_ACTIVE}] [data-testid="chat-input-send"] { opacity: 0.4; pointer-events: none; }
			html[${JUMP_ACTIVE}] :is([data-testid="user-message-retry"], [data-testid="user-message-edit"], [data-testid="action-bar-retry"], .advanced-edit-button) { display: none !important; }
			html[${JUMP_ACTIVE}] [data-cds-dock-card]:has(${EARLIER_VERSION}) { display: none; }
		`;
		document.head.appendChild(style);
	}

	// Coalesced on a short timer: the observer fires constantly while a reply streams. Not an animation
	// frame: those don't run in a hidden desktop window.
	function watchVersionBanners() {
		let scheduled = false;
		const check = () => {
			scheduled = false;
			document.documentElement.toggleAttribute(JUMP_ACTIVE, isJumped());
			placeJumpBanner().catch(error => log.error('Jump banner failed:', error));
			const nativeBanner = document.querySelector(EARLIER_VERSION)?.closest('[data-cds="Banner"]');
			if (!nativeBanner || bannersSeen.has(nativeBanner) || isJumped()) return;
			bannersSeen.add(nativeBanner);
			addFlipBanner(nativeBanner).catch(error => log.error('Continue banner failed:', error));
		};
		const schedule = () => {
			if (scheduled) return;
			scheduled = true;
			setTimeout(check, 100);
		};
		new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
		new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: [JUMP_ATTRIBUTE] });
	}
	// #endregion

	function initialize() {
		injectTreeStyles();
		watchVersionBanners();
		blockSendingWhileJumped();
		// Add navigation button to top right
		ButtonBar.register({
			buttonClass: 'navigation-button',
			createFn: createNavigationButton,
			tooltip: localize('nav.navigation'),
			pages: ['chat'],
		});
		MessageButtonBar.register({
			buttonClass: 'bookmark-button',
			target: 'assistant',
			createFn: createBookmarkButton,
			pages: ['chat'],
		});

		MessageButtonBar.register({
			buttonClass: 'nav-up-button',
			target: 'user',
			createFn: createNavUpButton,
			pages: ['chat'],
			insertFn: (button, container) => container.appendChild(button),
		});
		MessageButtonBar.register({
			buttonClass: 'nav-down-button',
			target: 'user',
			createFn: createNavDownButton,
			pages: ['chat'],
			insertFn: (button, container) => container.appendChild(button),
		});
	}

	// Wait for DOM to be ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initialize);
	} else {
		initialize();
	}
})();