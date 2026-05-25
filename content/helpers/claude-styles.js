// claude-styles.js
// Shared style utilities for Claude.ai extension
// No IIFE - runs in shared global context

// Add marker for usage tracker to know if it's installed:
document.documentElement.setAttribute('data-claude-qol-installed', 'true');

const CLAUDE_CLASSES = {
	// Buttons
	ICON_BTN: 'inline-flex items-center justify-center relative shrink-0 ring-offset-2 ring-offset-bg-300 ring-accent-main-100 focus-visible:outline-none focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none disabled:drop-shadow-none text-text-200 border-transparent transition-colors font-styrene active:bg-bg-400 h-9 w-9 rounded-md active:scale-95',
	ICON_BTN_MSG: 'inline-flex items-center justify-center relative shrink-0 can-focus select-none disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none disabled:drop-shadow-none border-transparent transition font-base duration-300 ease-[cubic-bezier(0.165,0.85,0.45,1)] h-8 w-8 rounded-md active:scale-95 group/btn',
	BTN_PRIMARY: 'inline-flex items-center justify-center px-4 py-2 font-base-bold bg-text-000 text-bg-000 rounded hover:bg-text-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors min-w-[5rem] h-9',
	BTN_SECONDARY: 'inline-flex items-center justify-center px-4 py-2 hover:bg-bg-500/40 rounded transition-colors min-w-[5rem] h-9 text-text-000 font-base-bold border-0.5 border-border-200',

	// Modal
	MODAL_BACKDROP: 'fixed inset-0 flex items-center justify-center z-50',
	MODAL_CONTAINER: 'bg-bg-100 rounded-lg p-6 shadow-xl max-w-md w-full mx-4 border border-border-300',
	MODAL_HEADING: 'text-lg font-semibold mb-4 text-text-100',

	// Form elements
	INPUT: 'w-full p-2 rounded bg-bg-200 text-text-100 border border-border-300 hover:border-border-200',
	SELECT: 'w-full p-2 rounded bg-bg-200 text-text-100 border border-border-300 hover:border-border-200 cursor-pointer',
	CHECKBOX: 'mr-2 rounded border-border-300 accent-accent-main-100',
	LABEL: 'block text-sm font-medium text-text-200 mb-1',

	// Text
	TEXT_SM: 'text-sm text-text-400 sm:text-[0.75rem]',
	TEXT_MUTED: 'text-sm text-text-400',

	// Tooltip
	TOOLTIP_WRAPPER: 'fixed left-0 top-0 min-w-max z-[100] pointer-events-none',
	TOOLTIP_CONTENT: 'px-2 py-1 text-xs font-normal font-ui leading-tight rounded-md shadow-md text-white bg-black/80 backdrop-blur break-words max-w-[13rem]',

	// Layout helpers
	FLEX_CENTER: 'flex items-center justify-center',
	FLEX_BETWEEN: 'flex items-center justify-between',
	FLEX_GAP_2: 'flex items-center gap-2',

	// List components
	LIST_CONTAINER: 'space-y-2 overflow-y-auto',
	LIST_ITEM: 'p-3 rounded bg-bg-200 border border-border-300 hover:bg-bg-300 cursor-pointer transition-colors',
};

const spinnerStyles = document.createElement('style');
spinnerStyles.textContent = `
	@keyframes claude-modal-spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}
	.claude-modal-spinner {
		animation: claude-modal-spin 1s linear infinite;
	}
`;
if (document.head) document.head.appendChild(spinnerStyles);

// Component creators
class ClaudeModal {
	constructor(title = '', content = '', dismissible = true) {
		this.config = { title, content, dismissible };
		this.isVisible = false;
		this.buttons = [];

		this._buildModal();
		this._attachEventListeners();
	}

	_buildModal() {
		this.backdrop = document.createElement('div');
		this.backdrop.className = CLAUDE_CLASSES.MODAL_BACKDROP;
		this.backdrop.style.position = 'fixed';
		this.backdrop.style.inset = '0';
		this.backdrop.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
		this.backdrop.style.display = 'none';
		this.backdrop.style.zIndex = '50';
		this.backdrop.style.display = 'none';

		this.modal = document.createElement('div');
		this.modal.className = CLAUDE_CLASSES.MODAL_CONTAINER;
		this.modal.setAttribute('role', 'dialog');
		this.modal.setAttribute('aria-modal', 'true');

		this.titleElement = document.createElement('h2');
		this.titleElement.id = 'modal-title';
		this.titleElement.className = CLAUDE_CLASSES.MODAL_HEADING;
		this.modal.setAttribute('aria-labelledby', 'modal-title');
		this.modal.appendChild(this.titleElement);
		this._updateTitle(this.config.title);

		this.contentDiv = document.createElement('div');
		this.contentDiv.className = 'mb-4';
		this._setContent(this.config.content);
		this.modal.appendChild(this.contentDiv);

		this.buttonContainer = document.createElement('div');
		this.buttonContainer.className = 'flex justify-end gap-2';
		this.modal.appendChild(this.buttonContainer);

		this.backdrop.appendChild(this.modal);
	}

	_setContent(content) {
		this.contentDiv.innerHTML = '';
		if (!content) return;

		if (typeof content === 'string') {
			this.contentDiv.innerHTML = content;
		} else if (content instanceof HTMLElement) {
			this.contentDiv.appendChild(content);
		}
	}

	_updateTitle(title) {
		if (title) {
			this.titleElement.textContent = title;
			this.titleElement.style.display = '';
		} else {
			this.titleElement.style.display = 'none';
		}
	}

	_attachEventListeners() {
		this._handleEscape = (e) => {
			if (e.key === 'Escape' && this.isVisible && this.config.dismissible) {
				this.hide();
			}
		};

		// Track where the mousedown occurred
		let mouseDownOnBackdrop = false;

		this.backdrop.addEventListener('mousedown', (e) => {
			// Only set flag if mousedown is directly on backdrop (not modal)
			mouseDownOnBackdrop = e.target === this.backdrop;
		});

		this.backdrop.addEventListener('mouseup', (e) => {
			// Only close if both mousedown AND mouseup were on backdrop
			if (mouseDownOnBackdrop && e.target === this.backdrop && this.config.dismissible) {
				this.hide();
			}
			// Reset flag
			mouseDownOnBackdrop = false;
		});
	}

