// settings.js
// Centralized settings management for Claude Toolbox.
// Polyglot: loaded in both ISOLATED and MAIN worlds.
// ISOLATED world: IndexedDB (+ chrome.storage.local for secrets) + postMessage bridge for MAIN.
// MAIN world: uses _bridgeRequest() from claude-api.js for get/set.
//
// STORAGE BACKENDS
// Settings live in claude.ai-origin IndexedDB by default. IndexedDB opened from an ISOLATED-world
// content script belongs to the *page* origin, not the extension, so it survives an extension
// uninstall/reinstall — unlike chrome.storage.local, which the browser wipes. The trade-off is that
// clearing claude.ai site data now clears settings too.
//
// Keys flagged `local: true` stay in chrome.storage.local. That flag is for secrets and for
// extension lifecycle state. Page JS can read *and write* origin IndexedDB, and a script that can
// rewrite e.g. openai_tts_base_url redirects the next TTS call — taking the API key with it. So
// anything that *directs where a secret is sent* is treated as a secret too.
//
// Settings are stored plaintext. The encryption helpers in databases.js are deliberately not reused:
// _initEncryptionKey() wipes all encrypted data when the key skill is missing, so binding settings
// to that key would mean deleting one skill nukes every setting.

// ======== SETTINGS KEY DEFINITIONS ========
// Central manifest of all settings keys, grouped by feature.
// Each entry: { key: 'storage_key', default: defaultValue, type: 'boolean'|'string'|'object' }
// Optional `local: true` — keep in chrome.storage.local instead of IndexedDB (see above).

