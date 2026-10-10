// code-session-prompt.js
// Adds the user's system prompt (picked from the Code page's top-right preset button, content/isolated/pref-switcher.js)
// to every Claude Code cloud session the page creates: POST /v1/code/sessions takes it in its config, fixed
// for the session's life. "append" chains it onto config.append_system_prompt, which claude.ai already
// fills with its own text (how to write PR links); "replace" sets config.custom_system_prompt, which takes
// the place of Claude Code's built-in instructions. Read from the localStorage mirror at request time, so a
// change applies to the next session without a reload. Desktop "Local" sessions don't come through here.
(function () {
	'use strict';
	const log = createLogger('CodePrompt');

	const MIRROR_KEY = 'claude_qol_code_prompt';

	function promptSetting() {
		try {
			const setting = JSON.parse(localStorage.getItem(MIRROR_KEY) || 'null');
			return setting?.text?.trim() ? setting : null;
		} catch (e) {
			return null;
		}
	}

	// getFetchUrl resolves relative URLs, but returns '' for an input it can't read: never throw on the way past.
	const isCreateUrl = (url) => {
		try {
			return new URL(url).pathname === '/v1/code/sessions';
		} catch (e) {
			return false;
		}
	};

	const originalFetch = window.fetch;
	window.fetch = async (...args) => {
		const [input, config] = args;
		if (config?.body == null || ClaudeExtNet.getFetchMethod(input, config) !== 'POST' || !isCreateUrl(ClaudeExtNet.getFetchUrl(input))) {
			return originalFetch(...args);
		}
		const setting = promptSetting();
		if (!setting) return originalFetch(...args);
		try {
			const body = await ClaudeExtNet.readJsonRequestBody(config);
			const sessionConfig = body.config ??= {};
			if (setting.mode === 'replace') {
				sessionConfig.custom_system_prompt = setting.text;
				log('Set the system prompt of a new session (replace)');
			} else {
				const existing = sessionConfig.append_system_prompt;
				sessionConfig.append_system_prompt = existing ? `${existing}\n\n${setting.text}` : setting.text;
				log('Added to the system prompt of a new session (append)');
			}
			return originalFetch(input, await ClaudeExtNet.withJsonRequestBody(config, body));
		} catch (e) {
			log.warn('Could not add the system prompt:', e.message);
			return originalFetch(...args);
		}
	};
})();
