// tts-interceptor.js
(function () {
	'use strict';
	const log = createLogger('TTSInterceptor');

	// Fallback for when message_start didn't yield a UUID: fetch the conversation and
	// pick the newest assistant message. Only reachable if the stream parse failed.
	async function findNewAssistantMessage(orgId, conversationId, requestSentTime, maxRetries = 2) {
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			if (attempt > 0) {
				log(`Assistant message not found, retrying (${attempt}/${maxRetries})...`);
				await new Promise(r => setTimeout(r, 1000));
			}

			try {
				const response = await fetch(
					`/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`
				);

				if (!response.ok) {
					log.error('Failed to fetch conversation:', response.status);
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
				log.error('Error fetching conversation:', error);
			}
		}

		return null;
	}

	const originalFetch = window.fetch;
	window.fetch = async (...args) => {
		const [input, config] = args;
		const url = ClaudeExtNet.getFetchUrl(input);

		// Intercept completion requests
		if (ClaudeExtNet.isCompletionUrl(url, { retry: true }) && ClaudeExtNet.getFetchMethod(input, config) === 'POST') {
			// DIAGNOSTIC kill-switch: set localStorage['claude_qol_tts_noclone']='1' to skip the
			// TTS response.clone()+background read. Teeing the completion body and draining the
			// clone in a tight loop can make Claude's renderer receive data in bursts (streaming
			// jank). This lets us confirm that live with no rebuild.
			if (ClaudeExtNet.isKillSwitchOn('claude_qol_tts_noclone')) {
				log('TTS clone BYPASSED (claude_qol_tts_noclone=1) — no tee on completion stream');
				return originalFetch(...args);
			}

			const { orgId, conversationId } = ClaudeExtNet.getApiIds(url);
			const currentConversationId = getConversationId();

			// Only handle if valid and matches current conversation
			if (!orgId || !conversationId || (currentConversationId && conversationId !== currentConversationId)) {
				return originalFetch(...args);
			}

			log('Intercepted completion request for TTS handling:', url);
			const requestSentTime = new Date().toISOString();

			// Make the original request
			const response = await originalFetch(...args);

			// Clone the response so we can consume the stream without affecting Claude's UI
			const clonedResponse = response.clone();

			// Consume the cloned stream in the background
			(async () => {
				try {
					let responseUuid = null;
					// Read until message_stop, picking the response UUID out of message_start. Only
					// those two events are parsed; returning false cancels the clone, so it stops
					// buffering whatever follows.
					await ClaudeExtNet.readSseEvents(clonedResponse, (event) => {
						if (!responseUuid && event.raw.includes('"message_start"')) {
							responseUuid = event.data?.message?.uuid ?? null;
							log('TTS: Got response UUID from message_start:', responseUuid);
						}
						if (event.event === 'message_stop' || event.raw.includes('"type":"message_stop"')) {
							log('Stream completion detected');
							return false;
						}
					});

					log('Completed reading completion response stream for TTS handling');
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
						log('No new assistant message found after retries');
					}
				} catch (error) {
					log.error('Error processing completion stream:', error);
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
				log.error('Dialogue analysis failed:', error);
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