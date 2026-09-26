// language.js
// Language picker (top-right, home page only). The choice is shared with every extension using
// common/i18n (see i18n-core.js), and takes effect on the reload after saving.
(function () {
	'use strict';

	const GLOBE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		<circle cx="12" cy="12" r="10"/>
		<line x1="2" y1="12" x2="22" y2="12"/>
		<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
	</svg>`;

	function showLanguageModal() {
		const current = getLanguageOverride();

		const content = document.createElement('div');
		const label = document.createElement('label');
		label.className = CLAUDE_CLASSES.LABEL;
		label.textContent = localize('lang.label');
		content.appendChild(label);

		const select = createLanguageSelect();
		content.appendChild(select);

		const modal = new ClaudeModal(localize('lang.title'), content);
		modal.addCancel();
		modal.addConfirm(localize('common.save'), () => {
			const value = select.value;
			setLanguageOverride(value);
			if (value !== current) location.reload();
		});
		modal.show();
	}

	function initialize() {
		// Keep the shared account locale cache fresh (common/i18n/i18n-core.js). From this ISOLATED-only
		// file rather than a helper both worlds load, so a refresh costs one request, not two.
		refreshAccountLocale();

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
