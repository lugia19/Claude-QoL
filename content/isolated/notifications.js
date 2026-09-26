// notifications.js
// Version-update and rate-reminder cards (common/ui/cards.js).
'use strict';

(function () {
	const KEYS = {
		previousVersion: SETTINGS_KEYS.NOTIFICATIONS.PREVIOUS_VERSION,
		rateReminderTime: SETTINGS_KEYS.NOTIFICATIONS.RATE_REMINDER_TIME,
		rateReminderShown: SETTINGS_KEYS.NOTIFICATIONS.RATE_REMINDER_SHOWN,
	};

	initNotificationCards({
		name: 'Claude QoL',
		releasesUrl: 'https://github.com/lugia19/Claude-QoL/releases',
		storeUrls: {
			chrome: 'https://chromewebstore.google.com/detail/claude-qol/dkdnancajokhfclpjpplkhlkbhaeejob',
			firefox: 'https://addons.mozilla.org/en-US/firefox/addon/claude-qol/',
		},
		storage: {
			get: (name) => settingsRegistry.get(KEYS[name]),
			set: (name, value) => settingsRegistry.set(KEYS[name], value),
		},
	});
})();
