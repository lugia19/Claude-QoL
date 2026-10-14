// org-mirror.js
// Copies of settings for the MAIN world. Settings live in ISOLATED (settings.js) and load at
// document_idle, but MAIN acts on the first snapshot or request, so the ISOLATED side keeps copies in
// claude.ai's localStorage (same origin, readable synchronously). Settings are per org, and one
// localStorage can serve several (switching orgs in one profile; containers get their own), so each
// copy is stored per org: localStorage[claude_qol_mirror:<orgId>:<name>] = JSON.
// Loaded in both worlds right after page.js (getActiveOrgId), before anything that reads a copy.

function _qolMirrorKey(name) {
	const orgId = getActiveOrgId();
	return orgId && `claude_qol_mirror:${orgId}:${name}`;
}

// The current org's copy of `name`, or undefined (none yet, logged out, storage unavailable).
function readOrgMirror(name) {
	try {
		const key = _qolMirrorKey(name);
		const raw = key && localStorage.getItem(key);
		return raw ? JSON.parse(raw) : undefined;
	} catch (e) {
		return undefined;
	}
}

// Set (or, with undefined, remove) the current org's copy of `name`.
function writeOrgMirror(name, value) {
	try {
		const key = _qolMirrorKey(name);
		if (!key) return;
		if (value === undefined) localStorage.removeItem(key);
		else localStorage.setItem(key, JSON.stringify(value));
	} catch (e) { /* storage unavailable: MAIN falls back to its defaults */ }
}

// One-time move of the copies older versions kept for every org at once (claude_qol_<name>) to the
// current org, so the first load after updating still sees them; the ISOLATED side rewrites them
// anyway once its settings load.
(function () {
	const legacy = {
		full_load: (raw) => raw !== '0',
		image_gallery: JSON.parse,
		code_prompt: JSON.parse,
		phantom_ids: JSON.parse,
	};
	if (!getActiveOrgId()) return; // logged out: keep them for when there's an org
	try {
		for (const [name, parse] of Object.entries(legacy)) {
			const raw = localStorage.getItem(`claude_qol_${name}`);
			if (raw === null) continue;
			if (readOrgMirror(name) === undefined) writeOrgMirror(name, parse(raw));
			localStorage.removeItem(`claude_qol_${name}`);
		}
	} catch (e) { /* storage unavailable, or a damaged copy: the ISOLATED side rewrites them */ }
})();
