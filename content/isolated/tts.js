// tts.js
(function () {
	'use strict';
	const log = createLogger('TTS');

	const T = SETTINGS_KEYS.TTS;
	const TP = SETTINGS_KEYS.TTS_PERCHAT;

	//#region SVG Icons
	const SPEAKER_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 16 16">
        <path d="M10 2.5L5.5 5.5H2v5h3.5L10 13.5v-11z" stroke-linejoin="round"/>
        <path d="M13 5c1.5 1 1.5 5 0 6" stroke-linecap="round"/>
    </svg>`;
	//#endregion

	//#region Provider Instance
	let ttsProvider = null;

	function initializeProvider(providerKey) {
		const providerInfo = window.TTSProviders.TTS_PROVIDERS[providerKey];
		return providerInfo ? new providerInfo.class() : null; // null: unknown key
	}

	// Claude's built-in TTS: native plays, never hijacked (relayed for per-chat options).
	function isNativeProvider(providerKey) {
		return !!window.TTSProviders.TTS_PROVIDERS[providerKey]?.native;
	}

	let ttsProviderKey = null;
	function getProvider(providerKey) {
		if (providerKey !== ttsProviderKey || !ttsProvider) {
			ttsProvider = initializeProvider(providerKey);
			ttsProviderKey = providerKey;
		}
		return ttsProvider;
	}

	//#endregion

	//#region Synthesis (drives claude.ai's native player via the WS interceptor)
	// The MAIN-world WS interceptor collects the native "Read aloud" text and asks us to synthesize.
	// We produce 16kHz PCM via our provider and stream it back; native handles all playback.

	// requestId -> { abort: AbortController, cancelled: bool }
	const activeSynth = new Map();

	// ~150ms of 16kHz mono s16le silence, primes native's player during actor-mode attribution latency.
	const SILENCE_PRIMER_MS = 150;
	function makeSilence(ms) {
		return new Int16Array(Math.floor(16000 * ms / 1000)).buffer; // zeros
	}

	function postSynthDone(requestId) {
		window.postMessage({ type: 'TTS_SYNTH_DONE', requestId }, window.location.origin);
	}

	function abortSynth(requestId) {
		const entry = activeSynth.get(requestId);
		if (entry) {
			entry.cancelled = true;
			entry.abort.abort();
			activeSynth.delete(requestId);
		}
	}

	async function readChatOptions(conversationId) {
		const [actorModeEnabled, voiceOverride, quotesOnly, characters] = await Promise.all([
			settingsRegistry.getPerChat(TP.ACTOR_MODE, conversationId).then(v => v === true),
			settingsRegistry.getPerChat(TP.VOICE, conversationId).then(v => v || ''),
			settingsRegistry.getPerChat(TP.QUOTES_ONLY, conversationId).then(v => v === true),
			settingsRegistry.getPerChat(TP.CHARACTERS, conversationId).then(v => v || [])
		]);
		return { actorModeEnabled, voiceOverride, quotesOnly, characters };
	}

	// Actor mode: `text` split by character (an LLM round-trip), as [{ voice, text, extra }] in reading
	// order. Characters without a voice aren't read; consecutive segments in the same voice with the same
	// extra are joined (fewer requests).
	async function actorSegments(provider, text, characters, model) {
		const voiceMap = {}; // lowercased name -> voice
		characters.forEach(char => {
			if (char.voice) voiceMap[char.name.toLowerCase()] = char.voice;
		});
		const attributed = await provider.attributeDialogueToCharacters(text, characters, model);
		const merged = [];
		for (const s of attributed) {
			const voice = voiceMap[s.character];
			if (!voice || !provider.isSpeakable(s.text, model)) continue; // e.g. a lone audio tag
			const last = merged.at(-1);
			if (last && last.voice === voice && JSON.stringify(last.extra) === JSON.stringify(s.extra)) last.text += ' ' + s.text;
			else merged.push({ voice, text: s.text, extra: s.extra });
		}
		return merged;
	}

	async function handleSynthRequest({ requestId, text, conversationId }) {
		const settings = await loadSettings();
		const provider = getProvider(settings.provider);
		// Defensive: MAIN gating should prevent this, but never leave native hanging.
		if (!provider) { postSynthDone(requestId); return; }

		const { actorModeEnabled, voiceOverride, quotesOnly, characters } = await readChatOptions(conversationId);

		const defaultVoice = voiceOverride || settings.voice;
		const baseUrl = settings.openaiBaseUrl || '';
		const finalText = cleanupText(text, quotesOnly);
		if (!finalText) { postSynthDone(requestId); return; } // e.g. quotes-only with no quotes

		const entry = { abort: new AbortController(), cancelled: false };
		activeSynth.set(requestId, entry);
		const signal = entry.abort.signal;

		const onChunk = (ab) => {
			if (entry.cancelled) return;
			// Structured-clone copy (no transfer list): this message is delivered to BOTH the MAIN
			// and ISOLATED listeners on this window, so a transferable would be detached for one of
			// them. The data rate is tiny (~32 KB/s at 16kHz mono), so copying is cheap.
			window.postMessage({ type: 'TTS_SYNTH_PCM', requestId, chunk: ab }, window.location.origin);
		};

		try {
			if (actorModeEnabled && characters.length > 0) {
				await synthesizeActorMode(provider, finalText, characters, settings, baseUrl, signal, onChunk, entry);
			} else {
				await provider.synthesize(finalText, defaultVoice, settings.model, settings.apiKey, { baseUrl }, signal, onChunk);
			}
		} catch (error) {
			log.error('Synthesis failed:', error);
		} finally {
			if (!entry.cancelled) postSynthDone(requestId);
			activeSynth.delete(requestId);
		}
	}

	async function synthesizeActorMode(provider, text, characters, settings, baseUrl, signal, onChunk, entry) {
		// Prime the native player so it doesn't time out while attribution (an LLM round-trip) runs.
		if (SILENCE_PRIMER_MS > 0) onChunk(makeSilence(SILENCE_PRIMER_MS));

		const segments = await actorSegments(provider, text, characters, settings.model);

		// Synthesize sequentially so PCM stays ordered; native concatenates the frames gaplessly.
		for (const segment of segments) {
			if (entry.cancelled || signal.aborted) return;
			await provider.synthesize(segment.text, segment.voice, settings.model, settings.apiKey, { ...segment.extra, baseUrl }, signal, onChunk);
		}
	}

	// Claude's built-in TTS, in a chat with per-chat options: tts-ws-interceptor.js's RelaySocket asks
	// what to read in which voice and plays it through claude.ai's own socket, one per segment:
	// [{ voice, language, text }]. A null voice keeps the page's (the user's claude.ai voice), a null
	// language the page's (set for a voice of another language). An empty plan reads nothing; a failed
	// one (the attribution's LLM call, say) reads it all in the page's voice.
	async function handlePlanRequest({ requestId, text, conversationId }) {
		const entry = { abort: new AbortController(), cancelled: false };
		activeSynth.set(requestId, entry);
		let segments = [];
		let finalText = text;
		try {
			const provider = getProvider('claude');
			const { actorModeEnabled, voiceOverride, quotesOnly, characters } = await readChatOptions(conversationId);
			finalText = cleanupText(text, quotesOnly);
			if (!finalText) return; // e.g. quotes only with no quotes: the empty plan
			const actor = actorModeEnabled && characters.length > 0;
			// Loads alongside the attribution, and only when a voice is to be picked.
			const voices = actor || voiceOverride ? provider.getVoices() : Promise.resolve([]);
			const planned = actor
				? await actorSegments(provider, finalText, characters)
				: [{ voice: voiceOverride, text: finalText }];
			// A voice that isn't claude.ai's (one saved for another provider) reads in the page's voice.
			const languages = new Map((await voices).map(v => [v.voice_id, v.language]));
			segments = planned.map(s => languages.has(s.voice)
				? { voice: s.voice, language: languages.get(s.voice), text: s.text }
				: { voice: null, language: null, text: s.text });
		} catch (error) {
			log.error('Could not plan the reading, reading it all in the default voice:', error);
			segments = [{ voice: null, language: null, text: finalText }];
		} finally {
			if (!entry.cancelled) window.postMessage({ type: 'TTS_PLAN', requestId, segments }, window.location.origin);
			activeSynth.delete(requestId);
		}
	}
	//#endregion

	//#region Message Listener
	// The synth relay streams, so it stays hand-rolled rather than going through ClaudeExtBridge.
	window.addEventListener('message', (event) => {
		if (event.source !== window || event.origin !== window.location.origin) return;
		const d = event.data;

		if (d?.type === 'TTS_SYNTH_REQUEST') {
			handleSynthRequest(d);
		} else if (d?.type === 'TTS_PLAN_REQUEST') {
			handlePlanRequest(d);
		} else if (d?.type === 'TTS_SYNTH_ABORT') {
			abortSynth(d.requestId);
		} else if (d?.type === 'TTS_HIJACK_CONFIG_REQUEST') {
			postHijackConfig(); // MAIN is waiting: no coalescing
		} else if (d?.type === 'TTS_OPUS_WASM_REQUEST') {
			sendOpusWasm();
		}
	});

	// The Opus encoder's .wasm for tts-ws-interceptor.js (MAIN), which claude.ai's CSP keeps from
	// fetching extension files itself. A public library, so answering any page script is harmless.
	async function sendOpusWasm() {
		try {
			const response = await fetch(chrome.runtime.getURL('lib/opus/opus-encoder.wasm'));
			const bytes = await response.arrayBuffer();
			window.postMessage({ type: 'TTS_OPUS_WASM', bytes }, window.location.origin, [bytes]);
		} catch (error) {
			log.error('Could not load the Opus encoder:', error);
			window.postMessage({ type: 'TTS_OPUS_WASM', error: String(error) }, window.location.origin);
		}
	}

	async function autoSpeak(messageUuid) {
		const settings = await loadSettings();
		if (!settings.autoSpeak) return;

		// Retry logic to find the native button (DOM might not be ready yet).
		const maxRetries = 10;
		const retryDelay = 300;
		// The reply's own row: a just-streamed original reply is keyed "<parent>-hub-reply"
		// (message-ui.js), so it's found through the tree, fetched fresh so it includes the reply. The
		// loop waits for that exact row; never guess "the last reply", which can still be the previous
		// one while the new row mounts.
		let findRow = null;
		for (let attempt = 0; attempt < maxRetries; attempt++) {
			let messageElement = document.querySelector(`[data-turn-key="${CSS.escape(String(messageUuid))}"]`);
			if (!messageElement) {
				findRow ??= rowFinder(String(messageUuid), await new ClaudeConversation(getOrgId(), getConversationId()).getData(true)
					.then(data => data.chat_messages ?? [], () => []));
				messageElement = findRow();
			}
			if (messageElement) {
				const nativeBtn = messageElement.querySelector('button[data-testid="action-bar-read-aloud"]');
				if (nativeBtn) {
					nativeBtn.click();
					return;
				}
			}
			if (attempt < maxRetries - 1) {
				await new Promise(r => setTimeout(r, retryDelay));
			}
		}
		log('Could not find native read-aloud button for message:', messageUuid);
	}

	// Sent by tts-interceptor.js when a reply finishes streaming (the turn settles on StreamTimeline). Not awaited: the button search can
	// outlast the bridge's timeout, and MAIN ignores the reply anyway.
	ClaudeExtBridge.serve('qol', {
		handlers: {
			TTS_AUTO_SPEAK: ({ messageUuid }) => { autoSpeak(messageUuid); }
		}
	});
	//#endregion

	//#region Text Cleanup
	function cleanupText(text, quotesOnly = false) {
		// Remove triple-backtick code blocks
		text = text.replace(/```[\s\S]*?```/g, '');
		// Remove lines that are indented with 4+ spaces (markdown code blocks)
		text = text.split('\n')
			.filter(line => !line.match(/^ {4}/))
			.join('\n');
		// Clean up multiple newlines
		text = text.replace(/\n{3,}/g, '\n\n').trim();
		// Clean up symbols
		text = text.replace("*", "").replace("_", "").replace("#", "").trim();

		if (quotesOnly) {
			const quotes = text.match(/"([^"]*)"/g);
			if (!quotes) return '';
			return quotes.map(q => q.slice(1, -1)).join(". ");
		}
		return text;
	}
	//#endregion

	//#region Settings Modal
	//#region Settings Modal
	async function createSettingsModal() {
		// Show loading modal immediately
		const loadingModal = createLoadingModal(localize('tts.loading_settings'));
		loadingModal.show();

		try {
			const settings = await loadSettings();
			const conversationId = getConversationId();

			// Load per-chat settings
			const [chatQuotesOnly, chatVoiceOverride, actorModeEnabled] = await Promise.all([
				settingsRegistry.getPerChat(TP.QUOTES_ONLY, conversationId).then(v => v === true),
				settingsRegistry.getPerChat(TP.VOICE, conversationId).then(v => v || ''),
				settingsRegistry.getPerChat(TP.ACTOR_MODE, conversationId).then(v => v === true)
			]);

			const providerOptions = Object.entries(window.TTSProviders.TTS_PROVIDERS).map(([key, info]) => ({
				value: key,
				label: info.name
			}));
			const currentProviderInfo = window.TTSProviders.TTS_PROVIDERS[settings.provider];
			// The per-chat voice override's options: "use the default", then the provider's voices.
			const overrideOptionsOf = (voiceOptions) => [{ value: '', label: localize('tts.use_default_voice') }, ...voiceOptions];

			// When OpenAI is used with a custom Base URL, the hardcoded model dropdown
			// can't name the custom endpoint's models, so use a free-text input instead.
			const useCustomModel = (provider, baseUrl) => provider === 'openai' && !!(baseUrl || '').trim();

			// Load voices and models if API key exists
			let voices = [];
			let models = [];
			if (settings.apiKey && currentProviderInfo.requiresApiKey) {
				const tempProvider = initializeProvider(settings.provider, null);
				[voices, models] = await Promise.all([
					tempProvider.getVoices(settings.apiKey),
					tempProvider.getModels(settings.apiKey)
				]);
			} else if (!currentProviderInfo.requiresApiKey) {
				const tempProvider = initializeProvider(settings.provider);
				if (tempProvider) {
					[voices, models] = await Promise.all([
						tempProvider.getVoices(),
						tempProvider.getModels()
					]);
				}
			}

			// Close loading modal and show the actual settings modal
			loadingModal.destroy();

			// Build content
			const content = document.createElement('div');

			// Provider select
			const providerSection = document.createElement('div');
			providerSection.className = 'mb-4';
			const providerLabel = document.createElement('label');
			providerLabel.className = CLAUDE_CLASSES.LABEL;
			providerLabel.textContent = localize('tts.provider_label');
			providerSection.appendChild(providerLabel);
			const providerSelect = createClaudeSelect(providerOptions, settings.provider);
			providerSelect.id = 'providerSelect';
			providerSection.appendChild(providerSelect);
			content.appendChild(providerSection);

			// Native (Claude built-in) note — shown when the 'claude' passthrough provider is selected
			const nativeNote = document.createElement('p');
			nativeNote.id = 'ttsNativeNote';
			nativeNote.className = CLAUDE_CLASSES.TEXT_MUTED + ' mb-4';
			nativeNote.textContent = localize('tts.native_note');
			nativeNote.style.display = isNativeProvider(settings.provider) ? 'block' : 'none';
			content.appendChild(nativeNote);

			// API Key input
			const apiKeySection = document.createElement('div');
			apiKeySection.className = 'mb-4';
			apiKeySection.id = 'apiKeySection';
			apiKeySection.style.display = currentProviderInfo.requiresApiKey ? 'block' : 'none';
			const apiKeyLabel = document.createElement('label');
			apiKeyLabel.className = CLAUDE_CLASSES.LABEL;
			apiKeyLabel.textContent = localize('tts.api_key_label');
			apiKeySection.appendChild(apiKeyLabel);
			const apiKeyInput = createClaudeInput({
				type: 'password',
				value: settings.apiKey || '',
				placeholder: localize('tts.api_key_placeholder')
			});
			apiKeyInput.id = 'apiKeyInput';
			apiKeySection.appendChild(apiKeyInput);
			content.appendChild(apiKeySection);

			// Base URL input (for OpenAI-compatible APIs)
			const baseUrlSection = document.createElement('div');
			baseUrlSection.className = 'mb-4';
			baseUrlSection.id = 'baseUrlSection';
			baseUrlSection.style.display = settings.provider === 'openai' ? 'block' : 'none';
			const baseUrlLabel = document.createElement('label');
			baseUrlLabel.className = CLAUDE_CLASSES.LABEL;
			baseUrlLabel.textContent = localize('tts.base_url_label');
			baseUrlSection.appendChild(baseUrlLabel);
			const baseUrlInput = createClaudeInput({
				type: 'text',
				value: settings.openaiBaseUrl || '',
				placeholder: 'https://api.openai.com'
			});
			baseUrlInput.id = 'baseUrlInput';
			baseUrlSection.appendChild(baseUrlInput);
			const baseUrlHint = document.createElement('p');
			baseUrlHint.className = 'text-text-500 text-xs mt-1';
			baseUrlHint.textContent = localize('tts.base_url_hint');
			baseUrlSection.appendChild(baseUrlHint);
			content.appendChild(baseUrlSection);

			// Voice select
			const voiceSection = document.createElement('div');
			voiceSection.className = 'mb-4';
			voiceSection.id = 'voiceSection';
			voiceSection.style.display = isNativeProvider(settings.provider) ? 'none' : 'block';
			const voiceLabel = document.createElement('label');
			voiceLabel.className = CLAUDE_CLASSES.LABEL;
			voiceLabel.textContent = localize('tts.voice_label');
			voiceSection.appendChild(voiceLabel);

			const voiceOptions = voices.length > 0
				? voices.map(v => ({ value: v.voice_id, label: v.name }))
				: [{ value: '', label: currentProviderInfo.requiresApiKey ? localize('tts.set_api_key_option') : localize('shared.loading') }];
			const voiceSelect = createClaudeSearchableSelect(voiceOptions, settings.voice || '');
			voiceSelect.id = 'voiceSelect';
			voiceSelect.disabled = currentProviderInfo.requiresApiKey && !settings.apiKey;
			voiceSection.appendChild(voiceSelect);
			// ElevenLabs applies each voice's last-used generation settings (we don't send voice_settings).
			const elevenVoiceHint = document.createElement('p');
			elevenVoiceHint.id = 'elevenVoiceHint';
			elevenVoiceHint.className = 'text-text-500 text-xs mt-1';
			elevenVoiceHint.textContent = localize('tts.eleven_voice_hint');
			elevenVoiceHint.style.display = settings.provider === 'elevenlabs' ? 'block' : 'none';
			voiceSection.appendChild(elevenVoiceHint);
			content.appendChild(voiceSection);

			// Model select
			const modelSection = document.createElement('div');
			modelSection.className = 'mb-4';
			modelSection.id = 'modelSelectSection';
			const modelLabel = document.createElement('label');
			modelLabel.className = CLAUDE_CLASSES.LABEL;
			modelLabel.textContent = localize('tts.model_label');
			modelSection.appendChild(modelLabel);

			const modelOptions = models.length > 0
				? models.map(m => ({ value: m.model_id, label: m.name }))
				: [{ value: '', label: currentProviderInfo.requiresApiKey ? localize('tts.set_api_key_option') : localize('shared.loading') }];
			const modelSelect = createClaudeSelect(modelOptions, settings.model || '');
			modelSelect.id = 'modelSelect';
			modelSelect.disabled = currentProviderInfo.requiresApiKey && !settings.apiKey;
			modelSection.appendChild(modelSelect);
			modelSection.style.display = (isNativeProvider(settings.provider) || useCustomModel(settings.provider, settings.openaiBaseUrl)) ? 'none' : 'block';
			content.appendChild(modelSection);

			// Custom model input (OpenAI with a custom Base URL)
			const modelCustomSection = document.createElement('div');
			modelCustomSection.className = 'mb-4';
			modelCustomSection.id = 'modelCustomSection';
			modelCustomSection.style.display = (!isNativeProvider(settings.provider) && useCustomModel(settings.provider, settings.openaiBaseUrl)) ? 'block' : 'none';
			const modelCustomLabel = document.createElement('label');
			modelCustomLabel.className = CLAUDE_CLASSES.LABEL;
			modelCustomLabel.textContent = localize('tts.model_label');
			modelCustomSection.appendChild(modelCustomLabel);
			const modelCustomInput = createClaudeInput({
				type: 'text',
				value: settings.model || '',
				placeholder: 'gpt-4o-mini-tts'
			});
			modelCustomInput.id = 'modelCustomInput';
			modelCustomSection.appendChild(modelCustomInput);
			const modelCustomHint = document.createElement('p');
			modelCustomHint.className = 'text-text-500 text-xs mt-1';
			modelCustomHint.textContent = localize('tts.custom_model_hint');
			modelCustomSection.appendChild(modelCustomHint);
			content.appendChild(modelCustomSection);

			// Auto-speak toggle
			const autoSpeakSection = document.createElement('div');
			autoSpeakSection.className = 'mb-4';
			const autoSpeakToggle = createClaudeToggle(localize('tts.auto_speak'), settings.autoSpeak, null);
			autoSpeakSection.appendChild(autoSpeakToggle.container);
			const autoSpeakNote = document.createElement('p');
			autoSpeakNote.className = CLAUDE_CLASSES.TEXT_MUTED + ' mt-1';
			autoSpeakNote.textContent = localize('tts.auto_speak_note');
			autoSpeakSection.appendChild(autoSpeakNote);
			content.appendChild(autoSpeakSection);

			// Per-Chat Settings Section
			const perChatSection = document.createElement('div');
			perChatSection.className = 'border-t border-border-300 pt-4 mt-4';

			const perChatHeading = document.createElement('h4');
			perChatHeading.className = 'text-sm font-semibold text-text-200 mb-3';
			perChatHeading.textContent = localize('tts.per_chat_heading');
			perChatSection.appendChild(perChatHeading);

			// Quotes only toggle
			const quotesSection = document.createElement('div');
			quotesSection.className = 'mb-4';
			const quotesOnlyToggle = createClaudeToggle(localize('tts.quotes_only'), chatQuotesOnly, null);
			createClaudeTooltip(quotesOnlyToggle.container, localize('tts.quotes_only_tooltip'));
			quotesSection.appendChild(quotesOnlyToggle.container);
			perChatSection.appendChild(quotesSection);

			// Voice override select
			const overrideSection = document.createElement('div');
			overrideSection.className = 'mb-4';
			const overrideLabel = document.createElement('label');
			overrideLabel.className = CLAUDE_CLASSES.LABEL;
			overrideLabel.textContent = localize('tts.voice_override_label');
			overrideSection.appendChild(overrideLabel);

			const overrideOptions = overrideOptionsOf(voiceOptions.filter(opt => opt.value)); // not "Set an API key..."
			const chatVoiceOverrideSelect = createClaudeSearchableSelect(overrideOptions, chatVoiceOverride);
			chatVoiceOverrideSelect.id = 'chatVoiceOverride';
			chatVoiceOverrideSelect.disabled = currentProviderInfo.requiresApiKey && !settings.apiKey;
			overrideSection.appendChild(chatVoiceOverrideSelect);
			perChatSection.appendChild(overrideSection);

			// Actor mode section
			const actorSection = document.createElement('div');
			actorSection.className = 'mb-4';
			const actorContainer = document.createElement('div');
			actorContainer.className = 'flex items-center justify-between';

			const actorToggleContainer = document.createElement('div');
			actorToggleContainer.className = 'flex-1';
			const actorModeToggle = createClaudeToggle(localize('tts.actor_mode'), actorModeEnabled, null);
			createClaudeTooltip(actorModeToggle.container, localize('tts.actor_mode_tooltip'));
			actorToggleContainer.appendChild(actorModeToggle.container);

			actorContainer.appendChild(actorToggleContainer);

			const configureActorsBtn = createClaudeButton(localize('tts.configure_characters'), 'secondary');
			configureActorsBtn.id = 'configureActorsBtn';
			configureActorsBtn.style.display = actorModeEnabled ? 'block' : 'none';
			configureActorsBtn.classList.add('ml-2');
			actorContainer.appendChild(configureActorsBtn);

			actorSection.appendChild(actorContainer);
			perChatSection.appendChild(actorSection);

			// Only add the per-chat section if we're in... a chat: then the account-wide settings and the
			// per-chat ones are side by side.
			let modalContent = content;
			const inChat = window.location.href.includes('claude.ai/chat');
			if (inChat) {
				const columns = createModalColumns();
				perChatSection.className = '';
				columns.left.appendChild(content);
				columns.right.appendChild(perChatSection);
				modalContent = columns.container;
			}

			// Create modal with new class
			const modal = new ClaudeModal(localize('tts.settings_title'), modalContent);
			if (inChat) widenModal(modal);

			modal.addCancel();
			modal.addConfirm(localize('common.save'), async () => {
				// Claude's own voice is picked in claude.ai's settings: its voice and model fields are hidden,
				// and the stored ones (another provider's) stay for switching back.
				const native = isNativeProvider(providerSelect.value);
				const newSettings = {
					provider: providerSelect.value,
					apiKey: apiKeyInput.value.trim(),
					voice: native ? settings.voice : voiceSelect.value,
					model: native ? settings.model
						: useCustomModel(providerSelect.value, baseUrlInput.value) ? modelCustomInput.value.trim()
							: modelSelect.value,
					autoSpeak: autoSpeakToggle.input.checked,
					openaiBaseUrl: baseUrlInput.value.trim().replace(/\/+$/, '')  // Strip trailing slashes
				};

				// Verify API key if provider requires it
				const providerInfo = window.TTSProviders.TTS_PROVIDERS[newSettings.provider];
				if (providerInfo.requiresApiKey && newSettings.apiKey) {
					const tempProvider = initializeProvider(newSettings.provider, null);
					// Pass baseUrl for OpenAI provider
					const isValid = newSettings.provider === 'openai'
						? await tempProvider.testApiKey(newSettings.apiKey, newSettings.openaiBaseUrl)
						: await tempProvider.testApiKey(newSettings.apiKey);

					if (!isValid) {
						showClaudeAlert(localize('tts.api_key_error_title'), localize('tts.invalid_provider_key', { provider: providerInfo.name }));
						return false; // Don't save, keep modal open
					}
				} else if (providerInfo.requiresApiKey && !newSettings.apiKey) {
					showClaudeAlert(localize('tts.api_key_required_title'), localize('tts.api_key_required', { provider: providerInfo.name }));
					return false; // Don't save, keep modal open
				}

				// Handle per-chat settings
				if (conversationId) {
					// Enforce mutual exclusivity: if both are checked (shouldn't happen due to UI logic),
					// prioritize actor mode
					const quotesOnlyValue = quotesOnlyToggle.input.checked;
					const actorModeValue = actorModeToggle.input.checked;

					if (quotesOnlyValue && actorModeValue) {
						// Shouldn't happen, but if it does, prefer actor mode
						await settingsRegistry.setPerChat(TP.QUOTES_ONLY, conversationId, false);
						await settingsRegistry.setPerChat(TP.ACTOR_MODE, conversationId, true);
					} else {
						await settingsRegistry.setPerChat(TP.QUOTES_ONLY, conversationId, quotesOnlyValue);
						await settingsRegistry.setPerChat(TP.ACTOR_MODE, conversationId, actorModeValue);
					}

					const chatOverride = chatVoiceOverrideSelect.value;
					if (chatOverride) {
						await settingsRegistry.setPerChat(TP.VOICE, conversationId, chatOverride);
					} else {
						await settingsRegistry.removePerChat(TP.VOICE, conversationId);
					}
				}

				// Drop the cached provider so the next synth request re-inits with the new settings.
				ttsProvider = null;
				ttsProviderKey = null;

				await saveSettings(newSettings);

				// Reload so the MAIN WS interceptor picks up the new provider / hijack state cleanly.
				window.location.reload();
			});

			// Handle mutual exclusivity between quotes-only and actor mode
			quotesOnlyToggle.input.addEventListener('change', (e) => {
				if (e.target.checked) {
					// Turn off actor mode when quotes-only is enabled
					actorModeToggle.input.checked = false;
					actorModeToggle.input.dispatchEvent(new Event('change'));
					configureActorsBtn.style.display = 'none';
				}
			});

			actorModeToggle.input.addEventListener('change', (e) => {
				if (e.target.checked) {
					// Turn off quotes-only when actor mode is enabled
					quotesOnlyToggle.input.checked = false;
					quotesOnlyToggle.input.dispatchEvent(new Event('change'));
				}
				// Also update configure button visibility
				configureActorsBtn.style.display = e.target.checked ? 'block' : 'none';
			});

			// Configure actors button
			configureActorsBtn.onclick = async () => {
				const currentApiKey = apiKeyInput.value.trim();
				const currentProviderKey = providerSelect.value;
				await createActorConfigModal(currentApiKey, currentProviderKey);
			};

			// Handle provider change
			providerSelect.addEventListener('change', async (e) => {
				const newProviderKey = e.target.value;
				const newProviderInfo = window.TTSProviders.TTS_PROVIDERS[newProviderKey];
				const native = isNativeProvider(newProviderKey);

				// Native (Claude built-in): hide all of our provider config.
				nativeNote.style.display = native ? 'block' : 'none';
				apiKeySection.style.display = (!native && newProviderInfo.requiresApiKey) ? 'block' : 'none';
				baseUrlSection.style.display = (!native && newProviderKey === 'openai') ? 'block' : 'none';
				voiceSection.style.display = native ? 'none' : 'block';
				elevenVoiceHint.style.display = (newProviderKey === 'elevenlabs') ? 'block' : 'none';

				// Swap between the model dropdown and the custom-model input (both hidden when native)
				const custom = useCustomModel(newProviderKey, baseUrlInput.value);
				modelSection.style.display = (native || custom) ? 'none' : 'block';
				modelCustomSection.style.display = (!native && custom) ? 'block' : 'none';

				const tempProvider = initializeProvider(newProviderKey);

				// Check if we need to load data
				if (newProviderInfo.requiresApiKey) {
					const currentApiKey = apiKeyInput.value.trim();
					if (!currentApiKey) {
						voiceSelect.populateOptions([{ value: '', label: localize('tts.set_api_key_option') }]);
						modelSelect.populateOptions([{ value: '', label: localize('tts.set_api_key_option') }]);
						chatVoiceOverrideSelect.populateOptions(overrideOptionsOf([]));
						chatVoiceOverrideSelect.disabled = true;
						return;
					}
				}

				// Show loading modal
				const loadingModal = createLoadingModal(localize('tts.loading_voices_models'));
				loadingModal.show();

				try {
					let newVoices, newModels;
					if (newProviderInfo.requiresApiKey) {
						const currentApiKey = apiKeyInput.value.trim();
						[newVoices, newModels] = await Promise.all([
							tempProvider.getVoices(currentApiKey),
							tempProvider.getModels(currentApiKey)
						]);
					} else {
						[newVoices, newModels] = await Promise.all([
							tempProvider.getVoices(),
							tempProvider.getModels()
						]);
					}

					const newVoiceOptions = newVoices.map(v => ({
						value: v.voice_id,
						label: v.name
					}));
					voiceSelect.populateOptions(newVoiceOptions);
					chatVoiceOverrideSelect.populateOptions(overrideOptionsOf(newVoiceOptions));
					chatVoiceOverrideSelect.disabled = false;

					const newModelOptions = newModels.map(m => ({ value: m.model_id, label: m.name }));
					modelSelect.populateOptions(newModelOptions);

					loadingModal.destroy();
				} catch (error) {
					log.error('Failed to load provider data:', error);
					loadingModal.destroy();
					showClaudeAlert(localize('tts.loading_error_title'), localize('tts.load_provider_failed'));
				}
			});

			// Handle API key changes
			apiKeyInput.addEventListener('change', async (e) => {
				const newKey = e.target.value.trim();
				const currentProviderKey = providerSelect.value;
				const currentProviderInfo = window.TTSProviders.TTS_PROVIDERS[currentProviderKey];

				if (!currentProviderInfo.requiresApiKey) return;

				if (newKey) {
					// Show loading modal
					const loadingModal = createLoadingModal(localize('tts.validating_key'));
					loadingModal.show();

					const tempProvider = initializeProvider(currentProviderKey, null);
					const currentBaseUrl = baseUrlInput.value.trim().replace(/\/+$/, '');
					const isValid = currentProviderKey === 'openai'
						? await tempProvider.testApiKey(newKey, currentBaseUrl)
						: await tempProvider.testApiKey(newKey);
					if (isValid) {
						const [newVoices, newModels] = await Promise.all([
							tempProvider.getVoices(newKey),
							tempProvider.getModels(newKey)
						]);

						const newVoiceOptions = newVoices.map(v => ({
							value: v.voice_id,
							label: v.name
						}));
						voiceSelect.populateOptions(newVoiceOptions);

						chatVoiceOverrideSelect.populateOptions(overrideOptionsOf(newVoiceOptions));

						const newModelOptions = newModels.map(m => ({ value: m.model_id, label: m.name }));
						modelSelect.populateOptions(newModelOptions);

						loadingModal.destroy();
					} else {
						loadingModal.destroy();
						showClaudeAlert(localize('tts.api_key_error_title'), localize('tts.invalid_key'));
						e.target.value = settings.apiKey || '';
					}
				}
			});

			// Swap between the model dropdown and the custom-model input as the Base URL changes
			baseUrlInput.addEventListener('input', () => {
				const custom = useCustomModel(providerSelect.value, baseUrlInput.value);
				modelSection.style.display = custom ? 'none' : 'block';
				modelCustomSection.style.display = custom ? 'block' : 'none';
			});

			modal.show();

		} catch (error) {
			loadingModal.destroy();
			showClaudeAlert(localize('common.error'), localize('tts.load_settings_failed', { error: error.message }));
			log.error('Settings modal error:', error);
		}
	}

	async function createActorConfigModal(apiKey, providerKey) {
		// Show loading modal immediately
		const loadingModal = createLoadingModal(localize('tts.loading_voices'));
		loadingModal.show();

		try {
			const conversationId = getConversationId();
			let characters = (await settingsRegistry.getPerChat(TP.CHARACTERS, conversationId)) || [];

			// Ensure narrator exists
			if (!characters.find(c => c.name.toLowerCase() === 'narrator')) {
				characters = [{ name: 'Narrator', gender: 'other', voice: '' }, ...characters];
			}

			// Load available voices
			const tempProvider = initializeProvider(providerKey, null);
			const providerInfo = window.TTSProviders.TTS_PROVIDERS[providerKey];

			let voices = [];
			if (tempProvider) {
				if (providerInfo.requiresApiKey && apiKey) {
					voices = await tempProvider.getVoices(apiKey);
				} else if (!providerInfo.requiresApiKey) {
					voices = await tempProvider.getVoices();
				}
			}

			// Close loading modal
			loadingModal.destroy();

			const voiceOptions = [
				{ value: '', label: localize('tts.voice_none') },
				...voices.map(v => ({ value: v.voice_id, label: v.name }))
			];

			// Create modal content
			const contentContainer = document.createElement('div');

			// Characters section
			const charactersSection = document.createElement('div');
			charactersSection.className = 'mb-4';

			const headerDiv = document.createElement('div');
			headerDiv.className = 'flex items-center justify-between mb-3';

			const instructionText = document.createElement('p');
			instructionText.className = 'text-sm text-text-300';
			instructionText.textContent = localize('tts.actor_instructions');
			headerDiv.appendChild(instructionText);

			// Control buttons
			const controlButtons = document.createElement('div');
			controlButtons.className = 'flex justify-end gap-2 mb-3';

			const addBtn = createClaudeButton(
				'<span class="flex items-center gap-1"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" stroke-linecap="round"/></svg>' + localize('tts.add_character') + '</span>',
				'secondary',
				null,
				true
			);

			const removeBtn = createClaudeButton(
				'<span class="flex items-center gap-1"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 16 16"><path d="M3 8h10" stroke-linecap="round"/></svg>' + localize('tts.remove_last') + '</span>',
				'secondary',
				null,
				true
			);

			controlButtons.appendChild(addBtn);
			controlButtons.appendChild(removeBtn);

			// Table container
			const tableContainer = document.createElement('div');
			tableContainer.className = 'border border-border-300 rounded-lg overflow-hidden';

			// Table header
			const tableHeader = document.createElement('div');
			tableHeader.className = 'grid grid-cols-3 gap-4 p-3 bg-bg-100 border-b border-border-300 font-medium text-sm';
			tableHeader.innerHTML = `<div>${localize('tts.character_name')}</div><div>${localize('tts.gender')}</div><div>${localize('tts.voice_label')}</div>`;

			// Characters list container
			const charactersList = document.createElement('div');
			charactersList.id = 'charactersList';
			charactersList.className = 'max-h-96 overflow-y-auto';

			tableContainer.appendChild(tableHeader);
			tableContainer.appendChild(charactersList);

			const tipText = document.createElement('div');
			tipText.className = 'mt-3 text-xs text-text-400';
			tipText.textContent = localize('tts.actor_tip');

			charactersSection.appendChild(headerDiv);
			charactersSection.appendChild(controlButtons);

			// Add warning if voices couldn't load
			if (voices.length === 0 && apiKey) {
				const warningDiv = document.createElement('div');
				warningDiv.className = 'mb-3 p-2 bg-accent-100 border border-accent-200 rounded text-sm text-accent-600';
				warningDiv.textContent = localize('tts.voices_load_failed');
				charactersSection.appendChild(warningDiv);
			}

			charactersSection.appendChild(tableContainer);
			charactersSection.appendChild(tipText);

			contentContainer.appendChild(charactersSection);

			// Function to create a character row
			function createCharacterRow(character = {}, isNarrator = false) {
				const row = document.createElement('div');
				row.className = 'grid grid-cols-3 gap-4 p-3 border-b border-border-200 character-row hover:bg-bg-50';
				if (isNarrator) {
					row.classList.add('narrator-row', 'bg-bg-50');
				}

				const nameInput = createClaudeInput({
					type: 'text',
					placeholder: localize('tts.character_name_placeholder'),
					value: character.name || ''
				});
				nameInput.classList.add('character-name');
				if (isNarrator) {
					nameInput.disabled = true;
					nameInput.className += ' opacity-60';
				}

				const genderOptions = [
					{ value: 'male', label: localize('tts.gender_male') },
					{ value: 'female', label: localize('tts.gender_female') },
					{ value: 'other', label: localize('tts.gender_other') }
				];
				const genderSelect = createClaudeSelect(genderOptions, character.gender || 'male');
				genderSelect.classList.add('character-gender');
				if (isNarrator) {
					genderSelect.disabled = true;
					genderSelect.className += ' opacity-60';
				}

				const voiceSelect = createClaudeSearchableSelect(voiceOptions, character.voice || '');
				voiceSelect.classList.add('character-voice');

				row.appendChild(nameInput);
				row.appendChild(genderSelect);
				row.appendChild(voiceSelect);

				return row;
			}

			// Populate existing characters
			const narratorChar = characters.find(c => c.name.toLowerCase() === 'narrator') ||
				{ name: 'Narrator', gender: 'other', voice: '' };
			charactersList.appendChild(createCharacterRow(narratorChar, true));

			characters.filter(c => c.name.toLowerCase() !== 'narrator').forEach(character => {
				charactersList.appendChild(createCharacterRow(character, false));
			});

			if (characters.filter(c => c.name.toLowerCase() !== 'narrator').length === 0) {
				charactersList.appendChild(createCharacterRow());
			}

			// Add character button
			addBtn.onclick = () => {
				charactersList.appendChild(createCharacterRow());
			};

			// Remove character button
			removeBtn.onclick = () => {
				const rows = charactersList.querySelectorAll('.character-row:not(.narrator-row)');
				if (rows.length > 1) {
					rows[rows.length - 1].remove();
				} else if (rows.length === 1) {
					rows[0].querySelector('.character-name').value = '';
					rows[0].querySelector('.character-gender').value = 'male';
					rows[0].querySelector('.character-voice').value = '';
				}
			};

			// Create the modal
			const modal = new ClaudeModal(localize('tts.actor_config_title'), contentContainer);

			modal.addCancel();
			modal.addConfirm(localize('common.save'), async () => {
				const characterRows = charactersList.querySelectorAll('.character-row');
				const charactersData = Array.from(characterRows)
					.map(row => ({
						name: row.querySelector('.character-name').value.trim(),
						gender: row.querySelector('.character-gender').value,
						voice: row.querySelector('.character-voice').value
					}))
					.filter(char => char.name);

				if (charactersData.length > 0) {
					await settingsRegistry.setPerChat(TP.CHARACTERS, conversationId, charactersData);
				}
			});

			// Adjust modal width
			modal.modal.style.maxWidth = '900px';
			modal.modal.style.width = '90%';

			modal.show();

		} catch (error) {
			loadingModal.destroy();
			showClaudeAlert(localize('common.error'), localize('tts.actor_config_failed', { error: error.message }));
			log.error('Actor config modal error:', error);
		}
	}

	async function loadSettings() {
		const [provider, apiKey, voice, model, autoSpeak, openaiBaseUrl] = await Promise.all([
			settingsRegistry.get(T.PROVIDER),
			settingsRegistry.get(T.API_KEY),
			settingsRegistry.get(T.VOICE),
			settingsRegistry.get(T.MODEL),
			settingsRegistry.get(T.AUTO_SPEAK),
			settingsRegistry.get(T.BASE_URL)
		]);

		return {
			provider,
			apiKey,
			voice,
			model,
			autoSpeak,
			openaiBaseUrl
		};
	}

	async function saveSettings(settings) {
		await Promise.all([
			settingsRegistry.set(T.PROVIDER, settings.provider),
			settingsRegistry.set(T.API_KEY, settings.apiKey),
			settingsRegistry.set(T.VOICE, settings.voice),
			settingsRegistry.set(T.MODEL, settings.model),
			settingsRegistry.set(T.AUTO_SPEAK, settings.autoSpeak),
			settingsRegistry.set(T.BASE_URL, settings.openaiBaseUrl)
		]);
	}
	//#endregion

	//#region Settings Button
	function createSettingsButton() {
		const button = createClaudeButton(SPEAKER_ICON, 'icon', async () => {
			await createSettingsModal();
		});

		button.classList.add('tts-settings-button');
		refreshTTSButtonColor(button);
		return button;
	}

	// Tints the toolbar icon blue when a custom (non-native) provider is active.
	async function refreshTTSButtonColor(button) {
		button = button || document.querySelector('.tts-settings-button');
		if (!button) return;
		const provider = await settingsRegistry.get(T.PROVIDER);
		button.classList.toggle('tts-custom-provider', !!provider && !isNativeProvider(provider));
	}
	//#endregion

	//#region Config sync
	// Gate: hijack the native TTS socket only when a premium provider is fully configured.
	async function computeHijack() {
		const [provider, apiKey, voice] = await Promise.all([
			settingsRegistry.get(T.PROVIDER),
			settingsRegistry.get(T.API_KEY),
			settingsRegistry.get(T.VOICE)
		]);
		return !!provider && !isNativeProvider(provider) && !!apiKey && !!voice;
	}

	// With Claude's built-in TTS, the chats whose reads go through MAIN's RelaySocket: those with a
	// per-chat option set. Other chats keep native's socket untouched.
	async function computeRelayChats() {
		const provider = await settingsRegistry.get(T.PROVIDER);
		if (!isNativeProvider(provider)) return [];
		const [actorMode, characters, quotesOnly, voice] = await Promise.all(
			[TP.ACTOR_MODE, TP.CHARACTERS, TP.QUOTES_ONLY, TP.VOICE].map(k => settingsRegistry.get(k).then(v => v || {})));
		const ids = new Set();
		for (const [id, on] of Object.entries(actorMode)) if (on === true && characters[id]?.length) ids.add(id);
		for (const [id, on] of Object.entries(quotesOnly)) if (on === true) ids.add(id);
		for (const [id, override] of Object.entries(voice)) if (override) ids.add(id);
		return [...ids];
	}

	async function postHijackConfig() {
		const [hijack, relayChats] = await Promise.all([computeHijack(), computeRelayChats()]);
		window.postMessage({ type: 'TTS_HIJACK_CONFIG', hijack, relayChats }, window.location.origin);
	}

	// For setting changes: a save changes several keys at once, one push covers them all.
	let pushTimer = null;
	function pushHijackConfig() {
		clearTimeout(pushTimer);
		pushTimer = setTimeout(postHijackConfig, 0);
	}

	//#endregion

	//#region Initialization
	function addTTSStyles() {
		if (document.querySelector('#tts-styles')) return;

		const style = document.createElement('style');
		style.id = 'tts-styles';
		style.textContent = `
        .tts-settings-button.tts-custom-provider {
            color: #2c84db;
        }
    `;
		document.head.appendChild(style);
	}

	async function initialize() {
		addTTSStyles();
		ButtonBar.register({
			buttonClass: 'tts-settings-button',
			createFn: createSettingsButton,
			tooltip: localize('tts.settings_title'),
			forceDisplayOnMobile: false, // on phones: in the More-actions menu (the preset switcher stays out)
			pages: ['chat', 'home', 'codeHome', 'codeChat'],
		});
		postHijackConfig();
		// Re-push the hijack decision + recolor the icon whenever a relevant setting changes.
		[T.PROVIDER, T.API_KEY, T.VOICE, T.BASE_URL].forEach(k =>
			settingsRegistry.onChange(k, () => { pushHijackConfig(); refreshTTSButtonColor(); })
		);
		// The per-chat options decide which chats relay (the actor modal saves without a reload).
		[TP.ACTOR_MODE, TP.CHARACTERS, TP.QUOTES_ONLY, TP.VOICE].forEach(k => settingsRegistry.onChange(k, pushHijackConfig));
	}

	// Wait for DOM to be ready before initializing
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initialize);
	} else {
		// DOM is already ready
		initialize();
	}
	//#endregion
})();