	addButton(text, variant = 'primary', onClick = null, closeOnClick = true) {
		const button = createClaudeButton(text, variant);

		button.onclick = async () => {
			try {
				let shouldClose = closeOnClick;

				if (onClick) {
					let result = onClick(button, this);
					if (result instanceof Promise) {
						result = await result;
					}
					if (result === false) {
						shouldClose = false;
					}
				}

				if (shouldClose) {
					this.destroy();
				}
			} catch (error) {
				console.error('Modal button handler error:', error);
			}
		};

		this.buttonContainer.appendChild(button);
		this.buttons.push(button);

		return button;
	}

	addCancel(text = 'Cancel', onClick = null) {
		return this.addButton(text, 'secondary', onClick, true);
	}

	addConfirm(text = 'Confirm', onClick = null, closeOnClick = true) {
		return this.addButton(text, 'primary', onClick, closeOnClick);
	}

	clearButtons() {
		this.buttons.forEach(btn => btn.remove());
		this.buttons = [];
		return this;
	}

	show() {
		if (this.isVisible) return this;

		this.backdrop.style.display = 'flex';
		document.body.appendChild(this.backdrop);
		document.addEventListener('keydown', this._handleEscape);
		this.isVisible = true;

		// Steal focus
		this.backdrop.setAttribute('tabindex', '-1');
		this.backdrop.focus();

		return this;
	}

	hide() {
		if (!this.isVisible) return this;

		this.backdrop.style.display = 'none';
		document.removeEventListener('keydown', this._handleEscape);
		this.isVisible = false;

		return this;
	}

	destroy() {
		this.hide();
		this.backdrop.remove();
	}

	setContent(content) {
		this._setContent(content);
		return this;
	}

	setTitle(title) {
		this.config.title = title;
		this._updateTitle(title);
		return this;
	}
}

function createLoadingContent(text) {
	const div = document.createElement('div');
	div.className = 'flex items-start gap-3'; // Changed from items-center to items-start

	// Split on newlines and create proper line breaks
	const lines = text.split('\n');
	const textContent = document.createElement('div');
	textContent.className = 'text-text-200';

	lines.forEach((line, index) => {
		const span = document.createElement('span');
		span.textContent = line;
		textContent.appendChild(span);
		if (index < lines.length - 1) {
			textContent.appendChild(document.createElement('br'));
		}
	});

	div.innerHTML = `
		<div class="claude-modal-spinner rounded-full h-5 w-5 border-2 border-border-300 flex-shrink-0" style="border-top-color: #2c84db"></div>
	`;
	div.appendChild(textContent);

	return div;
}

function createLoadingModal(text = 'Loading...') {
	return new ClaudeModal('', createLoadingContent(text), false);
}

function showClaudeConfirm(title, message) {
	return new Promise((resolve) => {
		const messageEl = document.createElement('p');
		messageEl.className = 'text-text-100';
		messageEl.textContent = message;

		const modal = new ClaudeModal(title, messageEl);

		modal.addCancel('Cancel', () => {
			resolve(false);
		});

		modal.addConfirm('Confirm', () => {
			resolve(true);
		});

		// Override backdrop click to resolve with false
		modal.backdrop.onclick = (e) => {
			if (e.target === modal.backdrop) {
				modal.hide();
				resolve(false);
			}
		};

		modal.show();
	});
}

// Three-option modal for more complex choices
// options = { left: {text, variant?}, middle: {text, variant?}, right: {text, variant?} }
// Returns 'left', 'middle', or 'right'
function showClaudeThreeOption(title, message, options) {
	return new Promise((resolve) => {
		const messageEl = document.createElement('p');
		messageEl.className = 'text-text-100';
		messageEl.style.whiteSpace = 'pre-line';
		messageEl.textContent = message;

		const modal = new ClaudeModal(title, messageEl, false); // Not dismissible

		modal.addButton(options.left.text, options.left.variant || 'secondary', () => resolve('left'));
		modal.addButton(options.middle.text, options.middle.variant || 'secondary', () => resolve('middle'));
		modal.addButton(options.right.text, options.right.variant || 'primary', () => resolve('right'));

		modal.show();
	});
}

async function promptForSettingsMismatch(sourceSettings) {
	const account = await getAccountSettings();
	const current = account.settings || account;

	const desiredArtifacts = sourceSettings?.preview_feature_uses_artifacts === true;
	const desiredCE = sourceSettings?.enabled_monkeys_in_a_barrel === true;
	const currentArtifacts = current.preview_feature_uses_artifacts === true;
	const currentCE = current.enabled_monkeys_in_a_barrel === true;

	const artifactsMismatch = desiredArtifacts !== currentArtifacts;
	const ceMismatch = desiredCE !== currentCE;

	if (!artifactsMismatch && !ceMismatch) {
		return {
			preview_feature_uses_artifacts: currentArtifacts,
			enabled_monkeys_in_a_barrel: currentCE,
		};
	}

	const mismatches = [];
	if (artifactsMismatch) {
		mismatches.push(`Artifacts: Originally ${desiredArtifacts ? 'ON' : 'OFF'} | Currently ${currentArtifacts ? 'ON' : 'OFF'}`);
	}
	if (ceMismatch) {
		mismatches.push(`Code Execution: Originally ${desiredCE ? 'ON' : 'OFF'} | Currently ${currentCE ? 'ON' : 'OFF'}`);
	}

	const result = await showClaudeThreeOption(
		'Settings Mismatch',
		`Source conversation has different settings:\n${mismatches.join('\n')}\n\nWhat would you like to do?`,
		{
			left: { text: 'Cancel', variant: 'secondary' },
			middle: { text: 'Continue anyway', variant: 'secondary' },
			right: { text: 'Switch to match', variant: 'primary' }
		}
	);

	if (result === 'left') {
		throw new Error('USER_CANCELLED');
	}

	if (result === 'middle') {
		return {
			preview_feature_uses_artifacts: currentArtifacts,
			enabled_monkeys_in_a_barrel: currentCE,
		};
	}

	return {
		preview_feature_uses_artifacts: desiredArtifacts,
		enabled_monkeys_in_a_barrel: desiredCE,
	};
}