const SETTINGS_KEYS = {
	TTS: {
		ENABLED: { key: 'tts_enabled', default: false, type: 'boolean', local: true }, // legacy; migrated to PROVIDER='claude'
		PROVIDER: { key: 'tts_provider', default: 'claude', type: 'string' }, // 'claude' = native passthrough (no hijack)
		API_KEY: { key: 'tts_apiKey', default: '', type: 'string', local: true }, // secret
		VOICE: { key: 'tts_voice', default: '', type: 'string' },
		MODEL: { key: 'tts_model', default: 'eleven_flash_v2_5', type: 'string' },
		AUTO_SPEAK: { key: 'tts_autoSpeak', default: false, type: 'boolean' },
		BASE_URL: { key: 'openai_tts_base_url', default: '', type: 'string', local: true }, // directs where API_KEY is sent
	},
	// Per-chat settings: each stores { conversationId: value, ... }
	TTS_PERCHAT: {
		VOICE: { key: 'tts_chatVoice', default: {}, type: 'object', oldKeyPrefix: 'chatVoice_' },
		ACTOR_MODE: { key: 'tts_chatActorMode', default: {}, type: 'object', oldKeyPrefix: 'chatActorMode_' },
		CHARACTERS: { key: 'tts_chatCharacters', default: {}, type: 'object', oldKeyPrefix: 'chatCharacters_' },
		QUOTES_ONLY: { key: 'tts_chatQuotesOnly', default: {}, type: 'object', oldKeyPrefix: 'chatQuotesOnly_' },
	},
	NAVIGATION: {
		BOOKMARKS: { key: 'navigation_bookmarks', default: {}, type: 'object' },
	},
	IMAGE_EXTRACTOR: {
		AUTO_EXPAND: { key: 'image_auto_expand', default: false, type: 'boolean' },
	},
	// Extension lifecycle state, not user data — must not survive a reinstall, or the
	// first-install branch of checkForVersionUpdate() is skipped and a spurious update card shows.
	NOTIFICATIONS: {
		PREVIOUS_VERSION: { key: 'qolPreviousVersion', default: null, type: 'string', local: true },
		RATE_REMINDER_TIME: { key: 'qolRateReminderTime', default: null, type: 'number', local: true },
		RATE_REMINDER_SHOWN: { key: 'qolRateReminderShown', default: false, type: 'boolean', local: true },
	},
	PREF_SWITCHER: {
		PRESETS: { key: 'preference_presets', default: {}, type: 'object' },
	},
	BANNER_WATCHER: {
		// Cache of org flags, refetched from /api/organizations on every poll — nothing to preserve.
		STORED_FLAGS: { key: 'banner_stored_flags', default: {}, type: 'object', local: true },
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

function _resolveDef(keyOrDef) {
	return typeof keyOrDef === 'string' ? _settingsDefinitions[keyOrDef] : keyOrDef;
}

// Deep copy via JSON — every stored setting is JSON-safe by construction (it has to survive the
// structured clone into IndexedDB). JSON specifically, because the built-in belongs to *our*
// compartment, so the copy is always an extension-side object whichever side the input came from.
// That matters on Firefox: IndexedDB opened from a content script belongs to the page, so rows read
// back are Xray-wrapped page objects, and assigning an extension-side object into one throws
// "Not allowed to define cross-origin object as property on [Object] or [Array] XrayWrapper".
// That is exactly what savePreset (presets[id] = {...}) and saveBookmarks do.
function _deepCopy(value) {
	if (value === null || typeof value !== 'object') return value;
	return JSON.parse(JSON.stringify(value));
}

function _resolveDefault(keyOrDef) {
	const def = _resolveDef(keyOrDef);
	if (!def) return undefined;
	// Clone object defaults — callers mutate what get() hands back (e.g. banner-watcher deletes
	// expired flags), and handing out the definition's literal would poison it for the session.
	return _deepCopy(def.default);
}

// Which backend a key uses. Unknown keys (the MAIN-world bridge accepts raw strings) default to
// IndexedDB, matching the default for declared keys.
function _isLocalKey(keyOrDef) {
	const def = _resolveDef(keyOrDef);
	return !!(def && def.local);
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

	// claude.ai-origin IndexedDB — survives extension uninstall. Dexie is loaded ahead of this file
	// in every manifest.
	const _settingsDB = new Dexie('ClaudeToolboxSettingsDB');
	_settingsDB.version(1).stores({ settings: 'key' }); // rows: { key, value }

	// Origin storage is best-effort and evictable under disk pressure; ask to be exempted.
	// Chrome grants this heuristically for frequently-visited sites.
	if (navigator.storage?.persist) {
		navigator.storage.persisted()
			.then(granted => granted || navigator.storage.persist())
			.catch(() => { });
	}

	// ======== One-time migration off chrome.storage.local ========
	const MIGRATION_MARKER = 'qol_settings_idb_migrated';

	async function _migrateFromChromeStorage() {
		try {
			const all = await chrome.storage.local.get(null);
			if (all[MIGRATION_MARKER]) return;

			const pending = {};   // storage key -> value destined for IndexedDB
			const toRemove = [];

			// Pass 1: declared non-local keys.
			for (const def of Object.values(_settingsDefinitions)) {
				if (def.local) continue;
				if (all[def.key] === undefined) continue;
				pending[def.key] = all[def.key];
				toRemove.push(def.key);
			}

			// Pass 2: legacy per-chat keys (chatVoice_<id>) fold into their object-valued key.
			// Runs after pass 1 so the merged object isn't overwritten by the raw stored one.
			// Doing this here retires the lazy per-read migration getPerChat used to carry.
			for (const def of Object.values(_settingsDefinitions)) {
				if (def.local || !def.oldKeyPrefix) continue;
				for (const [storageKey, value] of Object.entries(all)) {
					if (!storageKey.startsWith(def.oldKeyPrefix)) continue;
					const conversationId = storageKey.slice(def.oldKeyPrefix.length);
					const obj = pending[def.key] || (pending[def.key] = {});
					if (obj[conversationId] === undefined) obj[conversationId] = value;
					toRemove.push(storageKey);
				}
			}

			// Never overwrite what IndexedDB already holds. Guards a reinstall or downgrade from
			// letting a stale chrome.storage value clobber good data.
			let migrated = 0;
			for (const [key, value] of Object.entries(pending)) {
				if (await _settingsDB.settings.get(key) !== undefined) continue;
				await _settingsDB.settings.put({ key, value });
				migrated++;
			}

			// Remove only after the writes land — a crash midway just leaves work for the next run.
			if (toRemove.length) await chrome.storage.local.remove(toRemove);
			await chrome.storage.local.set({ [MIGRATION_MARKER]: true });
			if (migrated) console.log(`[QOL-Settings] Migrated ${migrated} setting(s) to IndexedDB`);
		} catch (e) {
			// Leave the marker unset so the next page load retries.
			console.warn('[QOL-Settings] Migration to IndexedDB failed:', e.message);
		}
	}

	// Every read and write awaits this, so no consumer can observe a half-migrated store.
	const _ready = _migrateFromChromeStorage();

	settingsRegistry.get = async function (keyOrDef) {
		await _ready;
		const key = _resolveKey(keyOrDef);
		if (_isLocalKey(keyOrDef)) {
			const result = await chrome.storage.local.get(key);
			if (result[key] !== undefined) return result[key];
		} else {
			const row = await _settingsDB.settings.get(key);
			// Copy: the row belongs to the page's compartment, and callers mutate what they get back.
			if (row && row.value !== undefined) return _deepCopy(row.value);
		}
		return _resolveDefault(keyOrDef);
	};

	settingsRegistry.set = async function (keyOrDef, value) {
		await _ready;
		const key = _resolveKey(keyOrDef);
		if (_isLocalKey(keyOrDef)) {
			await chrome.storage.local.set({ [key]: value });  // chrome.storage.onChanged notifies
		} else {
			await _settingsDB.settings.put({ key, value });
			_notifyChange(key, value);
		}
	};

	// ======== Change listeners ========
	// Two backends, one listener map. chrome.storage.onChanged covers the local-flagged keys and
	// fires cross-tab for free; IndexedDB has no such event, so writes are announced manually.
	const _changeListeners = {}; // key -> Set<callback>

	function _fireListeners(key, newValue, oldValue) {
		const listeners = _changeListeners[key];
		if (!listeners) return;
		for (const cb of listeners) cb(newValue, oldValue);
	}

	const _changeChannel = new BroadcastChannel('qol-settings-changed');
	_changeChannel.addEventListener('message', (event) => {
		const { key, value } = event.data || {};
		if (key) _fireListeners(key, value, undefined);
	});

	function _notifyChange(key, value) {
		_fireListeners(key, value, undefined); // BroadcastChannel doesn't echo to the sender
		_changeChannel.postMessage({ key, value });
	}

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== 'local') return;
		for (const [key, { oldValue, newValue }] of Object.entries(changes)) {
			_fireListeners(key, newValue, oldValue);
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
	// Thin wrappers over get/set — those handle the ready gate, backend routing and defaults.

	settingsRegistry.getPerChat = async function (def, conversationId) {
		const obj = await settingsRegistry.get(def) || {};
		return obj[conversationId] !== undefined ? obj[conversationId] : null;
	};

	settingsRegistry.setPerChat = async function (def, conversationId, value) {
		const obj = await settingsRegistry.get(def) || {};
		obj[conversationId] = value;
		await settingsRegistry.set(def, obj);
	};

	settingsRegistry.removePerChat = async function (def, conversationId) {
		const obj = await settingsRegistry.get(def) || {};
		delete obj[conversationId];
		await settingsRegistry.set(def, obj);
	};

	// ======== PostMessage bridge for MAIN world access ========
	window.addEventListener('message', async (event) => {
		if (event.source !== window) return;

		try {
			switch (event.data.type) {
				case 'SETTINGS_GET': {
					const value = await settingsRegistry.get(event.data.key);
					window.postMessage({
						type: 'SETTINGS_GET_RESULT',
						messageId: event.data.messageId,
						value: value
					}, '*');
					break;
				}
				case 'SETTINGS_SET': {
					await settingsRegistry.set(event.data.key, event.data.value);
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
		console.warn('[QOL-Settings] onChange is not available in MAIN world');
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
