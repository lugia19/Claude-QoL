// notifications.js
// Version update notification for Claude QoL extension
'use strict';

const QOL_BLUE_HIGHLIGHT = 'var(--qol-primary, #2c84db)';

// Notification card styles
const notificationStyles = document.createElement('style');
notificationStyles.textContent = `
	.qol-card {
		position: fixed;
		padding: 12px;
		border-radius: 8px;
		z-index: 10000;
		font-size: 14px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
	}
	.qol-header {
		font-weight: bold;
		padding-bottom: 8px;
		margin-bottom: 8px;
		cursor: move;
	}
	.qol-close {
		position: absolute;
		top: 8px;
		right: 8px;
		border: none;
		font-size: 18px;
		cursor: pointer;
		line-height: 1;
		padding: 4px 8px;
		border-radius: 4px;
	}
	.qol-close:hover {
		background: rgba(0, 0, 0, 0.1);
	}
	.qol-text-center {
		text-align: center;
	}
	.qol-text-left {
		text-align: left;
	}
	.qol-block {
		display: block;
	}
	.qol-mb-1 {
		margin-bottom: 4px;
	}
	.qol-mb-2 {
		margin-bottom: 8px;
	}
	.qol-content-box {
		padding: 8px;
		border-radius: 4px;
		overflow-y: auto;
	}
	.qol-link {
		text-decoration: none;
	}
	.qol-link:hover {
		text-decoration: underline;
	}
`;
document.head.appendChild(notificationStyles);

// Draggable functionality for cards
function makeDraggable(element, dragHandle = null) {
	let isDragging = false;
	let currentX;
	let currentY;
	let initialX;
	let initialY;
	let pointerId = null;

	const dragElement = dragHandle || element;

	function handleDragStart(e) {
		if (isDragging) return;

		isDragging = true;
		pointerId = e.pointerId;
		dragElement.setPointerCapture(e.pointerId);

		initialX = e.clientX - element.offsetLeft;
		initialY = e.clientY - element.offsetTop;

		dragElement.style.cursor = 'grabbing';
		e.preventDefault();
	}

	function handleDragMove(e) {
		if (!isDragging || e.pointerId !== pointerId) return;
		e.preventDefault();

		currentX = e.clientX - initialX;
		currentY = e.clientY - initialY;

		const maxX = window.innerWidth - element.offsetWidth;
		const maxY = window.innerHeight - element.offsetHeight;
		currentX = Math.min(Math.max(0, currentX), maxX);
		currentY = Math.min(Math.max(0, currentY), maxY);

		element.style.left = `${currentX}px`;
		element.style.top = `${currentY}px`;
		element.style.right = 'auto';
		element.style.bottom = 'auto';
	}

	function handleDragEnd(e) {
		if (e.pointerId !== pointerId) return;

		isDragging = false;
		pointerId = null;
		dragElement.style.cursor = dragHandle ? 'move' : 'grab';
		dragElement.releasePointerCapture(e.pointerId);
	}

	dragElement.addEventListener('pointerdown', handleDragStart);
	dragElement.addEventListener('pointermove', handleDragMove);
	dragElement.addEventListener('pointerup', handleDragEnd);
	dragElement.addEventListener('pointercancel', handleDragEnd);

	dragElement.style.cursor = dragHandle ? 'move' : 'grab';
	dragElement.style.touchAction = 'none';

	return () => {
		dragElement.removeEventListener('pointerdown', handleDragStart);
		dragElement.removeEventListener('pointermove', handleDragMove);
		dragElement.removeEventListener('pointerup', handleDragEnd);
		dragElement.removeEventListener('pointercancel', handleDragEnd);
	};
}

// Base floating card class
class FloatingCard {
	constructor() {
		// Electron needs extra top offset to clear the toolbar in the content pane
		const isElectronClient = !!document.querySelector('.dframe-content-inner');
		this.defaultPosition = { top: isElectronClient ? '40px' : '20px', right: '20px' };
		this.element = document.createElement('div');
		this.element.className = 'bg-bg-100 border border-border-400 text-text-000 qol-card';
	}

	addCloseButton() {
		const closeButton = document.createElement('button');
		closeButton.className = 'qol-close text-base';
		closeButton.style.color = QOL_BLUE_HIGHLIGHT;
		closeButton.style.background = 'none';
		closeButton.textContent = '\u00d7';
		closeButton.addEventListener('click', () => this.remove());
		this.element.appendChild(closeButton);
	}

