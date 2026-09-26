// claude-search-chat.js
(function () {
	'use strict';
	const log = createLogger('ChatSearch');

	const { getRelativeTime, simplifyText, fuzzyMatch, compileQuery, findMatches } = window.ClaudeSearchShared;

	// Fill `el` with `text`, wrapping every match in a highlight. Builds nodes rather than assigning
	// innerHTML - message text is arbitrary and would otherwise be parsed as markup.
	function highlightInto(el, text, matcher) {
		el.textContent = '';
		const matches = findMatches(text, matcher);
		let at = 0;
		for (const m of matches) {
			if (m.start > at) el.appendChild(document.createTextNode(text.slice(at, m.start)));
			const mark = document.createElement('strong');
			mark.className = 'bg-yellow-200 dark:bg-yellow-800';
			mark.textContent = text.slice(m.start, m.end);
			el.appendChild(mark);
			at = m.end;
		}
		if (at < text.length) el.appendChild(document.createTextNode(text.slice(at)));
	}

	// "N messages ago" / "Branched N messages ago" label for a search result
	function formatPosition(result) {
		const many = result.position > 1;
		if (result.is_branched) {
			return localize(many ? 'search.branched_messages_ago' : 'search.branched_message_ago', { n: fmtNum(result.position) });
		}
		return localize(many ? 'search.messages_ago' : 'search.message_ago', { n: fmtNum(result.position) });
	}

	// ======== SEARCH FUNCTION ========
	async function searchMessages(query, conversation) {
		if (!query || query.trim() === '') {
			return [];
		}

		const matcher = compileQuery(query);
		const results = [];
		const messages = await conversation.getMessages(true);

		// Build message map for easy lookup
		const messageMap = new Map();
		for (const message of messages) {
			messageMap.set(message.uuid, message);
		}

		// Calculate position with branch awareness
		const currentLeafId = conversation.conversationData.current_leaf_message_uuid;

		// Step 1: Build array of all ancestors from current leaf
		const ancestors = [];
		let tempId = currentLeafId;
		while (tempId) {
			ancestors.push(tempId);
			const tempMsg = messageMap.get(tempId);
			tempId = tempMsg?.parent_message_uuid;
		}

		// Search through messages
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index];
			const text = ClaudeConversation.extractMessageText(message);
			const firstMatch = findMatches(text, matcher)[0];

			if (firstMatch) {
				// Extract ~100 chars centered on match
				const contextChars = 50;
				const startIndex = Math.max(0, firstMatch.start - contextChars);
				const endIndex = Math.min(text.length, firstMatch.end + contextChars);

				let matchedText = text.substring(startIndex, endIndex);
				if (startIndex > 0) matchedText = '...' + matchedText;
				if (endIndex < text.length) matchedText = matchedText + '...';

				// Get prev and next messages by parent/child relationship
				const prevMessage = messageMap.get(message.parent_message_uuid);
				const nextMessage = Array.from(messageMap.values()).find(
					m => m.parent_message_uuid === message.uuid
				);

				// Calculate position (messages ago from current leaf)
				// Step 2: Walk from matched message upward until we hit an ancestor
				let position = 0;
				let isBranched = false;

				if (ancestors.includes(message.uuid)) {
					// Direct ancestor - just get its index
					position = ancestors.indexOf(message.uuid);
					isBranched = false;
				} else {
					// Branched - walk upward until we hit the ancestor chain
					isBranched = true;
					tempId = message.uuid;
					while (tempId && !ancestors.includes(tempId)) {
						const tempMsg = messageMap.get(tempId);
						tempId = tempMsg?.parent_message_uuid;
					}
					position = ancestors.indexOf(tempId);
				}

				results.push({
					matched_text: matchedText,
					full_message_text: text,
					prev_message_text: prevMessage ? ClaudeConversation.extractMessageText(prevMessage) : null,
					prev_message_role: prevMessage ? prevMessage.sender : null,
					next_message_text: nextMessage ? ClaudeConversation.extractMessageText(nextMessage) : null,
					next_message_role: nextMessage ? nextMessage.sender : null,
					next_message_id: nextMessage ? nextMessage.uuid : null,
					matched_message_id: message.uuid,
					role: message.sender,
					position: position,
					is_branched: isBranched,
					timestamp: message.created_at
				});
			}
		}

		return results;
	}

	// ======== CONTEXT MODAL ========
	function showContextModal(result, query, conversation) {
		const contentDiv = document.createElement('div');

		// Scrollable messages container
		const messagesContainer = document.createElement('div');
		messagesContainer.className = 'space-y-4 pr-2';
		messagesContainer.style.maxHeight = '60vh';
		messagesContainer.style.overflowY = 'auto';

		// Helper to create a message block
		function createMessageBlock(text, role, label, isMatched = false) {
			if (!text) return null;

			const block = document.createElement('div');

			const header = document.createElement('div');
			header.className = 'text-sm text-text-200 mb-2';
			const roleIcon = role === 'human' ? '👤' : '🤖';
			const roleName = role === 'human' ? localize('search.role_user') : 'Claude';
			header.textContent = `${roleIcon} ${label}`;
			block.appendChild(header);

			const textBox = document.createElement('div');
			textBox.className = 'p-3 rounded bg-bg-200 border border-border-300';

			if (isMatched && query) {
				highlightInto(textBox, text, compileQuery(query));
			} else {
				textBox.textContent = text;
			}

			block.appendChild(textBox);
			return block;
		}

		// Position text for matched message label
		const positionText = formatPosition(result);

		let matchedBlock = null;

		// Show context based on message role
		if (result.role === 'human') {
			// Human message: show matched + next (assistant response)
			matchedBlock = createMessageBlock(
				result.full_message_text,
				result.role,
				localize('search.matched_message', { position: positionText }),
				true
			);
			if (matchedBlock) messagesContainer.appendChild(matchedBlock);

			if (result.next_message_text) {
				const nextBlock = createMessageBlock(
					result.next_message_text,
					result.next_message_role,
					localize('search.response'),
					false
				);
				if (nextBlock) messagesContainer.appendChild(nextBlock);
			}
		} else {
			// Assistant message: show prev (human question) + matched
			if (result.prev_message_text) {
				const prevBlock = createMessageBlock(
					result.prev_message_text,
					result.prev_message_role,
					localize('search.question'),
					false
				);
				if (prevBlock) messagesContainer.appendChild(prevBlock);
			}

			matchedBlock = createMessageBlock(
				result.full_message_text,
				result.role,
				localize('search.matched_message', { position: positionText }),
				true
			);
			if (matchedBlock) messagesContainer.appendChild(matchedBlock);
		}

		contentDiv.appendChild(messagesContainer);

		const modal = new ClaudeModal(localize('search.message_context'), contentDiv);

		modal.addCancel();
		modal.addConfirm(localize('search.go_to_message'), async () => {
			// Show loading modal
			const loadingModal = createLoadingModal(localize('search.navigating_to_message'));
			loadingModal.show();

			// Human messages carry no data-message-uuid in the DOM, but
			// revealMessageByUuid resolves them via the adjacent assistant message.
			sessionStorage.setItem('message_uuid_to_find', result.matched_message_id);

			const longestLeaf = conversation.findLongestLeaf(result.matched_message_id);
			await conversation.setCurrentLeaf(longestLeaf.leafId);
			window.location.reload();
		});

		// Make context modal larger
		modal.modal.classList.remove('max-w-md');
		modal.modal.classList.add('max-w-2xl', 'w-[90vw]');

		modal.show();

		// Scroll to matched message
		if (matchedBlock) {
			setTimeout(() => matchedBlock.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
		}
	}

	// ======== MAIN SEARCH MODAL ========
	async function showSearchModal() {
		// Show loading modal
		const loadingModal = createLoadingModal(localize('search.loading_conversation'));
		loadingModal.show();

		// Fetch conversation data
		let conversation;
		try {
			const conversationId = getConversationId();
			if (!conversationId) {
				throw new Error('Not in a conversation');
			}

			const orgId = getOrgId();
			conversation = new ClaudeConversation(orgId, conversationId);
			await conversation.getData();
		} catch (error) {
			log.error('Failed to fetch conversation:', error);
			loadingModal.destroy();

			// Show error modal
			showClaudeAlert(localize('common.error'), localize('search.load_conversation_failed'))
			return;
		}

		// Destroy loading modal
		loadingModal.destroy();

		// Build the search UI
		const contentDiv = document.createElement('div');

		// Go to Latest / Go to Longest buttons row
		const topButtonsRow = document.createElement('div');
		topButtonsRow.className = CLAUDE_CLASSES.FLEX_GAP_2 + ' mb-4';

		const latestBtn = createClaudeButton(localize('common.go_to_latest'), 'secondary', async () => {
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

		const longestBtn = createClaudeButton(localize('common.go_to_longest'), 'secondary', async () => {
			const rootId = "00000000-0000-4000-8000-000000000000";
			const longestLeaf = conversation.findLongestLeaf(rootId);
			await conversation.setCurrentLeaf(longestLeaf.leafId);
			window.location.reload();
		});
		longestBtn.classList.add('w-full');
		latestBtn.classList.add('w-full');

		topButtonsRow.appendChild(latestBtn);
		topButtonsRow.appendChild(longestBtn);
		contentDiv.appendChild(topButtonsRow);

		// Search input row
		const searchRow = document.createElement('div');
		searchRow.className = CLAUDE_CLASSES.FLEX_GAP_2 + ' mb-4';

		const searchInput = createClaudeInput({
			type: 'text',
			placeholder: localize('search.search_placeholder'),
		});
		searchInput.className += ' flex-1';

		const searchBtn = createClaudeButton(localize('search.search'), 'primary');

		searchRow.appendChild(searchInput);
		searchRow.appendChild(searchBtn);
		contentDiv.appendChild(searchRow);

		// Results container
		const resultsContainer = document.createElement('div');
		resultsContainer.className = CLAUDE_CLASSES.LIST_CONTAINER;
		resultsContainer.style.maxHeight = '32rem';

		contentDiv.appendChild(resultsContainer);

		// Search function
		const performSearch = async () => {
			const query = searchInput.value.trim();
			resultsContainer.innerHTML = '';

			if (!query) {
				return;
			}

			const results = await searchMessages(query, conversation);

			if (results.length === 0) {
				const noResults = document.createElement('div');
				noResults.className = 'text-center text-text-400 py-8';
				noResults.textContent = localize('search.no_matches', { query });
				resultsContainer.appendChild(noResults);
				return;
			}

			// Sort results by timestamp (most recent first)
			results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

			// Display results
			results.forEach(result => {
				const resultItem = document.createElement('div');
				resultItem.className = CLAUDE_CLASSES.LIST_ITEM;

				const header = document.createElement('div');
				header.className = 'text-sm text-text-200 mb-1';
				const roleIcon = result.role === 'human' ? '👤' : '🤖';
				const roleName = result.role === 'human' ? localize('search.role_user') : 'Claude';
				const relativeTime = getRelativeTime(result.timestamp);
				const positionText = formatPosition(result);

				header.textContent = `${roleIcon} ${roleName} (${positionText} · ${relativeTime})`;

				const matchText = document.createElement('div');
				matchText.className = 'text-text-100';

				// Highlight the match in the preview
				highlightInto(matchText, result.matched_text, compileQuery(query));

				resultItem.appendChild(header);
				resultItem.appendChild(matchText);

				resultItem.onclick = () => {
					showContextModal(result, query, conversation);
				};

				resultsContainer.appendChild(resultItem);
			});
		};

		// Wire up search button and Enter key
		searchBtn.onclick = performSearch;
		searchInput.addEventListener('keypress', (e) => {
			if (e.key === 'Enter') {
				performSearch();
			}
		});

		// Create and show the search modal
		const modal = new ClaudeModal(localize('search.search_conversation'), contentDiv);
		modal.addCancel(localize('common.close'));

		// Override the max-width
		modal.modal.classList.remove('max-w-md');
		modal.modal.classList.add('max-w-xl');

		modal.show();

		// Focus the search input
		setTimeout(() => searchInput.focus(), 100);
	}

	// ======== BUTTON CREATION ========
	function createSearchButton() {
		const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<circle cx="11" cy="11" r="8"></circle>
			<path d="m21 21-4.35-4.35"></path>
		</svg>`;

		const button = createClaudeButton(svgContent, 'icon', () => showSearchModal());
		return button;
	}

	// ======== SCROLL TO TEXT ========
	// Runs after a reload triggered by "Go to Message" or a bookmark. The target is
	// usually not rendered — the page loads at the tail of the branch — so this
	// hands off to revealMessageByUuid, which drives the virtualizer.
	async function scrollToMessageByUuid() {
		const messageUuid = sessionStorage.getItem('message_uuid_to_find');
		if (!messageUuid) return;
		sessionStorage.removeItem('message_uuid_to_find');
		sessionStorage.removeItem('highlight_previous_message'); // legacy key, no longer written

		const revealed = await revealMessageByUuid(messageUuid);
		if (!revealed) log('Could not reveal message', messageUuid);
	}

	// ======== INITIALIZATION ========
	function initialize() {
		// Existing scroll check
		setTimeout(scrollToMessageByUuid, 1000);

		// Add search button to top right
		ButtonBar.register({
			buttonClass: 'search-button',
			createFn: createSearchButton,
			tooltip: localize('search.search_conversation'),
			pages: ['chat'],
		});
	}

	// Wait for DOM to be ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initialize);
	} else {
		initialize();
	}
})();