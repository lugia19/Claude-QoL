// extension-settings.js
// "Extension settings" (top-right, every page): the UI language, shared with every extension using
// common/i18n (see i18n-core.js) and applied on the reload after saving, "Load whole conversations"
// (content/main/full-load.js), "Show project names in chat titles" (content/main/project-prefix.js),
// the image galleries (content/main/image-extractor.js), and the debug-log viewer.
(function () {
	'use strict';

	// The MAIN-world settings: full-load.js, project-prefix.js and image-extractor.js act on the first
	// snapshot or request, long before this document_idle script exists, so they read the org's mirror
	// (org-mirror.js), kept current here on every page, on cross-tab changes and on save.
	const TOGGLES = [
		{ setting: SETTINGS_KEYS.FULL_LOAD.ENABLED, mirror: 'full_load', label: 'settings.full_load', hint: 'settings.full_load_hint' },
		{ setting: SETTINGS_KEYS.PROJECT_PREFIX.ENABLED, mirror: 'project_prefix', label: 'settings.project_prefix', hint: 'settings.project_prefix_hint' },
	];
	const G = SETTINGS_KEYS.IMAGE_EXTRACTOR;

	async function writeMirror(toggle, value) {
		writeOrgMirror(toggle.mirror, !!(value ?? await settingsRegistry.get(toggle.setting)));
	}

	async function loadGallerySettings() {
		const [enabled, limitEnabled, limit] = await Promise.all([
			settingsRegistry.get(G.ENABLED),
			settingsRegistry.get(G.LIMIT_ENABLED),
			settingsRegistry.get(G.LIMIT)
		]);
		return { enabled, limitEnabled, limit };
	}

	async function writeGalleryMirror() {
		writeOrgMirror('image_gallery', await loadGallerySettings());
	}

	const GEAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		<circle cx="12" cy="12" r="3"/>
		<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
	</svg>`;

	function addToggle(parent, labelKey, hintKey, checked, onChange) {
		const toggle = createClaudeToggle(localize(labelKey), checked, onChange);
		toggle.container.style.marginTop = '16px';
		parent.appendChild(toggle.container);
		const hint = document.createElement('p');
		hint.className = 'text-text-500 text-xs mt-1';
		hint.textContent = localize(hintKey);
		parent.appendChild(hint);
		return toggle;
	}

	// The gallery section: the on/off toggle and the per-gallery image limit.
	function createGallerySection(settings) {
		const section = document.createElement('div');
		section.className = 'border-t border-border-300 mt-4';

		const enabledToggle = addToggle(section, 'gallery.show_as_galleries', 'gallery.enabled_hint', settings.enabled, null);

		const limitInput = createClaudeInput({ type: 'number', value: settings.limit });
		limitInput.min = 1;
		limitInput.step = 1;
		const setLimitEnabled = (on) => {
			limitInput.disabled = !on;
			limitInput.classList.toggle('opacity-50', !on);
		};
		const limitToggle = createClaudeToggle(localize('gallery.limit_toggle'), settings.limitEnabled, setLimitEnabled);
		limitToggle.container.style.marginTop = '16px';
		section.appendChild(limitToggle.container);

		const limitField = document.createElement('div');
		limitField.className = 'mt-3';
		const limitLabel = document.createElement('label');
		limitLabel.className = CLAUDE_CLASSES.LABEL;
		limitLabel.textContent = localize('gallery.images_per_gallery');
		limitField.appendChild(limitLabel);
		limitField.appendChild(limitInput);
		section.appendChild(limitField);
		setLimitEnabled(settings.limitEnabled);

		const note = document.createElement('p');
		note.className = CLAUDE_CLASSES.TEXT_MUTED + ' mt-2';
		note.textContent = localize('gallery.inline_note');
		section.appendChild(note);

		// The values to save, or null (after an alert) when the limit isn't valid.
		const read = () => {
			const limitEnabled = limitToggle.input.checked;
			const limit = parseInt(limitInput.value, 10);
			if (limitEnabled && !(limit >= 1)) {
				showClaudeAlert(localize('gallery.invalid_limit_title'), localize('gallery.invalid_limit'));
				return null;
			}
			return { enabled: enabledToggle.input.checked, limitEnabled, limit: limitEnabled ? limit : settings.limit };
		};
		return { section, read };
	}

	async function showSettingsModal() {
		const current = getLanguageOverride();
		const toggles = await Promise.all(TOGGLES.map(async t => ({ t, before: await settingsRegistry.get(t.setting) })));
		const galleryBefore = await loadGallerySettings();

		const content = document.createElement('div');
		const label = document.createElement('label');
		label.className = CLAUDE_CLASSES.LABEL;
		label.textContent = localize('lang.label');
		content.appendChild(label);

		const select = createLanguageSelect();
		content.appendChild(select);

		const display = document.createElement('div');
		display.className = 'border-t border-border-300 mt-4';
		for (const row of toggles) {
			row.input = addToggle(display, row.t.label, row.t.hint, row.before, null).input;
		}
		content.appendChild(display);

		const gallery = createGallerySection(galleryBefore);
		content.appendChild(gallery.section);

		const logsButton = createClaudeButton(localize('shared.view_debug_logs'), 'secondary', openDebugLogs);
		logsButton.style.marginTop = '16px';
		content.appendChild(logsButton);

		const modal = new ClaudeModal(localize('shared.extension_settings'), content);
		modal.addCancel();
		modal.addConfirm(localize('common.save'), async () => {
			const galleryAfter = gallery.read();
			if (!galleryAfter) return false;

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
			const keys = { enabled: G.ENABLED, limitEnabled: G.LIMIT_ENABLED, limit: G.LIMIT };
			const galleryChanged = Object.keys(keys).filter(k => galleryAfter[k] !== galleryBefore[k]);
			if (galleryChanged.length) {
				await Promise.all(galleryChanged.map(k => settingsRegistry.set(keys[k], galleryAfter[k])));
				await writeGalleryMirror();
				changed = true;
			}
			// Everything here is applied when the page loads, so reload for it to show.
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
		writeGalleryMirror();
		[G.ENABLED, G.LIMIT_ENABLED, G.LIMIT].forEach(k => settingsRegistry.onChange(k, () => writeGalleryMirror()));

		ButtonBar.register({
			buttonClass: 'extension-settings-button',
			createFn: () => createClaudeButton(GEAR_SVG, 'icon', showSettingsModal),
			tooltip: localize('shared.extension_settings'),
			forceDisplayOnMobile: true,
			pages: ['chat', 'home', 'codeHome', 'codeChat', 'project'],
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initialize);
	} else {
		initialize();
	}
})();