	show(position) {
		if (position) {
			['top', 'right', 'bottom', 'left'].forEach(prop => {
				this.element.style[prop] = null;
			});
			Object.entries(position).forEach(([key, value]) => {
				this.element.style[key] = typeof value === 'number' ? `${value}px` : value;
			});
		} else {
			Object.entries(this.defaultPosition).forEach(([key, value]) => {
				this.element.style[key] = value;
			});
		}
		// On Electron, inject into content area so cards don't overlap window controls.
		// Ensure the mount is a positioning context so `top`/`right` are relative to it.
		const electronMount = document.querySelector('.dframe-content-inner');
		if (electronMount) {
			if (getComputedStyle(electronMount).position === 'static') {
				electronMount.style.position = 'relative';
			}
			this.element.style.position = 'absolute';
			electronMount.appendChild(this.element);
		} else {
			document.body.appendChild(this.element);
		}
	}

	makeCardDraggable(dragHandle = null) {
		this.cleanup = makeDraggable(this.element, dragHandle);
	}

	addImageButton(href, imageFile, alt) {
		const link = document.createElement('a');
		link.href = href;
		link.target = '_blank';
		link.className = 'qol-block qol-text-center';
		link.style.marginTop = '10px';

		const img = document.createElement('img');
		img.src = chrome.runtime.getURL(imageFile);
		img.height = 36;
		img.style.border = '0';
		img.alt = alt;
		link.appendChild(img);

		this.element.appendChild(link);
	}

	addKofiButton() {
		this.addImageButton('https://ko-fi.com/R6R14IUBY', 'kofi-button.png', 'Buy Me a Coffee at ko-fi.com');
	}

	remove() {
		if (this.cleanup) {
			this.cleanup();
		}
		this.element.remove();
	}
}

// Version notification card with Ko-fi button
class VersionNotificationCard extends FloatingCard {
	constructor(previousVersion, currentVersion, patchHighlights) {
		super();
		this.previousVersion = previousVersion;
		this.currentVersion = currentVersion;
		this.patchHighlights = patchHighlights;
		this.element.classList.add('qol-text-center');
		this.element.style.maxWidth = '280px';
		this.build();
	}

	build() {
		const dragHandle = document.createElement('div');
		dragHandle.className = 'border-b border-border-400 qol-header';
		dragHandle.textContent = 'Claude QoL';

		const message = document.createElement('div');
		message.className = 'qol-mb-2';
		message.textContent = `Updated to v${this.currentVersion}!`;

		this.element.appendChild(dragHandle);
		this.element.appendChild(message);

		if (this.patchHighlights?.length > 0) {
			const patchContainer = document.createElement('div');
			patchContainer.className = 'bg-bg-000 qol-content-box qol-text-left qol-mb-2';
			patchContainer.style.maxHeight = '150px';

			const patchTitle = document.createElement('div');
			patchTitle.textContent = "What's New:";
			patchTitle.style.fontWeight = 'bold';
			patchTitle.className = 'qol-mb-1';
			patchContainer.appendChild(patchTitle);

			const patchList = document.createElement('ul');
			patchList.style.paddingLeft = '12px';
			patchList.style.margin = '0';
			patchList.style.listStyleType = 'disc';

			this.patchHighlights.forEach(highlight => {
				const item = document.createElement('li');
				item.textContent = highlight;
				item.style.marginBottom = '3px';
				item.style.paddingLeft = '3px';
				patchList.appendChild(item);
			});

			patchContainer.appendChild(patchList);
			this.element.appendChild(patchContainer);
		}

		const patchNotesLink = document.createElement('a');
		patchNotesLink.href = 'https://github.com/lugia19/Claude-QoL/releases';
		patchNotesLink.target = '_blank';
		patchNotesLink.className = 'qol-link qol-block qol-mb-2';
		patchNotesLink.style.color = QOL_BLUE_HIGHLIGHT;
		patchNotesLink.textContent = 'View full release notes';
		this.element.appendChild(patchNotesLink);

		this.addKofiButton();
		this.addCloseButton();
		this.makeCardDraggable(dragHandle);
	}

}

// Rate extension notification card
class RateNotificationCard extends FloatingCard {
	constructor() {
		super();
		this.element.classList.add('qol-text-center');
		this.element.style.maxWidth = '280px';
		this.build();
	}

