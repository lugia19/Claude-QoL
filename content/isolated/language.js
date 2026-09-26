// language.js
// Language picker (top-right, home page only). The choice is stored in settings and mirrored to
// localStorage, where i18n.js reads it synchronously in both worlds on the next page load.
(function () {
	'use strict';

	const LANGUAGE = SETTINGS_KEYS.I18N.LANGUAGE;

	const GLOBE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		<circle cx="12" cy="12" r="10"/>
		<line x1="2" y1="12" x2="22" y2="12"/>
		<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
	</svg>`;

	function writeMirror(value) {
		try {
			if (value) localStorage.setItem(I18N_OVERRIDE_KEY, value);
			else localStorage.removeItem(I18N_OVERRIDE_KEY);
		} catch (e) { /* storage blocked - i18n.js falls back to the account language */ }
	}

	async function showLanguageModal() {
		const current = await settingsRegistry.get(LANGUAGE);

		const content = document.createElement('div');
		const label = document.createElement('label');
		label.className = CLAUDE_CLASSES.LABEL;
		label.textContent = localize('lang.label');
		content.appendChild(label);

		const options = [
			{ value: '', label: localize('lang.auto') },
			...I18N_LOCALES.map(l => ({ value: l, label: LANGUAGE_NATIVE_NAMES[l] })),
		];
		const select = createClaudeSelect(options, current || '');
		content.appendChild(select);

		const modal = new ClaudeModal(localize('lang.title'), content);
		modal.addCancel();
		modal.addConfirm(localize('common.save'), async () => {
			const value = select.value;
			await settingsRegistry.set(LANGUAGE, value);
			writeMirror(value);
			if (value !== (current || '')) location.reload();
		});
		modal.show();
	}

	function initialize() {
		// Keep the mirror in sync with the stored setting (source of truth), including cross-tab changes.
		settingsRegistry.get(LANGUAGE).then(writeMirror);
		settingsRegistry.onChange(LANGUAGE, (value) => writeMirror(value));

		ButtonBar.register({
			buttonClass: 'language-settings-button',
			createFn: () => createClaudeButton(GLOBE_SVG, 'icon', showLanguageModal),
			tooltip: localize('lang.tooltip'),
			forceDisplayOnMobile: true,
			pages: ['home'],
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initialize);
	} else {
		initialize();
	}
})();
