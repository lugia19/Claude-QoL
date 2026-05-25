// prompt-templates.js
(function () {
	'use strict';

	const TEMPLATES_KEY = SETTINGS_KEYS.TEMPLATES.LIBRARY;
	const TEMPLATE_BUTTON_CLASS = 'prompt-templates-button';
	const TEMPLATE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
	const PLACEHOLDER_REGEX = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;

	function nowTs() {
		return Date.now();
	}

	function makeId() {
		return `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	}

	function normalizeName(name) {
		return (name || '').trim().toLowerCase();
	}

	function sanitizeTemplate(item) {
		if (!item || typeof item !== 'object') return null;
		const id = typeof item.id === 'string' && item.id ? item.id : makeId();
		const name = typeof item.name === 'string' ? item.name.trim() : '';
		const content = typeof item.content === 'string' ? item.content : '';
		if (!name || !content.trim()) return null;
		return {
			id,
			name,
			content,
			tags: Array.isArray(item.tags) ? item.tags.filter(t => typeof t === 'string') : [],
			createdAt: typeof item.createdAt === 'number' ? item.createdAt : nowTs(),
			updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : nowTs(),
			lastUsedAt: typeof item.lastUsedAt === 'number' ? item.lastUsedAt : 0,
			usageCount: typeof item.usageCount === 'number' ? item.usageCount : 0,
		};
	}

	async function getTemplatesMap() {
		const raw = await settingsRegistry.get(TEMPLATES_KEY);
		if (!raw || typeof raw !== 'object') return {};
		const cleaned = {};
		for (const [id, item] of Object.entries(raw)) {
			const normalized = sanitizeTemplate({ ...item, id });
			if (normalized) cleaned[normalized.id] = normalized;
		}
		return cleaned;
	}

	async function saveTemplatesMap(map) {
		await settingsRegistry.set(TEMPLATES_KEY, map);
	}

	function sortTemplates(items) {
		return items.sort((a, b) => {
			const lastUsedDiff = (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
			if (lastUsedDiff !== 0) return lastUsedDiff;
			const usageDiff = (b.usageCount || 0) - (a.usageCount || 0);
			if (usageDiff !== 0) return usageDiff;
			return a.name.localeCompare(b.name);
		});
	}

	function extractVariables(content) {
		const vars = [];
		const seen = new Set();
		let match;
		while ((match = PLACEHOLDER_REGEX.exec(content)) !== null) {
			const key = match[1].trim();
			const normalized = key.toLowerCase();
			if (!seen.has(normalized)) {
				seen.add(normalized);
				vars.push(key);
			}
		}
		PLACEHOLDER_REGEX.lastIndex = 0;
		return vars;
	}

	function renderTemplate(content, values) {
		return content.replace(PLACEHOLDER_REGEX, (_, key) => {
			const value = values[key] ?? values[key.toLowerCase()] ?? '';
			return String(value);
		});
	}

	async function saveTemplate(input, originalId = null) {
		const map = await getTemplatesMap();
		const name = (input.name || '').trim();
		const content = input.content || '';
		if (!name) throw new Error('Template name is required.');
		if (!content.trim()) throw new Error('Template content is required.');

		const normalized = normalizeName(name);
		for (const tpl of Object.values(map)) {
			if (tpl.id !== originalId && normalizeName(tpl.name) === normalized) {
				throw new Error('A template with this name already exists.');
			}
		}

		const id = originalId || makeId();
		const existing = map[id];
		map[id] = sanitizeTemplate({
			id,
			name,
			content,
			tags: input.tags || existing?.tags || [],
			createdAt: existing?.createdAt || nowTs(),
			updatedAt: nowTs(),
			lastUsedAt: existing?.lastUsedAt || 0,
			usageCount: existing?.usageCount || 0,
		});
		await saveTemplatesMap(map);
		return map[id];
	}

	async function deleteTemplate(id) {
		const map = await getTemplatesMap();
		delete map[id];
		await saveTemplatesMap(map);
	}

	async function touchTemplateUsage(id) {
		const map = await getTemplatesMap();
		const tpl = map[id];
		if (!tpl) return;
		tpl.lastUsedAt = nowTs();
		tpl.usageCount = (tpl.usageCount || 0) + 1;
		tpl.updatedAt = nowTs();
		await saveTemplatesMap(map);
	}

	function findComposerInput() {
		const selectors = [
			'textarea[placeholder*="Message"]',
			'textarea[data-testid*="chat"]',
			'textarea',
			'div[contenteditable="true"][role="textbox"]',
			'div[contenteditable="true"]',
		];
		for (const selector of selectors) {
			const nodes = Array.from(document.querySelectorAll(selector));
			const node = nodes.find(el => el.offsetParent !== null && !el.closest('[aria-hidden="true"]'));
			if (node) return node;
		}
		return null;
	}

	function setComposerText(target, textToInsert) {
		if (!target) return false;
		const isTextArea = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
		if (isTextArea) {
			const current = target.value || '';
			const sep = current.trim().length ? '\n\n' : '';
			target.value = `${current}${sep}${textToInsert}`;
			target.dispatchEvent(new Event('input', { bubbles: true }));
			target.dispatchEvent(new Event('change', { bubbles: true }));
			target.focus();
			return true;
		}

		if (target.isContentEditable) {
			const current = target.innerText || '';
			const sep = current.trim().length ? '\n\n' : '';
			target.innerText = `${current}${sep}${textToInsert}`;
			target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: textToInsert }));
			target.focus();
			return true;
		}

		return false;
	}

	async function insertTemplateIntoComposer(template) {
		const vars = extractVariables(template.content);
		let finalText = template.content;
		if (vars.length > 0) {
			const values = await showVariableModal(template.name, vars);
			if (!values) return false;
			finalText = renderTemplate(template.content, values);
		}

		const composer = findComposerInput();
		if (!composer) {
			await showClaudeAlert('Error', 'Could not find message input.');
			return false;
		}

		const ok = setComposerText(composer, finalText);
		if (!ok) {
			await showClaudeAlert('Error', 'Could not insert into message input.');
			return false;
		}

		await touchTemplateUsage(template.id);
		await showClaudeAlert('Prompt templates', `Inserted "${template.name}".`);
		return true;
	}

	async function showVariableModal(templateName, variables) {
		return new Promise((resolve) => {
			const root = document.createElement('div');
			root.className = 'space-y-3';
			const inputs = {};

			for (const key of variables) {
				const wrap = document.createElement('div');
				const label = document.createElement('label');
				label.className = CLAUDE_CLASSES.LABEL;
				label.textContent = key;
				const input = createClaudeInput({ type: 'text', placeholder: `Value for ${key}` });
				inputs[key] = input;
				wrap.appendChild(label);
				wrap.appendChild(input);
				root.appendChild(wrap);
			}

			const modal = new ClaudeModal(`Fill variables: ${templateName}`, root, false);
			modal.addCancel('Cancel', () => resolve(null));
			modal.addConfirm('Insert', () => {
				const values = {};
				for (const [key, input] of Object.entries(inputs)) {
					values[key] = input.value || '';
				}
				resolve(values);
			});
			modal.show();
		});
	}

	function createTemplateEditorElement(initial = null) {
		const wrapper = document.createElement('div');
		wrapper.className = 'space-y-3';

		const nameWrap = document.createElement('div');
		const nameLabel = document.createElement('label');
		nameLabel.className = CLAUDE_CLASSES.LABEL;
		nameLabel.textContent = 'Template name';
		const nameInput = createClaudeInput({ type: 'text', value: initial?.name || '', placeholder: 'e.g., Bug triage prompt' });
		nameWrap.appendChild(nameLabel);
		nameWrap.appendChild(nameInput);

		const contentWrap = document.createElement('div');
		const contentLabel = document.createElement('label');
		contentLabel.className = CLAUDE_CLASSES.LABEL;
		contentLabel.textContent = 'Template content';
		const contentInput = document.createElement('textarea');
		contentInput.className = `${CLAUDE_CLASSES.INPUT} min-h-32`;
		contentInput.rows = 8;
		contentInput.placeholder = 'Use {{variable_name}} placeholders if needed.';
		contentInput.value = initial?.content || '';
		contentWrap.appendChild(contentLabel);
		contentWrap.appendChild(contentInput);

		const hint = document.createElement('p');
		hint.className = CLAUDE_CLASSES.TEXT_MUTED;
		hint.textContent = 'Variables format: {{topic}}, {{tone}}, {{audience}}';

		wrapper.appendChild(nameWrap);
		wrapper.appendChild(contentWrap);
		wrapper.appendChild(hint);

		return { wrapper, nameInput, contentInput };
	}

	async function showTemplateEditorModal(existing = null) {
		return new Promise((resolve) => {
			const ui = createTemplateEditorElement(existing);
			const modal = new ClaudeModal(existing ? 'Edit template' : 'New template', ui.wrapper, false);
			modal.addCancel('Cancel', () => resolve(false));
			modal.addConfirm(existing ? 'Save' : 'Create', async () => {
				try {
					await saveTemplate({
						name: ui.nameInput.value,
						content: ui.contentInput.value,
					}, existing?.id || null);
					resolve(true);
				} catch (error) {
					await showClaudeAlert('Validation error', error.message || 'Failed to save template.');
					return false;
				}
				return true;
			});
			modal.show();
		});
	}

	function createTemplateRow(template, refresh, options = {}) {
		const { onInserted = null } = options;
		const row = document.createElement('div');
		row.className = 'p-3 rounded bg-bg-200 border border-border-300 space-y-2';

		const top = document.createElement('div');
		top.className = 'flex items-center justify-between gap-2';
		const title = document.createElement('div');
		title.className = 'text-text-100 font-medium';
		title.textContent = template.name;
		const actions = document.createElement('div');
		actions.className = 'flex gap-2';

		const insertBtn = createClaudeButton('Insert', 'primary', async () => {
			const inserted = await insertTemplateIntoComposer(template);
			if (inserted && typeof onInserted === 'function') {
				onInserted();
			}
		});
		const editBtn = createClaudeButton('Edit', 'secondary', async () => {
			const changed = await showTemplateEditorModal(template);
			if (changed) await refresh();
		});
		const deleteBtn = createClaudeButton('Delete', 'secondary', async () => {
			const confirmed = await showClaudeConfirm('Delete template', `Delete "${template.name}"?`);
			if (!confirmed) return;
			await deleteTemplate(template.id);
			await refresh();
		});

		actions.appendChild(insertBtn);
		actions.appendChild(editBtn);
		actions.appendChild(deleteBtn);
		top.appendChild(title);
		top.appendChild(actions);

		const preview = document.createElement('div');
		preview.className = 'text-sm text-text-300';
		preview.textContent = template.content.length > 180
			? `${template.content.slice(0, 180)}...`
			: template.content;

		row.appendChild(top);
		row.appendChild(preview);
		return row;
	}

	async function showTemplatePickerModal() {
		const root = document.createElement('div');
		root.className = 'space-y-3';

		const search = createClaudeInput({ type: 'text', placeholder: 'Search templates...' });
		const list = document.createElement('div');
		list.className = 'max-h-[50vh] overflow-y-auto space-y-2';

		const modal = new ClaudeModal('Prompt Templates', root);
		modal.modal.classList.remove('max-w-md');
		modal.modal.classList.add('max-w-3xl');
		modal.addCancel('Close');
		modal.addConfirm('New template', async () => {
			const created = await showTemplateEditorModal();
			if (created) await refresh();
			return false;
		}, false);

		root.appendChild(search);
		root.appendChild(list);

		const refresh = async () => {
			const query = (search.value || '').trim().toLowerCase();
			const templates = sortTemplates(Object.values(await getTemplatesMap()));
			list.innerHTML = '';

			const filtered = templates.filter(t => {
				if (!query) return true;
				return t.name.toLowerCase().includes(query) || t.content.toLowerCase().includes(query);
			});

			if (filtered.length === 0) {
				const empty = document.createElement('div');
				empty.className = 'text-text-400 text-sm py-4 text-center';
				empty.textContent = query ? 'No templates match your search.' : 'No templates yet. Create one to get started.';
				list.appendChild(empty);
				return;
			}

			filtered.forEach(t => list.appendChild(createTemplateRow(t, refresh, {
				onInserted: () => modal.destroy(),
			})));
		};

		search.addEventListener('input', refresh);
		await refresh();
		modal.show();
	}

	function createTemplateButton() {
		const button = createClaudeButton(TEMPLATE_ICON_SVG, 'icon');
		button.classList.add('shrink-0');
		button.onclick = async () => {
			await showTemplatePickerModal();
		};
		return button;
	}

	async function findSettingsTextarea() {
		const textarea = document.getElementById('conversation-preferences');
		if (!textarea) return null;
		const container = textarea.closest('.group.relative');
		if (!container || container.dataset.templatesManagerProcessed) return null;
		return { container };
	}

	function createSettingsManagerUI() {
		const root = document.createElement('div');
		root.className = 'prompt-template-settings mb-4';
		root.innerHTML = `
			<div class="flex items-center justify-between mb-2">
				<label class="${CLAUDE_CLASSES.LABEL} mb-0">Prompt templates</label>
				<button class="new-template-btn ${CLAUDE_CLASSES.BTN_SECONDARY}">New Template</button>
			</div>
			<input class="${CLAUDE_CLASSES.INPUT} template-search mb-3" placeholder="Search templates..." />
			<div class="template-list max-h-[45vh] overflow-y-auto space-y-2"></div>
		`;
		return root;
	}

	async function renderSettingsTemplateList(root) {
		const list = root.querySelector('.template-list');
		const query = (root.querySelector('.template-search').value || '').trim().toLowerCase();
		const templates = sortTemplates(Object.values(await getTemplatesMap()));
		list.innerHTML = '';

		const filtered = templates.filter(t => !query
			|| t.name.toLowerCase().includes(query)
			|| t.content.toLowerCase().includes(query));

		if (filtered.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'text-text-400 text-sm py-4 text-center';
			empty.textContent = query ? 'No matches.' : 'No templates created yet.';
			list.appendChild(empty);
			return;
		}

		const refresh = async () => renderSettingsTemplateList(root);
		filtered.forEach(t => list.appendChild(createTemplateRow(t, refresh)));
	}

	async function attachSettingsManagerHandlers(root) {
		root.querySelector('.new-template-btn').addEventListener('click', async () => {
			const created = await showTemplateEditorModal();
			if (created) await renderSettingsTemplateList(root);
		});

		root.querySelector('.template-search').addEventListener('input', async () => {
			await renderSettingsTemplateList(root);
		});

		await renderSettingsTemplateList(root);
	}

	async function tryInjectSettingsUI() {
		const elements = await findSettingsTextarea();
		if (!elements) return;
		const { container } = elements;

		const manager = createSettingsManagerUI();
		await attachSettingsManagerHandlers(manager);
		container.parentNode.insertBefore(manager, container);
		container.dataset.templatesManagerProcessed = 'true';
	}

	function initialize() {
		ButtonBar.register({
			buttonClass: TEMPLATE_BUTTON_CLASS,
			createFn: createTemplateButton,
			tooltip: 'Prompt templates',
			forceDisplayOnMobile: false,
			pages: ['chat', 'home', 'coworkChat', 'coworkHome'],
		});

		tryInjectSettingsUI();
		setInterval(tryInjectSettingsUI, 1000);
	}

	setTimeout(initialize);
})();