// Full-featured prompt with all options
function showClaudePrompt(title, message, placeholder = '', defaultValue = '', onValidate = null) {
	return new Promise((resolve, reject) => {
		const contentDiv = document.createElement('div');

		if (message) {
			const label = document.createElement('label');
			label.className = CLAUDE_CLASSES.LABEL;
			label.textContent = message;
			contentDiv.appendChild(label);
		}

		const input = createClaudeInput({
			type: 'text',
			placeholder: placeholder,
			value: defaultValue,
		});
		contentDiv.appendChild(input);

		const modal = new ClaudeModal(title, contentDiv);

		modal.addCancel('Cancel', () => {
			reject(new Error('User cancelled'));
		});

		modal.addConfirm('OK', async (btn, modal) => {
			const value = input.value.trim();

			// Run validation if provided
			if (onValidate) {
				const validationResult = await onValidate(value);
				if (validationResult !== true) {
					// Show error message if validation failed
					if (typeof validationResult === 'string') {
						showClaudeAlert('Validation Error', validationResult);
					}
					return false; // Keep modal open
				}
			}

			resolve(value);
			return true; // Close modal
		});

		modal.show();

		// Focus the input
		setTimeout(() => input.focus(), 100);

		// Allow Enter key to submit
		input.addEventListener('keypress', (e) => {
			if (e.key === 'Enter') {
				const confirmBtn = modal.buttons[modal.buttons.length - 1];
				if (confirmBtn) confirmBtn.click();
			}
		});
	});
}

// Full-featured alert with customization
function showClaudeAlert(title, message, buttonText = 'OK') {
	return new Promise((resolve) => {
		const contentDiv = document.createElement('div');
		contentDiv.className = 'text-text-200';

		if (typeof message === 'string') {
			contentDiv.textContent = message;
		} else if (message instanceof HTMLElement) {
			contentDiv.appendChild(message);
		}

		const modal = new ClaudeModal(title, contentDiv);
		modal.addButton(buttonText, 'primary', () => {
			resolve();
		});
		modal.show();
	});
}

function createClaudeButton(content, variant = 'primary', onClick = null, contentIsHTML = false) {
	const button = document.createElement('button');
	button.setAttribute('data-toolbox-button', 'true');

	switch (variant) {
		case 'primary':
			button.className = CLAUDE_CLASSES.BTN_PRIMARY;
			break;
		case 'secondary':
			button.className = CLAUDE_CLASSES.BTN_SECONDARY;
			break;
		case 'icon': case 'icon-message':
			if (variant === 'icon') {
				button.className = CLAUDE_CLASSES.ICON_BTN;
			} else {
				button.className = CLAUDE_CLASSES.ICON_BTN_MSG;
			}
			contentIsHTML = true;

			// Add hover effect directly
			button.addEventListener('mouseenter', () => {
				button.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
			});
			button.addEventListener('mouseleave', () => {
				button.style.backgroundColor = '';
			});
			break;
		default:
			button.className = CLAUDE_CLASSES.BTN_PRIMARY;
	}

	if (contentIsHTML) {
		button.innerHTML = content;
	} else {
		button.textContent = content;
	}

	if (onClick) button.onclick = onClick;
	return button;
}


function createClaudeInput({ type = 'text', placeholder = '', value = '', onChange = null } = {}) {
	const input = document.createElement('input');
	input.type = type;
	input.className = CLAUDE_CLASSES.INPUT;
	input.placeholder = placeholder;
	input.value = value;

	if (onChange) {
		input.addEventListener('input', onChange);
	}

	return input;
}

function createClaudeSelect(options, selectedValue = '', onChange = null) {
	const select = document.createElement('select');
	select.className = CLAUDE_CLASSES.SELECT;

	options.forEach(option => {
		const optionEl = document.createElement('option');
		optionEl.value = option.value;
		optionEl.textContent = option.label;
		optionEl.selected = option.value === selectedValue;
		select.appendChild(optionEl);
	});

	if (onChange) {
		select.addEventListener('change', onChange);
	}

	return select;
}

function createClaudeCheckbox(labelText = '', checked = false, onChange = null) {
	const container = document.createElement('div');
	container.className = CLAUDE_CLASSES.FLEX_GAP_2;

	const checkbox = document.createElement('input');
	checkbox.type = 'checkbox';
	checkbox.className = CLAUDE_CLASSES.CHECKBOX;
	checkbox.checked = checked;

	// Add aria-label for screen readers
	if (labelText) {
		checkbox.setAttribute('aria-label', labelText);
	}

	if (onChange) {
		checkbox.addEventListener('change', (e) => onChange(e.target.checked));
	}

	container.appendChild(checkbox);

	if (labelText) {
		const label = document.createElement('label');
		label.className = 'text-text-100 cursor-pointer select-none';
		label.textContent = labelText;
		label.onclick = () => checkbox.click();
		container.appendChild(label);
	}

	return { container, checkbox };
}

