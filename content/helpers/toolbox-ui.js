// toolbox-ui.js
// Toolbox-only UI glue that used to live in claude-styles.js. No IIFE - shared global context.

// Add marker for usage tracker to know if it's installed:
document.documentElement.setAttribute('data-claude-qol-installed', 'true');

// Warn on any mismatch between the source conversation's feature settings and
// the current account settings. Informational only — never switches anything.
// Returns the current feature settings (fed to prepareNew for addFile routing).
async function warnAboutSettingsMismatch(sourceSettings) {
	const account = await getAccountSettings();
	const current = account.settings || account;

	const sourceArtifacts = sourceSettings?.preview_feature_uses_artifacts === true;
	const sourceCE = sourceSettings?.enabled_monkeys_in_a_barrel === true;
	const currentArtifacts = current.preview_feature_uses_artifacts === true;
	const currentCE = current.enabled_monkeys_in_a_barrel === true;

	const currentSettings = {
		preview_feature_uses_artifacts: currentArtifacts,
		enabled_monkeys_in_a_barrel: currentCE,
	};

	const mismatches = [];
	if (sourceArtifacts !== currentArtifacts) {
		mismatches.push(localize('ui.settings_mismatch_artifacts', { was: localize(sourceArtifacts ? 'ui.on' : 'ui.off'), now: localize(currentArtifacts ? 'ui.on' : 'ui.off') }));
	}
	if (sourceCE !== currentCE) {
		mismatches.push(localize('ui.settings_mismatch_code_execution', { was: localize(sourceCE ? 'ui.on' : 'ui.off'), now: localize(currentCE ? 'ui.on' : 'ui.off') }));
	}

	if (mismatches.length === 0) return currentSettings;

	const proceed = await showClaudeConfirm(
		localize('ui.settings_mismatch_title'),
		localize('ui.settings_mismatch_body', { mismatches: mismatches.join('\n') })
	);
	if (!proceed) throw new Error('USER_CANCELLED');

	return currentSettings;
}

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
