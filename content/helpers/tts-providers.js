// tts-providers.js
(function () {
	'use strict';
	const log = createLogger('TTSProviders');


	//#region PCM Helpers
	// Providers stream PCM (ElevenLabs at 16kHz, OpenAI at 24kHz); we normalize everything to 16kHz mono
	// s16le and hand ArrayBuffers back. tts-ws-interceptor.js turns that into whatever the native player
	// asked for (Opus packets nowadays).

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

		// Actor mode: Claude (FAST_MODEL) splits `text` into segments, each with the character whose voice
		// reads it, and submits them through a client tool (structuredCall), so there's no JSON to dig
		// out of a text reply. `rules` adds provider-specific instructions to the prompt, `extraFields`
		// per-segment string fields to the tool's schema. Returns [{ character (lowercased), text, extra }],
		// extra holding the extraFields.
		async splitIntoSegments(text, characters, { rules = '', extraFields = {} } = {}) {
			const narratorChar = characters.find(c => c.name.toLowerCase() === 'narrator');
			const includeNarration = narratorChar && narratorChar.voice;
			const availableCharacters = includeNarration
				? characters.map(c => c.name)
				: characters.filter(c => c.name.toLowerCase() !== 'narrator').map(c => c.name);

			const prompt = `Split the text below into segments for reading aloud, in order, and submit them with the submit_segments tool.
Available characters: ${availableCharacters.join(', ')}

${includeNarration ? 'Include narration as "narrator".' : 'Only include quoted dialogue, skip narration.'}
A character's segments hold only their spoken words, without quotation marks: dialogue tags like "she said" and any other narration ${includeNarration ? 'go to the narrator' : 'are skipped'}.
${rules}
Text:
${text}`;

			const segment = { type: 'object', properties: { character: { type: 'string' }, text: { type: 'string' }, ...extraFields }, required: ['character', 'text'] };
			const input = await structuredCall(prompt, {
				name: 'submit_segments',
				description: 'Submit the text split into segments, in reading order, each with the character who speaks it.',
				schema: { type: 'object', properties: { segments: { type: 'array', items: segment } }, required: ['segments'] },
			});

			const segments = input?.segments;
			if (!Array.isArray(segments) || !segments.every(s => typeof s?.character === 'string' && typeof s.text === 'string')) {
				throw new Error('Dialogue analysis returned malformed segments');
			}
			return segments.map(s => ({
				character: s.character.toLowerCase(),
				text: s.text,
				extra: Object.fromEntries(Object.keys(extraFields).map(k => [k, typeof s[k] === 'string' ? s[k] : ''])),
			}));
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
				log.warn('Failed to fetch ElevenLabs model char limits:', e);
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
						log.error('Failed to fetch voices:', response.status);
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
				log.error('Error fetching voices:', error);
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
					log.error('Failed to fetch models:', response.status);
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
				log.error('Failed to load models:', error);
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
			// Eleven v3 and v4 (eleven_v3, eleven_v4, eleven_v4_turbo) take audio tags. The rules are
			// adapted from ElevenLabs' own "Enhance" prompt (docs: Text to Speech best practices,
			// "Enhancing input"), minus its output format, which the tool replaces.
			const takesAudioTags = /(^|_)v[34]($|_)/i.test(model || '');
			const audioTagRules = `
AUDIO TAGS: add audio tags to each segment's "text" to make it more expressive when spoken, while STRICTLY preserving the original words and meaning.
- Tags go in square brackets, typically right before the part they modify or right after it, e.g. "[annoyed] This is hard." or "This is hard. [sighs]".
- Tags MUST describe something auditory, and only for the voice: no music or sound effects, and no tags like [standing], [grinning], [pacing], [music].
- Make them contextually appropriate, matching the emotion and subtext of each line, and vary them across the dialogue (energetic, relaxed, casual, surprised, thoughtful...).
- DO NOT alter, add or remove any words of the original text, narration included, and never put original text inside brackets.
- DO NOT turn existing narrative descriptions into tags: if the text says "He laughed loudly", keep it and add a tag only if it fits, e.g. "He laughed loudly [chuckles]".
- DO NOT pick tags that contradict or change the meaning or intent of a line.
- You may add emphasis without changing the words: capitalize some words, or add a question mark, an exclamation mark or ellipses where it makes sense.
Directions (non-exhaustive, similar ones are fine): [happy], [sad], [excited], [angry], [whisper], [annoyed], [appalled], [thoughtful], [surprised]
Non-verbal (non-exhaustive, similar ones are fine): [laughing], [chuckles], [sighs], [clears throat], [short pause], [long pause], [exhales sharply], [inhales deeply]
Example segments:
{"character": "Alice", "text": "[appalled] Are you serious? [sighs] I can't believe you did that!"}
{"character": "Bob", "text": "I guess you're right. [sighs] It's just... [muttering] difficult."}
`;
			return this.splitIntoSegments(text, characters, { rules: takesAudioTags ? audioTagRules : '' }); // tags stay in the text
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
			return this.splitIntoSegments(text, characters, {
				rules: 'Give every segment a brief voice instruction in "instructions" (e.g. "speak sadly", "whisper excitedly", "calm and measured").\n',
				extraFields: { instructions: { type: 'string', description: 'Brief voice instruction for the segment.' } },
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