function createClaudeToggle(labelText = '', checked = false, onChange = null) {
	// Container for toggle + label
	const container = document.createElement('div');
	container.className = 'flex items-center gap-2';

	// Toggle wrapper
	const toggleWrapper = document.createElement('label');

	const toggleContainer = document.createElement('div');
	toggleContainer.className = 'group/switch relative select-none cursor-pointer inline-block';

	const input = document.createElement('input');
	input.type = 'checkbox';
	input.className = 'peer sr-only';
	input.role = 'switch';
	input.checked = checked;
	input.style.width = '36px';
	input.style.height = '20px';

	if (labelText) {
		input.setAttribute('aria-label', labelText);
	}


	const track = document.createElement('div');
	track.className = 'border-border-300 rounded-full bg-bg-500 transition-colors peer-disabled:opacity-50';
	track.style.width = '36px';
	track.style.height = '20px';

	const thumb = document.createElement('div');
	thumb.className = 'absolute flex items-center justify-center rounded-full bg-white transition-transform group-hover/switch:opacity-80';
	thumb.style.width = '16px';
	thumb.style.height = '16px';
	thumb.style.left = '2px';
	thumb.style.top = '2px';
	thumb.style.transform = checked ? 'translateX(16px)' : 'translateX(0)';

	const updateTrackColor = (on) => {
		track.style.backgroundColor = on ? '#2c84db' : '';
	};
	updateTrackColor(checked);

	input.addEventListener('change', (e) => {
		thumb.style.transform = e.target.checked ? 'translateX(16px)' : 'translateX(0)';
		updateTrackColor(e.target.checked);
		if (onChange) onChange(e.target.checked);
	});

	toggleContainer.appendChild(input);
	toggleContainer.appendChild(track);
	toggleContainer.appendChild(thumb);
	toggleContainer.style.transform = 'translateY(3px)'; // Slight vertical align
	toggleWrapper.appendChild(toggleContainer);

	container.appendChild(toggleWrapper);

	// Add label text if provided
	if (labelText) {
		const label = document.createElement('span');
		label.className = 'text-text-100 select-none cursor-pointer';
		label.textContent = labelText;
		label.onclick = () => input.click(); // Make label clickable
		container.appendChild(label);
	}

	return { container, input, toggle: toggleContainer };
}


function createClaudeSlider(label, defaultValue = 100, options = {}) {
	const {
		min = 0,
		max = 100,
		step = 25,
		showLabels = true,
		suffix = '%',
		leftLabel = null,
		rightLabel = null
	} = options;

	const container = document.createElement('div');
	container.className = 'space-y-2';
	container.style.paddingBottom = '1rem';

	// Label
	if (label) {
		const labelElement = document.createElement('label');
		labelElement.className = CLAUDE_CLASSES.LABEL;
		labelElement.textContent = label;
		container.appendChild(labelElement);
	}

	// Left/Right labels row (if provided)
	if (leftLabel || rightLabel) {
		const labelRow = document.createElement('div');
		labelRow.style.marginBottom = '-1rem';
		labelRow.className = 'flex justify-between text-sm text-text-500 pb-1';
		labelRow.innerHTML = `
		<span>${leftLabel || ''}</span>
		<span>${rightLabel || ''}</span>
	`;
		container.appendChild(labelRow);
	}

	// Slider wrapper
	const sliderWrapper = document.createElement('div');
	sliderWrapper.className = 'relative px-4 py-4 select-none';

	// Track
	const track = document.createElement('div');
	track.className = 'relative w-full h-2 bg-bg-300 rounded-lg cursor-pointer';

	// Filled track (progress)
	const fillTrack = document.createElement('div');
	fillTrack.className = 'absolute left-0 top-0 h-full rounded-lg pointer-events-none';
	fillTrack.style.backgroundColor = '#2c84db';

	// Thumb
	const thumb = document.createElement('div');
	thumb.className = 'absolute top-1/2 w-5 h-5 rounded-full border-2 border-white shadow-md cursor-grab active:cursor-grabbing';
	thumb.style.backgroundColor = '#2c84db';
	thumb.style.transform = 'translate(-50%, -50%)';
	thumb.style.transition = 'none';

	track.appendChild(fillTrack);
	track.appendChild(thumb);
	sliderWrapper.appendChild(track);

	// Hidden input for form compatibility
	const input = document.createElement('input');
	input.type = 'hidden';
	input.value = defaultValue;
	sliderWrapper.appendChild(input);

	// Tick marks and labels
	if (showLabels) {
		const ticksContainer = document.createElement('div');
		ticksContainer.className = 'relative w-full mt-3';

		for (let value = min; value <= max; value += step) {
			const percentage = ((value - min) / (max - min)) * 100;

			const tickWrapper = document.createElement('div');
			tickWrapper.className = 'absolute flex flex-col items-center cursor-pointer';
			tickWrapper.style.left = `${percentage}%`;
			tickWrapper.style.transform = 'translateX(-50%)';

			// Tick mark
			const tick = document.createElement('div');
			tick.className = 'w-0.5 h-2 bg-border-300 mb-1';
			tickWrapper.appendChild(tick);

			// Label
			const tickLabel = document.createElement('span');
			tickLabel.className = 'text-xs text-text-400 select-none whitespace-nowrap';
			tickLabel.textContent = `${value}${suffix}`;
			tickWrapper.appendChild(tickLabel);

			// Click on tick to set value
			tickWrapper.addEventListener('click', () => {
				setValue(value);
			});

			ticksContainer.appendChild(tickWrapper);
		}

		sliderWrapper.appendChild(ticksContainer);
	}

	container.appendChild(sliderWrapper);

	// State
	let currentValue = defaultValue;
	let isDragging = false;

	// Helper functions
	const snapToStep = (value) => {
		const steps = Math.round((value - min) / step);
		return Math.min(max, Math.max(min, min + steps * step));
	};

	const setValue = (value) => {
		currentValue = snapToStep(value);
		const percentage = ((currentValue - min) / (max - min)) * 100;
		thumb.style.left = `${percentage}%`;
		fillTrack.style.width = `${percentage}%`;
		input.value = currentValue;

		// Dispatch both input (for real-time) and change (for compatibility)
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new Event('change', { bubbles: true }));
	};

	const handleMove = (clientX) => {
		const rect = track.getBoundingClientRect();
		const percentage = ((clientX - rect.left) / rect.width) * 100;
		const value = min + (percentage / 100) * (max - min);
		setValue(value);
	};

	// Mouse events
	thumb.addEventListener('mousedown', (e) => {
		isDragging = true;
		thumb.style.transition = 'none';
		e.preventDefault();
	});

	track.addEventListener('mousedown', (e) => {
		if (e.target === track || e.target === fillTrack) {
			isDragging = true;
			thumb.style.transition = 'none';
			handleMove(e.clientX);
			e.preventDefault();
		}
	});

	document.addEventListener('mousemove', (e) => {
		if (isDragging) {
			handleMove(e.clientX);
		}
	});

	document.addEventListener('mouseup', () => {
		if (isDragging) {
			isDragging = false;
			thumb.style.transition = '';
		}
	});

	// Touch events
	thumb.addEventListener('touchstart', (e) => {
		isDragging = true;
		thumb.style.transition = 'none';
		e.preventDefault();
	});

	track.addEventListener('touchstart', (e) => {
		if (e.target === track || e.target === fillTrack) {
			isDragging = true;
			thumb.style.transition = 'none';
			handleMove(e.touches[0].clientX);
			e.preventDefault();
		}
	});

	document.addEventListener('touchmove', (e) => {
		if (isDragging) {
			handleMove(e.touches[0].clientX);
		}
	});

	document.addEventListener('touchend', () => {
		if (isDragging) {
			isDragging = false;
			thumb.style.transition = '';
		}
	});

	// Initialize
	setValue(defaultValue);

	// Add hover effect
	thumb.addEventListener('mouseenter', () => {
		if (!isDragging) {
			thumb.style.transform = 'translate(-50%, -50%) scale(1.1)';
		}
	});

	thumb.addEventListener('mouseleave', () => {
		if (!isDragging) {
			thumb.style.transform = 'translate(-50%, -50%)';
		}
	});

	return {
		container,
		input,
		setValue,
		getValue: () => currentValue
	};
}


