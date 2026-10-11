// pref-switcher.js
// Preset switchers: a top-right button opening a list of saved texts, one of which is active. The list,
// its CRUD and both modals are shared; each target has its own list, its own notion of "active" and its
// own way of applying a text:
// - Preferences (chat, home): claude.ai's account preferences (PUT /api/account_profile).
// - Claude Code system prompt (/code, /epitaxy): a setting, mirrored to localStorage for
//   content/main/code-session-prompt.js, which adds it to every new Code session.
(function () {
	'use strict';
	const log = createLogger('PrefSwitcher');

	const PRESET_ICON_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0" aria-hidden="true"><line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/></svg>`;
	const PROMPT_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6.5l2 1.5-2 1.5M8.5 10h3"/></svg>`;

	// A target: { buttonClass, icon, pages, forceDisplayOnMobile, presetsKey, getActive(), apply(text) -> ok,
	//   strings: { tooltip, title, info, applying, unsavedTitle, unsavedConfirm, unsavedRow, placeholder,
	//   updateFailed }, extraContent?() -> element shown under the list, listActions?: [{ label, onClick }]
	//   (primary buttons in the footer, right of Close, that close the list) }.
	function createPresetSwitcher(target) {
		const { strings } = target;

		// ======== PRESETS ========
		const getStoredPresets = () => settingsRegistry.get(target.presetsKey);

		async function savePreset(id, name, content) {
			const presets = await getStoredPresets();
			if (!id) id = crypto.randomUUID();
			presets[id] = { id, name, content: content.trim(), lastModified: Date.now() };
			await settingsRegistry.set(target.presetsKey, presets);
			return id;
		}

		async function deletePreset(id) {
			const presets = await getStoredPresets();
			delete presets[id];
			await settingsRegistry.set(target.presetsKey, presets);
		}

		// The active preset is the one whose content is the active text: 'none' when there's no text,
		// 'unsaved' when the text matches no preset.
		function getCurrentPresetId(active, presets) {
			for (const [id, preset] of Object.entries(presets)) {
				if (preset.content.trim() === active.trim()) return id;
			}
			return active.trim() ? 'unsaved' : 'none';
		}

		// Each target refreshes the button itself once its active text changes (see the targets below).
		const apply = (content) => target.apply(content);

		// ======== HEADER BUTTON ========
		function createButton() {
			const button = createClaudeButton(target.icon, 'icon');
			button.classList.add('shrink-0', target.buttonClass);
			button.onclick = () => showListModal();
			return button;
		}

		async function updateButtonAppearance() {
			const [active, presets] = await Promise.all([target.getActive(), getStoredPresets()]);
			const activeId = getCurrentPresetId(active, presets);
			let label = localize('prefs.none');
			if (activeId === 'unsaved') {
				label = localize('prefs.unsaved');
			} else if (activeId !== 'none') {
				label = presets[activeId].name;
			}
			ButtonBar.updateTooltip(target.buttonClass, strings.tooltip(label));
			const button = document.querySelector('.' + target.buttonClass);
			if (button) button.style.color = activeId === 'none' ? '' : '#0084ff';
		}

		// ======== LIST MODAL ========
		async function showListModal() {
			const loadingModal = createLoadingModal(localize('prefs.loading_presets'));
			loadingModal.show();

			try {
				const contentContainer = document.createElement('div');

				const list = document.createElement('div');
				list.className = CLAUDE_CLASSES.LIST_CONTAINER;
				list.style.maxHeight = '300px';
				contentContainer.appendChild(list);

				async function applyPreset(content) {
					const applyingModal = createLoadingModal(strings.applying);
					applyingModal.show();
					try {
						await apply(content);
						await renderList();
					} finally {
						applyingModal.destroy();
					}
				}

				const confirmLeavingUnsaved = async (activeId) =>
					activeId !== 'unsaved' || await showClaudeConfirm(strings.unsavedTitle, strings.unsavedConfirm);

				async function renderList() {
					const [active, presets] = await Promise.all([target.getActive(), getStoredPresets()]);
					const nowActiveId = getCurrentPresetId(active, presets);
					list.innerHTML = '';

					// "None" row — always first
					list.appendChild(createPresetRow({
						name: localize('prefs.none'), isActive: nowActiveId === 'none',
						onApply: async () => {
							if (!await confirmLeavingUnsaved(nowActiveId)) return;
							await applyPreset('');
						}
					}));

					// "Unsaved" row
					if (nowActiveId === 'unsaved') {
						list.appendChild(createPresetRow({
							name: strings.unsavedRow, isActive: true, isUnsaved: true,
							onEdit: () => showEditPresetModal(null, active, renderList),
						}));
					}

					// Stored presets
					for (const [id, preset] of Object.entries(presets)) {
						list.appendChild(createPresetRow({
							name: preset.name, isActive: nowActiveId === id,
							onApply: async () => {
								if (!await confirmLeavingUnsaved(nowActiveId)) return;
								await applyPreset(preset.content);
							},
							onEdit: () => showEditPresetModal(id, null, renderList),
							onDelete: async () => {
								if (!await showClaudeConfirm(localize('prefs.delete_preset_title'), localize('prefs.delete_preset_confirm', { name: preset.name }))) return;
								const deletingModal = createLoadingModal(localize('prefs.deleting_preset'));
								deletingModal.show();
								try {
									await deletePreset(id);
									if (nowActiveId === id) await apply('');
									await renderList();
								} finally {
									deletingModal.destroy();
								}
							}
						}));
					}
				}

				// The first render does the fetching, so the loading modal stays up until it's done.
				await renderList();
				loadingModal.destroy();

				// "+ New Preset" button
				const newBtn = createClaudeButton(localize('prefs.new_preset_button'), 'secondary');
				newBtn.classList.add('mt-3');
				newBtn.onclick = () => showEditPresetModal(null, null, renderList);
				contentContainer.appendChild(newBtn);

				if (target.extraContent) contentContainer.appendChild(await target.extraContent());

				// Info text
				const infoText = document.createElement('div');
				infoText.className = CLAUDE_CLASSES.TEXT_MUTED + ' mt-4';
				infoText.textContent = strings.info;
				contentContainer.appendChild(infoText);

				const modal = new ClaudeModal(strings.title, contentContainer);
				modal.modal.classList.remove('max-w-md');
				modal.modal.classList.add('max-w-lg');
				modal.addCancel(localize('common.close'));
				// The target's own actions, right of Close (Close/Cancel left, actions right, as in every modal).
				for (const { label, onClick } of target.listActions ?? []) modal.addConfirm(label, () => { onClick(); });
				modal.show();
			} catch (error) {
				log.error('Error loading presets:', error);
				loadingModal.destroy();
				showClaudeAlert(localize('common.error'), localize('prefs.load_presets_failed'));
			}
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
			textarea.placeholder = strings.placeholder;
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
				const savingModal = createLoadingModal(strings.applying);
				savingModal.show();
				try {
					await savePreset(presetId, name, content);
					if (!await apply(content)) {
						showClaudeAlert(localize('common.error'), strings.updateFailed);
						return false;
					}
					if (onSaved) await onSaved();
				} finally {
					savingModal.destroy();
				}
			});

			modal.show();
		}

		ButtonBar.register({
			buttonClass: target.buttonClass,
			createFn: createButton,
			tooltip: strings.tooltip(localize('prefs.none')),
			forceDisplayOnMobile: target.forceDisplayOnMobile,
			pages: target.pages,
			onInjected: () => updateButtonAppearance(),
		});

		return { updateButtonAppearance };
	}

	function createPresetRow({ name, isActive, isUnsaved, onApply, onEdit, onDelete }) {
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

	// ======== PREFERENCES ========
	function initPreferences() {
		const channel = new BroadcastChannel('pref-switcher-updates');

		async function getCurrentPreferences() {
			try {
				const response = await fetch('https://claude.ai/api/account_profile', { method: 'GET' });
				const data = await response.json();
				return data.conversation_preferences || '';
			} catch (error) {
				log.error('Failed to fetch preferences:', error);
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
					channel.postMessage({ type: 'preferences-changed' }); // doesn't echo to this tab
					switcher.updateButtonAppearance();
				}
				return response.ok;
			} catch (error) {
				log.error('Failed to set preferences:', error);
				return false;
			}
		}

		const switcher = createPresetSwitcher({
			buttonClass: 'preset-switcher-button',
			icon: PRESET_ICON_SVG,
			pages: ['chat', 'home'],
			forceDisplayOnMobile: true, // the one button kept out of the More-actions menu on phones
			presetsKey: SETTINGS_KEYS.PREF_SWITCHER.PRESETS,
			getActive: getCurrentPreferences,
			apply: setPreferences,
			strings: {
				tooltip: (name) => localize('prefs.preset_tooltip', { name }),
				title: localize('prefs.manage_presets_title'),
				info: localize('prefs.caching_reset_info'),
				applying: localize('prefs.applying_preferences'),
				unsavedTitle: localize('prefs.unsaved_preferences_title'),
				unsavedConfirm: localize('prefs.unsaved_preferences_confirm'),
				unsavedRow: localize('prefs.unsaved_preferences'),
				placeholder: localize('prefs.content_placeholder'),
				updateFailed: localize('prefs.update_preferences_failed'),
			},
		});

		// Changed in another tab (here or by pref-switcher-fetch-watcher.js, from claude.ai's own settings).
		channel.addEventListener('message', (event) => {
			if (event.data.type === 'preferences-changed') switcher.updateButtonAppearance();
		});
	}

	// ======== CLAUDE CODE SYSTEM PROMPT ========
	function initCodePrompt() {
		const P = SETTINGS_KEYS.CODE_PROMPT;
		// code-session-prompt.js (MAIN) reads this when a session is created: same origin, synchronous.
		// Written on init and synchronously on every change of the setting (here or in another tab), from
		// the values in hand: settingsRegistry.set() runs this tab's listeners before it resolves, so the
		// mirror is current by the time an apply or a mode change completes. Removed when there's no prompt.
		const MIRROR_KEY = 'claude_qol_code_prompt';
		const mirror = { text: '', mode: P.MODE.default };

		function writeMirror() {
			try {
				if (mirror.text.trim()) localStorage.setItem(MIRROR_KEY, JSON.stringify(mirror));
				else localStorage.removeItem(MIRROR_KEY);
			} catch (e) { /* storage unavailable: sessions start without the prompt */ }
		}

		// Replace (the default) or append, under the list. Saved as soon as it changes.
		async function modeSelect() {
			const section = document.createElement('div');
			section.className = 'mt-4 space-y-2';
			const label = document.createElement('label');
			label.className = CLAUDE_CLASSES.LABEL;
			label.textContent = localize('code_prompt.mode_label');
			section.appendChild(label);
			const warning = document.createElement('p');
			warning.className = CLAUDE_CLASSES.TEXT_MUTED;
			warning.textContent = localize('code_prompt.replace_warning');
			const select = createClaudeSelect([
				{ value: 'replace', label: localize('code_prompt.mode_replace') },
				{ value: 'append', label: localize('code_prompt.mode_append') },
			], await settingsRegistry.get(P.MODE), async () => {
				warning.hidden = select.value !== 'replace';
				await settingsRegistry.set(P.MODE, select.value);
			});
			warning.hidden = select.value !== 'replace';
			section.appendChild(select);
			section.appendChild(warning);
			return section;
		}

		const switcher = createPresetSwitcher({
			buttonClass: 'code-prompt-button',
			icon: PROMPT_ICON_SVG,
			pages: ['codeHome'], // a prompt only applies to new sessions, so not in a session
			presetsKey: P.PRESETS,
			getActive: () => settingsRegistry.get(P.TEXT),
			apply: async (text) => {
				try {
					await settingsRegistry.set(P.TEXT, text.trim() ? text : '');
					return true;
				} catch (e) {
					log.error('Failed to save the Claude Code system prompt:', e);
					return false;
				}
			},
			extraContent: modeSelect,
			// The UI only starts a session with a first message; code-session-prompt.js (MAIN) makes one without.
			// In the footer, right of Close.
			listActions: [{
				label: localize('code_prompt.launch_empty'),
				onClick: () => window.postMessage({ type: 'qol-empty-code-session' }, window.location.origin),
			}],
			strings: {
				tooltip: (name) => localize('code_prompt.tooltip', { name }),
				title: localize('code_prompt.title'),
				info: localize('code_prompt.hint'),
				applying: localize('code_prompt.applying'),
				unsavedTitle: localize('code_prompt.unsaved_title'),
				unsavedConfirm: localize('code_prompt.unsaved_confirm'),
				unsavedRow: localize('code_prompt.unsaved_row'),
				placeholder: localize('code_prompt.placeholder'),
				updateFailed: localize('code_prompt.update_failed'),
			},
		});

		// The one place the mirror and the button follow the setting: onChange fires in this tab too.
		// A change that lands while the first read is in flight is newer than what that read returns.
		const changed = new Set();
		settingsRegistry.onChange(P.TEXT, (text) => { changed.add('text'); mirror.text = text; writeMirror(); switcher.updateButtonAppearance(); });
		settingsRegistry.onChange(P.MODE, (mode) => { changed.add('mode'); mirror.mode = mode; writeMirror(); });
		Promise.all([settingsRegistry.get(P.TEXT), settingsRegistry.get(P.MODE)]).then(([text, mode]) => {
			if (!changed.has('text')) mirror.text = text;
			if (!changed.has('mode')) mirror.mode = mode;
			writeMirror();
		});
	}

	setTimeout(() => {
		initPreferences();
		initCodePrompt();
	});
})();
