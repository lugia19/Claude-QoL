// navigation.js
(function () {
	'use strict';

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
			console.error('[QOL-Navigation] Failed to migrate bookmarks from localStorage:', e);
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
			'Add Bookmark',
			'Bookmark Name:',
			'Enter bookmark name...',
			'',
			async (value) => {
				if (!value) {
					return 'Please enter a bookmark name';
				}

				// Check for duplicate names
				const bookmarks = await getBookmarks(conversationId);
				if (bookmarks[value]) {
					return 'A bookmark with this name already exists';
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
		const ROOT_UUID = "00000000-0000-4000-8000-000000000000";

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
		tree.set(ROOT_UUID, []);

		// For each bookmark, find its parent bookmark
		for (const [name, bookmarkUuid] of Object.entries(bookmarks)) {
			let parentBookmarkUuid = ROOT_UUID;
			let tempId = messageMap.get(bookmarkUuid)?.parent_message_uuid;

			// Walk up until we find another bookmark or hit root
			while (tempId && tempId !== ROOT_UUID) {
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
		for (const [name, bookmarkUuid] of Object.entries(bookmarks)) {
			let depth = 0;
			let tempId = bookmarkUuid;
			while (tempId && tempId !== ROOT_UUID) {
				depth++;
				const msg = messageMap.get(tempId);
				tempId = msg?.parent_message_uuid;
			}
			bookmarkDepths.set(bookmarkUuid, depth);
		}

		return { tree, bookmarks, bookmarkDepths };
	}

	function renderBookmarkTree(tree, parentUuid, conversation, bookmarkDepths, conversationId, onDelete) {
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
			content.onclick = async () => {
				const loadingModal = createLoadingModal('Navigating to bookmark...');
				try {
					loadingModal.show();

					const longestLeaf = conversation.findLongestLeaf(bookmark.uuid);
					await conversation.setCurrentLeaf(longestLeaf.leafId);
					sessionStorage.setItem('message_uuid_to_find', bookmark.uuid);
					window.location.reload();
				} catch (error) {
					console.error('Navigation failed:', error);
					showClaudeAlert('Navigation Error', 'Failed to navigate. The bookmark may be invalid.');
					loadingModal.destroy();
				}
			};

			item.appendChild(content);

			// Delete button
			const deleteBtn = createClaudeButton('×', 'icon');
			deleteBtn.classList.remove('h-9', 'w-9');
			deleteBtn.classList.add('h-6', 'w-6', 'text-base', 'ml-1');
			deleteBtn.onclick = async (e) => {
				e.stopPropagation();
				const confirmed = await showClaudeConfirm('Delete Bookmark', `Are you sure you want to delete the bookmark "${bookmark.name}"?`);
				if (confirmed) {
					await deleteBookmark(conversationId, bookmark.name);
					onDelete();
				}
			};
			item.appendChild(deleteBtn);

			bookmarkWrapper.appendChild(item);

			// Recursively render children
			const childTree = renderBookmarkTree(tree, bookmark.uuid, conversation, bookmarkDepths, conversationId, onDelete);
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
		const loading = createLoadingModal('Loading conversation data...');
		loading.show();

		let conversation;
		try {
			conversation = await getConversation();
		} catch (error) {
			console.error('Failed to fetch conversation:', error);
			loading.setTitle('Error');
			loading.setContent('Failed to load conversation data. Please try again.');
			loading.addConfirm('OK');
			return;
		}

		const conversationId = getConversationId();
		const contentDiv = document.createElement('div');

		// Top buttons row
		const topButtonsRow = document.createElement('div');
		topButtonsRow.className = CLAUDE_CLASSES.FLEX_GAP_2 + ' mb-4';

		const latestBtn = createClaudeButton('Go to Latest', 'secondary', async () => {
			const loadingModal = createLoadingModal('Navigating to latest message...');
			loadingModal.show();

			let latestMessage = null;
			let latestTimestamp = 0;

			const messages = await conversation.getMessages(true);
			for (const msg of messages) {
				const timestamp = new Date(msg.created_at).getTime();
				if (timestamp > latestTimestamp) {
					latestTimestamp = timestamp;
					latestMessage = msg;
				}
			}

			if (latestMessage) {
				await conversation.setCurrentLeaf(latestMessage.uuid);
				window.location.reload();
			}
		});

		const longestBtn = createClaudeButton('Go to Longest', 'secondary', async () => {
			const loadingModal = createLoadingModal('Navigating to longest branch...');
			loadingModal.show();

			const rootId = "00000000-0000-4000-8000-000000000000";
			const longestLeaf = conversation.findLongestLeaf(rootId);
			await conversation.setCurrentLeaf(longestLeaf.leafId);
			window.location.reload();
		});
		latestBtn.classList.add('w-full');
		longestBtn.classList.add('w-full');

		topButtonsRow.appendChild(latestBtn);
		topButtonsRow.appendChild(longestBtn);
		contentDiv.appendChild(topButtonsRow);

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
				emptyMsg.textContent = 'No bookmarks yet. Use the bookmark button on messages to add one.';
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
			rootLabel.textContent = 'Root';
			rootContent.appendChild(rootLabel);

			rootNode.appendChild(rootContent);
			treeContainer.appendChild(rootNode);

			// Render tree starting from root
			const ROOT_UUID = "00000000-0000-4000-8000-000000000000";
			const treeContent = renderBookmarkTree(tree, ROOT_UUID, conversation, bookmarkDepths, conversationId, renderTree);

			if (treeContent) {
				treeContainer.appendChild(treeContent);
			}
		};

		// Initial render
		await renderTree();

		// Close loading modal
		loading.destroy();

		// Create and show modal
		const modal = new ClaudeModal('Navigation', contentDiv);
		modal.addCancel('Close');
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
		const actionsGroup = button.closest('[role="toolbar"][aria-label="Message actions"], [role="group"][aria-label="Message actions"]');
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

		let conversation = await getCachedConversation();
		let messages = await conversation.getRenderedMessages();
		let clickedUuid = resolveUserMessageUuid(messageElement, messages);

		// A cached branch goes stale as soon as new messages are sent — if the clicked
		// message isn't in it, rebuild once and retry.
		if (!clickedUuid) {
			conversation = await getCachedConversation(true);
			messages = await conversation.getRenderedMessages();
			clickedUuid = resolveUserMessageUuid(messageElement, messages);
		}
		if (!clickedUuid) return;

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
		button.setAttribute('aria-label', 'Previous user message');
		createClaudeTooltip(button, 'Previous user message');

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
		button.setAttribute('aria-label', 'Next user message');
		createClaudeTooltip(button, 'Next user message');

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
		button.setAttribute('aria-label', 'Bookmark this message');

		createClaudeTooltip(button, 'Bookmark this message');

		button.onclick = async (e) => {
			e.preventDefault();
			e.stopPropagation();

			const messageContainer = e.target.closest('[data-message-uuid]');
			const messageUuid = messageContainer?.dataset.messageUuid;

			if (!messageUuid) {
				showClaudeAlert('Error', 'Could not find message UUID');
				return;
			}

			const conversationId = getConversationId();

			try {
				await showNameInputModal(conversationId, messageUuid);
				showClaudeAlert('Success', 'Bookmark added!');
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

	function initialize() {
		injectTreeStyles();
		// Add navigation button to top right
		ButtonBar.register({
			buttonClass: 'navigation-button',
			createFn: createNavigationButton,
			tooltip: 'Navigation',
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