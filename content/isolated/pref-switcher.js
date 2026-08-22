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
		let label = 'None';
		if (activeId === 'unsaved') {
			label = 'Unsaved';
		} else if (activeId !== 'none') {
			const presets = await getStoredPresets();
			if (presets[activeId]) label = presets[activeId].name;
		}
		ButtonBar.updateTooltip('preset-switcher-button', `Preferences preset: ${label}`);
		const button = document.querySelector('.preset-switcher-button');
		if (button) button.style.color = activeId === 'none' ? '' : '#0084ff';
	}

	// ======== LIST MODAL ========
	async function showPresetListModal() {
		const loadingModal = createLoadingModal('Loading presets...');
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
				const applyingModal = createLoadingModal('Applying preferences...');
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
					id: 'none', name: 'None', isActive: nowActiveId === 'none',
					onApply: async () => {
						if (nowActiveId === 'unsaved') {
							if (!await showClaudeConfirm('Unsaved Preferences', 'Current preferences are unsaved and will be lost. Switch anyway?')) return;
						}
						await applyPreset('');
					}
				}));

				// "Unsaved" row
				if (nowActiveId === 'unsaved') {
					const unsavedPrefs = await getCurrentPreferences();
					list.appendChild(createPresetRow({
						id: 'unsaved', name: 'Unsaved preferences', isActive: true, isUnsaved: true,
						onEdit: () => showEditPresetModal(null, unsavedPrefs, renderList),
					}));
				}

				// Stored presets
				for (const [id, preset] of Object.entries(presets)) {
					list.appendChild(createPresetRow({
						id, name: preset.name, isActive: nowActiveId === id,
						onApply: async () => {
							if (nowActiveId === 'unsaved') {
								if (!await showClaudeConfirm('Unsaved Preferences', 'Current preferences are unsaved and will be lost. Switch anyway?')) return;
							}
							await applyPreset(preset.content);
						},
						onEdit: () => showEditPresetModal(id, null, renderList),
						onDelete: async () => {
							if (!await showClaudeConfirm('Delete Preset', `Delete preset "${preset.name}"?`)) return;
							const deletingModal = createLoadingModal('Deleting preset...');
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
			const newBtn = createClaudeButton('+ New Preset', 'secondary');
			newBtn.classList.add('mt-3');
			newBtn.onclick = () => showEditPresetModal(null, null, renderList);
			contentContainer.appendChild(newBtn);

			// Info text
			const infoText = document.createElement('div');
			infoText.className = CLAUDE_CLASSES.TEXT_MUTED + ' mt-4';
			infoText.textContent = 'Changing preferences will reset the caching status of the conversation.';
			contentContainer.appendChild(infoText);

			const modal = new ClaudeModal('Manage Preference Presets', contentContainer);
			modal.modal.classList.remove('max-w-md');
			modal.modal.classList.add('max-w-lg');
			modal.addCancel('Close');
			modal.show();
		} catch (error) {
			console.error('Error loading presets:', error);
			loadingModal.destroy();
			showClaudeAlert('Error', 'Failed to load presets. Please try again.');
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
			const editBtn = createClaudeButton('Edit', 'secondary');
			editBtn.classList.add('!min-w-0', '!px-2', '!h-7', '!text-xs');
			editBtn.onclick = (e) => { e.stopPropagation(); onEdit(); };
			row.appendChild(editBtn);
		}

		if (onDelete) {
			const deleteBtn = createClaudeButton('Delete', 'secondary');
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
		nameLabel.textContent = 'Preset Name';
		contentContainer.appendChild(nameLabel);

		const nameInput = createClaudeInput({ placeholder: 'Preset name', value: existingName });
		nameInput.classList.add('mb-4');
		contentContainer.appendChild(nameInput);

		const contentLabel = document.createElement('label');
		contentLabel.className = CLAUDE_CLASSES.LABEL;
		contentLabel.textContent = 'Content';
		contentContainer.appendChild(contentLabel);

		const textarea = document.createElement('textarea');
		textarea.className = 'bg-bg-000 border border-border-300 p-3 leading-5 rounded-[0.6rem] transition-colors hover:border-border-200 focus:border-border-200 focus:outline-none placeholder:text-text-500 w-full';
		textarea.style.resize = 'vertical';
		textarea.rows = 8;
		textarea.placeholder = 'Enter your preferences here...';
		textarea.setAttribute('data-1p-ignore', 'true');
		textarea.value = existingContent;
		contentContainer.appendChild(textarea);

		const modal = new ClaudeModal(presetId ? 'Edit Preset' : 'New Preset', contentContainer);
		modal.modal.classList.remove('max-w-md');
		modal.modal.classList.add('max-w-xl');

		modal.addCancel();
		modal.addConfirm('Save & Apply', async () => {
			const name = nameInput.value.trim();
			if (!name) {
				showClaudeAlert('Name required', 'Please enter a name for this preset.');
				return false;
			}
			const content = textarea.value;
			const savingModal = createLoadingModal('Applying preferences...');
			savingModal.show();
			try {
				await savePreset(presetId, name, content);
				const ok = await setPreferences(content);
				if (!ok) {
					showClaudeAlert('Error', 'Failed to update preferences. Please try again.');
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
			tooltip: 'Preferences preset: None',
			forceDisplayOnMobile: false,
			pages: ['chat', 'home'],
			onInjected: () => updatePresetButtonAppearance(),
		});
	}

	setTimeout(initialize);
})();
