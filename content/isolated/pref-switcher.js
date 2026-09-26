// pref-switcher.js
(function () {
	'use strict';
	const channel = new BroadcastChannel('pref-switcher-updates');

	const PRESET_ICON_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0" aria-hidden="true"><line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/></svg>`;

	channel.addEventListener('message', (event) => {
		if (event.data.type === 'preferences-changed') {
			updatePresetButtonAppearance();
		}
	});

	// ======== API FUNCTIONS ========
	async function getCurrentPreferences() {
		try {
			const response = await fetch('https://claude.ai/api/account_profile', { method: 'GET' });
			const data = await response.json();
			return data.conversation_preferences || '';
		} catch (error) {
			console.error('Failed to fetch preferences:', error);
			return '';
		}
	}

	async function setPreferences(preferencesText) {
		try {
			const response = await fetch('https://claude.ai/api/account_profile?source=preset-manager', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ conversation_preferences: preferencesText })
			});
			if (response.ok) {
				channel.postMessage({ type: 'preferences-changed' });
				updatePresetButtonAppearance();
			}
			return response.ok;
		} catch (error) {
			console.error('Failed to set preferences:', error);
			return false;
		}
	}

	// ======== PRESET MANAGEMENT ========
	async function getStoredPresets() {
		return await settingsRegistry.get(SETTINGS_KEYS.PREF_SWITCHER.PRESETS);
	}

	async function savePreset(id, name, content) {
		const presets = await getStoredPresets();
		if (!id) id = crypto.randomUUID();
		presets[id] = { id, name, content: content.trim(), lastModified: Date.now() };
		await settingsRegistry.set(SETTINGS_KEYS.PREF_SWITCHER.PRESETS, presets);
		return id;
	}

	async function deletePreset(id) {
		const presets = await getStoredPresets();
		delete presets[id];
		await settingsRegistry.set(SETTINGS_KEYS.PREF_SWITCHER.PRESETS, presets);
	}

	async function getCurrentPresetId() {
		const currentPrefs = await getCurrentPreferences();
		const presets = await getStoredPresets();
		for (const [id, preset] of Object.entries(presets)) {
			if (preset.content.trim() === currentPrefs.trim()) return id;
		}
		return currentPrefs.trim() ? 'unsaved' : 'none';
	}

	// ======== HEADER BUTTON ========
	function createPresetButton() {
		const button = createClaudeButton(PRESET_ICON_SVG, 'icon');
		button.classList.add('shrink-0', 'preset-switcher-button');
		button.onclick = () => showPresetListModal();
		return button;
	}

	async function updatePresetButtonAppearance() {
		const activeId = await getCurrentPresetId();
		let label = localize('prefs.none');
		if (activeId === 'unsaved') {
			label = localize('prefs.unsaved');
		} else if (activeId !== 'none') {
			const presets = await getStoredPresets();
			if (presets[activeId]) label = presets[activeId].name;
		}
		ButtonBar.updateTooltip('preset-switcher-button', localize('prefs.preset_tooltip', { name: label }));
		const button = document.querySelector('.preset-switcher-button');
		if (button) button.style.color = activeId === 'none' ? '' : '#0084ff';
	}

	// ======== LIST MODAL ========
	async function showPresetListModal() {
		const loadingModal = createLoadingModal(localize('prefs.loading_presets'));
		loadingModal.show();

		try {
			const activeId = await getCurrentPresetId();
			const currentPrefs = activeId === 'unsaved' ? await getCurrentPreferences() : '';
			loadingModal.destroy();

			const contentContainer = document.createElement('div');

			const list = document.createElement('div');
			list.className = CLAUDE_CLASSES.LIST_CONTAINER;
			list.style.maxHeight = '300px';
			contentContainer.appendChild(list);

			async function applyPreset(content) {
				const applyingModal = createLoadingModal(localize('prefs.applying_preferences'));
				applyingModal.show();
				try {
					await setPreferences(content);
					await renderList();
				} finally {
					applyingModal.destroy();
				}
			}

			async function renderList() {
				const presets = await getStoredPresets();
				const nowActiveId = await getCurrentPresetId();
				list.innerHTML = '';

				// "None" row — always first
				list.appendChild(createPresetRow({
					id: 'none', name: localize('prefs.none'), isActive: nowActiveId === 'none',
					onApply: async () => {
						if (nowActiveId === 'unsaved') {
							if (!await showClaudeConfirm(localize('prefs.unsaved_preferences_title'), localize('prefs.unsaved_preferences_confirm'))) return;
						}
						await applyPreset('');
					}
				}));

				// "Unsaved" row
				if (nowActiveId === 'unsaved') {
					const unsavedPrefs = await getCurrentPreferences();
					list.appendChild(createPresetRow({
						id: 'unsaved', name: localize('prefs.unsaved_preferences'), isActive: true, isUnsaved: true,
						onEdit: () => showEditPresetModal(null, unsavedPrefs, renderList),
					}));
				}

				// Stored presets
				for (const [id, preset] of Object.entries(presets)) {
					list.appendChild(createPresetRow({
						id, name: preset.name, isActive: nowActiveId === id,
						onApply: async () => {
							if (nowActiveId === 'unsaved') {
								if (!await showClaudeConfirm(localize('prefs.unsaved_preferences_title'), localize('prefs.unsaved_preferences_confirm'))) return;
							}
							await applyPreset(preset.content);
						},
						onEdit: () => showEditPresetModal(id, null, renderList),
						onDelete: async () => {
							if (!await showClaudeConfirm(localize('prefs.delete_preset_title'), localize('prefs.delete_preset_confirm', { name: preset.name }))) return;
							const deletingModal = createLoadingModal(localize('prefs.deleting_preset'));
							deletingModal.show();
							try {
								await deletePreset(id);
								if (nowActiveId === id) await setPreferences('');
								await renderList();
							} finally {
								deletingModal.destroy();
							}
						}
					}));
				}
			}

			await renderList();

			// "+ New Preset" button
			const newBtn = createClaudeButton(localize('prefs.new_preset_button'), 'secondary');
			newBtn.classList.add('mt-3');
			newBtn.onclick = () => showEditPresetModal(null, null, renderList);
			contentContainer.appendChild(newBtn);

			// Info text
			const infoText = document.createElement('div');
			infoText.className = CLAUDE_CLASSES.TEXT_MUTED + ' mt-4';
			infoText.textContent = localize('prefs.caching_reset_info');
			contentContainer.appendChild(infoText);

			const modal = new ClaudeModal(localize('prefs.manage_presets_title'), contentContainer);
			modal.modal.classList.remove('max-w-md');
			modal.modal.classList.add('max-w-lg');
			modal.addCancel(localize('common.close'));
			modal.show();
		} catch (error) {
			console.error('Error loading presets:', error);
			loadingModal.destroy();
			showClaudeAlert(localize('common.error'), localize('prefs.load_presets_failed'));
		}
	}

	function createPresetRow({ id, name, isActive, isUnsaved, onApply, onEdit, onDelete }) {
		const row = document.createElement('div');
		row.className = CLAUDE_CLASSES.LIST_ITEM + ' flex items-center gap-2';

		if (isActive && isUnsaved) {
			row.style.color = '#d97706';
			row.style.borderColor = '#d97706';
		} else if (isActive) {
			row.style.color = '#0084ff';
			row.style.borderColor = '#0084ff';
		}

		// Apply on the whole row, not just the label: LIST_ITEM already paints the row as clickable
		// (p-3, hover highlight, cursor-pointer), so a click landing on the padding or on the space
		// beside the text has to count. The Edit/Delete buttons stop propagation below.
		if (onApply) {
			row.onclick = onApply;
		} else {
			row.style.cursor = 'default';
		}

		const nameSpan = document.createElement('span');
		nameSpan.className = 'flex-1 text-sm';
		nameSpan.textContent = name;
		row.appendChild(nameSpan);

		if (onEdit) {
			const editBtn = createClaudeButton(localize('prefs.edit'), 'secondary');
			editBtn.classList.add('!min-w-0', '!px-2', '!h-7', '!text-xs');
			editBtn.onclick = (e) => { e.stopPropagation(); onEdit(); };
			row.appendChild(editBtn);
		}

		if (onDelete) {
			const deleteBtn = createClaudeButton(localize('prefs.delete'), 'secondary');
			deleteBtn.classList.add('!min-w-0', '!px-2', '!h-7', '!text-xs');
			deleteBtn.onclick = (e) => { e.stopPropagation(); onDelete(); };
			row.appendChild(deleteBtn);
		}

		return row;
	}

	// ======== EDIT MODAL ========
	async function showEditPresetModal(presetId, unsavedContent, onSaved) {
		let existingName = '';
		let existingContent = '';

		if (presetId) {
			const presets = await getStoredPresets();
			const preset = presets[presetId];
			if (preset) {
				existingName = preset.name;
				existingContent = preset.content;
			}
		} else if (unsavedContent) {
			existingContent = unsavedContent;
		}

		const contentContainer = document.createElement('div');

		const nameLabel = document.createElement('label');
		nameLabel.className = CLAUDE_CLASSES.LABEL;
		nameLabel.textContent = localize('prefs.preset_name_label');
		contentContainer.appendChild(nameLabel);

		const nameInput = createClaudeInput({ placeholder: localize('prefs.preset_name_placeholder'), value: existingName });
		nameInput.classList.add('mb-4');
		contentContainer.appendChild(nameInput);

		const contentLabel = document.createElement('label');
		contentLabel.className = CLAUDE_CLASSES.LABEL;
		contentLabel.textContent = localize('prefs.content_label');
		contentContainer.appendChild(contentLabel);

		const textarea = document.createElement('textarea');
		textarea.className = 'bg-bg-000 border border-border-300 p-3 leading-5 rounded-[0.6rem] transition-colors hover:border-border-200 focus:border-border-200 focus:outline-none placeholder:text-text-500 w-full';
		textarea.style.resize = 'vertical';
		textarea.rows = 8;
		textarea.placeholder = localize('prefs.content_placeholder');
		textarea.setAttribute('data-1p-ignore', 'true');
		textarea.value = existingContent;
		contentContainer.appendChild(textarea);

		const modal = new ClaudeModal(presetId ? localize('prefs.edit_preset_title') : localize('prefs.new_preset_title'), contentContainer);
		modal.modal.classList.remove('max-w-md');
		modal.modal.classList.add('max-w-xl');

		modal.addCancel();
		modal.addConfirm(localize('prefs.save_and_apply'), async () => {
			const name = nameInput.value.trim();
			if (!name) {
				showClaudeAlert(localize('prefs.name_required_title'), localize('prefs.name_required'));
				return false;
			}
			const content = textarea.value;
			const savingModal = createLoadingModal(localize('prefs.applying_preferences'));
			savingModal.show();
			try {
				await savePreset(presetId, name, content);
				const ok = await setPreferences(content);
				if (!ok) {
					showClaudeAlert(localize('common.error'), localize('prefs.update_preferences_failed'));
					return false;
				}
				if (onSaved) await onSaved();
			} finally {
				savingModal.destroy();
			}
		});

		modal.show();
	}

	// ======== INITIALIZATION ========
	function initialize() {
		ButtonBar.register({
			buttonClass: 'preset-switcher-button',
			createFn: createPresetButton,
			tooltip: localize('prefs.preset_tooltip', { name: localize('prefs.none') }),
			forceDisplayOnMobile: false,
			pages: ['chat', 'home'],
			onInjected: () => updatePresetButtonAppearance(),
		});
	}

	setTimeout(initialize);
})();
