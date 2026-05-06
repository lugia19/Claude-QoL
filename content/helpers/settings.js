// settings.js
// Centralized settings management for Claude Toolbox.
// Polyglot: loaded in both ISOLATED and MAIN worlds.
// ISOLATED world: direct chrome.storage.local access + postMessage bridge for MAIN.
// MAIN world: uses _bridgeRequest() from claude-api.js for get/set.

// ======== SETTINGS KEY DEFINITIONS ========
// Central manifest of all settings keys, grouped by feature.
// Each entry: { key: 'storage_key', default: defaultValue, type: 'boolean'|'string'|'object' }

const SETTINGS_KEYS = {
	STT: {
		ENABLED: { key: 'stt_enabled', default: false, type: 'boolean' },
		PROVIDER: { key: 'stt_provider', default: 'groq', type: 'string' },
		API_KEY: { key: 'stt_api_key', default: '', type: 'string' },
		AUTO_SEND: { key: 'stt_auto_send', default: false, type: 'boolean' },
		AUDIO_DEVICE: { key: 'stt_audio_device', default: 'default', type: 'string' },
		BASE_URL: { key: 'openai_stt_base_url', default: '', type: 'string' },
	},
	TTS: {
		ENABLED: { key: 'tts_enabled', default: false, type: 'boolean' },
		PROVIDER: { key: 'tts_provider', default: 'elevenlabs', type: 'string' },
		API_KEY: { key: 'tts_apiKey', default: '', type: 'string' },
		VOICE: { key: 'tts_voice', default: '', type: 'string' },
		MODEL: { key: 'tts_model', default: 'eleven_flash_v2_5', type: 'string' },
		AUTO_SPEAK: { key: 'tts_autoSpeak', default: false, type: 'boolean' },
		BASE_URL: { key: 'openai_tts_base_url', default: '', type: 'string' },
	},
	// Per-chat settings: each stores { conversationId: value, ... }
	TTS_PERCHAT: {
		VOICE: { key: 'tts_chatVoice', default: {}, type: 'object', oldKeyPrefix: 'chatVoice_' },
		ACTOR_MODE: { key: 'tts_chatActorMode', default: {}, type: 'object', oldKeyPrefix: 'chatActorMode_' },
		CHARACTERS: { key: 'tts_chatCharacters', default: {}, type: 'object', oldKeyPrefix: 'chatCharacters_' },
		QUOTES_ONLY: { key: 'tts_chatQuotesOnly', default: {}, type: 'object', oldKeyPrefix: 'chatQuotesOnly_' },
	},
	PERCHAT_STYLES: {
		STYLES: { key: 'perchat_styles', default: {}, type: 'object', oldKeyPrefix: 'style_' },
	},
	PERPROJECT_STYLES: {
		STYLES: { key: 'perproject_styles', default: {}, type: 'object' },
	},
	NAVIGATION: {
		BOOKMARKS: { key: 'navigation_bookmarks', default: {}, type: 'object' },
	},
	IMAGE_EXTRACTOR: {
		AUTO_EXPAND: { key: 'image_auto_expand', default: false, type: 'boolean' },
	},
	NOTIFICATIONS: {
		PREVIOUS_VERSION: { key: 'qolPreviousVersion', default: null, type: 'string' },
		RATE_REMINDER_TIME: { key: 'qolRateReminderTime', default: null, type: 'number' },
		RATE_REMINDER_SHOWN: { key: 'qolRateReminderShown', default: false, type: 'boolean' },
	},
	PREF_SWITCHER: {
		PRESETS: { key: 'preference_presets', default: {}, type: 'object' },
	},
	TEMPLATES: {
		LIBRARY: { key: 'prompt_templates', default: {}, type: 'object' },
	},
};

// ======== WORLD DETECTION ========
const _isIsolatedWorld = typeof chrome !== 'undefined' && !!chrome.storage?.local;

// ======== SETTINGS REGISTRY ========
// Build internal lookup: storage key string -> definition object
const _settingsDefinitions = {};
for (const group of Object.values(SETTINGS_KEYS)) {
	for (const def of Object.values(group)) {
		_settingsDefinitions[def.key] = def;
	}
}

function _resolveKey(keyOrDef) {
	return typeof keyOrDef === 'string' ? keyOrDef : keyOrDef.key;
}

function _resolveDefault(keyOrDef) {
	if (typeof keyOrDef !== 'string') return keyOrDef.default;
	const def = _settingsDefinitions[keyOrDef];
	return def ? def.default : undefined;
}

const settingsRegistry = {
	/**
	 * Get a single setting value with automatic default.
	 * @param {string|Object} keyOrDef - Storage key string or SETTINGS_KEYS definition
	 * @returns {Promise<*>}
	 */
	get: null, // set below based on world

	/**
	 * Set a single setting value.
	 * @param {string|Object} keyOrDef
	 * @param {*} value
	 * @returns {Promise<void>}
	 */
	set: null, // set below based on world

	/**
	 * Subscribe to changes for a specific key. ISOLATED world only.
	 * @param {string|Object} keyOrDef
	 * @param {Function} callback - (newValue, oldValue) => void
	 * @returns {Function} Unsubscribe function
	 */
	onChange: null, // set below based on world

	/**
	 * Get the default value for a key.
	 * @param {string|Object} keyOrDef
	 * @returns {*}
	 */
	getDefault(keyOrDef) {
		return _resolveDefault(keyOrDef);
	},
};

