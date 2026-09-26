// pref-switcher-fetch-watcher.js
(function () {
	'use strict';
	const channel = new BroadcastChannel('pref-switcher-updates');

	const originalFetch = window.fetch;
	window.fetch = async function (...args) {
		const [input, options] = args;

		// Check if this is a PUT to the account_profile endpoint
		if (ClaudeExtNet.getFetchUrl(input).includes('/api/account_profile') &&
			ClaudeExtNet.getFetchMethod(input, options) === 'PUT') {

			// Call the original fetch
			const response = await originalFetch.apply(this, args);
			if (response.ok) {
				channel.postMessage({ type: 'preferences-changed' });
			}

			return response;
		}

		// For all other requests, just pass through
		return originalFetch.apply(this, args);
	};
})();