function createClaudeTooltip(element, tooltipText, deleteOnClick) {
	const tooltipId = `tooltip-${Math.random().toString(36).substring(2, 11)}`;

	// Link element to tooltip for screen readers
	element.setAttribute('aria-describedby', tooltipId);

	// Create tooltip wrapper
	const tooltipWrapper = document.createElement('div');
	tooltipWrapper.className = CLAUDE_CLASSES.TOOLTIP_WRAPPER;
	tooltipWrapper.style.display = 'none';
	tooltipWrapper.setAttribute('data-radix-popper-content-wrapper', '');

	// Add tooltip content with the ID
	const tooltipContent = document.createElement('div');
	tooltipContent.id = tooltipId;
	tooltipContent.className = CLAUDE_CLASSES.TOOLTIP_CONTENT + ' tooltip-content';
	tooltipContent.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
	tooltipContent.setAttribute('data-side', 'bottom');
	tooltipContent.setAttribute('data-align', 'center');
	tooltipContent.setAttribute('data-state', 'delayed-open');
	tooltipContent.innerHTML = `
        ${tooltipText}
        <span role="tooltip" style="position: absolute; border: 0px; width: 1px; height: 1px; padding: 0px; margin: -1px; overflow: hidden; clip: rect(0px, 0px, 0px, 0px); white-space: nowrap; overflow-wrap: normal;">
            ${tooltipText}
        </span>
    `;
	tooltipWrapper.appendChild(tooltipContent);

	// Add hover events
	function checkTooltipParent() {
		if (!element.isConnected) {
			tooltipWrapper.remove();
			return;
		}
		if (tooltipWrapper.style.display !== 'none') {
			setTimeout(checkTooltipParent, 500);
		}
	}

	element.addEventListener('mouseenter', () => {
		tooltipWrapper.style.display = 'block';
		const rect = element.getBoundingClientRect();
		const tooltipRect = tooltipWrapper.getBoundingClientRect();
		const centerX = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
		tooltipWrapper.style.transform = `translate(${centerX}px, ${rect.bottom + 5}px)`;
		setTimeout(checkTooltipParent, 500);
	});

	element.addEventListener('mouseleave', () => {
		tooltipWrapper.style.display = 'none';
	});

	tooltipWrapper.addEventListener('mouseenter', () => {
		tooltipWrapper.style.display = 'none';
	});
	tooltipWrapper.addEventListener('pointerup', () => {
		tooltipWrapper.style.display = 'none';
	});

	// Handle click behavior
	const shouldHideOnClick = deleteOnClick === undefined
		? (element.onclick !== null)
		: deleteOnClick;

	if (shouldHideOnClick) {
		element.addEventListener('click', () => {
			tooltipWrapper.style.display = 'none';
		});
	}

	document.body.appendChild(tooltipWrapper);

	// Clean up when element is removed
	const originalRemove = element.remove.bind(element);
	element.remove = () => {
		tooltipWrapper.remove();
		originalRemove();
	};

	// Create tooltip API object
	const tooltipAPI = {
		wrapper: tooltipWrapper,
		updateText: (newText) => {
			tooltipContent.innerHTML = `
                ${newText}
                <span role="tooltip" style="position: absolute; border: 0px; width: 1px; height: 1px; padding: 0px; margin: -1px; overflow: hidden; clip: rect(0px, 0px, 0px, 0px); white-space: nowrap; overflow-wrap: normal;">
                    ${newText}
                </span>
            `;
		}
	};

	// Store tooltip on the element itself
	element.tooltip = tooltipAPI;

	// Still return it for convenience
	return tooltipAPI;
}


