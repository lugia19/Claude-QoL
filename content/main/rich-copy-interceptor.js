// rich-copy-interceptor.js (MAIN world)
// Intercepts clipboard.write/writeText when rich-copy is active, converts markdown
// to HTML, and writes both text/html and text/plain to the clipboard.

(function () {
	'use strict';

	let richCopyActive = false;

	window.addEventListener('message', (event) => {
		if (event.data.type === 'rich-copy-activate') {
			richCopyActive = true;
			window.postMessage({ type: 'rich-copy-ready' }, '*');
			setTimeout(() => { richCopyActive = false; }, 2000);
		}
	});

	function convertAndWrite(plainText) {
		plainText = plainText.replace(/====PHANTOM_MESSAGE====/g, '');
		plainText = plainText.replace(/====UUID:[a-f0-9-]+====/gi, '');
		plainText = plainText.replace(/====GALLERY_BREAK====/g, '');
		plainText = plainText.replace(/\n{3,}/g, '\n\n').trim();

		const html = marked.parse(plainText, { breaks: true });

		return navigator.clipboard.write.call(navigator.clipboard, [
			new ClipboardItem({
				'text/html': new Blob([html], { type: 'text/html' }),
				'text/plain': new Blob([plainText], { type: 'text/plain' })
			})
		]);
	}

	const prevWrite = navigator.clipboard.write;
	navigator.clipboard.write = async (data) => {
		if (!richCopyActive) {
			return prevWrite.call(navigator.clipboard, data);
		}
		richCopyActive = false;

		try {
			const item = data[0];
			let plainText = '';
			if (item && item.types.includes('text/plain')) {
				const blob = await item.getType('text/plain');
				plainText = await blob.text();
			}

			if (!plainText) {
				window.postMessage({ type: 'rich-copy-error', error: localize('main.rich_copy_no_text') }, '*');
				return prevWrite.call(navigator.clipboard, data);
			}

			await convertAndWrite(plainText);
			window.postMessage({ type: 'rich-copy-done' }, '*');
		} catch (err) {
			console.error('[QOL-RichCopy] Interceptor error:', err);
			window.postMessage({ type: 'rich-copy-error', error: err.message }, '*');
			return prevWrite.call(navigator.clipboard, data);
		}
	};

	const prevWriteText = navigator.clipboard.writeText;
	navigator.clipboard.writeText = async (text) => {
		if (!richCopyActive) {
			return prevWriteText.call(navigator.clipboard, text);
		}
		richCopyActive = false;

		try {
			if (!text) {
				window.postMessage({ type: 'rich-copy-error', error: localize('main.rich_copy_no_text') }, '*');
				return prevWriteText.call(navigator.clipboard, text);
			}

			await convertAndWrite(text);
			window.postMessage({ type: 'rich-copy-done' }, '*');
		} catch (err) {
			console.error('[QOL-RichCopy] Interceptor error:', err);
			window.postMessage({ type: 'rich-copy-error', error: err.message }, '*');
			return prevWriteText.call(navigator.clipboard, text);
		}
	};
})();
