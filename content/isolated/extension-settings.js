// extension-settings.js
// "Extension settings" (top-right, home page only): the UI language, shared with every extension using
// common/i18n (see i18n-core.js) and applied on the reload after saving, "Load whole conversations"
// (content/main/full-load.js), and the debug-log viewer.
(function () {
	'use strict';

	const FULL_LOAD = SETTINGS_KEYS.FULL_LOAD.ENABLED;
	// full-load.js (MAIN) acts on the first snapshot, long before this document_idle script exists, so
	// it reads a localStorage mirror ('0' = off), kept current here on every page, on cross-tab changes
	// and on save. Same pattern as image-gallery.js.
	const FULL_LOAD_MIRROR_KEY = 'claude_qol_full_load';

	async function writeFullLoadMirror(value) {
		try {
			localStorage.setItem(FULL_LOAD_MIRROR_KEY, (value ?? await settingsRegistry.get(FULL_LOAD)) ? '1' : '0');
		} catch (e) { /* storage unavailable: full-load.js falls back to its default (on) */ }
	}

	const GEAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		<circle cx="12" cy="12" r="3"/>
		<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
	</svg>`;

	async function showSettingsModal() {
		const current = getLanguageOverride();
		const fullLoadBefore = await settingsRegistry.get(FULL_LOAD);

		const content = document.createElement('div');
		const label = document.createElement('label');
		label.className = CLAUDE_CLASSES.LABEL;
		label.textContent = localize('lang.label');
		content.appendChild(label);

		const select = createLanguageSelect();
		content.appendChild(select);

		const fullLoadToggle = createClaudeToggle(localize('settings.full_load'), fullLoadBefore, null);
		fullLoadToggle.container.style.marginTop = '16px';
		content.appendChild(fullLoadToggle.container);
		const fullLoadHint = document.createElement('p');
		fullLoadHint.className = 'text-text-500 text-xs mt-1';
		fullLoadHint.textContent = localize('settings.full_load_hint');
		content.appendChild(fullLoadHint);

		const logsButton = createClaudeButton(localize('shared.view_debug_logs'), 'secondary', openDebugLogs);
		logsButton.style.marginTop = '16px';
		content.appendChild(logsButton);

		const modal = new ClaudeModal(localize('shared.extension_settings'), content);
		modal.addCancel();
		modal.addConfirm(localize('common.save'), async () => {
			const value = select.value;
			setLanguageOverride(value);
			const fullLoad = fullLoadToggle.input.checked;
			if (fullLoad !== fullLoadBefore) {
				await settingsRegistry.set(FULL_LOAD, fullLoad);
				await writeFullLoadMirror(fullLoad);
			}
			if (value !== current || fullLoad !== fullLoadBefore) location.reload();
		});
		modal.show();
	}

	function initialize() {
		// Keep the shared account locale cache fresh (common/i18n/i18n-core.js). From this ISOLATED-only
		// file rather than a helper both worlds load, so a refresh costs one request, not two.
		refreshAccountLocale();

		writeFullLoadMirror();
		settingsRegistry.onChange(FULL_LOAD, (value) => writeFullLoadMirror(value));

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