// ======== PAGE LAYOUTS ========
// Modular layout registry for button injection targets.
// Each layout has match() to detect the page, getAnchor() to find the DOM insertion point.
// Checked in order; first match() wins.
// Page layouts for top-right ButtonBar injection only.
// Each layout defines where the toolbox button container is anchored in the DOM.
// Code and cowork layouts must be checked before chat/home to avoid false matches.
const pageLayouts = {
	codeHome: {
		group: 'codeHome',
		match() { return !!window.location.pathname.match(/\/claude-code-desktop\/draft_/); },
		// Disabled for code web (aka claude.ai/code) for now due to being totally different.
		getAnchor() {
			const mainContent = document.getElementById('main-content');
			if (!mainContent) return null;
			return { parent: mainContent, referenceNode: null, mode: 'self-container' };
		},
	},
	codeChat: {
		group: 'codeChat',
		match() {
			return !!window.location.pathname.match(/\/claude-code-desktop\/session_/)
			//|| !!window.location.pathname.match(/\/code\//);	// Disable it on web for now.
		},
		getAnchor() {
			const sticky = document.querySelector('.sticky.top-0.z-20');
			if (!sticky) return null;
			const row = sticky.querySelector('.flex.items-center.gap-1');
			if (!row) return null;
			// Insert before the share/actions container (last child of the row)
			const actionsContainer = row.lastElementChild;
			return { parent: row, referenceNode: actionsContainer, mode: 'inline' };
		},
	},
	coworkHome: {
		group: 'coworkHome',
		match() {
			return window.location.pathname === '/task/new'
				&& !!document.querySelector('.dframe-pane-header');
		},
		getAnchor() {
			const header = document.querySelector('.dframe-pane-header');
			if (!header) return null;
			const actionsSlot = header.querySelector('#dframe-header-actions-slot');
			return { parent: header, referenceNode: actionsSlot || null, mode: 'inline' };
		},
	},
	coworkChat: {
		group: 'coworkChat',
		match() { return window.location.pathname.startsWith('/local_sessions/'); },
		getAnchor() {
			const aside = document.querySelector('aside[aria-label="Session activity panel"]');
			if (!aside) return null;
			const inner = aside.firstElementChild;
			if (!inner) return null;
			return { parent: inner, referenceNode: inner.firstElementChild, mode: 'inline' };
		},
	},
	chatActions: {
		group: 'chat',
		match() {
			return window.location.href.includes('/chat/')
				&& !!document.querySelector('[data-testid="chat-actions"]');
		},
		getAnchor() {
			const chatActions = document.querySelector('[data-testid="chat-actions"]');
			if (!chatActions) return null;
			const isMobile = window.innerHeight > window.innerWidth;
			if (isMobile) {
				const header = chatActions.closest('header');
				if (header) {
					return { parent: header, referenceNode: null, mode: 'inline' };
				}
			}
			return { parent: chatActions.parentElement, referenceNode: chatActions, mode: 'inline' };
		},
	},
	chatWiggle: {
		group: 'chat',
		match() {
			const wiggle = document.querySelector('[data-testid="wiggle-controls-actions"]');
			return window.location.href.includes('/chat/')
				&& !document.querySelector('[data-testid="chat-actions"]')
				&& !!wiggle && !wiggle.closest('[inert]');
		},
		getAnchor() {
			const wiggle = document.querySelector('[data-testid="wiggle-controls-actions"]');
			if (!wiggle) return null;
			const actionsSlot = wiggle.closest('#dframe-header-actions-slot');
			if (actionsSlot) {
				return { parent: actionsSlot.parentElement, referenceNode: actionsSlot, mode: 'inline' };
			}
			const isMobile = window.innerHeight > window.innerWidth;
			if (isMobile) {
				return { parent: wiggle.parentElement, referenceNode: wiggle.nextElementSibling, mode: 'wiggle' };
			}
			return { parent: wiggle.parentElement.parentElement, referenceNode: null, mode: 'wiggle' };
		},
	},
	homeWeb: {
		group: 'home',
		match() {
			const isHome = window.location.pathname === '/new' || window.location.pathname === '/';
			if (!isHome) return false;
			const mainContent = document.getElementById('main-content');
			return !!mainContent?.querySelector('[class*="look-around"]');
		},
		getAnchor() {
			const mainContent = document.getElementById('main-content');
			const ghost = mainContent?.querySelector('[class*="look-around"]');
			if (!ghost) return null;
			const zHeader = ghost.closest('.z-header');
			if (!zHeader) return null;
			let ref = ghost;
			while (ref.parentElement !== zHeader) ref = ref.parentElement;
			return { parent: zHeader, referenceNode: ref, mode: 'inline' };
		},
	},
	homeDesktop: {
		group: 'home',
		match() {
			const isHome = window.location.pathname === '/new' || window.location.pathname === '/';
			return isHome && !!document.querySelector('.dframe-pane-header');
		},
		getAnchor() {
			const header = document.querySelector('.dframe-pane-header');
			if (!header) return null;
			const actionsSlot = header.querySelector('#dframe-header-actions-slot');
			return { parent: header, referenceNode: actionsSlot || null, mode: 'inline' };
		},
	},
	project: {
		group: 'project',
		match() {
			return !!window.location.pathname.match(/\/project\/[a-f0-9-]+/);
		},
		getAnchor() {
			const nativeActions = document.querySelector('.flex.items-center.gap-1.ml-auto');
			if (!nativeActions) return null;
			const starWrapper = nativeActions.querySelector('[data-state]');
			return { parent: nativeActions, referenceNode: starWrapper || null, mode: 'inline' };
		},
	},
};

