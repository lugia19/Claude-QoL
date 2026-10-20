// settings.js
// Centralized settings management for Claude Toolbox.
// ISOLATED world only. MAIN has no access on purpose: anything served to MAIN is reachable by page
// scripts too, and the settings include secrets (the old MAIN bridge would hand out tts_apiKey).
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
// ACCOUNT SCOPING
// Every setting belongs to the claude.ai org the page is acting as (getActiveOrgId(), the
// lastActiveOrg cookie), so several accounts in one browser - Firefox containers, or switching orgs
// in one profile - each keep their own. Stored under `<orgId>:<key>` in either backend. An org with
// no value of its own inherits the unscoped one older versions wrote, so existing setups carry over to
// every account. Keys flagged `global: true` describe the extension install, not an account, and stay
// unscoped.
//
// Settings are stored plaintext. The encryption helpers in databases.js are deliberately not reused:
// an org whose key skill is missing gets its encrypted data wiped, so binding settings to that key
// would mean deleting one skill nukes that account's settings.

// ======== SETTINGS KEY DEFINITIONS ========
// Central manifest of all settings keys, grouped by feature.
// Each entry: { key: 'storage_key', default: defaultValue, type: 'boolean'|'string'|'object' }
// Optional `local: true` — keep in chrome.storage.local instead of IndexedDB (see above).
// Optional `global: true` — see ACCOUNT SCOPING above.

const settingsLog = createLogger('Settings');

const SETTINGS_KEYS = {
	TTS: {
		PROVIDER: { key: 'tts_provider', default: 'claude', type: 'string' }, // 'claude' = native passthrough (no hijack)
		API_KEY: { key: 'tts_apiKey', default: '', type: 'string', local: true }, // secret
		VOICE: { key: 'tts_voice', default: '', type: 'string' },
		MODEL: { key: 'tts_model', default: 'eleven_flash_v2_5', type: 'string' },
		AUTO_SPEAK: { key: 'tts_autoSpeak', default: false, type: 'boolean' },
		BASE_URL: { key: 'openai_tts_base_url', default: '', type: 'string', local: true }, // directs where API_KEY is sent
	},
	// Per-chat settings: each stores { conversationId: value, ... }
	TTS_PERCHAT: {
		VOICE: { key: 'tts_chatVoice', default: {}, type: 'object' },
		ACTOR_MODE: { key: 'tts_chatActorMode', default: {}, type: 'object' },
		CHARACTERS: { key: 'tts_chatCharacters', default: {}, type: 'object' },
		QUOTES_ONLY: { key: 'tts_chatQuotesOnly', default: {}, type: 'object' },
	},
	NAVIGATION: {
		BOOKMARKS: { key: 'navigation_bookmarks', default: {}, type: 'object' },
	},
	// Mirrored to localStorage[claude_qol_full_load] by extension-settings.js for content/main/full-load.js.
	FULL_LOAD: {
		ENABLED: { key: 'full_load_enabled', default: true, type: 'boolean' },
	},
	// Mirrored to localStorage (org-mirror.js, 'project_prefix') by extension-settings.js for content/main/project-prefix.js.
	PROJECT_PREFIX: {
		ENABLED: { key: 'project_prefix_enabled', default: false, type: 'boolean' },
	},
	IMAGE_EXTRACTOR: {
		ENABLED: { key: 'image_gallery_enabled', default: true, type: 'boolean' },
		LIMIT_ENABLED: { key: 'image_gallery_limit_enabled', default: false, type: 'boolean' },
		LIMIT: { key: 'image_gallery_limit', default: 3, type: 'number' },
	},
	// Mirrored to localStorage[claude_qol_code_prompt] by pref-switcher.js for content/main/code-session-prompt.js.
	CODE_PROMPT: {
		PRESETS: { key: 'code_system_prompt_presets', default: {}, type: 'object' }, // own list, same shape as PREF_SWITCHER.PRESETS
		TEXT: { key: 'code_system_prompt', default: '', type: 'string' }, // the active prompt
		MODE: { key: 'code_system_prompt_mode', default: 'replace', type: 'string' }, // 'replace' | 'append'
	},
	// Extension lifecycle state, not user data — must not survive a reinstall, or the
	// first-install branch of checkForVersionUpdate() is skipped and a spurious update card shows.
	NOTIFICATIONS: {
		PREVIOUS_VERSION: { key: 'qolPreviousVersion', default: null, type: 'string', local: true, global: true },
		RATE_REMINDER_TIME: { key: 'qolRateReminderTime', default: null, type: 'number', local: true, global: true },
		RATE_REMINDER_SHOWN: { key: 'qolRateReminderShown', default: false, type: 'boolean', local: true, global: true },
	},
	EXPORT: {
		LAST_FORMAT: { key: 'export_last_format', default: null, type: 'string' }, // the format select's last choice; null: none yet (exporter.js falls back)
	},
	PREF_SWITCHER: {
		PRESETS: { key: 'preference_presets', default: {}, type: 'object' },
	},
	BANNER_WATCHER: {
		// Cache of org flags, refetched from /api/organizations on every poll — nothing to preserve.
		// (Was 'banner_stored_flags', shared by every account: renamed so no account inherits it.)
		STORED_FLAGS: { key: 'banner_flags', default: {}, type: 'object', local: true },
	},
};

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

