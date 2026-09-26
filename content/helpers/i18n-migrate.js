// i18n-migrate.js
// One-time move of the toolbox's old language keys to the shared ones read by
// common/i18n/i18n-core.js. Runs in both worlds, before i18n-core.js resolves the language.
// Safe to delete once enough releases have passed.
(function () {
	'use strict';
	try {
		for (const [oldKey, newKey] of [
			['claude_qol_language', 'claude_ext_language'],
			['claude_qol_locale_cache', 'claude_ext_locale_cache'],
		]) {
			const value = localStorage.getItem(oldKey);
			if (value === null) continue;
			if (localStorage.getItem(newKey) === null) localStorage.setItem(newKey, value);
			localStorage.removeItem(oldKey);
		}
	} catch (e) { /* storage blocked - nothing to migrate */ }
})();
