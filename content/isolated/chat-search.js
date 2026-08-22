// claude-search-chat.js
(function () {
	'use strict';

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
			const roleName = role === 'human' ? 'User' : 'Claude';
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
		const positionText = result.is_branched
			? `Branched ${result.position} ${result.position > 1 ? "messages" : "message"} ago`
			: `${result.position} ${result.position > 1 ? "messages" : "message"} ago`;

		let matchedBlock = null;

		// Show context based on message role
		if (result.role === 'human') {
			// Human message: show matched + next (assistant response)
			matchedBlock = createMessageBlock(
				result.full_message_text,
				result.role,
				`Matched Message (${positionText})`,
				true
			);
			if (matchedBlock) messagesContainer.appendChild(matchedBlock);

			if (result.next_message_text) {
				const nextBlock = createMessageBlock(
					result.next_message_text,
					result.next_message_role,
					'Response',
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
					'Question',
					false
				);
				if (prevBlock) messagesContainer.appendChild(prevBlock);
			}

			matchedBlock = createMessageBlock(
				result.full_message_text,
				result.role,
				`Matched Message (${positionText})`,
				true
			);
			if (matchedBlock) messagesContainer.appendChild(matchedBlock);
		}

		contentDiv.appendChild(messagesContainer);

		const modal = new ClaudeModal('Message Context', contentDiv);

		modal.addCancel('Cancel');
		modal.addConfirm('Go to Message', async () => {
			// Show loading modal
			const loadingModal = createLoadingModal('Navigating to message...');
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

	// ======== AUTO-OPEN SEARCH ========
	let isNewConversation = true;

	function checkForAutoOpenSearch() {
		const conversationId = getConversationId();

		if (!conversationId) {
			// Not in a chat, reset flag
			isNewConversation = true;
			return;
		}

		// In a chat - only auto-open if we just navigated here
		if (!isNewConversation) {
			return;
		}

		console.log('[QOL-ChatSearch] Current conversation ID:', conversationId);

		const queriesJson = localStorage.getItem('global_search_queries');
		console.log('[QOL-ChatSearch] Queries from storage:', queriesJson);

		const queries = JSON.parse(queriesJson || '{}');
		const query = queries[conversationId];

		console.log('[QOL-ChatSearch] Query for this conversation:', query);

		if (!query) {
			// No query for this conversation, mark as processed
			isNewConversation = false;
			return;
		}

		console.log('Auto-open search detected for query:', query);

		const searchButton = document.querySelector('.search-button');
		console.log('[QOL-ChatSearch] Search button found:', !!searchButton);

		if (searchButton) {
			console.log('Search button found, opening modal directly');

			// Remove just this conversation's entry
			delete queries[conversationId];
			localStorage.setItem('global_search_queries', JSON.stringify(queries));

			showSearchModal(query);

			// NOW mark as not new, after successful open
			isNewConversation = false;
		}

		// If button not found yet, keep isNewConversation=true so we keep checking
	}

	// ======== MAIN SEARCH MODAL ========
	async function showSearchModal(autoQuery = null) {
		// Show loading modal
		const loadingModal = createLoadingModal('Loading conversation...');
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
			console.error('Failed to fetch conversation:', error);
			loadingModal.destroy();

			// Show error modal
			showClaudeAlert('Error', 'Failed to load conversation data.')
			return;
		}

		// Destroy loading modal
		loadingModal.destroy();

		// Build the search UI
		const contentDiv = document.createElement('div');

		// Go to Latest / Go to Longest buttons row
		const topButtonsRow = document.createElement('div');
		topButtonsRow.className = CLAUDE_CLASSES.FLEX_GAP_2 + ' mb-4';

		const latestBtn = createClaudeButton('Go to Latest', 'secondary', async () => {
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
			placeholder: 'Search messages... (/regex/)',
		});
		searchInput.className += ' flex-1';

		const searchBtn = createClaudeButton('Search', 'primary');

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
				noResults.textContent = `No matches found for "${query}"`;
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
				const roleName = result.role === 'human' ? 'User' : 'Claude';
				const relativeTime = getRelativeTime(result.timestamp);
				const positionText = result.is_branched
					? `Branched ${result.position} ${result.position > 1 ? "messages" : "message"} ago`
					: `${result.position} ${result.position > 1 ? "messages" : "message"} ago`;

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
		const modal = new ClaudeModal('Search Conversation', contentDiv);
		modal.addCancel('Close');

		// Override the max-width
		modal.modal.classList.remove('max-w-md');
		modal.modal.classList.add('max-w-xl');

		modal.show();

		// Focus the search input
		setTimeout(() => searchInput.focus(), 100);

		// If auto-open, pre-populate and run search
		if (autoQuery) {
			searchInput.value = autoQuery;
			performSearch();
		}
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
		if (!revealed) console.log('[QOL-ChatSearch] Could not reveal message', messageUuid);
	}

	// ======== INITIALIZATION ========
	function initialize() {
		// Existing scroll check
		setTimeout(scrollToMessageByUuid, 1000);

		// Add search button to top right
		ButtonBar.register({
			buttonClass: 'search-button',
			createFn: createSearchButton,
			tooltip: 'Search Conversation',
			pages: ['chat'],
		});

		// Check for auto-open search on chat pages (delayed start)
		setTimeout(() => {
			setInterval(() => {
				if (window.location.pathname.includes('/chat/')) {
					checkForAutoOpenSearch();
				}
			}, 1000);
		}, 5000);
	}

	// Wait for DOM to be ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initialize);
	} else {
		initialize();
	}
})();