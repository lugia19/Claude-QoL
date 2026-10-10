// file-download.js (ISOLATED world, document_idle)
// Download buttons claude.ai doesn't have:
// - the project Context dialog (a project page's "Context" row): one on every file row, next to its
//   "More options" menu, and one in the preview pane's header, for the file being previewed;
// - a chat's text-attachment preview dialog.
// Project files are found by name and upload time in the project's /docs and /files: each row's name
// button is labelled with the file name (from the data, not the UI language), and its <time datetime>
// is the file's created_at to the millisecond, which tells apart two files with the same name. Rows that
// match neither (a GitHub or Drive sync) get no button. ClaudeProject (claude-api.js) does the downloading.
(function () {
	'use strict';
	const log = createLogger('FileDownload');

	const ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256">
		<path d="M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0Zm-101.66,5.66a8,8,0,0,0,11.32,0l40-40a8,8,0,0,0-11.32-11.32L136,124.69V32a8,8,0,0,0-16,0v92.69L93.66,98.34a8,8,0,0,0-11.32,11.32Z"></path>
	</svg>`;
	const MARK = 'qol-download-button';

	// A button that looks like `model` (the native button it sits next to: same classes and data-cds
	// attributes, so it follows claude.ai's theme), with our icon.
	function downloadButton(model, tooltip, onClick) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = `${model.className} ${MARK}`;
		for (const attr of model.attributes) {
			if (attr.name.startsWith('data-cds') || attr.name === 'data-size') button.setAttribute(attr.name, attr.value);
		}
		button.setAttribute('aria-label', tooltip);
		button.innerHTML = ICON;
		createClaudeTooltip(button, tooltip);
		button.addEventListener('click', (e) => {
			e.stopPropagation();
			onClick();
		});
		return button;
	}

	// ======== Project files ========

	// The project's files. Fetched when a Context dialog opens, and again when a row appears that we
	// don't know (an upload while the dialog is open).
	let project = null;
	let lookup = null; // promise of Map(rowKey or file name -> { doc } | { file })
	// Unknown rows we've already refetched for, or that were there when the list was fetched (a GitHub
	// or Drive sync is never in it): each one costs at most one refetch, never a refetch loop.
	const settledUnknowns = new Set();

	function projectFiles(refresh) {
		const projectId = getProjectId();
		if (!projectId) return null;
		if (project?.projectId !== projectId) {
			project = new ClaudeProject(getOrgId(), projectId);
			lookup = null;
		}
		if (!lookup || refresh) {
			lookup = Promise.all([project.getDocs(), project.getFiles()]).then(([docs, files]) => {
				// Keyed by name and time, and by name alone for a row without a time (the first file of
				// that name wins there). A row with a time only ever matches its exact key.
				const entries = new Map();
				const add = (name, createdAt, entry) => {
					entries.set(fileKey(name, createdAt), entry);
					if (!entries.has(name)) entries.set(name, entry);
				};
				for (const file of files) add(file.file_name, file.created_at, { file });
				for (const doc of docs) add(doc.file_name, doc.created_at, { doc });
				return entries;
			}).catch((e) => {
				log.error('Could not list the project files:', e);
				lookup = null;
				return new Map();
			});
		}
		return lookup;
	}

	async function downloadProjectFile(row) {
		try {
			const entry = findEntry(await projectFiles(false), row);
			if (!entry) throw new Error(`${row.name} is not a project file`);
			if (entry.file) await project.downloadFile(entry.file.file_uuid);
			else await project.downloadAttachment(entry.doc.uuid);
		} catch (error) {
			log.error('Download failed:', error);
			showClaudeAlert(localize('common.error'), localize('download.failed'));
		}
	}

	// name + upload time in ms (API timestamps have microseconds, the page's have milliseconds).
	const fileKey = (name, time) => `${name}\u0000${Date.parse(String(time).replace(/(\.\d{3})\d+/, '$1'))}`;

	// A file row as { name, time, key }: its name button's label and its <time>'s datetime.
	function rowInfo(row) {
		const name = row?.querySelector('td:first-child button[aria-label]')?.getAttribute('aria-label');
		if (!name) return null;
		const time = row.querySelector('time[datetime]')?.getAttribute('datetime') ?? null;
		return { name, time, key: time ? fileKey(name, time) : name };
	}

	// Exact: a timed row whose time matches no file (a sync sharing a file's name) gets no button.
	const findEntry = (entries, row) => entries?.get(row.key);

	const seenDialogs = new WeakSet();

	// Passes may overlap (each scan starts one, whatever is in flight), so every row present at some scan
	// gets looked at. Overlapping passes share the list fetch, and each adds its buttons in one synchronous
	// loop that skips rows already done, so they can't duplicate a button or a refetch.
	async function decorateContextDialog(dialog) {
		const rows = [...dialog.querySelectorAll('tr')].filter(row => row.querySelector('[data-cds="TableRowActions"]'));
		if (!rows.length) return;
		const fresh = !seenDialogs.has(dialog);
		seenDialogs.add(dialog);
		let files = await projectFiles(fresh);
		if (!files) return;
		const unknown = () => rows.map(rowInfo).filter(info => info && !files.has(info.key) && !settledUnknowns.has(info.key));
		if (fresh) {
			unknown().forEach(info => settledUnknowns.add(info.key));
		} else {
			const fresher = unknown();
			if (fresher.length) {
				fresher.forEach(info => settledUnknowns.add(info.key));
				files = await projectFiles(true);
			}
		}

		for (const row of rows) {
			const info = rowInfo(row);
			const actions = row.querySelector('[data-cds="TableRowActions"]');
			const menu = actions?.querySelector('button[aria-haspopup="menu"]');
			const existing = actions?.querySelector(`.${MARK}`);
			if (!info || !menu || !findEntry(files, info)) {
				existing?.remove();
				continue;
			}
			if (existing?.dataset.fileKey === info.key) continue;
			existing?.remove();
			const button = downloadButton(menu, localize('download.download'), () => downloadProjectFile(info));
			button.dataset.fileKey = info.key;
			button.dataset.fileName = info.name;
			menu.before(button);
		}

		// The preview pane: its header is the h3 title's row, its close button the last icon button there.
		// Shown only while the previewed (active) row is a project file: a sync's preview gets none.
		const header = dialog.querySelector('h3')?.parentElement;
		const close = header && [...header.querySelectorAll('button[data-cds-icon-only]')].filter(b => !b.classList.contains(MARK)).at(-1);
		if (!close) return;
		let previewButton = header.querySelector(`.${MARK}`);
		if (!previewButton) {
			previewButton = downloadButton(close, localize('download.download_file'), () => {
				const info = rowInfo(dialog.querySelector('tr[data-active="true"]'));
				if (info) downloadProjectFile(info);
			});
			close.before(previewButton);
		}
		const active = rowInfo(dialog.querySelector('tr[data-active="true"]'));
		// style, not the hidden attribute: the copied classes set display and would win over it.
		previewButton.style.display = active && findEntry(files, active) ? '' : 'none';
	}

	// ======== Chat text-attachment preview ========

	// claude.ai's preview of a text attachment: a dialog with an h2 title (the file name), the text in a
	// pre-wrap block, and a close button.
	function decorateTextPreview(dialog) {
		const title = dialog.querySelector('h2');
		const text = dialog.querySelector('.whitespace-pre-wrap');
		const close = title && [...dialog.querySelectorAll('button[data-cds-icon-only]')].filter(b => !b.classList.contains(MARK)).at(-1);
		if (!title || !text || !close || dialog.querySelector(`.${MARK}`)) return;
		close.before(downloadButton(close, localize('download.download_file'), () => {
			saveBlob(new Blob([text.textContent], { type: 'text/plain' }), title.textContent.trim() || 'download.txt');
		}));
	}

	// ======== Watching for dialogs ========

	function scan() {
		for (const dialog of document.querySelectorAll('[role="dialog"]')) {
			if (dialog.querySelector('table[data-cds="Table"]')) {
				if (getProjectId()) decorateContextDialog(dialog).catch(e => log.error('Context dialog:', e));
			} else {
				decorateTextPreview(dialog);
			}
		}
	}

	// Scans are coalesced (the observer fires constantly while a reply streams) with a timer, not an
	// animation frame: frames don't run while a window isn't drawn (a desktop client window in the
	// background), and a scan waiting on one would leave the buttons out until it is.
	let scheduled = false;
	new MutationObserver(() => {
		if (scheduled) return;
		scheduled = true;
		setTimeout(() => {
			scheduled = false;
			scan();
		}, 50);
	}).observe(document.body, { childList: true, subtree: true });
	scan();
})();
