// claude-search-global.js
(function () {
	'use strict';

	const { searchDB, compileQuery, findMatches } = window.ClaudeSearchShared;

	// ======== STATE ========
	let isFirstSyncOnRecents = true;
	let syncCancelled = false;
	// Poll for navigation away from the chat list page (/chats, formerly /recents)
	setInterval(() => {
		if (!window.location.pathname.includes('/recents') && !window.location.pathname.includes('/chats')) {
			isFirstSyncOnRecents = true; // Reset when not on /recents
			sessionStorage.setItem('text_search_enabled', 'false'); // Disable text search when leaving
		}
	}, 500);

	// ======== SYNC LOGIC ========
	async function getConversationsToUpdate() {
		const orgId = getOrgId();

		const response = await fetch(`/api/organizations/${orgId}/chat_conversations_v2?limit=10000&offset=0`);
		if (!response.ok) {
			throw new Error('Failed to fetch conversations');
		}

		const allConversations = (await response.json()).data;
		console.log(`Found ${allConversations.length} total conversations`);

		const storedMetadata = await searchDB.getAllMetadata();
		const storedMap = new Map(storedMetadata.map(m => [m.uuid, m]));
		const convIdsWithMessages = new Set(await searchDB.getAllConversationIdsWithMessages());

		const toUpdate = [];
		for (const conv of allConversations) {
			const stored = storedMap.get(conv.uuid);

			if (!stored) {
				toUpdate.push(conv);
			} else if (!convIdsWithMessages.has(conv.uuid)) {
				// Metadata exists but no messages - needs update
				toUpdate.push(conv);
			} else if (new Date(conv.updated_at) > new Date(stored.updated_at)) {
				// Timestamp changed - needs update
				toUpdate.push(conv);
			}
		}

		console.log(`Need to update ${toUpdate.length} conversations`);
		return toUpdate;
	}

	async function syncConversationsIndividually(progressCallback, toUpdate) {
		const orgId = getOrgId();

		if (toUpdate.length === 0) {
			progressCallback('All conversations up to date!');
			return;
		}

		// Split into 2 chunks for parallel processing
		const chunk1 = toUpdate.filter((_, i) => i % 2 === 0);
		const chunk2 = toUpdate.filter((_, i) => i % 2 === 1);

		let completed = 0;
		const delayMs = Math.min(1000, 100 + toUpdate.length); // Dynamic delay based on count
		console.log(`Using ${delayMs}ms delay for ${toUpdate.length} conversations`);

		async function processChunk(chunk) {
			for (let i = 0; i < chunk.length; i++) {
				if (syncCancelled) return; // Early exit on cancel

				const conv = chunk[i];

				try {
					const conversation = new ClaudeConversation(orgId, conv.uuid);
					const messages = await conversation.getMessages(true);
					await searchDB.setMessages(conv.uuid, messages);

					completed++;
					progressCallback(`Updating ${completed} of ${toUpdate.length} conversations...`);

					console.log(`Updated conversation: ${conv.name} (${messages.length} messages)`);
				} catch (error) {
					console.error(`Failed to update conversation ${conv.uuid}:`, error);
					completed++;
				}

				// Rate limit between requests
				if (i < chunk.length - 1) {
					await new Promise(resolve => setTimeout(resolve, delayMs));
				}
			}
		}

		await Promise.all([
			processChunk(chunk1),
			processChunk(chunk2)
		]);

		progressCallback('Sync complete!');
	}

	async function triggerSync() {
		syncCancelled = false; // Reset cancellation state
		const loadingModal = createLoadingModal('Initializing text search...');
		if (isFirstSyncOnRecents) {
			loadingModal.show(); // Show only on first sync when on /recents
			isFirstSyncOnRecents = false;
		}
		const toUpdate = await getConversationsToUpdate();

		for (const conv of toUpdate) {
			await searchDB.setMetadata(conv);
		}

		try {
			// Check conversation count
			loadingModal.setContent(createLoadingContent('Checking what needs syncing...'));

			if (toUpdate.length >= 300) {
				// Use GDPR export for efficiency
				loadingModal.setContent(createLoadingContent(`Preparing to sync ${toUpdate.length} conversations...`));
				await new Promise(resolve => setTimeout(resolve, 2000)); // Let them read it

				while (true) {
					try {
						await syncConversationsViaExport(loadingModal);
						break; // Success, exit loop
					} catch (error) {
						// Handle direct retry from check-in modal (skip showing failure modal)
						if (error.message === 'GDPR_RETRY') {
							loadingModal.setContent(createLoadingContent('Retrying export...'));
							continue;
						}

						console.error('GDPR export failed:', error);
						loadingModal.destroy();

						// Ask user what they want to do with three options
						let errorMessage = error.message;
						if (errorMessage == "USER_CANCEL") errorMessage = undefined
						const choice = await showClaudeThreeOption(
							'Export Failed',
							`The bulk data export failed${errorMessage ? `: ${errorMessage}` : '. '}\n\nWhat would you like to do?`,
							{
								left: { text: 'Cancel' },
								middle: { text: 'Slow Sync' },
								right: { text: 'Retry' }
							}
						);

						if (choice === 'right') { // Retry
							// Show loading modal again and retry
							loadingModal.show();
							loadingModal.setContent(createLoadingContent('Retrying export...'));
							continue;
						} else if (choice === 'middle') { // Use Standard
							const newLoadingModal = createLoadingModal('Starting standard sync...');
							// Add cancel button for fallback sync
							newLoadingModal.addCancel('Cancel', () => {
								syncCancelled = true;
								sessionStorage.setItem('text_search_enabled', 'false');
								newLoadingModal.destroy();
								window.location.reload();
							});
							newLoadingModal.show();

							await syncConversationsIndividually((status) => {
								newLoadingModal.setContent(createLoadingContent(status));
							}, toUpdate);

							newLoadingModal.destroy();
							break; // Done with standard sync
						} else {
							// User cancelled. Reload page and set text search off
							sessionStorage.setItem('text_search_enabled', 'false');
							window.location.reload();
							return;
						}
					}
				}
			} else {
				// Use incremental sync for small amounts of conversations
				// Add cancel button for individual sync
				loadingModal.addCancel('Cancel', () => {
					syncCancelled = true;
					sessionStorage.setItem('text_search_enabled', 'false');
					loadingModal.destroy();
					window.location.reload();
				});

				await syncConversationsIndividually((status) => {
					loadingModal.setContent(createLoadingContent(status));
				}, toUpdate);
			}

		} catch (error) {
			console.error('Sync failed:', error);
			showClaudeAlert('Sync Failed', `An error occurred during sync: ${error.message}`);
			throw error;
		} finally {
			loadingModal.destroy();
		}
	}

	// ======== GDPR EXPORT ========
	let gdprLoadingModal = null;
	let gdprTotalConversations = 0;
	let gdprProcessedConversations = 0;
	let gdprBatchQueue = [];
	let gdprProcessing = false;
	let gdprAllBatchesReceived = false;

	chrome.runtime.onMessage.addListener((message) => {
		// NOTE: this listener must NOT be async. An async listener returns a Promise, which makes
		// Firefox hold the message channel open ("Promised response from onMessage listener went
		// out of scope"). We respond to nothing here, so return undefined.
		if (message.type === 'GDPR_BATCH') {
			gdprBatchQueue.push(message);
			gdprTotalConversations = message.total;
			if (!gdprProcessing) {
				processBatchQueue();
			}
		} else if (message.type === 'GDPR_COMPLETE') {
			// Authoritative "all batches sent" signal. Finishing on this (rather than an exact
			// processed-vs-total count) means a dropped/miscounted batch can't hang the modal.
			gdprAllBatchesReceived = true;
			if (!gdprProcessing && gdprBatchQueue.length === 0) {
				finishGdprImport();
			}
		} else if (message.type === 'GDPR_ERROR') {
			console.error('[QOL-GDPRExport] Import failed:', message.error);
			gdprBatchQueue = [];
			gdprProcessing = false;
			gdprAllBatchesReceived = false;
			gdprProcessedConversations = 0;
			gdprTotalConversations = 0;
			if (gdprLoadingModal) {
				gdprLoadingModal.destroy();
				gdprLoadingModal = null;
			}
			showClaudeAlert('Import Failed', `The data export import failed: ${message.error}`);
		}
	});

	function finishGdprImport() {
		console.log('[QOL-GDPRExport] All conversations processed');
		if (gdprLoadingModal) {
			gdprLoadingModal.destroy();
			gdprLoadingModal = null;
		}
		gdprProcessedConversations = 0;
		gdprTotalConversations = 0;
		gdprAllBatchesReceived = false;
	}

	async function processBatchQueue() {
		gdprProcessing = true;

		while (gdprBatchQueue.length > 0) {
			const message = gdprBatchQueue.shift();

			for (const conv of message.batch) {
				try {
					const metadata = await searchDB.getMetadata(conv.uuid);
					if (metadata) {
						await searchDB.setMessages(conv.uuid, conv.chat_messages);
					}

					gdprProcessedConversations++;
				} catch (error) {
					console.error(`[QOL-GDPRExport] Failed to load conversation ${conv.uuid}:`, error);
					gdprProcessedConversations++;
				}
			}

			console.log(`[QOL-GDPRExport] Processed batch of ${message.batch.length}, total processed: ${gdprProcessedConversations}/${gdprTotalConversations}`);

			if (gdprLoadingModal) {
				gdprLoadingModal.setContent(createLoadingContent(
					`Loading ${gdprProcessedConversations} of ${gdprTotalConversations} conversations...`
				));
			}
		}

		gdprProcessing = false;

		// If the background has signalled completion and the queue is drained, we're done.
		if (gdprAllBatchesReceived && gdprBatchQueue.length === 0) {
			finishGdprImport();
		}
	}

	// Resolve a single export download nonce to its signed GCS URL via the export_signed_url API.
	// Returns { ready: true, signedUrl } once ready — note this success CONSUMES the nonce — or
	// { ready: false, status, message } while still generating ('export_link_not_found') or if it
	// was already consumed ('export_link_used').
	async function resolveExportSignedUrl(orgId, nonce) {
		const response = await fetch(`/api/organizations/${orgId}/export_signed_url/${nonce}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' }
		});
		if (response.status === 200) {
			const data = await response.json();
			return { ready: true, signedUrl: data.signed_url };
		}
		let message = null;
		try { message = (await response.json()).error?.message; } catch (e) { /* ignore */ }
		return { ready: false, status: response.status, message };
	}

	async function syncConversationsViaExport(loadingModal) {
		const orgId = getOrgId();

		console.log('[QOL-GDPRExport] Starting export sync for conversations');

		// Phase 1: Request export
		loadingModal.setContent(createLoadingContent(
			'Requesting data export...'
		));

		console.log('[QOL-GDPRExport] Requesting export from API...');
		const exportResponse = await fetch(`/api/organizations/${orgId}/export_data`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' }
		});

		if (!exportResponse.ok) {
			const errorText = await exportResponse.text();
			console.error('[QOL-GDPRExport] Export request failed:', exportResponse.status, errorText);
			throw new Error(`Export request failed: ${exportResponse.status}`);
		}

		const exportData = await exportResponse.json();
		const nonce = exportData.nonce;
		console.log('[QOL-GDPRExport] Export requested, nonce:', nonce);

		// Phase 2: Poll export_signed_url until the export is ready.
		// While generating it returns 404 'export_link_not_found' (does NOT consume the nonce);
		// once ready it returns 200 { signed_url } AND consumes the nonce — so we keep and use that
		// signed URL directly here (re-POSTing the nonce afterward yields 'export_link_used').
		const POLL_INTERVAL_MS = 30000; // 30 seconds
		const CHECK_IN_INTERVAL_MS = 180000; // 3 minutes

		let manifestSignedUrl = null;
		let lastCheckInTime = Date.now();

		while (true) {
			const msUntilCheckIn = CHECK_IN_INTERVAL_MS - (Date.now() - lastCheckInTime);
			const mins = Math.floor(msUntilCheckIn / 60000);
			const secs = Math.floor((msUntilCheckIn % 60000) / 1000);
			loadingModal.setContent(createLoadingContent(
				`Waiting for export to complete...\nChecking in in ${mins}m ${secs}s...`
			));

			try {
				const result = await resolveExportSignedUrl(orgId, nonce);
				if (result.ready) {
					manifestSignedUrl = result.signedUrl;
					console.log('[QOL-GDPRExport] Export ready, got manifest URL');
					break;
				}
				if (result.message === 'export_link_used') {
					throw new Error('Export link already used');
				}
				// 'export_link_not_found' → still generating, keep waiting.
			} catch (error) {
				if (error.message === 'Export link already used') throw error;
				console.warn(`[QOL-GDPRExport] Poll failed:`, error.message);
			}

			// Wait before next attempt
			await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

			// Check if it's time for a check-in
			if (Date.now() - lastCheckInTime >= CHECK_IN_INTERVAL_MS) {
				lastCheckInTime = Date.now();
				const choice = await showClaudeThreeOption(
					'Export In Progress',
					'The data export is taking a while. Would you like to keep waiting?\n\nIf you received an email from Anthropic stating the export failed, retry or cancel.',
					{
						left: { text: 'Cancel' },
						middle: { text: 'Retry', variant: 'primary' },
						right: { text: 'Keep Waiting', variant: 'primary' }
					}
				);
				if (choice === 'left') throw new Error('USER_CANCEL');
				if (choice === 'middle') throw new Error('GDPR_RETRY');
			}
		}

		// Phase 3: Fetch the manifest and resolve each batch nonce to a signed ZIP URL.
		// GCS signed URLs are CORS-blocked from the page, so the background fetches them.
		loadingModal.setContent(createLoadingContent('Downloading and processing export...'));

		const manifestResult = await new Promise((resolve) => {
			chrome.runtime.sendMessage({ type: 'GDPR_FETCH_MANIFEST', url: manifestSignedUrl }, resolve);
		});
		if (!manifestResult || !manifestResult.success) {
			throw new Error(`Manifest fetch failed: ${manifestResult ? manifestResult.error : 'no response'}`);
		}

		// The signed URL either points at a manifest listing per-batch nonces, or straight at the
		// archive. In the latter case there is nothing to resolve — the URL we hold is the only batch.
		const zipUrls = [];
		if (manifestResult.isZip) {
			console.log('[QOL-GDPRExport] Export is a single archive, no manifest indirection');
			zipUrls.push(manifestSignedUrl);
		}

		const dataFiles = manifestResult.isZip ? [] : (manifestResult.manifest.data_files || [])
			.slice()
			.sort((a, b) => a.batch_index - b.batch_index);
		if (!manifestResult.isZip) {
			console.log('[QOL-GDPRExport] Manifest lists', dataFiles.length, 'batch file(s)');
		}

		for (const file of dataFiles) {
			const batchNonce = file.export_url.split('/').pop();
			let resolved = await resolveExportSignedUrl(orgId, batchNonce);
			// Batches of a freshly-generated export should be ready immediately; retry briefly.
			let attempts = 0;
			while (!resolved.ready && resolved.message === 'export_link_not_found' && attempts < 5) {
				await new Promise(r => setTimeout(r, 2000));
				resolved = await resolveExportSignedUrl(orgId, batchNonce);
				attempts++;
			}
			if (!resolved.ready) {
				throw new Error(`Batch ${file.batch_index} unavailable: ${resolved.message || resolved.status}`);
			}
			zipUrls.push(resolved.signedUrl);
		}

		if (zipUrls.length === 0) {
			throw new Error('The export contained no data files');
		}

		// Phase 4: Hand the ZIP URLs to the background to download, unzip and stream back.
		// Reset streaming state for this import, then show the import modal before kicking it off
		// (the background may start streaming GDPR_BATCH the moment it responds).
		gdprBatchQueue = [];
		gdprProcessing = false;
		gdprAllBatchesReceived = false;
		gdprProcessedConversations = 0;
		gdprTotalConversations = 0;

		gdprLoadingModal = createLoadingModal('Importing...');
		gdprLoadingModal.show();
		const downloadResult = await new Promise((resolve) => {
			chrome.runtime.sendMessage({ type: 'DOWNLOAD_GDPR_EXPORT', zipUrls }, resolve);
		});

		if (!downloadResult || !downloadResult.success) {
			gdprLoadingModal.destroy();
			gdprLoadingModal = null;
			throw new Error(`Download failed: ${downloadResult ? downloadResult.error : 'no response'}`);
		}

		console.log('[QOL-GDPRExport] Processing', downloadResult.totalCount, 'conversations...');
	}

	function transformGDPRToMetadata(gdprConv) {
		return {
			uuid: gdprConv.uuid,
			name: gdprConv.name,
			created_at: gdprConv.created_at,
			updated_at: gdprConv.updated_at,
			summary: gdprConv.summary || "",
			model: null,
			settings: {},
			is_starred: false,
			is_temporary: false,
			project_uuid: null,
			current_leaf_message_uuid: null,
			user_uuid: null,
			project: null
		};
	}

	// ======== SEARCH INTERCEPT HANDLER ========
	window.addEventListener('message', async (event) => {
		if (event.source !== window) return;
		if (event.data.type !== 'SEARCH_INTERCEPT') return;

		const { messageId, query, url } = event.data;
		//console.log('[QOL-Search] Received intercept request:', query);

		// If text search is not enabled, don't intercept

		if (sessionStorage.getItem('text_search_enabled') != 'true') {
			//console.log('[QOL-Search] Text search disabled, not intercepting');
			window.postMessage({
				type: 'SEARCH_RESPONSE',
				messageId,
				intercept: false
			}, '*');
			return;
		}

		try {
			// Search all conversations
			const results = await searchAllConversations(query);

			//console.log('[QOL-Search] Found', results.length, 'matching conversations');

			window.postMessage({
				type: 'SEARCH_RESPONSE',
				messageId,
				intercept: true,
				results: results
			}, '*');

		} catch (error) {
			console.error('[QOL-Search] Search failed:', error);
			window.postMessage({
				type: 'SEARCH_RESPONSE',
				messageId,
				intercept: false
			}, '*');
		}
	});

	// Build a ~snippetSize preview centred on `first` (the first match in `text`), with leading/
	// trailing ellipses when truncated. Returns { text, matches } with matches as offsets into text.
	function buildSnippet(text, first, matcher, snippetSize = 160) {
		if (!text) return { text: '', matches: [] };
		// `first` is a single {start, end}, not a list - guard on the shape so a caller passing an
		// array can't silently fall through and produce a garbage window.
		if (!first || typeof first.start !== 'number') {
			return { text: text.slice(0, snippetSize) + (text.length > snippetSize ? '…' : ''), matches: [] };
		}
		// Match widths vary under a regex query, so centre on this match's actual span.
		const matchLength = first.end - first.start;
		const pad = Math.max(0, Math.floor((snippetSize - matchLength) / 2));
		const start = Math.max(0, first.start - pad);
		const end = Math.min(text.length, first.end + pad);
		const prefix = start > 0 ? '…' : '';
		const suffix = end < text.length ? '…' : '';
		const body = text.slice(start, end);
		// Re-find occurrences within the visible window, offset by the leading ellipsis. Scanning
		// the window rather than keeping every match keeps memory flat across a big result set.
		const matches = findMatches(body, matcher).map(m => ({
			start: m.start + prefix.length,
			end: m.end + prefix.length
		}));
		return { text: prefix + body + suffix, matches };
	}

	// ======== SEARCH FUNCTION (NEW) ========
	async function searchAllConversations(query) {
		if (!query || query.trim() === '') {
			return [];
		}

		const totalStart = performance.now();
		console.log('========================================');
		console.log('[QOL-Search] Query:', query);

		const matcher = compileQuery(query);
		if (matcher.regex) {
			console.log('[QOL-Search] Regex mode:', matcher.regex.source);
		}

		// Load everything
		const loadStart = performance.now();
		const [allMetadata, allMessages] = await Promise.all([
			searchDB.getAllMetadata(),
			searchDB.getAllMessages()
		]);
		const loadTime = performance.now() - loadStart;
		console.log(`[QOL-Search] Loaded ${allMessages.length} conversations in ${loadTime.toFixed(0)}ms`);

		// Search through plain text
		const searchStart = performance.now();
		const matches = [];

		for (const entry of allMessages) {
			const textMatches = findMatches(entry.searchableText, matcher);

			if (textMatches.length > 0) {
				// Only the first match is retained - it's all the snippet needs to centre itself,
				// and holding every offset for every hit adds up fast on a common query.
				matches.push({ uuid: entry.uuid, matchCount: textMatches.length, firstMatch: textMatches[0] });
			}
		}
		const searchTime = performance.now() - searchStart;

		// Build results in Claude's conversation/search/v2 shape:
		// { conversation, matched_snippet: { text, matches }, title_matches }
		const messagesByUuid = new Map(allMessages.map(m => [m.uuid, m]));
		const results = matches.map(match => {
			const metadata = allMetadata.find(m => m.uuid === match.uuid);
			const entry = messagesByUuid.get(match.uuid);

			// title_matches must reference the ORIGINAL name, before we append the count suffix.
			const titleMatches = findMatches(metadata.name, matcher);

			return {
				conversation: {
					...metadata,
					name: `${metadata.name} (${match.matchCount} match${match.matchCount > 1 ? 'es' : ''})`
				},
				matched_snippet: buildSnippet(entry ? entry.searchableText : '', match.firstMatch, matcher),
				title_matches: titleMatches
			};
		});

		// Sort
		results.sort((a, b) =>
			new Date(b.conversation.updated_at).getTime() - new Date(a.conversation.updated_at).getTime()
		);

		const totalTime = performance.now() - totalStart;

		console.log(`[QOL-Search] Results:`);
		console.log(`  - Load: ${loadTime.toFixed(0)}ms`);
		console.log(`  - Search: ${searchTime.toFixed(0)}ms`);
		console.log(`  - TOTAL: ${totalTime.toFixed(0)}ms`);
		console.log(`  - Found: ${results.length} matches`);
		console.log('========================================');

		return results;
	}

	// ======== GLOBAL SEARCH TOGGLE ========
	function addGlobalSearchToggle() {
		// Only on the chat list page (/chats, formerly /recents)
		if (!window.location.pathname.includes('/recents') && !window.location.pathname.includes('/chats')) {
			return;
		}

		// Check if toggle already exists anywhere on page
		if (document.querySelector('.global-search-toggle')) {
			return;
		}

		// Find the header buttons container
		const header = document.querySelector('[data-testid="page-header"]');
		if (!header) return;
		const newLink = header.querySelector('a[href="/new"]');
		if (!newLink) return;
		const buttonsContainer = newLink.closest('.flex.items-center');
		if (!buttonsContainer) return;

		// Create toggle container - place it in the header
		const toggleContainer = document.createElement('div');
		toggleContainer.className = 'flex items-center gap-2 global-search-toggle shrink-0';

		// Labels
		const titleLabel = document.createElement('span');
		titleLabel.className = 'text-text-500 text-sm select-none';
		titleLabel.textContent = 'Title Search';

		const textLabel = document.createElement('span');
		textLabel.className = 'text-text-500 text-sm select-none';
		textLabel.textContent = 'Text Search';

		// Create toggle (always defaults to false = title search)
		const isTextSearch = sessionStorage.getItem('text_search_enabled') === 'true';
		const toggle = createClaudeToggle('', isTextSearch);

		if (isTextSearch) {
			triggerSync();
		}

		// Update state on change
		toggle.input.addEventListener('change', (e) => {
			const mode = e.target.checked ? 'text' : 'title';
			console.log('Search mode changed to:', mode);

			if (mode === 'text') {
				sessionStorage.setItem('text_search_enabled', 'true');
			} else {
				sessionStorage.removeItem('text_search_enabled');
			}
			window.location.reload();
		});

		// Assemble
		toggleContainer.appendChild(titleLabel);
		toggleContainer.appendChild(toggle.container);
		toggleContainer.appendChild(textLabel);

		// Insert before the existing buttons
		buttonsContainer.insertBefore(toggleContainer, buttonsContainer.firstChild);
	}

	// ======== INITIALIZATION ========
	function initialize() {
		// Add global search toggle on recents page
		setInterval(() => {
			addGlobalSearchToggle();
		}, 1000);
	}

	// Wait for DOM to be ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initialize);
	} else {
		initialize();
	}
})();