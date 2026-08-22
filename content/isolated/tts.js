// tts.js
(function () {
	'use strict';

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
		// 'claude' (native passthrough) has class: null; unknown keys too.
		if (!providerInfo || !providerInfo.class) return null;
		return new providerInfo.class();
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
		window.postMessage({ type: 'TTS_SYNTH_DONE', requestId }, '*');
	}

	function abortSynth(requestId) {
		const entry = activeSynth.get(requestId);
		if (entry) {
			entry.cancelled = true;
			entry.abort.abort();
			activeSynth.delete(requestId);
		}
	}

	async function handleSynthRequest({ requestId, text, conversationId }) {
		const settings = await loadSettings();
		const provider = getProvider(settings.provider);
		// Defensive: MAIN gating should prevent this, but never leave native hanging.
		if (!provider) { postSynthDone(requestId); return; }

		const [actorModeEnabled, voiceOverride, quotesOnly, characters] = await Promise.all([
			settingsRegistry.getPerChat(TP.ACTOR_MODE, conversationId).then(v => v === true),
			settingsRegistry.getPerChat(TP.VOICE, conversationId).then(v => v || ''),
			settingsRegistry.getPerChat(TP.QUOTES_ONLY, conversationId).then(v => v === true),
			settingsRegistry.getPerChat(TP.CHARACTERS, conversationId).then(v => v || [])
		]);

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
			window.postMessage({ type: 'TTS_SYNTH_PCM', requestId, chunk: ab }, '*');
		};

		try {
			if (actorModeEnabled && characters.length > 0) {
				await synthesizeActorMode(provider, finalText, characters, settings, baseUrl, signal, onChunk, entry);
			} else {
				await provider.synthesize(finalText, defaultVoice, settings.model, settings.apiKey, { baseUrl }, signal, onChunk);
			}
		} catch (error) {
			console.error('[QOL-TTS] Synthesis failed:', error);
			if (window.showErrorToast) window.showErrorToast('TTS Synthesis failed: ' + (error.message || error));
		} finally {
			if (!entry.cancelled) postSynthDone(requestId);
			activeSynth.delete(requestId);
		}
	}

	async function synthesizeActorMode(provider, text, characters, settings, baseUrl, signal, onChunk, entry) {
		// Prime the native player so it doesn't time out while attribution (an LLM round-trip) runs.
		if (SILENCE_PRIMER_MS > 0) onChunk(makeSilence(SILENCE_PRIMER_MS));

		const segments = await provider.attributeDialogueToCharacters(text, characters, settings.model);
		if (entry.cancelled || signal.aborted) return;

		const voiceMap = {};
		characters.forEach(char => {
			if (char.voice) voiceMap[char.name.toLowerCase()] = char.voice;
		});

		// Merge consecutive segments from the same character with matching extra (fewer API calls).
		const mergedSegments = [];
		let currentSegment = null;
		for (const segment of segments) {
			const characterName = segment.character.toLowerCase();
			const extraStr = JSON.stringify(segment.extra || {});
			if (currentSegment && currentSegment.character === characterName && currentSegment.extraStr === extraStr) {
				currentSegment.text += ' ' + segment.text;
			} else {
				if (currentSegment) mergedSegments.push(currentSegment);
				currentSegment = { character: characterName, text: segment.text, extra: segment.extra || {}, extraStr };
			}
		}
		if (currentSegment) mergedSegments.push(currentSegment);

		// Synthesize sequentially so PCM stays ordered; native concatenates the frames gaplessly.
		for (const segment of mergedSegments) {
			if (entry.cancelled || signal.aborted) return;
			const voice = voiceMap[segment.character];
			if (!voice) continue; // character mapped to no voice -> skip
			await provider.synthesize(segment.text, voice, settings.model, settings.apiKey, { ...segment.extra, baseUrl }, signal, onChunk);
		}
	}
	//#endregion

	//#region Message Listener
	window.addEventListener('message', async (event) => {
		if (event.source !== window || !event.data) return;
		const d = event.data;

		if (d.type === 'TTS_SYNTH_REQUEST') {
			handleSynthRequest(d);
		} else if (d.type === 'TTS_SYNTH_ABORT') {
			abortSynth(d.requestId);
		} else if (d.type === 'TTS_HIJACK_CONFIG_REQUEST') {
			pushHijackConfig();
		} else if (d.type === 'tts-auto-speak') {
			const settings = await loadSettings();
			if (!settings.autoSpeak) return;

			const { messageUuid } = d;
			// Retry logic to find the native button (DOM might not be ready yet).
			const maxRetries = 10;
			const retryDelay = 300;
			for (let attempt = 0; attempt < maxRetries; attempt++) {
				const messageElement = document.querySelector(`[data-message-uuid="${messageUuid}"]`);
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
			console.log('[QOL-TTS] Could not find native read-aloud button for message:', messageUuid);
		}
	});
	//#endregion

	//#region Text Cleanup
	function cleanupText(text, quotesOnly = false) {
		// Remove triple-backtick code blocks
		text = text.replace(/```[\s\S]*?```/g, '');
		// Remove lines that are indented with 4+ spaces (markdown code blocks)
		text = text.split('\n')
			.filter(line => !line.match(/^    /))
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
		const loadingModal = createLoadingModal('Loading settings...');
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
			// 'claude' is native passthrough: no key/voice/model of ours, native TTS handles it.
			const isNative = (key) => !!window.TTSProviders.TTS_PROVIDERS[key]?.native;

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
			providerLabel.textContent = 'TTS Provider';
			providerSection.appendChild(providerLabel);
			const providerSelect = createClaudeSelect(providerOptions, settings.provider);
			providerSelect.id = 'providerSelect';
			providerSection.appendChild(providerSelect);
			content.appendChild(providerSection);

			// Native (Claude built-in) note — shown when the 'claude' passthrough provider is selected
			const nativeNote = document.createElement('p');
			nativeNote.id = 'ttsNativeNote';
			nativeNote.className = CLAUDE_CLASSES.TEXT_MUTED + ' mb-4';
			nativeNote.textContent = "Using Claude's built-in voice (set it in Claude's own settings). Pick ElevenLabs or OpenAI to use a custom voice.";
			nativeNote.style.display = isNative(settings.provider) ? 'block' : 'none';
			content.appendChild(nativeNote);

			// API Key input
			const apiKeySection = document.createElement('div');
			apiKeySection.className = 'mb-4';
			apiKeySection.id = 'apiKeySection';
			apiKeySection.style.display = currentProviderInfo.requiresApiKey ? 'block' : 'none';
			const apiKeyLabel = document.createElement('label');
			apiKeyLabel.className = CLAUDE_CLASSES.LABEL;
			apiKeyLabel.textContent = 'API Key';
			apiKeySection.appendChild(apiKeyLabel);
			const apiKeyInput = createClaudeInput({
				type: 'password',
				value: settings.apiKey || '',
				placeholder: 'Enter your API key'
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
			baseUrlLabel.textContent = 'Base URL (optional)';
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
			baseUrlHint.textContent = 'For OpenAI-compatible APIs (LocalAI, vLLM, etc.)';
			baseUrlSection.appendChild(baseUrlHint);
			content.appendChild(baseUrlSection);

			// Voice select
			const voiceSection = document.createElement('div');
			voiceSection.className = 'mb-4';
			voiceSection.id = 'voiceSection';
			voiceSection.style.display = isNative(settings.provider) ? 'none' : 'block';
			const voiceLabel = document.createElement('label');
			voiceLabel.className = CLAUDE_CLASSES.LABEL;
			voiceLabel.textContent = 'Voice';
			voiceSection.appendChild(voiceLabel);

			const voiceOptions = voices.length > 0
				? voices.map(v => ({ value: v.voice_id, label: v.name }))
				: [{ value: '', label: currentProviderInfo.requiresApiKey ? 'Set an API key...' : 'Loading...' }];
			const voiceSelect = createClaudeSearchableSelect(voiceOptions, settings.voice || '');
			voiceSelect.id = 'voiceSelect';
			voiceSelect.disabled = currentProviderInfo.requiresApiKey && !settings.apiKey;
			voiceSection.appendChild(voiceSelect);
			// ElevenLabs applies each voice's last-used generation settings (we don't send voice_settings).
			const elevenVoiceHint = document.createElement('p');
			elevenVoiceHint.id = 'elevenVoiceHint';
			elevenVoiceHint.className = 'text-text-500 text-xs mt-1';
			elevenVoiceHint.textContent = 'Uses this voice’s last-used settings (stability, style, speed…) — adjust them on the ElevenLabs playground at elevenlabs.io.';
			elevenVoiceHint.style.display = settings.provider === 'elevenlabs' ? 'block' : 'none';
			voiceSection.appendChild(elevenVoiceHint);
			content.appendChild(voiceSection);

			// Model select
			const modelSection = document.createElement('div');
			modelSection.className = 'mb-4';
			modelSection.id = 'modelSelectSection';
			const modelLabel = document.createElement('label');
			modelLabel.className = CLAUDE_CLASSES.LABEL;
			modelLabel.textContent = 'Model';
			modelSection.appendChild(modelLabel);

			const modelOptions = models.length > 0
				? models.map(m => ({ value: m.model_id, label: m.name }))
				: [{ value: '', label: currentProviderInfo.requiresApiKey ? 'Set an API key...' : 'Loading...' }];
			const modelSelect = createClaudeSelect(modelOptions, settings.model || '');
			modelSelect.id = 'modelSelect';
			modelSelect.disabled = currentProviderInfo.requiresApiKey && !settings.apiKey;
			modelSection.appendChild(modelSelect);
			modelSection.style.display = (isNative(settings.provider) || useCustomModel(settings.provider, settings.openaiBaseUrl)) ? 'none' : 'block';
			content.appendChild(modelSection);

			// Custom model input (OpenAI with a custom Base URL)
			const modelCustomSection = document.createElement('div');
			modelCustomSection.className = 'mb-4';
			modelCustomSection.id = 'modelCustomSection';
			modelCustomSection.style.display = (!isNative(settings.provider) && useCustomModel(settings.provider, settings.openaiBaseUrl)) ? 'block' : 'none';
			const modelCustomLabel = document.createElement('label');
			modelCustomLabel.className = CLAUDE_CLASSES.LABEL;
			modelCustomLabel.textContent = 'Model';
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
			modelCustomHint.textContent = 'Model name for the custom endpoint';
			modelCustomSection.appendChild(modelCustomHint);
			content.appendChild(modelCustomSection);

			// Auto-speak toggle
			const autoSpeakSection = document.createElement('div');
			autoSpeakSection.className = 'mb-4';
			const autoSpeakToggle = createClaudeToggle('Auto-speak on new message', settings.autoSpeak, null);
			autoSpeakSection.appendChild(autoSpeakToggle.container);
			const autoSpeakNote = document.createElement('p');
			autoSpeakNote.className = CLAUDE_CLASSES.TEXT_MUTED + ' mt-1';
			autoSpeakNote.textContent = 'Only works on normal chats (not cowork, not code)';
			autoSpeakSection.appendChild(autoSpeakNote);
			content.appendChild(autoSpeakSection);

			// Per-Chat Settings Section
			const perChatSection = document.createElement('div');
			perChatSection.className = 'border-t border-border-300 pt-4 mt-4';

			const perChatHeading = document.createElement('h4');
			perChatHeading.className = 'text-sm font-semibold text-text-200 mb-3';
			perChatHeading.textContent = 'Per-Chat Settings';
			perChatSection.appendChild(perChatHeading);

			// Quotes only toggle
			const quotesSection = document.createElement('div');
			quotesSection.className = 'mb-4';
			const quotesOnlyToggle = createClaudeToggle('Only speak quoted text', chatQuotesOnly, null);
			createClaudeTooltip(quotesOnlyToggle.container, 'Quick dialogue-only playback using regex (instant, no API call)');
			quotesSection.appendChild(quotesOnlyToggle.container);
			perChatSection.appendChild(quotesSection);

			// Voice override select
			const overrideSection = document.createElement('div');
			overrideSection.className = 'mb-4';
			const overrideLabel = document.createElement('label');
			overrideLabel.className = CLAUDE_CLASSES.LABEL;
			overrideLabel.textContent = 'Voice Override';
			overrideSection.appendChild(overrideLabel);

			const overrideOptions = [
				{ value: '', label: 'Use default voice' },
				...voiceOptions.filter(opt => opt.value) // Exclude "Set an API key..." option
			];
			const chatVoiceOverrideSelect = createClaudeSearchableSelect(overrideOptions, chatVoiceOverride);
			chatVoiceOverrideSelect.id = 'chatVoiceOverride';
			chatVoiceOverrideSelect.disabled = !settings.apiKey;
			overrideSection.appendChild(chatVoiceOverrideSelect);
			perChatSection.appendChild(overrideSection);

			// Actor mode section
			const actorSection = document.createElement('div');
			actorSection.className = 'mb-4';
			const actorContainer = document.createElement('div');
			actorContainer.className = 'flex items-center justify-between';

			const actorToggleContainer = document.createElement('div');
			actorToggleContainer.className = 'flex-1';
			const actorModeToggle = createClaudeToggle('Actor mode', actorModeEnabled, null);
			createClaudeTooltip(actorModeToggle.container, 'Multi-voice character assignment with AI attribution (+latency)');
			actorToggleContainer.appendChild(actorModeToggle.container);

			actorContainer.appendChild(actorToggleContainer);

			const configureActorsBtn = createClaudeButton('Configure Characters', 'secondary');
			configureActorsBtn.id = 'configureActorsBtn';
			configureActorsBtn.style.display = actorModeEnabled ? 'block' : 'none';
			configureActorsBtn.classList.add('ml-2');
			actorContainer.appendChild(configureActorsBtn);

			actorSection.appendChild(actorContainer);
			perChatSection.appendChild(actorSection);

			// Only add the per-chat section if we're in... a chat.
			if (window.location.href.includes('claude.ai/chat')) {
				content.appendChild(perChatSection);
			}

			// Create modal with new class
			const modal = new ClaudeModal('TTS Settings', content);

			modal.addCancel('Cancel');
			modal.addConfirm('Save', async () => {
				const newSettings = {
					provider: providerSelect.value,
					apiKey: apiKeyInput.value.trim(),
					voice: voiceSelect.value,
					model: useCustomModel(providerSelect.value, baseUrlInput.value)
						? modelCustomInput.value.trim()
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
						showClaudeAlert('API Key Error', `Invalid ${providerInfo.name} API key. Please check your key and try again.`);
						return false; // Don't save, keep modal open
					}
				} else if (providerInfo.requiresApiKey && !newSettings.apiKey) {
					showClaudeAlert('API Key Required', `${providerInfo.name} requires an API key. Please enter one.`);
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
				const native = isNative(newProviderKey);

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

				if (native) return; // nothing of ours to load

				const tempProvider = initializeProvider(newProviderKey);

				// Check if we need to load data
				if (newProviderInfo.requiresApiKey) {
					const currentApiKey = apiKeyInput.value.trim();
					if (!currentApiKey) {
						voiceSelect.populateOptions([{ value: '', label: 'Set an API key...' }]);
						modelSelect.populateOptions([{ value: '', label: 'Set an API key...' }]);
						return;
					}
				}

				// Show loading modal
				const loadingModal = createLoadingModal('Loading voices and models...');
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

					const newModelOptions = newModels.map(m => ({ value: m.model_id, label: m.name }));
					modelSelect.populateOptions(newModelOptions);

					loadingModal.destroy();
				} catch (error) {
					console.error('Failed to load provider data:', error);
					if (window.showErrorToast) window.showErrorToast('Failed to load provider data: ' + (error.message || error));
					loadingModal.destroy();
					showClaudeAlert('Loading Error', 'Failed to load provider data');
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
					const loadingModal = createLoadingModal('Validating API key...');
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

						chatVoiceOverrideSelect.populateOptions([
							{ value: '', label: 'Use default voice' },
							...newVoiceOptions
						]);

						const newModelOptions = newModels.map(m => ({ value: m.model_id, label: m.name }));
						modelSelect.populateOptions(newModelOptions);

						loadingModal.destroy();
					} else {
						loadingModal.destroy();
						showClaudeAlert('API Key Error', 'Invalid API key');
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
			showClaudeAlert('Error', 'Failed to load settings: ' + error.message);
			console.error('Settings modal error:', error);
		}
	}

	async function createActorConfigModal(apiKey, providerKey) {
		// Show loading modal immediately
		const loadingModal = createLoadingModal('Loading voices...');
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
				{ value: '', label: 'None' },
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
			instructionText.textContent = 'Assign voices to character names. If a voice is "None", that character\'s dialog will not be spoken.';
			headerDiv.appendChild(instructionText);

			// Control buttons
			const controlButtons = document.createElement('div');
			controlButtons.className = 'flex justify-end gap-2 mb-3';

			const addBtn = createClaudeButton(
				'<span class="flex items-center gap-1"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" stroke-linecap="round"/></svg>Add Character</span>',
				'secondary',
				null,
				true
			);

			const removeBtn = createClaudeButton(
				'<span class="flex items-center gap-1"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 16 16"><path d="M3 8h10" stroke-linecap="round"/></svg>Remove Last</span>',
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
			tableHeader.innerHTML = '<div>Character Name</div><div>Gender</div><div>Voice</div>';

			// Characters list container
			const charactersList = document.createElement('div');
			charactersList.id = 'charactersList';
			charactersList.className = 'max-h-96 overflow-y-auto';

			tableContainer.appendChild(tableHeader);
			tableContainer.appendChild(charactersList);

			const tipText = document.createElement('div');
			tipText.className = 'mt-3 text-xs text-text-400';
			tipText.textContent = 'Tip: Set Narrator to "None" to only speak dialogue. Set it to a voice to include narration.';

			charactersSection.appendChild(headerDiv);
			charactersSection.appendChild(controlButtons);

			// Add warning if voices couldn't load
			if (voices.length === 0 && apiKey) {
				const warningDiv = document.createElement('div');
				warningDiv.className = 'mb-3 p-2 bg-accent-100 border border-accent-200 rounded text-sm text-accent-600';
				warningDiv.textContent = 'Could not load voices. Please check your API key.';
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
					placeholder: 'e.g., Alice',
					value: character.name || ''
				});
				nameInput.classList.add('character-name');
				if (isNarrator) {
					nameInput.disabled = true;
					nameInput.className += ' opacity-60';
				}

				const genderOptions = [
					{ value: 'male', label: 'Male' },
					{ value: 'female', label: 'Female' },
					{ value: 'other', label: 'Other' }
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
			const modal = new ClaudeModal('Character Voice Configuration', contentContainer);

			modal.addCancel('Cancel');
			modal.addConfirm('Save', async () => {
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
			showClaudeAlert('Error', 'Failed to load character configuration: ' + error.message);
			console.error('Actor config modal error:', error);
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
		button.classList.toggle('tts-custom-provider', !!provider && provider !== 'claude');
	}
	//#endregion

	//#region Config sync + Migration
	// Gate: hijack the native TTS socket only when a premium provider is fully configured.
	async function computeHijack() {
		const [provider, apiKey, voice] = await Promise.all([
			settingsRegistry.get(T.PROVIDER),
			settingsRegistry.get(T.API_KEY),
			settingsRegistry.get(T.VOICE)
		]);
		return !!provider && provider !== 'claude' && !!apiKey && !!voice;
	}

	async function pushHijackConfig() {
		window.postMessage({ type: 'TTS_HIJACK_CONFIG', hijack: await computeHijack() }, '*');
	}

	// One-time migration from the old enable-toggle to the provider-as-gate model.
	async function migrateEnabledSetting() {
		const raw = await chrome.storage.local.get(T.ENABLED.key);
		if (!(T.ENABLED.key in raw)) return; // never set, or already migrated
		const legacyEnabled = raw[T.ENABLED.key];
		const provider = await settingsRegistry.get(T.PROVIDER);
		// Disabled users, and Browser-provider users (Browser dropped), fall back to native TTS.
		if (legacyEnabled === false || provider === 'browser') {
			await settingsRegistry.set(T.PROVIDER, 'claude');
		}
		await chrome.storage.local.remove(T.ENABLED.key); // absence marks migration complete
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
		await migrateEnabledSetting();
		ButtonBar.register({
			buttonClass: 'tts-settings-button',
			createFn: createSettingsButton,
			tooltip: 'TTS Settings',
			forceDisplayOnMobile: true,
			pages: ['chat', 'home', 'coworkHome', 'coworkChat'],
		});
		pushHijackConfig();
		// Re-push the hijack decision + recolor the icon whenever a relevant setting changes.
		[T.PROVIDER, T.API_KEY, T.VOICE, T.BASE_URL].forEach(k =>
			settingsRegistry.onChange(k, () => { pushHijackConfig(); refreshTTSButtonColor(); })
		);
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