// extension-settings.js
// "Extension settings" (top-right, home page only): the UI language, shared with every extension using
// common/i18n (see i18n-core.js) and applied on the reload after saving, "Load whole conversations"
// (content/main/full-load.js), "Show project names in chat titles" (content/main/project-prefix.js),
// and the debug-log viewer.
(function () {
	'use strict';

	// The MAIN-world toggles: full-load.js and project-prefix.js act on the first snapshot or request,
	// long before this document_idle script exists, so they read the org's mirror (org-mirror.js), kept
	// current here on every page, on cross-tab changes and on save. Same pattern as image-gallery.js.
	const TOGGLES = [
		{ setting: SETTINGS_KEYS.FULL_LOAD.ENABLED, mirror: 'full_load', label: 'settings.full_load', hint: 'settings.full_load_hint' },
		{ setting: SETTINGS_KEYS.PROJECT_PREFIX.ENABLED, mirror: 'project_prefix', label: 'settings.project_prefix', hint: 'settings.project_prefix_hint' },
	];

	async function writeMirror(toggle, value) {
		writeOrgMirror(toggle.mirror, !!(value ?? await settingsRegistry.get(toggle.setting)));
	}

	const GEAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		<circle cx="12" cy="12" r="3"/>
		<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
	</svg>`;

	async function showSettingsModal() {
		const current = getLanguageOverride();
		const toggles = await Promise.all(TOGGLES.map(async t => ({ t, before: await settingsRegistry.get(t.setting) })));

		const content = document.createElement('div');
		const label = document.createElement('label');
		label.className = CLAUDE_CLASSES.LABEL;
		label.textContent = localize('lang.label');
		content.appendChild(label);

		const select = createLanguageSelect();
		content.appendChild(select);

		for (const row of toggles) {
			const toggle = createClaudeToggle(localize(row.t.label), row.before, null);
			toggle.container.style.marginTop = '16px';
			content.appendChild(toggle.container);
			const hint = document.createElement('p');
			hint.className = 'text-text-500 text-xs mt-1';
			hint.textContent = localize(row.t.hint);
			content.appendChild(hint);
			row.input = toggle.input;
		}

		const logsButton = createClaudeButton(localize('shared.view_debug_logs'), 'secondary', openDebugLogs);
		logsButton.style.marginTop = '16px';
		content.appendChild(logsButton);

		const modal = new ClaudeModal(localize('shared.extension_settings'), content);
		modal.addCancel();
		modal.addConfirm(localize('common.save'), async () => {
			const value = select.value;
			setLanguageOverride(value);
			let changed = value !== current;
			for (const { t, before, input } of toggles) {
				const checked = input.checked;
				if (checked === before) continue;
				await settingsRegistry.set(t.setting, checked);
				await writeMirror(t, checked);
				changed = true;
			}
			if (changed) location.reload();
		});
		modal.show();
	}

	function initialize() {
		// Keep the shared account locale cache fresh (common/i18n/i18n-core.js). From this ISOLATED-only
		// file rather than a helper both worlds load, so a refresh costs one request, not two.
		refreshAccountLocale();

		for (const t of TOGGLES) {
			writeMirror(t);
			settingsRegistry.onChange(t.setting, (value) => writeMirror(t, value));
		}

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
