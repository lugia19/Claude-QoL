// i18n.js
// UI localization. Polyglot: loaded in both ISOLATED and MAIN worlds, after the string tables in
// content/i18n/<lang>.js (each registers itself on globalThis.QOL_I18N).
//
// The language is resolved synchronously from localStorage (page origin, so both worlds see it):
//   1. claude_qol_language      - user override, mirrored from settings by content/isolated/language.js
//   2. claude_qol_locale_cache  - the claude.ai account locale, cached by fetchAndCacheLocale() (claude-api.js)
//   3. navigator.language
// A language change always reloads the page; nothing re-renders live.

const I18N_LOCALES = ['en', 'fr', 'de', 'hi', 'id', 'it', 'ja', 'ko', 'pt-BR', 'es'];

// Deliberately untranslated: each language is shown in its own script.
const LANGUAGE_NATIVE_NAMES = {
	'en': 'English',
	'fr': 'Français',
	'de': 'Deutsch',
	'hi': 'हिन्दी',
	'id': 'Bahasa Indonesia',
	'it': 'Italiano',
	'ja': '日本語',
	'ko': '한국어',
	'pt-BR': 'Português (Brasil)',
	'es': 'Español',
};

const I18N_OVERRIDE_KEY = 'claude_qol_language';

function normalizeLocale(raw) {
	if (!raw || typeof raw !== 'string') return 'en';
	const lower = raw.toLowerCase();
	const exact = I18N_LOCALES.find(l => l.toLowerCase() === lower);
	if (exact) return exact;
	const base = lower.split('-')[0];
	if (base === 'pt') return 'pt-BR';
	return I18N_LOCALES.find(l => l === base) || 'en';
}

function _resolveLocale() {
	try {
		const override = localStorage.getItem(I18N_OVERRIDE_KEY);
		if (override) return normalizeLocale(override);
		const cached = localStorage.getItem('claude_qol_locale_cache');
		if (cached) return normalizeLocale(JSON.parse(cached).locale);
	} catch (e) { /* storage blocked or bad JSON - fall through */ }
	return normalizeLocale(navigator.language);
}

const _i18nLocale = _resolveLocale();

function currentLocale() {
	return _i18nLocale;
}

/**
 * Look up a UI string. Falls back to English, then to the key itself.
 * @param {string} key - Dotted key, e.g. 'common.cancel'
 * @param {Object} [vars] - Values for {name} placeholders
 */
function localize(key, vars) {
	const tables = globalThis.QOL_I18N || {};
	let str = tables[_i18nLocale]?.[key] ?? tables.en?.[key] ?? key;
	if (vars) {
		str = str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''));
	}
	return str;
}

function fmtNum(n) {
	return Number(n).toLocaleString(_i18nLocale);
}