// ======== BUTTON BAR SINGLETON ========
// All top right buttons must be in ISOLATED only!
// Callers register buttons once; ButtonBar handles polling, injection, ordering, and mobile.
const ButtonBar = {
	BUTTON_PRIORITY: [
		'banner-watcher-button',
		'search-button',
		'navigation-button',
		'prompt-templates-button',
		'style-selector-button',
		'preset-switcher-button',
		'export-button',
		'tts-settings-button',
	],

	_registrations: new Map(),
	_mobileModalButtons: [],
	_pollInterval: null,
	_container: null,
	_currentGroup: null,

	getCurrentGroup() {
		return this._currentGroup;
	},

	updateTooltip(buttonClass, text) {
		const reg = this._registrations.get(buttonClass);
		if (reg) reg.tooltip = text;
		const button = this._container?.querySelector('.' + buttonClass);
		if (button?.tooltip) button.tooltip.updateText(text);
		const modalEntry = this._mobileModalButtons.find(b => b.class === buttonClass);
		if (modalEntry) modalEntry.tooltip = text;
	},

	register({ buttonClass, createFn, tooltip = '', forceDisplayOnMobile = false, pages, onInjected = null }) {
		if (this._registrations.has(buttonClass)) return;
		this._registrations.set(buttonClass, { buttonClass, createFn, tooltip, forceDisplayOnMobile, pages, onInjected });
		if (!this._pollInterval) {
			this._pollInterval = setInterval(() => this._tick(), 1000);
			this._tick();
		}
	},

	_detectLayout() {
		for (const [name, layout] of Object.entries(pageLayouts)) {
			if (layout.match()) {
				return { name, ...layout };
			}
		}
		return null;
	},

	_tick() {
		const layout = this._detectLayout();
		if (!layout) {
			document.querySelectorAll('.toolbox-buttons').forEach(el => el.remove());
			this._container = null;
			this._currentGroup = null;
			return;
		}

		this._currentGroup = layout.group;
		const anchor = layout.getAnchor();
		if (!anchor) return;

		this._cleanStaleContainers(anchor);
		this._ensureContainer(anchor);
		if (!this._container) return;

		this._syncButtons(layout.group);

		if (anchor.mode === 'wiggle') {
			this._updateWigglePosition(anchor);
		}
	},

	_cleanStaleContainers(anchor) {
		document.querySelectorAll('.toolbox-buttons').forEach(el => {
			if (el !== this._container && el !== anchor.parent && el.parentElement !== anchor.parent) {
				el.remove();
			}
		});
	},

	_ensureContainer(anchor) {
		// Check if existing container is still in the DOM
		if (this._container && this._container.isConnected) {
			// Verify it's still in the right parent
			if (anchor.mode === 'self-container') {
				if (this._container.parentElement === anchor.parent) return;
			} else {
				if (this._container.parentElement === anchor.parent) return;
			}
			// Wrong parent — discard
			this._container.remove();
			this._container = null;
		}

		if (anchor.mode === 'self-container') {
			// Desktop homepage: container is a direct child of parent with special classes
			let container = anchor.parent.querySelector('.toolbox-buttons-home');
			if (!container) {
				container = document.createElement('div');
				container.className = 'toolbox-buttons-home toolbox-buttons absolute right-3 flex items-center gap-3.5';
				container.style.top = '0.625rem';
				anchor.parent.appendChild(container);
			}
			this._container = container;
		} else {
			let container = anchor.parent.querySelector(':scope > .toolbox-buttons');
			if (!container) {
				container = document.createElement('div');
				const isMobileChat = this._currentGroup === 'chat' && window.innerHeight > window.innerWidth;
				if (anchor.mode === 'wiggle') {
					if (isMobileChat) {
						container.className = 'toolbox-buttons flex items-center gap-1 pointer-events-auto self-end px-3 z-20 bg-bg-100 rounded-bl-lg';
						container.style.height = '2.25rem';
						container.style.marginTop = '-4px';
					} else {
						container.className = 'toolbox-buttons absolute top-0 z-20 flex items-center gap-1';
						container.style.height = '3rem';
					}
				} else {
					if (isMobileChat) {
						container.className = 'toolbox-buttons absolute top-full right-0 flex items-center gap-1 px-3 z-20 bg-bg-100 rounded-bl-lg';
						container.style.height = '2.25rem';
					} else {
						container.className = 'toolbox-buttons flex items-center justify-end gap-1';
					}
				}
				if (anchor.referenceNode) {
					anchor.parent.insertBefore(container, anchor.referenceNode);
				} else {
					anchor.parent.appendChild(container);
				}
			}
			this._container = container;
		}
	},

	_syncButtons(group) {
		const container = this._container;
		const isMobile = window.innerHeight > window.innerWidth;
		const isChatGroup = group === 'chat';

		// Remove buttons that don't belong to the current group
		for (const [buttonClass, reg] of this._registrations) {
			if (!reg.pages.includes(group)) {
				const existing = container.querySelector('.' + buttonClass);
				if (existing) existing.remove();
			}
		}

		for (const [buttonClass, reg] of this._registrations) {
			// Check if this button should appear on this page type
			if (!reg.pages.includes(group)) continue;

			// Mobile handling: on chat pages, non-forced buttons go to "More actions" modal
			if (isMobile && isChatGroup && !reg.forceDisplayOnMobile) {
				// Remove from container if it exists
				const existing = container.querySelector('.' + buttonClass);
				if (existing) existing.remove();

				// Add to modal array if not already there
				if (!this._mobileModalButtons.find(b => b.class === buttonClass)) {
					this._mobileModalButtons.push({
						class: buttonClass,
						createFn: reg.createFn,
						tooltip: reg.tooltip
					});
					if (reg.onInjected) reg.onInjected(null);
				}
				continue;
			}

			// Desktop / forced mobile: show button directly
			// Remove from mobile modal if it was there
			const modalIndex = this._mobileModalButtons.findIndex(b => b.class === buttonClass);
			if (modalIndex !== -1) {
				this._mobileModalButtons.splice(modalIndex, 1);
			}

			// Add button if it doesn't exist
			if (!container.querySelector('.' + buttonClass)) {
				const button = reg.createFn();
				button.classList.add(buttonClass);

				if (isMobile) {
					button.classList.add('-mx-1.5');
				}

				if (reg.tooltip) {
					createClaudeTooltip(button, reg.tooltip);
				}

				container.appendChild(button);

				if (reg.onInjected) {
					reg.onInjected(button);
				}
			}
		}

		// Handle "More actions" button for mobile on chat pages
		if (isMobile && isChatGroup && this._mobileModalButtons.length > 0) {
			if (!container.querySelector('.more-actions-button')) {
				const moreButton = createClaudeButton(`
					<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
						<circle cx="8" cy="2" r="1.5"/>
						<circle cx="8" cy="8" r="1.5"/>
						<circle cx="8" cy="14" r="1.5"/>
					</svg>
				`, 'icon');
				moreButton.classList.add('more-actions-button', '-mx-1.5');
				moreButton.onclick = () => this._showMoreActionsModal();
				createClaudeTooltip(moreButton, 'More actions');
				container.appendChild(moreButton);
			}
		} else {
			const moreBtn = container.querySelector('.more-actions-button');
			if (moreBtn) moreBtn.remove();
		}

		this._reorderButtons();
	},

	_reorderButtons() {
		const container = this._container;
		const currentButtons = Array.from(container.querySelectorAll('button'));

		const priorityButtons = [];
		for (const className of this.BUTTON_PRIORITY) {
			const button = currentButtons.find(btn => btn.classList.contains(className));
			if (button) priorityButtons.push(button);
		}

		const nonPriorityButtons = currentButtons.filter(btn =>
			!this.BUTTON_PRIORITY.some(className => btn.classList.contains(className)) &&
			!btn.classList.contains('more-actions-button')
		);

		const moreButton = currentButtons.find(btn => btn.classList.contains('more-actions-button'));

		const desiredOrder = [...priorityButtons, ...nonPriorityButtons];
		if (moreButton) desiredOrder.push(moreButton);

		const needsReordering = currentButtons.length !== desiredOrder.length ||
			!currentButtons.every((btn, index) => btn === desiredOrder[index]);

		if (needsReordering) {
			desiredOrder.forEach(button => container.appendChild(button));
		}
	},

	_updateWigglePosition(anchor) {
		if (window.innerHeight > window.innerWidth) return;
		const wiggle = anchor.parent.querySelector('[data-testid="wiggle-controls-actions"]');
		if (wiggle && this._container) {
			this._container.style.right = (wiggle.offsetWidth + 4) + 'px';
		}
	},

	_showMoreActionsModal() {
		const modal = new ClaudeModal('More Actions', '', true);

		const list = document.createElement('div');
		list.className = 'space-y-2';

		this._mobileModalButtons.forEach(btnInfo => {
			const button = btnInfo.createFn();
			const item = document.createElement('div');
			item.className = 'p-3 rounded bg-bg-200 border border-border-300 hover:bg-bg-300 cursor-pointer transition-colors flex items-center gap-3';

			const iconWrapper = document.createElement('div');
			iconWrapper.className = 'flex-shrink-0';
			iconWrapper.innerHTML = button.innerHTML;
			item.appendChild(iconWrapper);

			if (btnInfo.tooltip) {
				const label = document.createElement('span');
				label.className = 'text-text-100 flex-1';
				label.textContent = btnInfo.tooltip;
				item.appendChild(label);
			}

			item.onclick = () => {
				if (button.onclick) button.onclick();
				modal.destroy();
			};

			list.appendChild(item);
		});

		modal.setContent(list);
		modal.show();
	},
};

