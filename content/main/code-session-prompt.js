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

	// ======== Empty sessions ========
	// claude.ai's UI only creates a session together with its first message; the API takes none. Asked
	// for by the Code prompt button (pref-switcher.js): a cloud session with no repo and no message, in
	// the org's default cloud environment, then opened. Created through window.fetch, so the wrapper
	// above adds the active prompt like for any other session. Left untitled: the first message titles
	// it, as it does for the UI's own.
	const ccrHeaders = (org) => ({ 'anthropic-version': '2023-06-01', 'anthropic-beta': 'ccr-byoc-2025-07-29', 'anthropic-client-feature': 'ccr', 'x-organization-uuid': org });

	async function createEmptySession() {
		const org = getActiveOrgId();
		if (!org) throw new Error('no active organization');
		const envResponse = await fetch(`/v1/environment_providers/private/organizations/${org}/environments?limit=1000`, { headers: ccrHeaders(org) });
		if (!envResponse.ok) throw new Error(`environments: HTTP ${envResponse.status}`);
		const clouds = ((await envResponse.json()).environments ?? []).filter(e => e.kind === 'anthropic_cloud');
		const environment = clouds.find(e => e.is_ccr_default) ?? clouds[0];
		if (!environment) throw new Error('no cloud environment');
		const response = await fetch('/v1/code/sessions', {
			method: 'POST',
			headers: { ...ccrHeaders(org), 'content-type': 'application/json' },
			body: JSON.stringify({ environment_id: environment.environment_id, config: { sources: [], outcomes: [] }, events: [] }),
		});
		if (!response.ok) throw new Error(`create: HTTP ${response.status}`);
		const id = (await response.json()).session?.id;
		if (!id) throw new Error('no session id');
		return id;
	}

	window.addEventListener('message', async (event) => {
		if (event.source !== window || event.origin !== window.location.origin) return;
		if (event.data?.type !== 'qol-empty-code-session') return;
		const loading = createLoadingModal(localize('code_prompt.launching'));
		loading.show();
		try {
			const id = await createEmptySession();
			log('Created an empty session', id);
			// The desktop client's Code pages live under /epitaxy; session pages use session_ for cse_.
			const base = location.pathname.startsWith('/epitaxy') ? '/epitaxy' : '/code';
			location.assign(`${base}/session_${id.replace(/^cse_/, '')}`);
		} catch (error) {
			log.error('Could not create an empty session:', error);
			loading.destroy();
			showClaudeAlert(localize('common.error'), localize('code_prompt.launch_failed'));
		}
	});
})();