if (_isIsolatedWorld) {
	// ======== ISOLATED WORLD IMPLEMENTATION ========

	settingsRegistry.get = async function (keyOrDef) {
		const key = _resolveKey(keyOrDef);
		const result = await chrome.storage.local.get(key);
		if (result[key] !== undefined) return result[key];
		return _resolveDefault(keyOrDef);
	};

	settingsRegistry.set = async function (keyOrDef, value) {
		const key = _resolveKey(keyOrDef);
		await chrome.storage.local.set({ [key]: value });
	};

	// Change listeners
	const _changeListeners = {}; // key -> Set<callback>

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== 'local') return;
		for (const [key, { oldValue, newValue }] of Object.entries(changes)) {
			const listeners = _changeListeners[key];
			if (listeners) {
				for (const cb of listeners) {
					cb(newValue, oldValue);
				}
			}
		}
	});

	settingsRegistry.onChange = function (keyOrDef, callback) {
		const key = _resolveKey(keyOrDef);
		if (!_changeListeners[key]) {
			_changeListeners[key] = new Set();
		}
		_changeListeners[key].add(callback);
		return () => _changeListeners[key].delete(callback);
	};

	// ======== Per-chat helpers (ISOLATED world) ========

	settingsRegistry.getPerChat = async function (def, conversationId) {
		const key = _resolveKey(def);
		const result = await chrome.storage.local.get(key);
		const obj = result[key] || {};

		if (obj[conversationId] !== undefined) return obj[conversationId];

		// Lazy migration: check old key format
		const oldPrefix = typeof def !== 'string' ? def.oldKeyPrefix : null;
		if (oldPrefix) {
			const oldKey = oldPrefix + conversationId;
			const oldResult = await chrome.storage.local.get(oldKey);
			if (oldResult[oldKey] !== undefined) {
				// Migrate forward: write to new object, delete old key
				obj[conversationId] = oldResult[oldKey];
				await chrome.storage.local.set({ [key]: obj });
				await chrome.storage.local.remove(oldKey);
				return oldResult[oldKey];
			}
		}

		return null;
	};

	settingsRegistry.setPerChat = async function (def, conversationId, value) {
		const key = _resolveKey(def);
		const result = await chrome.storage.local.get(key);
		const obj = result[key] || {};
		obj[conversationId] = value;
		await chrome.storage.local.set({ [key]: obj });
	};

	settingsRegistry.removePerChat = async function (def, conversationId) {
		const key = _resolveKey(def);
		const result = await chrome.storage.local.get(key);
		const obj = result[key] || {};
		delete obj[conversationId];
		await chrome.storage.local.set({ [key]: obj });
	};

	// ======== PostMessage bridge for MAIN world access ========
	window.addEventListener('message', async (event) => {
		if (event.source !== window) return;

		try {
			switch (event.data.type) {
				case 'SETTINGS_GET': {
					const key = event.data.key;
					const result = await chrome.storage.local.get(key);
					const def = _settingsDefinitions[key];
					const value = result[key] !== undefined ? result[key] : (def ? def.default : undefined);
					window.postMessage({
						type: 'SETTINGS_GET_RESULT',
						messageId: event.data.messageId,
						value: value
					}, '*');
					break;
				}
				case 'SETTINGS_SET': {
					await chrome.storage.local.set({ [event.data.key]: event.data.value });
					window.postMessage({
						type: 'SETTINGS_SET_RESULT',
						messageId: event.data.messageId
					}, '*');
					break;
				}
				case 'SETTINGS_GET_PERCHAT': {
					const def = _settingsDefinitions[event.data.key] || { key: event.data.key };
					const value = await settingsRegistry.getPerChat(def, event.data.conversationId);
					window.postMessage({
						type: 'SETTINGS_GET_PERCHAT_RESULT',
						messageId: event.data.messageId,
						value: value
					}, '*');
					break;
				}
				case 'SETTINGS_SET_PERCHAT': {
					const def = _settingsDefinitions[event.data.key] || { key: event.data.key };
					await settingsRegistry.setPerChat(def, event.data.conversationId, event.data.value);
					window.postMessage({
						type: 'SETTINGS_SET_PERCHAT_RESULT',
						messageId: event.data.messageId
					}, '*');
					break;
				}
				case 'SETTINGS_REMOVE_PERCHAT': {
					const def = _settingsDefinitions[event.data.key] || { key: event.data.key };
					await settingsRegistry.removePerChat(def, event.data.conversationId);
					window.postMessage({
						type: 'SETTINGS_REMOVE_PERCHAT_RESULT',
						messageId: event.data.messageId
					}, '*');
					break;
				}
			}
		} catch (error) {
			window.postMessage({
				type: 'BRIDGE_ERROR',
				messageId: event.data.messageId,
				error: error.message
			}, '*');
		}
	});

} else {
	// ======== MAIN WORLD IMPLEMENTATION ========
	// Uses _bridgeRequest() from claude-api.js (loaded before this file)

	settingsRegistry.get = async function (keyOrDef) {
		const key = _resolveKey(keyOrDef);
		const result = await _bridgeRequest('SETTINGS_GET', { key }, 'SETTINGS_GET_RESULT');
		if (result && result.value !== undefined) return result.value;
		return _resolveDefault(keyOrDef);
	};

	settingsRegistry.set = async function (keyOrDef, value) {
		const key = _resolveKey(keyOrDef);
		await _bridgeRequest('SETTINGS_SET', { key, value }, 'SETTINGS_SET_RESULT');
	};

	settingsRegistry.onChange = function () {
		console.warn('[SettingsRegistry] onChange is not available in MAIN world');
		return () => { };
	};

	settingsRegistry.getPerChat = async function (def, conversationId) {
		const key = _resolveKey(def);
		const result = await _bridgeRequest('SETTINGS_GET_PERCHAT', { key, conversationId }, 'SETTINGS_GET_PERCHAT_RESULT');
		return result ? result.value : null;
	};

	settingsRegistry.setPerChat = async function (def, conversationId, value) {
		const key = _resolveKey(def);
		await _bridgeRequest('SETTINGS_SET_PERCHAT', { key, conversationId, value }, 'SETTINGS_SET_PERCHAT_RESULT');
	};

	settingsRegistry.removePerChat = async function (def, conversationId) {
		const key = _resolveKey(def);
		await _bridgeRequest('SETTINGS_REMOVE_PERCHAT', { key, conversationId }, 'SETTINGS_REMOVE_PERCHAT_RESULT');
	};
}

