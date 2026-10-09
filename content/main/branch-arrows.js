// branch-arrows.js (MAIN world, document_start, right after full-load.js)
// Brings back the "N / M" version arrows on every fork. claude.ai hides them for forks made after the
// account moved to the merged experience: Message.siblings_viewable is only true for older forks, and
// the arrows show only where it is. The data is all there, so marking every message viewable is enough.
// Switching versions stays client-only; continuing an older version is the banner's job
// (navigation.js, "Continue anyway"). See docs/bard-rework.md, "Branches and navigation".
//
// Snapshots, history pages and live updates are all patched: updates are partial upserts, and one
// carrying a message without the flag would hide its arrows again.
(function () {
	'use strict';

	function showAllVersions(update) {
		let changed = false;
		for (const message of update.messages ?? []) {
			if (message.siblings_viewable) continue;
			message.siblings_viewable = true;
			changed = true;
		}
		return changed;
	}

	QolBardHost.onSnapshot(showAllVersions, { label: 'branch-arrows' });
	QolBardHost.onHistoryPage(showAllVersions, { label: 'branch-arrows' });
	QolBardHost.onLiveUpdate(showAllVersions, { label: 'branch-arrows' });
})();
