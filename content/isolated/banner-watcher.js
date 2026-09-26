(function () {
	'use strict';

	const FLAG_SEVERITY = {
		'consumer_first_warning': { level: 1, color: '#eab308', label: localize('banner.first_warning') },
		'consumer_second_warning': { level: 2, color: '#f97316', label: localize('banner.second_warning') },
		'consumer_restricted_mode': { level: 3, color: '#ef4444', label: localize('banner.restricted_mode') },
	};
	const DEFAULT_COLOR = '#eab308';

	const FLAG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
		<line x1="4" y1="22" x2="4" y2="15"/>
	</svg>`;

	let _activeFlags = [];
	let _buttonRef = null;

	function getHighestSeverityColor() {
		let maxLevel = 0;
		let color = DEFAULT_COLOR;
		for (const flag of _activeFlags) {
			const severity = FLAG_SEVERITY[flag.type];
			if (severity && severity.level > maxLevel) {
				maxLevel = severity.level;
				color = severity.color;
			}
		}
		return color;
	}

	function updateButton() {
		if (!_buttonRef) return;
		if (_activeFlags.length === 0) {
			_buttonRef.style.display = 'none';
		} else {
			_buttonRef.style.display = '';
			_buttonRef.style.color = getHighestSeverityColor();
		}
	}

	// Debug: comment/uncomment entries to test different flag states
	const DEBUG_FLAGS = [
		//{ type: 'consumer_first_warning', expires_at: '2099-01-01T00:00:00Z' },
		//{ type: 'consumer_second_warning', expires_at: '2099-01-01T00:00:00Z' },
		//{ type: 'consumer_restricted_mode', expires_at: '2099-01-01T00:00:00Z' },
	];

	async function fetchActiveFlags() {
		if (DEBUG_FLAGS.length > 0) {
			_activeFlags = DEBUG_FLAGS;
			updateButton();
			return;
		}

		try {
			const storedFlags = await settingsRegistry.get(SETTINGS_KEYS.BANNER_WATCHER.STORED_FLAGS);

			const orgId = getOrgId();
			const response = await fetch('/api/organizations');
			if (response.ok) {
				const orgs = await response.json();
				const org = orgs.find(o => o.uuid === orgId);
				if (org && org.active_flags) {
					for (const flag of org.active_flags) {
						storedFlags[flag.type] = { type: flag.type, expires_at: flag.expires_at || null };
					}
				}
			}

			const now = Date.now();
			for (const [key, flag] of Object.entries(storedFlags)) {
				if (flag.expires_at && new Date(flag.expires_at).getTime() <= now) {
					delete storedFlags[key];
				}
			}

			await settingsRegistry.set(SETTINGS_KEYS.BANNER_WATCHER.STORED_FLAGS, storedFlags);
			_activeFlags = Object.values(storedFlags);
			updateButton();
		} catch (e) {
			// Silently ignore polling errors
		}
	}

	function formatRelativeTime(expiresAt) {
		const diff = new Date(expiresAt).getTime() - Date.now();
		if (diff <= 0) return localize('banner.expired');
		const hours = Math.floor(diff / 3600000);
		const minutes = Math.floor((diff % 3600000) / 60000);
		if (hours > 0) return localize('banner.remaining_hm', { hours, minutes });
		return localize('banner.remaining_m', { minutes });
	}

	function showFlagsModal() {
		const content = document.createElement('div');

		for (const flag of _activeFlags) {
			const row = document.createElement('div');
			row.className = 'flex items-center gap-3 py-2';

			const severity = FLAG_SEVERITY[flag.type];
			const color = severity ? severity.color : DEFAULT_COLOR;
			const label = severity ? severity.label : flag.type;

			const dot = document.createElement('span');
			dot.className = 'inline-block w-3 h-3 rounded-full flex-shrink-0';
			dot.style.backgroundColor = color;

			const info = document.createElement('div');
			info.className = 'flex flex-col';

			const name = document.createElement('span');
			name.className = 'font-medium text-text-100';
			name.textContent = label;

			const expiry = document.createElement('span');
			expiry.className = 'text-xs text-text-500';
			if (flag.expires_at) {
				expiry.textContent = localize('banner.expires', { date: new Date(flag.expires_at).toLocaleString(currentLocale()), relative: formatRelativeTime(flag.expires_at) });
			} else {
				expiry.textContent = localize('banner.no_expiry');
			}

			info.appendChild(name);
			info.appendChild(expiry);
			row.appendChild(dot);
			row.appendChild(info);
			content.appendChild(row);
		}

		const modal = new ClaudeModal(localize('banner.modal_title'), content);
		modal.addCancel(localize('common.close'));
		modal.show();
	}

	function createBannerWatcherButton() {
		const button = createClaudeButton(FLAG_SVG, 'icon', showFlagsModal);
		button.style.display = 'none';
		return button;
	}

	function initialize() {
		ButtonBar.register({
			buttonClass: 'banner-watcher-button',
			createFn: createBannerWatcherButton,
			tooltip: localize('banner.tooltip'),
			pages: ['chat', 'home', 'coworkHome', 'coworkChat'],
			// Hidden with no active flags (see updateButton) - in the More menu too.
			menuVisible: () => _activeFlags.length > 0,
			onInjected: (btn) => {
				_buttonRef = btn;
				updateButton();
			},
		});

		fetchActiveFlags();
		setInterval(fetchActiveFlags, 60000);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initialize);
	} else {
		initialize();
	}
})();