	build() {
		const dragHandle = document.createElement('div');
		dragHandle.className = 'border-b border-border-400 qol-header';
		dragHandle.textContent = 'Claude QoL';

		const message = document.createElement('div');
		message.className = 'qol-mb-2';
		message.textContent = 'Enjoying Claude QoL?';

		const supportMessage = document.createElement('div');
		supportMessage.className = 'qol-mb-2';
		supportMessage.style.fontWeight = 'bold';
		supportMessage.textContent = 'Consider leaving a rating!';

		this.element.appendChild(dragHandle);
		this.element.appendChild(message);
		this.element.appendChild(supportMessage);

		const isChrome = !!window.chrome && (!!window.chrome.webstore || !!window.chrome.runtime);
		const rateUrl = isChrome
			? 'https://chromewebstore.google.com/detail/claude-qol/dkdnancajokhfclpjpplkhlkbhaeejob'
			: 'https://addons.mozilla.org/en-US/firefox/addon/claude-qol/';
		this.addImageButton(rateUrl, 'rate-badge.png', 'Rate this extension');

		this.addCloseButton();
		this.makeCardDraggable(dragHandle);
	}
}

// Notification manager
class QoLNotifications {
	constructor() {
		this.init();
	}

	async init() {
		// Delay to allow page to load
		await new Promise(resolve => setTimeout(resolve, 1000));
		await this.checkForVersionUpdate();
		await this.checkForRateReminder();
	}

	async checkForVersionUpdate() {
		const currentVersion = chrome.runtime.getManifest().version;
		const previousVersion = await settingsRegistry.get(SETTINGS_KEYS.NOTIFICATIONS.PREVIOUS_VERSION);

		// First install - don't show notification
		if (!previousVersion) {
			await settingsRegistry.set(SETTINGS_KEYS.NOTIFICATIONS.PREVIOUS_VERSION, currentVersion);
			return;
		}

		// No version change
		if (previousVersion === currentVersion) {
			return;
		}

		// Load patch notes
		let patchHighlights = [];
		try {
			const patchNotesFile = await fetch(chrome.runtime.getURL('update_patchnotes.txt'));
			if (patchNotesFile.ok) {
				const patchNotesText = await patchNotesFile.text();
				patchHighlights = patchNotesText
					.split('\n')
					.filter(line => line.trim().length > 0);
			}
		} catch (error) {
			console.error('[QOL-Notifications] Failed to load patch notes:', error);
		}

		await settingsRegistry.set(SETTINGS_KEYS.NOTIFICATIONS.PREVIOUS_VERSION, currentVersion);

		const notificationCard = new VersionNotificationCard(previousVersion, currentVersion, patchHighlights);
		notificationCard.show();
	}

	async checkForRateReminder() {
		const rateReminderTime = await settingsRegistry.get(SETTINGS_KEYS.NOTIFICATIONS.RATE_REMINDER_TIME);

		if (!rateReminderTime) {
			await settingsRegistry.set(SETTINGS_KEYS.NOTIFICATIONS.RATE_REMINDER_TIME, Date.now() + 8 * 24 * 60 * 60 * 1000);
			return;
		}

		const rateReminderShown = await settingsRegistry.get(SETTINGS_KEYS.NOTIFICATIONS.RATE_REMINDER_SHOWN);
		if (rateReminderShown) return;
		if (Date.now() < rateReminderTime) return;

		await settingsRegistry.set(SETTINGS_KEYS.NOTIFICATIONS.RATE_REMINDER_SHOWN, true);

		const notificationCard = new RateNotificationCard();
		notificationCard.show();
	}
}

// Self-initialize
const qolNotifications = new QoLNotifications();

// Global Error Toast Notification
class ErrorToastNotification extends FloatingCard {
	constructor(message) {
		super();
		this.defaultPosition = { bottom: '20px', right: '20px' };
		this.element.classList.add('qol-text-left');
		this.element.style.maxWidth = '300px';
		this.element.style.borderLeft = '4px solid #ef4444'; // Tailwind red-500
		
		const msgDiv = document.createElement('div');
		msgDiv.className = 'qol-mb-1';
		msgDiv.style.fontWeight = 'bold';
		msgDiv.textContent = 'Claude QoL Error';
		
		const detailsDiv = document.createElement('div');
		detailsDiv.style.fontSize = '12px';
		detailsDiv.textContent = message;
		
		this.element.appendChild(msgDiv);
		this.element.appendChild(detailsDiv);
		this.addCloseButton();
		
		// Auto dismiss after 5 seconds
		setTimeout(() => {
			if (this.element && this.element.parentNode) {
				this.remove();
			}
		}, 5000);
	}
}

window.showErrorToast = (msg) => {
	const toast = new ErrorToastNotification(msg);
	toast.show();
};
