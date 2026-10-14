// org-mirror.js
// Copies of settings for the MAIN world. Settings live in ISOLATED (settings.js) and load at
// document_idle, but MAIN acts on the first snapshot or request, so the ISOLATED side keeps copies in
// claude.ai's localStorage (same origin, readable synchronously). Settings are per org, and one
// localStorage can serve several (switching orgs in one profile; containers get their own), so each
// copy is stored per org: localStorage[claude_qol_mirror:<orgId>:<name>] = JSON.
// Loaded in both worlds right after page.js (getActiveOrgId), before anything that reads a copy.

// Older versions kept one copy for every org (claude_qol_<name>). An org without a copy of its own
// yet (its first load after updating, before the ISOLATED side writes one) reads that instead. They're
// never removed: there's no telling when every org sharing this storage has its own.
const _QOL_LEGACY_MIRRORS = {
	full_load: (raw) => raw !== '0',
	image_gallery: JSON.parse,
	code_prompt: JSON.parse,
	phantom_ids: JSON.parse,
};

function _qolMirrorKey(name) {
	const orgId = getActiveOrgId();
	return orgId && `claude_qol_mirror:${orgId}:${name}`;
}

// The current org's copy of `name` (null: the org has none), or undefined (logged out, storage
// unavailable, or no copy at all).
function readOrgMirror(name) {
	try {
		const key = _qolMirrorKey(name);
		if (!key) return undefined;
		const raw = localStorage.getItem(key);
		if (raw !== null) return JSON.parse(raw);
		const legacy = localStorage.getItem(`claude_qol_${name}`);
		return legacy !== null && _QOL_LEGACY_MIRRORS[name] ? _QOL_LEGACY_MIRRORS[name](legacy) : undefined;
	} catch (e) {
		return undefined;
	}
}

// Set the current org's copy of `name`. undefined stores null, "none for this org", so the legacy
// copy above no longer applies to it.
function writeOrgMirror(name, value) {
	try {
		const key = _qolMirrorKey(name);
		if (key) localStorage.setItem(key, JSON.stringify(value ?? null));
	} catch (e) { /* storage unavailable: MAIN falls back to its defaults */ }
}
