// image-gallery.js — Settings button + popup for the generated-image gallery injection
// done by content/main/image-extractor.js.
(function () {
	'use strict';

	const G = SETTINGS_KEYS.IMAGE_EXTRACTOR;

	// The MAIN-world injector rewrites the conversation GET ~300ms into page load, long before
	// this (document_idle) script exists, so it can't ask us for settings in time. We mirror the
	// relevant settings into localStorage (same origin, readable synchronously from MAIN) and
	// keep the mirror current on init, on cross-tab changes, and on save.
	const CONFIG_MIRROR_KEY = 'claude_qol_image_gallery';

	//#region SVG Icons
	const GALLERY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 16 16">
        <rect x="2" y="2.5" width="12" height="11" rx="1.5"/>
        <circle cx="5.5" cy="6" r="1"/>
        <path d="M2 11l3.5-3.5 2.5 2.5 2-2L14 12" stroke-linejoin="round"/>
    </svg>`;
	//#endregion

	//#region Settings
	async function loadSettings() {
		const [enabled, limitEnabled, limit] = await Promise.all([
			settingsRegistry.get(G.ENABLED),
			settingsRegistry.get(G.LIMIT_ENABLED),
			settingsRegistry.get(G.LIMIT)
		]);
		return { enabled, limitEnabled, limit };
	}

	async function saveSettings({ enabled, limitEnabled, limit }) {
		await Promise.all([
			settingsRegistry.set(G.ENABLED, enabled),
			settingsRegistry.set(G.LIMIT_ENABLED, limitEnabled),
			settingsRegistry.set(G.LIMIT, limit)
		]);
	}

	async function writeConfigMirror() {
		try {
			localStorage.setItem(CONFIG_MIRROR_KEY, JSON.stringify(await loadSettings()));
		} catch (e) { /* quota or serialization issue — MAIN falls back to defaults */ }
	}
	//#endregion

	//#region Settings Modal
	async function createSettingsModal() {
		const settings = await loadSettings();

		const content = document.createElement('div');
		content.className = 'space-y-4';

		const enabledToggle = createClaudeToggle(localize('gallery.show_as_galleries'), settings.enabled, null);
		content.appendChild(enabledToggle.container);
		const enabledHint = document.createElement('p');
		enabledHint.className = 'text-text-500 text-xs mt-1';
		enabledHint.textContent = localize('gallery.enabled_hint');
		content.appendChild(enabledHint);

		const limitSection = document.createElement('div');
		limitSection.className = 'border-t border-border-300 pt-4 mt-4';

		const limitInput = createClaudeInput({ type: 'number', value: settings.limit });
		limitInput.min = 1;
		limitInput.step = 1;
		const setLimitEnabled = (on) => {
			limitInput.disabled = !on;
			limitInput.classList.toggle('opacity-50', !on);
		};
		const limitToggle = createClaudeToggle(localize('gallery.limit_toggle'), settings.limitEnabled, setLimitEnabled);
		limitSection.appendChild(limitToggle.container);

		const limitField = document.createElement('div');
		limitField.className = 'mt-3';
		const limitLabel = document.createElement('label');
		limitLabel.className = CLAUDE_CLASSES.LABEL;
		limitLabel.textContent = localize('gallery.images_per_gallery');
		limitField.appendChild(limitLabel);
		limitField.appendChild(limitInput);
		limitSection.appendChild(limitField);
		setLimitEnabled(settings.limitEnabled);

		const note = document.createElement('p');
		note.className = CLAUDE_CLASSES.TEXT_MUTED + ' mt-2';
		note.textContent = localize('gallery.inline_note');
		limitSection.appendChild(note);

		content.appendChild(limitSection);

		const modal = new ClaudeModal(localize('gallery.settings_title'), content);
		modal.addCancel();
		modal.addConfirm(localize('common.save'), async () => {
			const limitEnabled = limitToggle.input.checked;
			const limit = parseInt(limitInput.value, 10);
			if (limitEnabled && !(limit >= 1)) {
				showClaudeAlert(localize('gallery.invalid_limit_title'), localize('gallery.invalid_limit'));
				return false;
			}
			await saveSettings({
				enabled: enabledToggle.input.checked,
				limitEnabled,
				limit: limitEnabled ? limit : settings.limit
			});
			await writeConfigMirror();
			// Galleries are built when the conversation loads / streams, so re-render the page
			// for the new layout to show.
			window.location.reload();
		});
		modal.show();
	}
	//#endregion

	//#region Settings Button
	function createSettingsButton() {
		const button = createClaudeButton(GALLERY_ICON, 'icon', async () => {
			await createSettingsModal();
		});

		button.classList.add('image-gallery-button');
		refreshButtonColor(button);
		return button;
	}

	// Tints the toolbar icon blue while gallery injection is enabled.
	async function refreshButtonColor(button) {
		button = button || document.querySelector('.image-gallery-button');
		if (!button) return;
		button.classList.toggle('image-gallery-enabled', !!(await settingsRegistry.get(G.ENABLED)));
	}
	//#endregion

	//#region Initialization
	function addStyles() {
		if (document.querySelector('#image-gallery-styles')) return;

		const style = document.createElement('style');
		style.id = 'image-gallery-styles';
		style.textContent = `
        .image-gallery-button.image-gallery-enabled {
            color: #2c84db;
        }
    `;
		document.head.appendChild(style);
	}

	function initialize() {
		addStyles();
		ButtonBar.register({
			buttonClass: 'image-gallery-button',
			createFn: createSettingsButton,
			tooltip: localize('gallery.settings_title'),
			pages: ['chat', 'home'],
		});
		writeConfigMirror();
		// Keep the mirror + icon current when another tab changes the settings.
		[G.ENABLED, G.LIMIT_ENABLED, G.LIMIT].forEach(k =>
			settingsRegistry.onChange(k, () => { writeConfigMirror(); refreshButtonColor(); })
		);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initialize);
	} else {
		initialize();
	}
	//#endregion
})();
