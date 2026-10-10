// code-session-prompt.js
// Adds the user's system prompt (set from the Code page's top-right button, content/isolated/code-prompt.js)
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

	const isCreateUrl = (url) => new URL(url, location.origin).pathname === '/v1/code/sessions';

	const originalFetch = window.fetch;
	window.fetch = async (...args) => {
		const [input, config] = args;
		if (typeof config?.body !== 'string' || ClaudeExtNet.getFetchMethod(input, config) !== 'POST' || !isCreateUrl(ClaudeExtNet.getFetchUrl(input))) {
			return originalFetch(...args);
		}
		const setting = promptSetting();
		if (!setting) return originalFetch(...args);
		try {
			const body = JSON.parse(config.body);
			const sessionConfig = body.config ??= {};
			if (setting.mode === 'replace') {
				sessionConfig.custom_system_prompt = setting.text;
			} else {
				const existing = sessionConfig.append_system_prompt;
				sessionConfig.append_system_prompt = existing ? `${existing}\n\n${setting.text}` : setting.text;
			}
			log(`Added the system prompt to a new session (${setting.mode === 'replace' ? 'replace' : 'append'})`);
			return originalFetch(input, { ...config, body: JSON.stringify(body) });
		} catch (e) {
			log.warn('Could not add the system prompt:', e.message);
			return originalFetch(...args);
		}
	};
})();
