// notifications.js
// Version-update and rate-reminder cards (common/ui/cards.js), and the notice for accounts not yet on
// claude.ai's merged experience.
'use strict';

// This version of QoL only supports the merged experience (docs/bard-rework.md, D1/D3). bard-host.js
// (MAIN) probes the account a couple of seconds after load, so check for a while; show the notice
// once per browser session.
(function () {
	const SHOWN_KEY = 'claude_qol_legacy_notice_shown';
	let done = false;
	const check = () => {
		if (done || qolAccountMode() !== 'legacy') return;
		done = true;
		try {
			if (sessionStorage.getItem(SHOWN_KEY)) return;
			sessionStorage.setItem(SHOWN_KEY, '1');
		} catch (e) { /* no sessionStorage: show it anyway */ }
		const card = new FloatingCard({ stackOrder: 1 });
		card.addHeader('Claude QoL');
		card.addText(localize('account.legacy_title'), { bold: true });
		card.addText(localize('account.legacy_body'));
		card.finish().show();
	};
	check();
	let polls = 0;
	const timer = setInterval(() => {
		check();
		if (done || ++polls >= 15) clearInterval(timer);
	}, 2000);
})();

(function () {
	const KEYS = {
		previousVersion: SETTINGS_KEYS.NOTIFICATIONS.PREVIOUS_VERSION,
		rateReminderTime: SETTINGS_KEYS.NOTIFICATIONS.RATE_REMINDER_TIME,
		rateReminderShown: SETTINGS_KEYS.NOTIFICATIONS.RATE_REMINDER_SHOWN,
	};

	initNotificationCards({
		name: 'Claude QoL',
		releasesUrl: 'https://github.com/lugia19/Claude-QoL/releases',
		// Below the usage tracker's cards (stackOrder 0), the more popular extension.
		stackOrder: 1,
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
