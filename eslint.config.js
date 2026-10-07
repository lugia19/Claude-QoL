// ESLint: the shared config (common/eslint.base.cjs). Cross-file globals are derived from the
// manifests' content-script groups and the background's importScripts, so no /* global */ lists.
const { baseConfig, manifestGroups } = require('./common/eslint.base.cjs');

module.exports = baseConfig({
	root: __dirname,
	groups: [
		...['manifest_chrome.json', 'manifest_firefox.json', 'manifest_electron.json'].flatMap(m => manifestGroups(__dirname, m)),
		// The service worker importScripts the logger (Firefox lists it in the manifest instead).
		{ name: 'background', files: ['common/log/logger.js', 'background.js'] },
	],
	libGlobals: {
		'lib/dexie.min.js': ['Dexie'],
		'lib/jszip.min.js': ['JSZip'],
		'lib/mime.min.js': ['mime'],
		'lib/marked.min.js': ['marked'],
		'lib/highlight.min.js': ['hljs'],
	},
	serviceWorker: ['background.js'],
	ignores: ['lib/**', 'userscripts/**', 'html_template/**'],
});
