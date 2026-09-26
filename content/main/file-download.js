// project-downloads.js

(function () {
	'use strict';
	const log = createLogger('FileDownload');

	let isProcessing = false;

	// The org and project of the project page we're on, or null elsewhere.
	function parseProjectUrl() {
		const projectId = getProjectId();
		return projectId ? { orgId: getOrgId(), projectId } : null;
	}

	// Create download button
	function createDownloadButton(fileId, isAttachment) {
		const button = createClaudeButton(`
			<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256">
				<path d="M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0Zm-101.66,5.66a8,8,0,0,0,11.32,0l40-40a8,8,0,0,0-11.32-11.32L136,124.69V32a8,8,0,0,0-16,0v92.69L93.66,98.34a8,8,0,0,0-11.32,11.32Z"></path>
			</svg>
		`, 'icon');

		button.classList.add('project-download-button');
		button.classList.add('!w-[18px]', '!h-[18px]', '!border-0.5', '!border-border-300/25', '!shadow-sm', '!rounded', '!bg-bg-000');
		button.setAttribute('data-file-id', fileId);
		button.setAttribute('data-is-attachment', isAttachment);

		createClaudeTooltip(button, localize('download.download'));

		button.onclick = async (e) => {
			e.stopPropagation();
			await handleDownload(fileId, isAttachment);
		};

		return button;
	}

	// Handle file download
	async function handleDownload(fileId, isAttachment) {
		const urlData = parseProjectUrl();
		if (!urlData) return;

		const project = new ClaudeProject(urlData.orgId, urlData.projectId);

		try {
			if (isAttachment) {
				await project.downloadAttachment(fileId);
			} else {
				await project.downloadFile(fileId);
			}
		} catch (error) {
			log.error(`Failed to download:`, error);
			alert(localize('download.failed'));
		}
	}

	// Poll for file thumbnails and add buttons
	async function pollAndAddButtons(project) {
		const maxAttempts = 20;
		const pollInterval = 500;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			// Updated selector to catch both types of thumbnails
			const thumbnails = document.querySelectorAll('.group\\/thumbnail');

			if (thumbnails.length > 0) {
				await addDownloadButtons(project, thumbnails);
				return;
			}

			await new Promise(resolve => setTimeout(resolve, pollInterval));
		}

	}

	// Add download buttons to thumbnails
	async function addDownloadButtons(project, thumbnails) {

		// Fetch all data
		const [syncs, docs, files] = await Promise.all([
			project.getSyncs(),
			project.getDocs(),
			project.getFiles()
		]);

		const syncsCount = syncs.length || 0;
		const docsCount = docs.length || 0;
		const filesCount = files.length || 0;

		// Track which buttons should exist
		const validButtonIds = new Set();

		// Process thumbnails and add/update buttons
		let buttonsAdded = 0;
		let buttonsReused = 0;

		thumbnails.forEach((thumbnail, index) => {
			if (index < syncsCount) {
				return;
			}

			const adjustedIndex = index - syncsCount;
			let fileId, isAttachment;

			if (adjustedIndex < docsCount) {
				// This is an attachment - uses 'uuid'
				fileId = docs[adjustedIndex].uuid;
				isAttachment = true;
			} else {
				// This is a file - uses 'file_uuid'
				const fileIndex = adjustedIndex - docsCount;
				if (fileIndex >= filesCount) {
					return;
				}
				fileId = files[fileIndex].file_uuid;
				isAttachment = false;
			}

			// Mark this button as valid
			validButtonIds.add(fileId);

			// Find the checkbox container - works for both types
			const checkboxContainer = thumbnail.querySelector('.flex.flex-row.gap-1.h-\\[18px\\]');
			if (!checkboxContainer) {
				return;
			}

			// Check if correct button already exists
			const existingButton = checkboxContainer.querySelector('.project-download-button');
			if (existingButton) {
				const existingId = existingButton.getAttribute('data-file-id');
				const existingIsAttachment = existingButton.getAttribute('data-is-attachment') === 'true';

				if (existingId === fileId && existingIsAttachment === isAttachment) {
					buttonsReused++;
					return;
				} else {
					existingButton.remove();
				}
			}

			// Create and add button (insert before the checkbox label)
			const button = createDownloadButton(fileId, isAttachment);
			const checkboxLabel = checkboxContainer.querySelector('label');
			if (checkboxLabel) {
				checkboxContainer.insertBefore(button, checkboxLabel);
			} else {
				checkboxContainer.appendChild(button);
			}
			buttonsAdded++;
		});

		// Remove orphaned buttons (buttons that don't correspond to any current thumbnail)
		const allButtons = document.querySelectorAll('.project-download-button');
		let buttonsRemoved = 0;
		allButtons.forEach(button => {
			const fileId = button.getAttribute('data-file-id');
			if (!validButtonIds.has(fileId)) {
				button.remove();
				buttonsRemoved++;
			}
		});

	}

	// Main processing function
	async function processProject() {
		if (isProcessing) {
			return;
		}

		const urlData = parseProjectUrl();
		if (!urlData) {
			return;
		}

		isProcessing = true;

		try {
			// Create project instance
			const project = new ClaudeProject(urlData.orgId, urlData.projectId);

			// Fetch project data to check if there are files
			const projectData = await project.getData();
			const totalFiles = (projectData.docs_count || 0) + (projectData.files_count || 0);

			if (totalFiles > 0) {
				await pollAndAddButtons(project);
			} else {
				// Remove any orphaned buttons if project now has no files
				const allButtons = document.querySelectorAll('.project-download-button');
				if (allButtons.length > 0) {
					allButtons.forEach(btn => btn.remove());
				}
			}
		} catch (error) {
			log.error(`Error during processing:`, error);
		} finally {
			isProcessing = false;
		}
	}

	// Set up fetch interception
	const originalFetch = window.fetch;
	window.fetch = function (...args) {
		const url = ClaudeExtNet.getFetchUrl(args[0]).split('?')[0];

		// Check if it's a project-related endpoint
		if (url.includes('/projects/') && (
			url.match(/\/projects\/[a-f0-9-]+$/) ||
			url.includes('/docs') ||
			url.includes('/files')
		)) {
			// Trigger processing after the fetch completes (a failed fetch is the page's to handle)
			const result = originalFetch.apply(this, args);
			result.then(() => processProject(), () => { });
			return result;
		}

		return originalFetch.apply(this, args);
	};

	// File preview download

	function addAttachmentDownloadButton() {
		const closeButton = document.querySelector('[data-testid="close-file-preview"]');
		if (!closeButton) return;

		// Check for file size indicator
		const sizeIndicators = document.querySelectorAll('.text-text-500 span');
		const hasSize = Array.from(sizeIndicators).some(span =>
			/KB|MB|bytes/.test(span.textContent)
		);
		if (!hasSize) return;

		// Find header and check if button exists
		const header = closeButton.closest('.sticky.flex.items-center.gap-1');
		if (!header || header.querySelector('.file-preview-download-button')) return;

		// Create button
		const button = createClaudeButton(`
		<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 256 256">
			<path d="M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0Zm-101.66,5.66a8,8,0,0,0,11.32,0l40-40a8,8,0,0,0-11.32-11.32L136,124.69V32a8,8,0,0,0-16,0v92.69L93.66,98.34a8,8,0,0,0-11.32,11.32Z"></path>
		</svg>
	`, 'icon');

		button.classList.add('file-preview-download-button', 'shrink-0', '-mr-2');
		createClaudeTooltip(button, localize('download.download_file'));

		button.onclick = () => {
			const filename = header.querySelector('h2')?.textContent.trim() || 'download.txt';
			const content = document.querySelector('.font-mono.whitespace-pre-wrap')?.textContent || '';

			const blob = new Blob([content], { type: 'text/plain' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			a.click();
			URL.revokeObjectURL(url);
		};

		header.insertBefore(button, closeButton);
	}

	// Periodic checking
	let lastUrl = '';
	setInterval(() => {
		const currentUrl = window.location.href;
		if (currentUrl !== lastUrl && currentUrl.includes('/project/')) {
			lastUrl = currentUrl;
			processProject();
		}

		addAttachmentDownloadButton();
	}, 1000);

	// Initial check
	if (window.location.href.includes('/project/')) {
		processProject();
	} else {
	}
})();