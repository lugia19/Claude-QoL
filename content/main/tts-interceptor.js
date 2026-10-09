// tts-interceptor.js
(function () {
	'use strict';
	const log = createLogger('TTSInterceptor');

	// Auto-speak: when a reply finishes streaming in the chat on screen, ask ISOLATED (tts.js) to read it.
	// On the merged experience the turn runs on StreamTimeline: while it runs, updates carry
	// conversation.status STATUS_RUNNING with status_assistant_message_id = the reply; it settles in one
	// update with STATUS_IDLE and that reply complete (is_complete + stop_reason). Only a reply this page
	// saw running counts, so a snapshot or a reconnect replaying a finished turn never speaks.
	const runningReplies = new Set(); // reply ids seen while their turn was running
	const spokenReplies = new Set();

	QolBardHost.observe(function autoSpeakOnSettle(event, ctx) {
		const update = event.update;
		if (!update || update.replace_all_state) return;
		const conversation = update.conversation;
		if (conversation?.status === 'STATUS_RUNNING' && conversation.status_assistant_message_id) {
			runningReplies.add(conversation.status_assistant_message_id);
			return;
		}
		if (conversation?.status !== 'STATUS_IDLE') return;
		for (const message of update.messages ?? []) {
			if (message.role !== 'ROLE_ASSISTANT' || !message.is_complete || !message.stop_reason) continue;
			if (!runningReplies.delete(message.id) || spokenReplies.has(message.id)) continue;
			// Only the chat on screen: its row is what tts.js reads aloud.
			if (ctx.conversationId !== getConversationId()) continue;
			spokenReplies.add(message.id);
			log('Turn settled, auto-speak for', message.id);
			ClaudeExtBridge.call('qol', 'TTS_AUTO_SPEAK', { messageUuid: message.id }).catch(() => { });
		}
	}, { label: 'tts-auto-speak' });

	// Handle dialogue analysis requests from ISOLATED world. ISOLATED asks here, the reverse of what
	// ClaudeExtBridge supports, so this relay stays hand-rolled.
	window.addEventListener('message', async (event) => {
		if (event.source !== window || event.origin !== window.location.origin) return;
		if (event.data?.type === 'tts-analyze-dialogue-request') {
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
				}, window.location.origin);

			} catch (error) {
				log.error('Dialogue analysis failed:', error);
				window.postMessage({
					type: 'tts-analyze-dialogue-response',
					requestId: requestId,
					success: false,
					error: error.message
				}, window.location.origin);
			}
		}
	});
})();