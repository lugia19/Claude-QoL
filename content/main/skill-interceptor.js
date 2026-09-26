// skill-interceptor.js
// Hides the encryption key skill from the skills list.
(function() {
	'use strict';

	const HIDDEN_SKILL_NAME = 'qol-encryptionkey-do-not-delete';
	// Legacy encryption-key styles that have since been converted into skills.
	// They carry this marker in their description rather than a known name.
	const HIDDEN_DESCRIPTION_MARKER = 'QOL_ENCRYPT_NODELETE';

	const originalFetch = window.fetch;
	window.fetch = async (...args) => {
		const [input, config] = args;

		// Filter our skill from the skills list
		if (ClaudeExtNet.getFetchUrl(input).includes('/skills/list-skills') &&
			ClaudeExtNet.getFetchMethod(input, config) === 'GET') {
			const response = await originalFetch(...args);
			if (!response.ok) return response;

			try {
				const data = await response.clone().json();
				if (data.skills && Array.isArray(data.skills)) {
					const before = data.skills.length;
					data.skills = data.skills.filter(s =>
						s.name !== HIDDEN_SKILL_NAME &&
						!(typeof s.description === 'string' && s.description.includes(HIDDEN_DESCRIPTION_MARKER))
					);
					if (data.skills.length !== before) {
						console.log('[QOL-SkillInterceptor] Filtered encryption key skill(s) from skills list');
					}
					return ClaudeExtNet.jsonResponse(response, data);
				}
			} catch (e) {
				console.warn('[QOL-SkillInterceptor] Failed to parse skills response:', e.message);
			}
			return response;
		}

		return originalFetch(...args);
	};
})();