function findMessageControls(messageElement) {
	// Find the message container (the .group element's parent)
	const messageContainer = messageElement.closest('.group')?.parentElement?.parentElement;
	if (!messageContainer) return null;

	// Use the aria-label to find the message actions container
	const actionsGroup = messageContainer.querySelector('[role="group"][aria-label="Message actions"]');
	if (!actionsGroup) return null;

	// Return the .justify-between element inside
	return actionsGroup.querySelector('.justify-between');
}

// Retrieve all message elements from the UI
function getUIMessages() {
	const assistantMessages = Array.from(document.querySelectorAll('.font-claude-response, .\\!font-claude-response'))
		.filter(el => !el.classList.contains('text-text-300'));
	const userMessages = Array.from(document.querySelectorAll('.font-user-message, .\\!font-user-message, [data-testid="user-message"]'));

	// Interleave messages: user, assistant, user, assistant...
	const allMessages = [];
	const maxLen = Math.max(userMessages.length, assistantMessages.length);
	for (let i = 0; i < maxLen; i++) {
		if (i < userMessages.length) allMessages.push(userMessages[i]);
		if (i < assistantMessages.length) allMessages.push(assistantMessages[i]);
	}

	return {
		assistantMessages,
		userMessages,
		allMessages
	};
}

// ======== MESSAGE BUTTON BAR SINGLETON ========
// Manages per-message buttons (injected into message controls area).
// Callers register once; MessageButtonBar handles polling, injection, and ordering.
const MessageButtonBar = {
	ASSISTANT_BUTTON_PRIORITY: [
		'tts-speak-button',
		'fork-button',
		'bookmark-button',
	],
	USER_BUTTON_PRIORITY: [
		'advanced-edit-button',
	],

	_registrations: new Map(),
	_pollInterval: null,

	register({ buttonClass, target, createFn, pages, shouldInject = null, insertFn = null }) {
		if (this._registrations.has(buttonClass)) return;
		this._registrations.set(buttonClass, { buttonClass, target, createFn, pages, shouldInject, insertFn });
		if (!this._pollInterval) {
			this._pollInterval = setInterval(() => this._tick(), 1000);
			this._tick();
		}
	},

	async _tick() {
		// Detect current page group (reuse ButtonBar's detection or detect independently)
		let group = ButtonBar.getCurrentGroup();
		if (!group) {
			// ButtonBar may not have ticked yet — detect independently
			for (const layout of Object.values(pageLayouts)) {
				if (layout.match()) { group = layout.group; break; }
			}
		}
		if (!group) return;

		const { assistantMessages, userMessages } = getUIMessages();

		for (const [buttonClass, reg] of this._registrations) {
			if (!reg.pages.includes(group)) continue;

			if (reg.shouldInject) {
				const allowed = await reg.shouldInject();
				if (!allowed) continue;
			}

			const messages = reg.target === 'assistant' ? assistantMessages : userMessages;
			const priorityArray = reg.target === 'assistant'
				? this.ASSISTANT_BUTTON_PRIORITY
				: this.USER_BUTTON_PRIORITY;

			for (const message of messages) {
				const container = findMessageControls(message);
				if (!container) continue;
				if (container.querySelector('.' + buttonClass)) continue;

				const button = reg.createFn();
				button.classList.add(buttonClass);

				if (reg.insertFn) {
					reg.insertFn(button, container);
				} else {
					this._defaultInsert(button, buttonClass, container, priorityArray);
				}
			}
		}
	},

	_defaultInsert(button, buttonClass, container, priorityArray) {
		let insertBefore = null;

		const currentPriority = priorityArray.indexOf(buttonClass);
		for (let i = currentPriority + 1; i < priorityArray.length; i++) {
			const lowerPriorityButton = container.querySelector('.' + priorityArray[i]);
			if (lowerPriorityButton) {
				insertBefore = lowerPriorityButton;
				break;
			}
		}

		// Fallback: insert before the copy button group
		if (!insertBefore) {
			const copyButtonParent = container.querySelector('[data-testid="action-bar-copy"]')?.parentElement;
			if (copyButtonParent) {
				insertBefore = copyButtonParent;
			}
		}

		while (insertBefore && insertBefore.parentElement !== container) {
			insertBefore = insertBefore.parentElement;
		}

		if (insertBefore) {
			container.insertBefore(button, insertBefore);
		} else {
			container.appendChild(button);
		}
	},
};


// Simple alert overwrite for ISOLATED context
if (typeof window !== 'undefined') {
	// Store original in case needed
	const nativeAlert = window.alert;

	// Override alert with Claude-styled version
	window.alert = function (message) {
		showClaudeAlert('', String(message || ''));
		// Returns immediately (fire-and-forget style)
	};

	// Provide access to original if ever needed
	window.nativeAlert = nativeAlert;
}
