// tts-interceptor.js
(function () {
	'use strict';

	// Fallback for when message_start didn't yield a UUID: fetch the conversation and
	// pick the newest assistant message. Only reachable if the stream parse failed.
	async function findNewAssistantMessage(orgId, conversationId, requestSentTime, maxRetries = 2) {
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			if (attempt > 0) {
				console.log(`Assistant message not found, retrying (${attempt}/${maxRetries})...`);
				await new Promise(r => setTimeout(r, 1000));
			}

			try {
				const response = await fetch(
					`/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`
				);

				if (!response.ok) {
					console.error('Failed to fetch conversation:', response.status);
					continue;
				}

				const data = await response.json();
				const messages = data.chat_messages || [];

				const assistantMessage = messages.find(msg =>
					msg.sender === 'assistant' &&
					msg.created_at > requestSentTime
				);

				if (assistantMessage) {
					return assistantMessage;
				}
			} catch (error) {
				console.error('Error fetching conversation:', error);
			}
		}

		return null;
	}

	const originalFetch = window.fetch;
	window.fetch = async (...args) => {
		const [input, config] = args;

		let url = undefined;
		if (input instanceof URL) {
			url = input.href;
		} else if (typeof input === 'string') {
			url = input;
		} else if (input instanceof Request) {
			url = input.url;
		}

		// Intercept completion requests
		if (url && (url.includes('/completion') || url.includes('/retry_completion')) && config?.method === 'POST') {
			// DIAGNOSTIC kill-switch: set localStorage['claude_qol_tts_noclone']='1' to skip the
			// TTS response.clone()+background read. Teeing the completion body and draining the
			// clone in a tight loop can make Claude's renderer receive data in bursts (streaming
			// jank). This lets us confirm that live with no rebuild.
			try {
				if (localStorage.getItem('claude_qol_tts_noclone') === '1') {
					console.log('[QOL-DIAG] TTS clone BYPASSED (claude_qol_tts_noclone=1) — no tee on completion stream');
					return originalFetch(...args);
				}
			} catch (e) { /* ignore */ }

			// Extract org ID and conversation ID from URL
			const urlParts = url.split('/');
			const orgIndex = urlParts.indexOf('organizations');
			const convIndex = urlParts.indexOf('chat_conversations');

			const orgId = orgIndex !== -1 ? urlParts[orgIndex + 1] : null;
			const conversationId = convIndex !== -1 ? urlParts[convIndex + 1] : null;
			const currentConversationId = getConversationId();

			// Only handle if valid and matches current conversation
			if (!orgId || !conversationId || (currentConversationId && conversationId !== currentConversationId)) {
				return originalFetch(...args);
			}

			console.log('Intercepted completion request for TTS handling:', url);
			const requestSentTime = new Date().toISOString();

			// Make the original request
			const response = await originalFetch(...args);

			// Clone the response so we can consume the stream without affecting Claude's UI
			const clonedResponse = response.clone();

			// Consume the cloned stream in the background
			(async () => {
				try {
					const reader = clonedResponse.body.getReader();
					const decoder = new TextDecoder();
					let responseUuid = null;
					// message_start can straddle a chunk boundary, which would leave us parsing
					// truncated JSON. Carry the incomplete trailing line into the next chunk.
					let sseBuffer = '';
					let scanningForUuid = true;

					// Consume until done, extracting response UUID from message_start
					while (true) {
						const { done, value } = await reader.read();

						if (done) break;

						const chunk = decoder.decode(value, { stream: true });

						// Extract response UUID from the message_start event
						if (scanningForUuid) {
							sseBuffer += chunk;
							const lines = sseBuffer.split('\n');
							sseBuffer = lines.pop();
							for (const line of lines) {
								const trimmed = line.trim();
								if (!trimmed.startsWith('data: ') || !trimmed.includes('"message_start"')) continue;
								try {
									const parsed = JSON.parse(trimmed.substring(6));
									responseUuid = parsed.message?.uuid;
									console.log('TTS: Got response UUID from message_start:', responseUuid);
								} catch (e) {}
								if (responseUuid) break;
							}
							// message_start is the first event in the stream, so if it hasn't turned up
							// early it isn't coming - stop buffering rather than hold the whole response.
							if (responseUuid || sseBuffer.length > 65536) {
								scanningForUuid = false;
								sseBuffer = '';
							}
						}

						if (chunk.includes('event: message_stop') || chunk.includes('"type":"message_stop"')) {
							console.log('Stream completion detected');
							reader.releaseLock();
							break;
						}
					}

					reader.releaseLock();
					console.log('Completed reading completion response stream for TTS handling');
					// The UUID from message_start is all the ISOLATED side needs - it only uses it
					// to locate the message in the DOM. Refetching the whole conversation to look
					// up a UUID we already have is pure waste, so only do it if parsing failed.
					const messageUuid = responseUuid
						?? (await findNewAssistantMessage(orgId, conversationId, requestSentTime))?.uuid;

					if (messageUuid) {
						window.postMessage({
							type: 'tts-auto-speak',
							messageUuid
						}, '*');
					} else {
						console.log('No new assistant message found after retries');
					}
				} catch (error) {
					console.error('Error processing completion stream:', error);
				}
			})();

			return response;
		}

		return originalFetch(...args);
	};

	// Handle dialogue analysis requests from ISOLATED world
	window.addEventListener('message', async (event) => {
		if (event.data.type === 'tts-analyze-dialogue-request') {
			const { prompt, requestId } = event.data;

			try {
				const orgId = getOrgId();
				const conversation = new ClaudeConversation(orgId);
				conversation.prepareNew('TTS Actor Analysis', FAST_MODEL, null, null);

				const response = await conversation.sendMessageAndWaitForResponse(prompt, { model: FAST_MODEL });

				let responseText = ClaudeConversation.extractMessageText(response);

				// Strip markdown code blocks if present
				responseText = responseText.replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim();

				await conversation.delete();

				window.postMessage({
					type: 'tts-analyze-dialogue-response',
					requestId: requestId,
					success: true,
					data: responseText
				}, '*');

			} catch (error) {
				console.error('Dialogue analysis failed:', error);
				window.postMessage({
					type: 'tts-analyze-dialogue-response',
					requestId: requestId,
					success: false,
					error: error.message
				}, '*');
			}
		}
	});
})();