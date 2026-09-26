// tts-providers.js
(function () {
	'use strict';


	//#region PCM Helpers
	// Native claude.ai TTS plays raw 16kHz mono s16le PCM. Providers stream PCM (ElevenLabs at
	// 16kHz, OpenAI at 24kHz); we normalize everything to 16kHz mono and hand ArrayBuffers back.

	// Stateful linear resampler (s16 mono, srcRate -> dstRate) safe across streamed chunks.
	class LinearResampler {
		constructor(srcRate, dstRate) {
			this.ratio = srcRate / dstRate;
			this.pos = 0;   // fractional read position, carried into the next chunk's index space
			this.prev = 0;  // last sample of the previous chunk, referenced at virtual index -1
		}

		process(int16) {
			if (int16.length === 0) return new Int16Array(0);
			const out = [];
			let t = this.pos;
			while (true) {
				const i0 = Math.floor(t);
				const i1 = i0 + 1;
				if (i1 >= int16.length) break; // need the next sample within this chunk
				const s0 = i0 < 0 ? this.prev : int16[i0];
				const s1 = int16[i1];
				out.push((s0 + (s1 - s0) * (t - i0)) | 0);
				t += this.ratio;
			}
			this.pos = t - int16.length; // shift remainder into the next chunk's index space
			this.prev = int16[int16.length - 1];
			return Int16Array.from(out);
		}
	}

	// Reads a provider's PCM stream, normalizes to 16kHz mono s16le, and emits ArrayBuffers via onChunk.
	async function pumpReaderToPCM16(reader, srcRate, signal, onChunk) {
		const resampler = srcRate === 16000 ? null : new LinearResampler(srcRate, 16000);
		let leftover = new Uint8Array(0);
		try {
			while (true) {
				if (signal?.aborted) { await reader.cancel().catch(() => {}); return; }
				const { done, value } = await reader.read();
				if (done) break;
				const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
				const combined = new Uint8Array(leftover.length + chunk.length);
				combined.set(leftover);
				combined.set(chunk, leftover.length);
				const nSamples = combined.length >> 1;
				const usable = nSamples << 1;
				leftover = combined.slice(usable); // 0 or 1 trailing byte across the boundary
				if (nSamples === 0) continue;
				if (resampler) {
					const int16 = new Int16Array(combined.buffer, 0, nSamples);
					const resampled = resampler.process(int16);
					if (resampled.length) onChunk(resampled.buffer.slice(0, resampled.byteLength));
				} else {
					onChunk(combined.buffer.slice(0, usable));
				}
			}
		} catch (e) {
			if (e.name !== 'AbortError') throw e;
		}
	}
	//#endregion

	//#region Base Provider
	class Provider {
		constructor(onStateChange = null) {
			this.onStateChange = onStateChange;
		}

		async getVoices(apiKey) {
			throw new Error('getVoices must be implemented by provider');
		}

		async getModels(apiKey) {
			throw new Error('getModels must be implemented by provider');
		}

		async testApiKey(apiKey) {
			throw new Error('testApiKey must be implemented by provider');
		}

		async attributeDialogueToCharacters(text, characters) {
			throw new Error('attributeDialogueToCharacters must be implemented by provider');
		}

		// Produce 16kHz mono s16le PCM for `text`, invoking onChunk(ArrayBuffer) as audio is generated.
		// `signal` (AbortSignal) cancels in-flight generation.
		async synthesize(text, voice, model, apiKey, extra, signal, onChunk) {
			throw new Error('synthesize must be implemented by provider');
		}
	}
	//#endregion

	//#region ElevenLabs Provider
	class ElevenLabsProvider extends Provider {
		constructor(onStateChange = null) {
			super(onStateChange);
			this.modelCharLimits = {};
		}

		async fetchModelCharLimits(apiKey) {
			if (Object.keys(this.modelCharLimits).length > 0) return;
			try {
				const [userResponse, models] = await Promise.all([
					fetch('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': apiKey } }),
					this.getModels(apiKey)
				]);
				const isFree = userResponse.ok && (await userResponse.json()).subscription?.status === 'free';
				for (const model of models) {
					const limit = isFree
						? model.max_characters_request_free_user
						: model.max_characters_request_subscribed_user;
					if (limit) this.modelCharLimits[model.model_id] = limit;
				}
			} catch (e) {
				console.warn('Failed to fetch ElevenLabs model char limits:', e);
			}
		}

		async getVoices(apiKey) {
			if (!apiKey) {
				return [];
			}

			const allVoices = [];
			let hasMore = true;
			let nextPageToken = null;

			try {
				while (hasMore) {
					let url = 'https://api.elevenlabs.io/v2/voices?page_size=100';
					if (nextPageToken) {
						url += `&next_page_token=${nextPageToken}`;
					}

					const response = await fetch(url, {
						headers: {
							'xi-api-key': apiKey
						}
					});

					if (!response.ok) {
						console.error('Failed to fetch voices:', response.status);
						return allVoices;
					}

					const data = await response.json();

					if (data.voices && data.voices.length > 0) {
						allVoices.push(...data.voices);
						nextPageToken = data.next_page_token;
						hasMore = data.has_more === true;
					} else {
						hasMore = false;
					}
				}

				allVoices.sort((a, b) => a.name.localeCompare(b.name));
				return allVoices;

			} catch (error) {
				console.error('Error fetching voices:', error);
				return allVoices;
			}
		}

		async getModels(apiKey) {
			if (!apiKey) {
				return [];
			}

			try {
				const response = await fetch('https://api.elevenlabs.io/v1/models', {
					headers: { 'xi-api-key': apiKey }
				});

				if (!response.ok) {
					console.error('Failed to fetch models:', response.status);
					return [];
				}

				const models = await response.json();
				return models.filter(model => model.can_do_text_to_speech).map(model => ({
					model_id: model.model_id,
					name: model.name,
					can_do_text_to_speech: model.can_do_text_to_speech,
					max_characters_request_free_user: model.max_characters_request_free_user,
					max_characters_request_subscribed_user: model.max_characters_request_subscribed_user
				}));

			} catch (error) {
				console.error('Failed to load models:', error);
				return [{
					model_id: 'eleven_multilingual_v2',
					name: 'Multilingual v2',
					can_do_text_to_speech: true
				}];
			}
		}

		async testApiKey(apiKey) {
			try {
				const response = await fetch('https://api.elevenlabs.io/v1/user', {
					headers: {
						'xi-api-key': apiKey
					}
				});
				return response.ok;
			} catch (error) {
				return false;
			}
		}

		async attributeDialogueToCharacters(text, characters, model) {
			const narratorChar = characters.find(c => c.name.toLowerCase() === 'narrator');
			const includeNarration = narratorChar && narratorChar.voice;
			const availableCharacters = includeNarration
				? characters.map(c => c.name)
				: characters.filter(c => c.name.toLowerCase() !== 'narrator').map(c => c.name);

			// Check if we're using v3 model for emotion tags
			const isV3 = model && model.toLowerCase().includes('v3');

			let prompt;
			if (isV3) {
				prompt = `Output ONLY a JSON array where each element has "character" and "text" fields.
Available characters: ${availableCharacters.join(', ')}

${includeNarration ? 'Include narration as "narrator".' : 'Only include quoted dialogue, skip narration.'}

IMPORTANT: Prefix each text segment with an expression tag in square brackets. Examples: [neutral], [happy], [shouting], [angry] and so on. Simple words.

Example: {"character": "Alice", "text": "[sad]I can't believe this happened."}

Analyze this text and output ONLY the JSON array:
${text}

JSON array:`;
			} else {
				// Basic prompt without emotion tags
				prompt = `Output ONLY a JSON array where each element has "character" and "text" fields.
Available characters: ${availableCharacters.join(', ')}

${includeNarration ? 'Include narration as "narrator".' : 'Only include quoted dialogue, skip narration.'}

Analyze this text and output ONLY the JSON array:
${text}

JSON array:`;
			}

			return new Promise((resolve, reject) => {
				const requestId = Math.random().toString(36).substr(2, 9);

				const listener = (event) => {
					if (event.data.type === 'tts-analyze-dialogue-response' &&
						event.data.requestId === requestId) {
						window.removeEventListener('message', listener);

						if (event.data.success) {
							try {
								const jsonMatch = event.data.data.match(/\[[\s\S]*\]/);
								if (!jsonMatch) {
									throw new Error('No JSON array found in response');
								}

								const parsed = JSON.parse(jsonMatch[0]);
								const segments = parsed.map(s => ({
									character: s.character.toLowerCase(),
									text: s.text, // Keep emotion tags in text
									extra: {}
								}));

								resolve(segments);
							} catch (error) {
								console.error('Failed to parse attribution response:', error);
								reject(error);
							}
						} else {
							reject(new Error(event.data.error));
						}
					}
				};

				window.addEventListener('message', listener);

				window.postMessage({
					type: 'tts-analyze-dialogue-request',
					prompt: prompt,
					requestId: requestId
				}, '*');

				setTimeout(() => {
					window.removeEventListener('message', listener);
					reject(new Error('Dialogue analysis timed out'));
				}, 30000);
			});
		}

		async streamText(text, voiceId, modelId, apiKey, signal) {
			const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_16000`;
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'xi-api-key': apiKey,
				},
				body: JSON.stringify({
					text: text,
					model_id: modelId,
					apply_text_normalization: (modelId.includes("turbo") || modelId.includes("flash")) ? "off" : "on"
				}),
				signal: signal
			});

			if (!response.ok) {
				const error = await response.text();
				throw new Error(`ElevenLabs API error: ${response.status} - ${error}`);
			}

			return response.body.getReader();
		}

		chunkText(text, maxLength) {
			if (text.length <= maxLength) {
				return [text];
			}

			const chunks = [];
			let currentChunk = '';

			const sentences = text.split(/(?<=[.!?])\s+/);

			for (const sentence of sentences) {
				if ((currentChunk + sentence).length > maxLength) {
					if (currentChunk) {
						chunks.push(currentChunk.trim());
						currentChunk = '';
					}

					if (sentence.length > maxLength) {
						const words = sentence.split(' ');
						for (const word of words) {
							if ((currentChunk + ' ' + word).length > maxLength) {
								if (currentChunk) {
									chunks.push(currentChunk.trim());
									currentChunk = '';
								}
							}
							currentChunk += (currentChunk ? ' ' : '') + word;
						}
					} else {
						currentChunk = sentence;
					}
				} else {
					currentChunk += (currentChunk ? ' ' : '') + sentence;
				}
			}

			if (currentChunk) {
				chunks.push(currentChunk.trim());
			}

			return chunks;
		}

		async synthesize(text, voice, model, apiKey, extra, signal, onChunk) {
			await this.fetchModelCharLimits(apiKey);
			const maxChars = this.modelCharLimits[model] ?? 4900; // Default to 4900 if limit not found
			const chunks = this.chunkText(text, maxChars);

			for (const chunk of chunks) {
				if (signal?.aborted) return;
				const reader = await this.streamText(chunk, voice, model, apiKey, signal);
				await pumpReaderToPCM16(reader, 16000, signal, onChunk); // ElevenLabs already at 16kHz
			}
		}
	}
	//#endregion

	//#region OpenAI Provider
	class OpenAIProvider extends Provider {
		static DEFAULT_BASE_URL = 'https://api.openai.com';

		constructor(onStateChange = null) {
			super(onStateChange);
		}

		async getVoices(apiKey) {
			return [
				{ voice_id: 'alloy', name: 'Alloy' },
				{ voice_id: 'ash', name: 'Ash' },
				{ voice_id: 'ballad', name: 'Ballad' },
				{ voice_id: 'coral', name: 'Coral' },
				{ voice_id: 'echo', name: 'Echo' },
				{ voice_id: 'fable', name: 'Fable' },
				{ voice_id: 'onyx', name: 'Onyx' },
				{ voice_id: 'nova', name: 'Nova' },
				{ voice_id: 'sage', name: 'Sage' },
				{ voice_id: 'shimmer', name: 'Shimmer' },
				{ voice_id: 'verse', name: 'Verse' }
			];
		}

		async getModels(apiKey) {
			return [
				{ model_id: 'gpt-4o-mini-tts', name: 'GPT-4o Mini TTS', can_do_text_to_speech: true }
			];
		}

		async testApiKey(apiKey, baseUrl = '') {
			const base = baseUrl || OpenAIProvider.DEFAULT_BASE_URL;
			try {
				const response = await fetch(`${base}/v1/models`, {
					headers: {
						'Authorization': `Bearer ${apiKey}`
					}
				});
				return response.ok;
			} catch (error) {
				return false;
			}
		}

		async attributeDialogueToCharacters(text, characters) {
			// Build OpenAI-specific prompt
			const narratorChar = characters.find(c => c.name.toLowerCase() === 'narrator');
			const includeNarration = narratorChar && narratorChar.voice;
			const availableCharacters = includeNarration
				? characters.map(c => c.name)
				: characters.filter(c => c.name.toLowerCase() !== 'narrator').map(c => c.name);

			const prompt = `Output ONLY a JSON array where each element has:
- "character": one of [${availableCharacters.join(', ')}]
- "text": the dialogue or narration text
- "instructions": brief voice instruction (e.g., "speak sadly", "whisper excitedly", "calm and measured")

${includeNarration ? 'Include narration as "narrator".' : 'Only include quoted dialogue, skip narration.'}

Analyze this text and output ONLY the JSON array:
${text}

JSON array:`;

			return new Promise((resolve, reject) => {
				const requestId = Math.random().toString(36).substr(2, 9);

				const listener = (event) => {
					if (event.data.type === 'tts-analyze-dialogue-response' &&
						event.data.requestId === requestId) {
						window.removeEventListener('message', listener);

						if (event.data.success) {
							try {
								// Parse JSON from response
								const jsonMatch = event.data.data.match(/\[[\s\S]*\]/);
								if (!jsonMatch) {
									throw new Error('No JSON array found in response');
								}

								const parsed = JSON.parse(jsonMatch[0]);
								const segments = parsed.map(s => ({
									character: s.character.toLowerCase(),
									text: s.text,
									extra: { instructions: s.instructions || '' }
								}));

								resolve(segments);
							} catch (error) {
								console.error('Failed to parse attribution response:', error);
								reject(error);
							}
						} else {
							reject(new Error(event.data.error));
						}
					}
				};

				window.addEventListener('message', listener);

				window.postMessage({
					type: 'tts-analyze-dialogue-request',
					prompt: prompt,
					requestId: requestId
				}, '*');

				setTimeout(() => {
					window.removeEventListener('message', listener);
					reject(new Error('Dialogue analysis timed out'));
				}, 30000);
			});
		}

		async streamText(text, voiceId, modelId, apiKey, extra = {}) {
			const baseUrl = extra.baseUrl || OpenAIProvider.DEFAULT_BASE_URL;
			const body = {
				input: text,
				model: modelId,
				voice: voiceId,
				response_format: 'pcm'
			};

			// Add instructions if present and model supports it
			if (extra.instructions && modelId === 'gpt-4o-mini-tts') {
				body.instructions = extra.instructions;
			}

			const response = await fetch(`${baseUrl}/v1/audio/speech`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${apiKey}`,
				},
				body: JSON.stringify(body),
				signal: extra.signal
			});

			if (!response.ok) {
				const error = await response.text();
				throw new Error(`OpenAI API error: ${response.status} - ${error}`);
			}

			return response.body.getReader();
		}

		chunkText(text, maxLength) {
			if (text.length <= maxLength) {
				return [text];
			}

			const chunks = [];
			let currentChunk = '';

			const sentences = text.split(/(?<=[.!?])\s+/);

			for (const sentence of sentences) {
				if ((currentChunk + sentence).length > maxLength) {
					if (currentChunk) {
						chunks.push(currentChunk.trim());
						currentChunk = '';
					}

					if (sentence.length > maxLength) {
						const words = sentence.split(' ');
						for (const word of words) {
							if ((currentChunk + ' ' + word).length > maxLength) {
								if (currentChunk) {
									chunks.push(currentChunk.trim());
									currentChunk = '';
								}
							}
							currentChunk += (currentChunk ? ' ' : '') + word;
						}
					} else {
						currentChunk = sentence;
					}
				} else {
					currentChunk += (currentChunk ? ' ' : '') + sentence;
				}
			}

			if (currentChunk) {
				chunks.push(currentChunk.trim());
			}

			return chunks;
		}

		async synthesize(text, voice, model, apiKey, extra, signal, onChunk) {
			const chunks = this.chunkText(text, 4096);

			for (const chunk of chunks) {
				if (signal?.aborted) return;
				const reader = await this.streamText(chunk, voice, model, apiKey, { ...extra, signal });
				await pumpReaderToPCM16(reader, 24000, signal, onChunk); // OpenAI PCM is 24kHz -> resample
			}
		}
	}
	//#endregion


	// Export to window for use by main script
	window.TTSProviders = {
		TTS_PROVIDERS: {
			claude: {
				name: localize('tts.provider_claude_builtin'),
				requiresApiKey: false,
				native: true, // passthrough: let claude.ai's own TTS play, no hijack
				class: null
			},
			elevenlabs: {
				name: 'ElevenLabs',
				requiresApiKey: true,
				class: ElevenLabsProvider
			},
			openai: {
				name: 'OpenAI',
				requiresApiKey: true,
				class: OpenAIProvider
			}
		}
	};
})();