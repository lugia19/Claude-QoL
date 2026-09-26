// extension-settings.js
// "Extension settings" (top-right, home page only): the UI language, shared with every extension using
// common/i18n (see i18n-core.js) and applied on the reload after saving, and the debug-log viewer.
(function () {
	'use strict';

	const GEAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		<circle cx="12" cy="12" r="3"/>
		<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
	</svg>`;

	function showSettingsModal() {
		const current = getLanguageOverride();

		const content = document.createElement('div');
		const label = document.createElement('label');
		label.className = CLAUDE_CLASSES.LABEL;
		label.textContent = localize('lang.label');
		content.appendChild(label);

		const select = createLanguageSelect();
		content.appendChild(select);

		const logsButton = createClaudeButton(localize('shared.view_debug_logs'), 'secondary', openDebugLogs);
		logsButton.style.marginTop = '16px';
		content.appendChild(logsButton);

		const modal = new ClaudeModal(localize('shared.extension_settings'), content);
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
			buttonClass: 'extension-settings-button',
			createFn: () => createClaudeButton(GEAR_SVG, 'icon', showSettingsModal),
			tooltip: localize('shared.extension_settings'),
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
