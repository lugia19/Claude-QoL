// pref-switcher-fetch-watcher.js
(function () {
	'use strict';
	const channel = new BroadcastChannel('pref-switcher-updates');

	// An account language change arrives here as { locale: 'ja-JP', ... }. Refresh the 24h locale
	// cache from the request body so i18n.js picks the new language up on the next load.
	function updateLocaleCache(body) {
		try {
			const locale = JSON.parse(body)?.locale;
			if (!SUPPORTED_LOCALES.includes(locale)) return;
			localStorage.setItem('claude_qol_locale_cache', JSON.stringify({
				locale,
				expiry: Date.now() + 24 * 60 * 60 * 1000
			}));
		} catch (e) { /* not JSON / no locale - nothing to do */ }
	}

	const originalFetch = window.fetch;
	window.fetch = async function (...args) {
		const [input, options] = args;
		let url = undefined;
		if (input instanceof URL) {
			url = input.href;
		} else if (typeof input === 'string') {
			url = input;
		} else if (input instanceof Request) {
			url = input.url;
		}

		// Check if this is a PUT to the account_profile endpoint
		if (typeof url === 'string' &&
			url.includes('/api/account_profile') &&
			options?.method === 'PUT') {

			// Call the original fetch
			const response = await originalFetch.apply(this, args);
			if (response.ok) {
				channel.postMessage({ type: 'preferences-changed' });
				updateLocaleCache(options.body);
			}

			return response;
		}

		// For all other requests, just pass through
		return originalFetch.apply(this, args);
	};
})();