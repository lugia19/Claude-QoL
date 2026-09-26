// background.js
// Also the only writer of the debug log (common/log/logger.js): content scripts send it their entries.
if (typeof importScripts === 'function') importScripts('common/log/logger.js'); // Firefox lists it in the manifest
configureLogger({ app: 'qol', prefix: '[QoL]', role: 'background' });

if (chrome.action) {
	chrome.action.onClicked.addListener((tab) => {
		chrome.tabs.create({ url: 'https://ko-fi.com/lugia19' });
	});
}