// ======== SETTINGS FIELD (ISOLATED world only) ========
if (_isIsolatedWorld) {

	class SettingsField {
		/**
		 * @param {Object} def - A SETTINGS_KEYS definition object ({ key, default, type })
		 * @param {Object} opts
		 * @param {string} [opts.label] - Label text (omit for toggles which include their own)
		 * @param {HTMLElement|Object} opts.element - A createClaude* result (HTMLElement or toggle object)
		 * @param {string} [opts.hint] - Hint text displayed below the element
		 * @param {Function} [opts.transform] - Transform function applied to getValue (e.g. strip trailing slashes)
		 * @param {Function} [opts.getValue] - Custom getValue override
		 * @param {Function} [opts.setValue] - Custom setValue override
		 */
		constructor(def, opts) {
			this.def = def;
			this._transform = opts.transform || null;

			// Auto-detect element type and wire up getValue/setValue
			const element = opts.element;

			if (opts.getValue && opts.setValue) {
				// Explicit custom getValue/setValue
				this._getValue = opts.getValue;
				this._setValue = opts.setValue;
				this.element = element;
			} else if (element && element.input && element.container) {
				// createClaudeToggle result: { container, input, toggle }
				this._getValue = () => element.input.checked;
				this._setValue = (v) => {
					element.input.checked = v;
					element.input.dispatchEvent(new Event('change'));
				};
				this.element = element.input;
			} else if (element instanceof HTMLInputElement) {
				this._getValue = () => element.value.trim();
				this._setValue = (v) => { element.value = v; };
				this.element = element;
			} else if (element instanceof HTMLSelectElement) {
				this._getValue = () => element.value;
				this._setValue = (v) => { element.value = v; };
				this.element = element;
			} else {
				throw new Error(`SettingsField: cannot auto-detect getValue/setValue for element. Provide explicit getValue/setValue.`);
			}

			// Build container: div.mb-4 with optional label, the display element, and optional hint
			this.container = document.createElement('div');
			this.container.className = 'mb-4';

			if (opts.label) {
				const labelEl = document.createElement('label');
				labelEl.className = CLAUDE_CLASSES.LABEL;
				labelEl.textContent = opts.label;
				this.container.appendChild(labelEl);
			}

			// Append the display element (toggle's .container vs raw element)
			const displayEl = (element && element.container) ? element.container : element;
			this.container.appendChild(displayEl);

			if (opts.hint) {
				const hintEl = document.createElement('p');
				hintEl.className = 'text-text-500 text-xs mt-1';
				hintEl.textContent = opts.hint;
				this.container.appendChild(hintEl);
			}
		}

		/** Read current UI value (no storage). */
		value() {
			let v = this._getValue();
			if (this._transform) v = this._transform(v);
			return v;
		}

		/** Populate the element from storage via registry. */
		async load() {
			const value = await settingsRegistry.get(this.def);
			this._setValue(value);
		}

		/** Write the element's current value to storage. */
		async save() {
			await settingsRegistry.set(this.def, this.value());
		}

	}

	// Expose as global
	window.SettingsField = SettingsField;
}
