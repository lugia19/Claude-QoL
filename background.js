// background.js
if (typeof importScripts !== 'undefined') {
	importScripts('lib/jszip.min.js');
}

if (chrome.action) {
	chrome.action.onClicked.addListener((tab) => {
		chrome.tabs.create({ url: 'https://ko-fi.com/lugia19' });
	});
}

// ======== GDPR export download (signed-URL flow) ========
// Claude's claude.ai API calls (export_data / export_signed_url) are made by the content
// script, where the page's first-party session cookies apply. The background only handles the
// storage.googleapis.com signed URLs — those are CORS-blocked from the page but allowed here via
// host_permissions — fetching the manifest JSON and unzipping each batch ZIP with JSZip.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	// Fetch a (CORS-restricted) GCS signed URL and report what came back: either the parsed
	// manifest JSON, or a flag saying the URL is the export archive itself.
	if (message.type === 'GDPR_FETCH_MANIFEST') {
		(async () => {
			try {
				const response = await fetch(message.url);
				if (!response.ok) {
					throw new Error(`Manifest download failed: ${response.status}`);
				}

				const reader = response.body.getReader();
				const chunks = [];
				const first = await reader.read();
				if (first.value) chunks.push(first.value);

				// Peek into the response to check whether we got a ZIP as a response instead of
				// JSON. 'PK\x03\x04' is the local file header every ZIP starts with.
				const head = first.value || new Uint8Array();
				if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
					await reader.cancel();
					console.log('[Background] Export URL resolved to a ZIP, not a manifest');
					sendResponse({ success: true, isZip: true });
					return;
				}

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					chunks.push(value);
				}

				const total = chunks.reduce((n, c) => n + c.length, 0);
				const joined = new Uint8Array(total);
				let offset = 0;
				for (const c of chunks) { joined.set(c, offset); offset += c.length; }
				const text = new TextDecoder().decode(joined);

				try {
					sendResponse({ success: true, manifest: JSON.parse(text) });
				} catch (parseError) {
					throw new Error(`Manifest is not JSON nor ZIP (${parseError.message}); response began: ${text.slice(0, 120)}`);
				}
			} catch (error) {
				console.error('[Background] Manifest fetch failed:', error);
				sendResponse({ success: false, error: error.message });
			}
		})();
		return true; // Keep channel open for async response
	}

	// Download + unzip each batch ZIP (by signed GCS URL), then stream conversations back.
	if (message.type === 'DOWNLOAD_GDPR_EXPORT') {
		const tabId = sender.tab && sender.tab.id;
		console.log('[Background] Downloading', (message.zipUrls || []).length, 'export batch(es)');

		(async () => {
			let conversations;
			try {
				conversations = [];
				for (let i = 0; i < message.zipUrls.length; i++) {
					console.log('[Background] Downloading batch', i);
					const zipResponse = await fetch(message.zipUrls[i]);
					if (!zipResponse.ok) {
						throw new Error(`Batch ${i} download failed: ${zipResponse.status}`);
					}
					const zip = await JSZip.loadAsync(await zipResponse.arrayBuffer());
					// Matched by pattern rather than by exact name: a batch archive has it at the
					// root, a whole-account export nests it under a directory.
					const conversationsFile = zip.file(/(^|\/)conversations\.json$/i)[0];
					if (!conversationsFile) {
						const names = Object.keys(zip.files).slice(0, 10).join(', ');
						throw new Error(`conversations.json not found in batch ${i} (archive contains: ${names || 'nothing'})`);
					}
					const batch = JSON.parse(await conversationsFile.async('text'));
					conversations.push(...batch);
					console.log('[Background] Batch', i, ':', batch.length, 'conversations');
				}
			} catch (error) {
				console.error('[Background] Download failed:', error);
				sendResponse({ success: false, error: error.message });
				return;
			}

			console.log('[Background] Total conversations:', conversations.length);
			// Resolve the content script's await first, then stream the data separately.
			sendResponse({ success: true, totalCount: conversations.length });

			if (!tabId) {
				console.error('[Background] No sender tab to stream batches to');
				return;
			}

			try {
				const BATCH_SIZE = 50;
				for (let i = 0; i < conversations.length; i += BATCH_SIZE) {
					chrome.tabs.sendMessage(tabId, {
						type: 'GDPR_BATCH',
						batch: conversations.slice(i, i + BATCH_SIZE),
						index: i,
						total: conversations.length
					});
					// Small delay to avoid overwhelming
					await new Promise(resolve => setTimeout(resolve, 30));
				}
				// Authoritative completion signal.
				chrome.tabs.sendMessage(tabId, { type: 'GDPR_COMPLETE' });
				console.log('[Background] All batches sent');
			} catch (error) {
				console.error('[Background] Streaming failed:', error);
				chrome.tabs.sendMessage(tabId, { type: 'GDPR_ERROR', error: error.message });
			}
		})();

		return true; // Keep channel open for async response
	}
});