// Which backend a key uses. Unknown keys (raw strings with no definition) default to
// IndexedDB, matching the default for declared keys.
function _isLocalKey(keyOrDef) {
	const def = _resolveDef(keyOrDef);
	return !!(def && def.local);
}

function _isGlobalKey(keyOrDef) {
	const def = _resolveDef(keyOrDef);
	return !!(def && def.global);
}

// Where a key is stored: the bare key for global ones, else `<orgId>:<key>` for the current org, or
// null when there's no org (logged out).
function _storedKey(keyOrDef) {
	const key = _resolveKey(keyOrDef);
	if (_isGlobalKey(keyOrDef)) return key;
	const orgId = getActiveOrgId();
	return orgId ? `${orgId}:${key}` : null;
}

// The other way round, for change events: { orgId, key }, orgId null for an unscoped key.
function _unscopeKey(storedKey) {
	const i = storedKey.indexOf(':');
	return i < 0 ? { orgId: null, key: storedKey } : { orgId: storedKey.slice(0, i), key: storedKey.slice(i + 1) };
}

const settingsRegistry = {
	/**
	 * Get a single setting value with automatic default.
	 * @param {string|Object} keyOrDef - Storage key string or SETTINGS_KEYS definition
	 * @returns {Promise<*>}
	 */
	get: null, // set below

	/**
	 * Set a single setting value.
	 * @param {string|Object} keyOrDef
	 * @param {*} value
	 * @returns {Promise<void>}
	 */
	set: null, // set below

	/**
	 * Subscribe to changes for a specific key.
	 * @param {string|Object} keyOrDef
	 * @param {Function} callback - (newValue, oldValue) => void
	 * @returns {Function} Unsubscribe function
	 */
	onChange: null, // set below

	/**
	 * Get the default value for a key.
	 * @param {string|Object} keyOrDef
	 * @returns {*}
	 */
	getDefault(keyOrDef) {
		return _resolveDefault(keyOrDef);
	},
};

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

// Reads several stored keys of one setting in a single call: their values in order, undefined for unset.
async function _readRaw(keyOrDef, storedKeys) {
	if (_isLocalKey(keyOrDef)) {
		const result = await chrome.storage.local.get(storedKeys);
		return storedKeys.map(k => result[k]);
	}
	// Copy: rows belong to the page's compartment, and callers mutate what they get back.
	return (await _settingsDB.settings.bulkGet(storedKeys)).map(row => row ? _deepCopy(row.value) : undefined);
}

settingsRegistry.get = async function (keyOrDef) {
	const storedKey = _storedKey(keyOrDef);
	if (!storedKey) return _resolveDefault(keyOrDef); // logged out: no account to read for
	const key = _resolveKey(keyOrDef);
	// Not set for this account yet: inherit what the unscoped (pre-scoping) setting held.
	const [own, inherited] = await _readRaw(keyOrDef, storedKey === key ? [key] : [storedKey, key]);
	const value = own !== undefined ? own : inherited;
	return value !== undefined ? value : _resolveDefault(keyOrDef);
};

settingsRegistry.set = async function (keyOrDef, value) {
	const storedKey = _storedKey(keyOrDef);
	if (!storedKey) {
		settingsLog.warn(`Not saving ${_resolveKey(keyOrDef)}: no active org (logged out?)`);
		return;
	}
	if (_isLocalKey(keyOrDef)) {
		await chrome.storage.local.set({ [storedKey]: value });  // chrome.storage.onChanged notifies
	} else {
		await _settingsDB.settings.put({ key: storedKey, value });
		_notifyChange(storedKey, value);
	}
};

// ======== Change listeners ========
// Two backends, one listener map. chrome.storage.onChanged covers the local-flagged keys and
// fires cross-tab for free; IndexedDB has no such event, so writes are announced manually.
const _changeListeners = {}; // key -> Set<callback>

// Fires for the current org's keys and global ones only: another org's change doesn't concern this
// page, and nothing writes unscoped keys any more.
function _fireListeners(storedKey, newValue, oldValue) {
	const { orgId, key } = _unscopeKey(storedKey);
	if (orgId ? orgId !== getActiveOrgId() : !_isGlobalKey(key)) return;
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

// ======== Per-chat helpers ========
// Thin wrappers over get/set — those handle backend routing and defaults.

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

// ======== SETTINGS FIELD ========
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
