// tts-interceptor.js
(function () {
	'use strict';
	const log = createLogger('TTSInterceptor');

	// Auto-speak: when a reply finishes streaming in the chat on screen, ask ISOLATED (tts.js) to read it.
	// On the merged experience the turn runs on StreamTimeline: while it runs, updates carry
	// conversation.status STATUS_RUNNING with status_assistant_message_id = the reply; it settles in one
	// update with STATUS_IDLE and that reply complete (is_complete + stop_reason). Only a reply this page
	// saw running counts, so a snapshot or a reconnect replaying a finished turn never speaks. A snapshot
	// that is itself running (the page loaded, or the stream reconnected, mid-reply) does count.
	const runningReplies = new Set(); // reply ids seen while their turn was running
	const spokenReplies = new Set();

	QolBardHost.observe(function autoSpeakOnSettle(event, ctx) {
		const update = event.update;
		if (!update) return;
		const conversation = update.conversation;
		if (conversation?.status === 'STATUS_RUNNING' && conversation.status_assistant_message_id) {
			runningReplies.add(conversation.status_assistant_message_id);
			return;
		}
		if (update.replace_all_state || conversation?.status !== 'STATUS_IDLE') return;
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
})();