// pref-switcher-fetch-watcher.js
(function () {
	'use strict';
	const channel = new BroadcastChannel('pref-switcher-updates');

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
			}

			return response;
		}

		// For all other requests, just pass through
		return originalFetch.apply(this, args);
	};
})();