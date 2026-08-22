// exporter.js
// Chat export and import functionality for Claude.ai
// Depends on: claude-styles.js, phantom-messages.js, claude-api.js

(function () {
	'use strict';

	// Global role configuration
	const ROLES = {
		USER: {
			apiName: "human",
			exportDelimiter: "User",
			librechatName: "User",
			tavernName: "User"
		},
		ASSISTANT: {
			apiName: "assistant",
			exportDelimiter: "Assistant",
			librechatName: "Claude",
			tavernName: "Claude"
		}
	};
	const EXPORT_TAG_PREFIX = 'CLEXP:';
	const TAG_REGEX = new RegExp(`^\\[${EXPORT_TAG_PREFIX}([\\da-zA-Z_-]+)(?::(\\d+))?\\]$`);
	const ATTACHMENT_DELIMITER_REGEX = /\n*=====ATTACHMENT_BEGIN: .+?=====\n[\s\S]*?\n=====ATTACHMENT_END=====/g;

	let bulkExportCancelled = false;

	function makeUniqueFilename(filename, uuid) {
		const lastDot = filename.lastIndexOf('.');
		if (lastDot === -1) return `${filename}-${uuid}`;
		return `${filename.substring(0, lastDot)}-${uuid}${filename.substring(lastDot)}`;
	}

	// Replicates SillyTavern's own humanizedDateTime(): YYYY-MM-DD@HHhMMmSSsMSms, local time.
	function humanizedDateTime(timestamp) {
		const parsed = timestamp ? new Date(timestamp) : new Date();
		const date = isNaN(parsed.getTime()) ? new Date() : parsed;
		const pad = (value, length = 2) => String(value).padStart(length, '0');
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
			`@${pad(date.getHours())}h${pad(date.getMinutes())}m${pad(date.getSeconds())}s${pad(date.getMilliseconds(), 3)}ms`;
	}

	//#region Export format handlers
	function formatTxtExport(conversationData, messages, conversationId) {
		let output = `Settings: ${JSON.stringify(conversationData.settings || {})}\n`;
		output += `Title: ${conversationData.name}\nDate: ${conversationData.updated_at}\n\n`;

		for (const message of messages) {
			// Message boundary
			const roleDelimiter = message.sender === ROLES.USER.apiName ? ROLES.USER.exportDelimiter : ROLES.ASSISTANT.exportDelimiter;
			const isoTimestamp = message.created_at || message.updated_at;
			const timestamp = isoTimestamp ? new Date(isoTimestamp).getTime() : '';
			const timestampSuffix = timestamp ? `:${timestamp}` : '';
			output += `[${EXPORT_TAG_PREFIX}${roleDelimiter}${timestampSuffix}]\n`;

			// Content blocks
			for (const content of message.content) {
				if (content.type === 'text') {
					output += `[${EXPORT_TAG_PREFIX}content-text]\n${content.text}\n\n`;
				} else {
					// All other content types as JSON
					output += `[${EXPORT_TAG_PREFIX}content-${content.type}]\n${JSON.stringify(content)}\n\n`;
				}
			}

			// Files - split into files_v2 (ClaudeFile/ClaudeCodeExecutionFile) and attachments (ClaudeAttachment)
			const files_v2 = message.files
				.filter(f => !(f instanceof ClaudeAttachment))
				.map(f => f.toApiFormat());
			const attachments = message.files
				.filter(f => f instanceof ClaudeAttachment)
				.map(f => f.toApiFormat());

			if (files_v2.length > 0) {
				output += `[${EXPORT_TAG_PREFIX}files_v2]\n${JSON.stringify(files_v2)}\n\n`;
			}

			if (attachments.length > 0) {
				output += `[${EXPORT_TAG_PREFIX}attachments]\n${JSON.stringify(attachments)}\n\n`;
			}
		}

		return output;
	}

	async function formatMdExport(conversationData, messages, conversationId, includeThinking = true, includeAttachments = false) {
		let output = `# ${conversationData.name}\n\n`;
		if (conversationData.model) {
			output += `**Model:** ${conversationData.model}\n\n`;
		}

		for (const message of messages) {
			const role = message.sender === ROLES.USER.apiName ? 'User' : 'Assistant';
			output += `### ${role}\n\n`;

			for (const content of message.content) {
				if (content.type === 'thinking') {
					if (!includeThinking) continue;
					// Use last summary if available, fallback to "Thinking"
					let summaryText = 'Thinking';
					if (content.summaries && content.summaries.length > 0) {
						summaryText = content.summaries[content.summaries.length - 1].summary;
					}
					output += `<details>\n<summary>${summaryText}</summary>\n\n${content.thinking}\n\n</details>\n\n<br>\n\n`;
				} else if (content.type === 'text') {
					output += `${content.text}\n\n`;
				}
				// Skip all other content types (tool_use, tool_result, etc.)
			}

			if (includeAttachments) {
				for (const file of message.files) {
					if (file instanceof ClaudeAttachment) {
						output += `<details>\n<summary>Attachment: ${file.file_name}</summary>\n\n${file.extracted_content}\n\n</details>\n\n`;
					} else if (file instanceof ClaudeFile || file instanceof ClaudeCodeExecutionFile) {
						try {
							const blob = await file.download();
							if (!blob) continue;
							const wrapped = new File([blob], file.file_name);
							if (!(await isLikelyTextFile(wrapped))) continue;
							const text = await blob.text();
							output += `<details>\n<summary>Attachment: ${file.file_name}</summary>\n\n${text}\n\n</details>\n\n`;
						} catch (e) {
							console.warn(`Failed to download file ${file.file_name} for markdown export:`, e);
						}
					}
				}
			}

			output += `---\n\n`;
		}

		return output;
	}

	// SillyTavern chat file: JSONL, first line a header, one message per line after it.
	// Field names follow SillyTavern's own writer. Its importer copies the file verbatim into the
	// character's chat folder, so the shape has to be right on the way out - it only checks that the
	// header carries user_name, name or chat_metadata, and rejects the file outright otherwise.
	// No BOM either: it runs JSON.parse on the first line, which throws on a leading U+FEFF.
	function formatJsonlExport(conversationData, messages, conversationId) {
		const header = {
			user_name: ROLES.USER.tavernName,
			character_name: ROLES.ASSISTANT.tavernName,
			create_date: humanizedDateTime(conversationData.created_at),
			chat_metadata: {}
		};

		const lines = messages.map(msg => {
			const isUser = msg.sender === ROLES.USER.apiName;
			const text = ClaudeConversation.extractMessageText(msg);

			// Always carried: SillyTavern renders extra.reasoning as a collapsed block separate from
			// the message body, so it costs nothing the way inlined thinking does in markdown.
			const extra = {};
			const reasoning = msg.content
				.filter(c => c.type === 'thinking')
				.map(c => c.thinking || '')
				.filter(Boolean)
				.join('\n');
			if (reasoning) {
				extra.reasoning = reasoning;
				extra.reasoning_type = 'model';
			}

			const isoTimestamp = msg.created_at || msg.updated_at;
			const sendDate = isoTimestamp ? new Date(isoTimestamp) : new Date();

			return {
				name: isUser ? ROLES.USER.tavernName : ROLES.ASSISTANT.tavernName,
				is_user: isUser,
				is_system: false,
				send_date: (isNaN(sendDate.getTime()) ? new Date() : sendDate).toISOString(),
				mes: text,
				// A SillyTavern swipe is alternate text for one message, not a branch: the messages
				// after it stay put. Our regenerations are real subtrees, so they cannot round-trip
				// as swipes; we export the same single path the other formats do.
				swipe_id: 0,
				swipes: [text],
				extra
			};
		});

		return [header, ...lines].map(entry => JSON.stringify(entry)).join('\n') + '\n';
	}

	//#region Tool call helpers (shared by the LibreChat and HTML exports)

	// Claude emits a tool_use and its tool_result as sibling blocks in the same message, so results
	// pair up by id without having to look at neighbouring messages.
	function mapToolResultsById(content) {
		const byId = new Map();
		for (const item of content || []) {
			if (item.type === 'tool_result' && item.tool_use_id) {
				byId.set(item.tool_use_id, item);
			}
		}
		return byId;
	}

	function blobToDataUri(blob) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onloadend = () => resolve(reader.result);
			reader.onerror = () => reject(reader.error || new Error('Failed to read blob'));
			reader.readAsDataURL(blob);
		});
	}

	// Resolves to null rather than throwing — callers treat unknown dimensions as "not renderable"
	// instead of failing the whole export.
	function getImageSize(blob) {
		return new Promise((resolve) => {
			const url = URL.createObjectURL(blob);
			const img = new Image();
			img.onload = () => {
				const size = { width: img.naturalWidth, height: img.naturalHeight };
				URL.revokeObjectURL(url);
				resolve(size.width && size.height ? size : null);
			};
			img.onerror = () => {
				URL.revokeObjectURL(url);
				resolve(null);
			};
			img.src = url;
		});
	}

	// Tool-generated images never appear in msg.files (that only carries user uploads), so the
	// file_uuid on the tool_result is the only handle we get. /preview is the sole endpoint that
	// serves them — the bare file URL and the usual /document, /content and /download variants all
	// 404 — and it re-encodes to webp regardless of what the tool originally produced, so callers
	// should trust the returned mimeType over any filename the tool declared.
	async function downloadGeneratedImage(orgId, fileUuid) {
		const file = new ClaudeFile({
			file_uuid: fileUuid,
			file_name: fileUuid,
			file_kind: 'image',
			preview_url: `https://claude.ai/api/${orgId}/files/${fileUuid}/preview`
		});

		const blob = await file.download();
		if (!blob) return null;

		return {
			blob,
			mimeType: (blob.type || '').split(';')[0].trim(),
			dataUri: await blobToDataUri(blob),
			size: await getImageSize(blob)
		};
	}
	//#endregion

	//#region LibreChat tool calls

	// LibreChat hard-codes these tool names to purpose-built renderers that read from their own
	// context/schema instead of the tool call's `output` string (see Part.tsx). A Claude tool that
	// happens to share a name would render as an empty card, so it gets suffixed instead.
	const LIBRECHAT_RESERVED_TOOL_NAMES = new Set([
		'web_search', 'bash_tool', 'read_file', 'create_file', 'edit_file',
		'file_search', 'retrieval', 'skill', 'subagent', 'execute_code'
	]);

	// Model providers conventionally constrain tool names to [A-Za-z0-9_-], and Claude's MCP server
	// names can carry spaces and parens ("ComfyUI (Remote)"). Collapse each RUN of anything else to
	// a single '-'; collapsing rather than substituting per character matters because LibreChat
	// rewrites '---' to '.' when it renders the server name, and a per-character swap would emit
	// that run for a name like "ComfyUI (Remote)".
	function normalizeToolNamePart(part) {
		return part.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
	}

	// LibreChat names MCP tools `${tool}_mcp_${server}` (its mcp_delimiter is '_mcp_'); Claude names
	// them `Server:tool`. Translating gets us LibreChat's MCP chip and server icon, and the result
	// can never collide with the reserved names above.
	function toLibrechatToolName(name) {
		const sep = name.indexOf(':');
		if (sep > 0 && sep < name.length - 1) {
			return `${normalizeToolNamePart(name.slice(sep + 1))}_mcp_${normalizeToolNamePart(name.slice(0, sep))}`;
		}
		const normalized = normalizeToolNamePart(name);
		return LIBRECHAT_RESERVED_TOOL_NAMES.has(normalized) ? `${normalized}_claude` : normalized;
	}

	// Claude stores web_search/web_fetch results as `knowledge` stubs — title, url and favicon
	// metadata, but never the retrieved page text — so there is nothing faithful to export for them.
	// Gating on the content types we can actually represent (rather than a tool-name blocklist)
	// drops those automatically and degrades correctly for tools we haven't seen yet.
	function isExportableToolResult(result) {
		return (result?.content || []).some(item => item.type === 'text' || item.type === 'image');
	}

	// LibreChat only renders an image inline when its filename carries one of these extensions
	// (its imageExtRegex). Anything outside the set degrades to a download chip no matter what we
	// do, so an unexpected format is better skipped than mislabelled.
	const LIBRECHAT_IMAGE_EXTENSIONS = {
		'image/jpeg': 'jpg',
		'image/png': 'png',
		'image/gif': 'gif',
		'image/webp': 'webp',
		'image/heic': 'heic',
		'image/heif': 'heif'
	};

	// The filename is derived from the bytes we actually received rather than any name the tool
	// declared, since /preview re-encodes (see downloadGeneratedImage).
	async function buildGeneratedImageAttachment(orgId, fileUuid, toolCallId, messageId, conversationId) {
		const image = await downloadGeneratedImage(orgId, fileUuid);
		if (!image) return null;

		// LibreChat needs the filename extension, width, height and filepath ALL present to render
		// an attachment inline (isImageAttachment); missing any one silently degrades it to a
		// download chip, so bail out rather than emit a half-populated attachment.
		const extension = LIBRECHAT_IMAGE_EXTENSIONS[image.mimeType];
		if (!extension || !image.size) return null;

		return {
			file_id: fileUuid,
			filename: `${fileUuid}.${extension}`,
			filepath: image.dataUri,
			type: image.mimeType,
			width: image.size.width,
			height: image.size.height,
			bytes: image.blob.size,
			source: 'local',
			object: 'file',
			context: 'image_generation',
			toolCallId,
			messageId,
			conversationId
		};
	}
	//#endregion

	async function formatLibrechatExport(conversationData, messages, conversationId, options = {}, loadingModal = null) {
		const includeImages = options.includeImages ?? false;
		// Only needed to build preview URLs; skip the lookup entirely when images are off.
		const orgId = includeImages ? getOrgId() : null;
		let imagesDownloaded = 0;

		const processedMessages = [];
		for (const msg of messages) {
			// Convert attachments to LibreChat file format
			const files = [];
			let attachmentText = '';

			// Get attachments from message.files (filter for ClaudeAttachment instances)
			const attachments = msg.files.filter(f => f instanceof ClaudeAttachment);
			for (const attachment of attachments) {
				const text = attachment.extracted_content || '';

				// Add to files array (survives re-export, we can read it back)
				files.push({
					file_id: crypto.randomUUID(),
					bytes: attachment.file_size || text.length || 0,
					context: 'message_attachment',
					filename: attachment.file_name || 'unknown',
					object: 'file',
					source: 'text',
					text: text,
					type: attachment.file_type || 'text/plain'
				});

				// Also embed inline (so LibreChat's AI can see it)
				if (text) {
					attachmentText += `\n=====ATTACHMENT_BEGIN: ${attachment.file_name || 'unknown'}=====\n`;
					attachmentText += text;
					attachmentText += `\n=====ATTACHMENT_END=====\n\n`;
				}
			}

			const toolResultsById = mapToolResultsById(msg.content);

			// Build content array: think, text, and exportable tool calls
			const content = [];
			const imageAttachments = [];
			for (const item of msg.content) {
				if (item.type === 'thinking') {
					content.push({
						type: 'think',
						think: item.thinking || ''
					});
				} else if (item.type === 'text') {
					content.push({
						type: 'text',
						text: item.text || ''
					});
				} else if (item.type === 'tool_use') {
					// A tool_use with no result (interrupted generation) has nothing to show, and
					// one whose result we can't represent is dropped wholesale — see
					// isExportableToolResult.
					const result = toolResultsById.get(item.id);
					if (!result || !isExportableToolResult(result)) continue;

					content.push({
						type: 'tool_call',
						tool_call: {
							id: item.id,
							name: toLibrechatToolName(item.name || ''),
							args: JSON.stringify(item.input ?? {}),
							type: 'tool_call',
							progress: 1,
							output: (result.content || [])
								.filter(c => c.type === 'text')
								.map(c => c.text || '')
								.join('\n')
						}
					});

					if (!includeImages || !orgId) continue;
					for (const resultItem of result.content || []) {
						if (resultItem.type !== 'image' || !resultItem.file_uuid) continue;
						// Sequential with a short gap, matching the HTML export's file downloads,
						// so a bulk export doesn't trip rate limiting.
						if (imagesDownloaded > 0) await new Promise(r => setTimeout(r, 200));
						imagesDownloaded++;
						loadingModal?.setContent(createLoadingContent(`Downloading generated image ${imagesDownloaded}...`));
						try {
							const attachment = await buildGeneratedImageAttachment(
								orgId, resultItem.file_uuid, item.id, msg.uuid, conversationId
							);
							if (attachment) imageAttachments.push(attachment);
						} catch (e) {
							// An image that won't download shouldn't sink the whole export.
							console.error('[Exporter] Failed to embed generated image:', e);
						}
					}
				}
				// Skip everything else (tool_result is consumed above)
			}


			// Prepend attachment text to first text block (for user messages)
			if (attachmentText) {
				const firstTextIndex = content.findIndex(c => c.type === 'text');
				if (firstTextIndex !== -1) {
					content[firstTextIndex].text = attachmentText + content[firstTextIndex].text;
				} else {
					// No text block found, create one at the start
					content.unshift({ type: 'text', text: attachmentText.trim() });
				}
			}


			const message = {
				messageId: msg.uuid,
				parentMessageId: msg.parent_message_uuid === "00000000-0000-4000-8000-000000000000"
					? null
					: msg.parent_message_uuid,
				content: content,
				sender: msg.sender === ROLES.ASSISTANT.apiName ? ROLES.ASSISTANT.librechatName : ROLES.USER.librechatName,
				isCreatedByUser: msg.sender === ROLES.USER.apiName,
				createdAt: msg.created_at,
				text: content.filter(c => c.type === 'text').map(c => c.text).join('\n'),
			};

			if (files.length > 0) {
				message.files = files;
			}

			if (imageAttachments.length > 0) {
				message.attachments = imageAttachments;
			}

			processedMessages.push(message);
		}

		return JSON.stringify({
			title: conversationData.name,
			endpoint: "anthropic",
			conversationId: conversationId,
			options: {
				model: conversationData.model ?? DEFAULT_CLAUDE_MODEL
			},
			messages: processedMessages
		}, null, 2);
	}

	function formatRawExport(conversationData, messages, conversationId) {
		// Filter chat_messages to only include messages present in the export set
		const messageUuids = new Set(messages.map(m => m.uuid));
		const filtered = {
			...conversationData,
			chat_messages: conversationData.chat_messages.filter(m => messageUuids.has(m.uuid))
		};
		return JSON.stringify(filtered, null, 2);
	}


	//#region HTML export
	// HTML export stuff
	const EXPORT_SCAFFOLD = `
	<!DOCTYPE html>
	<html lang="en">
	<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>{{TITLE}}</title>
	<style>{{STYLESHEET}}</style>
	</head>
	<body data-default-leaf="{{DEFAULT_LEAF}}">
	{{MESSAGES}}
	<button id="theme-toggle"></button>
	<script id="conversation-tree" type="application/json">{{TREE_JSON}}</script>
	<script id="conversation-raw" type="text/plain">{{RAW_TXT}}</script>
	<script>{{SCRIPT}}</script>
	</body>
	</html>`.replace(/^\t{1}/gm, '').trim();

	let _templateCache = null;

	async function extractFontDataUris() {
		// Family names are compared with every non-alphanumeric character stripped, so
		// both "Anthropic Sans" and "anthropic-sans" normalise to anthropicsans.
		// claude.ai renamed these families from spaced to hyphenated; matching on
		// letters/digits only keeps us working across either spelling.
		const FONT_KEYS = {
			'anthropicsans/normal': '{{FONT_SANS_NORMAL}}',
			'anthropicsans/italic': '{{FONT_SANS_ITALIC}}',
			'anthropicserif/normal': '{{FONT_SERIF_NORMAL}}',
			'anthropicserif/italic': '{{FONT_SERIF_ITALIC}}',
			'anthropicmono/normal': '{{FONT_MONO}}',
			'jetbrains/normal': '{{FONT_MONO}}'
		};

		const result = new Map();
		const fontFaceRegex = /@font-face\s*\{[^}]*\}/g;
		const familyRegex = /font-family:\s*["']?([^;"'\n]+)/;
		const styleRegex = /font-style:\s*(\w+)/;
		const urlRegex = /url\(["']?([^"')]+\.woff2)["']?\)/;

		// Gather all stylesheet URLs
		const sheetUrls = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
			.map(link => link.href)
			.filter(Boolean);

		for (const sheetUrl of sheetUrls) {
			try {
				const cssText = await fetch(sheetUrl).then(r => r.text());
				const blocks = cssText.match(fontFaceRegex) || [];

				for (const block of blocks) {
					const familyMatch = block.match(familyRegex);
					const styleMatch = block.match(styleRegex);
					const urlMatch = block.match(urlRegex);
					if (!familyMatch || !urlMatch) continue;

					const family = familyMatch[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
					const style = (styleMatch && styleMatch[1]) || 'normal';
					const key = family + '/' + style;
					const placeholder = FONT_KEYS[key];
					if (!placeholder || result.has(placeholder)) continue;

					const response = await fetch(urlMatch[1]);
					const blob = await response.blob();
					const dataUri = await new Promise(resolve => {
						const reader = new FileReader();
						reader.onloadend = () => resolve(reader.result);
						reader.readAsDataURL(blob);
					});
					result.set(placeholder, dataUri);
				}
			} catch (e) {
				console.warn('Failed to process stylesheet:', sheetUrl, e);
			}
		}

		return result;
	}

	async function getExportTemplate() {
		if (_templateCache) return _templateCache;

		const base = chrome.runtime.getURL('html_template/');
		const [css, js] = await Promise.all([
			fetch(base + 'export-template.css').then(r => r.text()),
			fetch(base + 'export-template.js').then(r => r.text()),
		]);

		// Embed fonts as data URIs
		const fontMap = await extractFontDataUris();
		let processedCss = css;
		for (const [placeholder, dataUri] of fontMap) {
			// Function replacement, not a string: see the note on the template assembly
			// below. Base64 payloads can contain $& and would otherwise self-splice.
			processedCss = processedCss.replaceAll(placeholder, () => dataUri);
		}

		// Any placeholder we couldn't resolve (claude.ai renamed a family, moved the
		// stylesheet, etc.) would otherwise ship as a literal url("{{FONT_...}}").
		// Drop those @font-face blocks so the export falls back to the system stack
		// declared alongside each family instead of emitting broken CSS.
		const unresolved = processedCss.match(/\{\{FONT_[A-Z_]+\}\}/g);
		if (unresolved) {
			console.warn('Export: could not embed fonts', [...new Set(unresolved)].join(', '));
			processedCss = processedCss.replace(/@font-face\s*\{[^{}]*\{\{FONT_[A-Z_]+\}\}[^{}]*\}\s*/g, '');
		}

		_templateCache = EXPORT_SCAFFOLD
			.replace('{{STYLESHEET}}', () => processedCss)
			.replace('{{SCRIPT}}', () => js);

		return _templateCache;
	}

	const _escEl = document.createElement('span');
	function esc(str) {
		// textContent -> innerHTML escapes & < > but NOT the double quote, and we
		// interpolate this into attributes (alt, download, href). A filename or search
		// result title containing a quote would otherwise close the attribute early and
		// spill the rest into stray markup. Escaping it is harmless in text contexts,
		// where &quot; just renders as a quote.
		_escEl.textContent = str;
		return _escEl.innerHTML.replace(/"/g, '&quot;');
	}

	function safeEmbed(str) {
		return str.replace(/<\//g, '<\\/');
	}

	// Renders one tool call as a collapsible block, mirroring the thinking-block idiom. Images are
	// deliberately excluded — the caller emits those as always-visible siblings, since a generated
	// image is primary content rather than a detail worth hiding behind a toggle.
	function renderToolBlockHtml(toolUse, result) {
		const name = toolUse.name || 'tool';
		// `message` is Claude's own human-readable label ("Generate illustrated image"); it is not
		// always present, and when it is it can repeat the name, so only show both when they differ.
		const label = toolUse.message || name;
		const body = [];

		if (toolUse.input && Object.keys(toolUse.input).length > 0) {
			body.push(`<pre class="tool-args">${esc(JSON.stringify(toolUse.input, null, 2))}</pre>`);
		}

		if (!result) {
			// A tool_use with no tool_result means the generation was interrupted. Worth recording
			// in an archive: it says the call was attempted.
			body.push(`<div class="tool-empty">No result recorded.</div>`);
		} else {
			const texts = (result.content || [])
				.filter(item => item.type === 'text')
				.map(item => item.text || '')
				.filter(Boolean);
			if (texts.length > 0) {
				body.push(`<pre class="tool-output">${esc(texts.join('\n'))}</pre>`);
			}

			// web_search / web_fetch return `knowledge` stubs: title, url and site metadata, never
			// the retrieved page text. A source list is all that can be shown, but in an archive
			// that is still real content. Favicon URLs in the metadata are deliberately ignored —
			// they point at a remote service, and this export must open offline.
			const sources = (result.content || []).filter(item => item.type === 'knowledge');
			if (sources.length > 0) {
				const items = sources.map(source => {
					const site = source.metadata?.site_name || source.metadata?.site_domain || '';
					const title = esc(source.title || source.url || 'Untitled');
					const link = source.url
						? `<a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${title}</a>`
						: title;
					return `<li>${link}${site ? `<span class="tool-source-site">${esc(site)}</span>` : ''}</li>`;
				}).join('');
				body.push(`<ul class="tool-sources">${items}</ul>`);
			}
		}

		const nameTag = label === name ? '' : `<span class="tool-name">${esc(name)}</span>`;
		const failedTag = result?.is_error ? `<span class="tool-failed">failed</span>` : '';
		const errorClass = result?.is_error ? ' tool-error' : '';
		return `<details class="tool-block${errorClass}"><summary>${esc(label)}${nameTag}${failedTag}</summary>${body.join('')}</details>`;
	}

	async function formatHtmlExport(conversationData, messages, conversationId, options = {}) {
		// Defaults ON here, unlike the LibreChat export — HTML's whole point is fidelity, so the
		// toggle is an escape hatch from size/download time rather than an opt-in.
		const includeImages = options.includeImages ?? true;

		// Configure marked to use highlight.js for code blocks
		marked.use({
			breaks: true,
			gfm: true,
			renderer: {
				code({ text, lang }) {
					let highlighted;
					if (lang && hljs.getLanguage(lang)) {
						highlighted = hljs.highlight(text, { language: lang }).value;
					} else {
						highlighted = hljs.highlightAuto(text).value;
					}
					return `<pre><code class="hljs">${highlighted}</code></pre>`;
				}
			}
		});

		// Extract current branch for the raw txt embed (re-import)
		const messageMap = new Map(messages.map(m => [m.uuid, m]));
		const ROOT = '00000000-0000-4000-8000-000000000000';
		const defaultLeaf = conversationData.current_leaf_message_uuid;
		const linearBranch = [];
		let walkId = defaultLeaf;
		while (walkId && walkId !== ROOT && messageMap.has(walkId)) {
			linearBranch.push(messageMap.get(walkId));
			walkId = messageMap.get(walkId).parent_message_uuid;
		}
		linearBranch.reverse();

		const rawTxt = formatTxtExport(conversationData, linearBranch, conversationId);
		const title = conversationData.name || 'Untitled Conversation';

		// Build tree JSON for navigation
		const treeJson = messages.map(m => ({
			id: m.uuid,
			parent: m.parent_message_uuid,
			sender: m.sender
		}));

		// Needed to build preview URLs for tool-generated images; fail soft so a missing org id
		// costs us the images rather than the whole export.
		let orgId = null;
		try { orgId = getOrgId(); } catch (e) { console.warn('[Exporter] No org id; skipping generated images'); }

		// One pacer shared by generated-image and attachment downloads. Both run per message, so
		// per-loop delays would let a message carrying an image AND files fire two bursts back to
		// back — the delay exists to stay under rate limiting, so it has to span every download.
		let downloadCount = 0;
		const paceDownload = async () => {
			if (downloadCount > 0) await new Promise(r => setTimeout(r, 200));
			downloadCount++;
		};

		// Render ALL messages as hidden divs
		let messagesHtml = `<div class="export-meta"><h1>${esc(title)}</h1>`;
		if (conversationData.model) {
			messagesHtml += `<div class="export-model">Model: ${esc(conversationData.model)}</div>`;
		}
		messagesHtml += `</div>\n`;
		for (const message of messages) {
			const isUser = message.sender === ROLES.USER.apiName;
			const role = isUser ? 'User' : 'Assistant';
			const roleClass = isUser ? 'msg-user' : 'msg-assistant';

			const toolResultsById = mapToolResultsById(message.content);
			// Older conversations list a generated image BOTH in the tool_result and in
			// message.files; newer ones only in the tool_result. Track what the tool path actually
			// rendered so the file loop below can skip the duplicate. Recorded only on success, so
			// a failed download still falls back to the file entry (which resolves via a different
			// URL and may well work).
			const renderedImageUuids = new Set();

			let contentHtml = '';
			for (const content of message.content) {
				if (content.type === 'thinking') {
					let summaryText = 'Thinking';
					if (content.summaries && content.summaries.length > 0) {
						summaryText = content.summaries[content.summaries.length - 1].summary;
					}
					contentHtml += `<details class="thinking-block"><summary>${esc(summaryText)}</summary><pre class="thinking-content">${esc(content.thinking || '')}</pre></details>`;
				} else if (content.type === 'text') {
					contentHtml += `<div class="text-content">${marked.parse(content.text || '')}</div>`;
				} else if (content.type === 'tool_use') {
					const result = toolResultsById.get(content.id);
					contentHtml += renderToolBlockHtml(content, result);

					// Emitted after (not inside) the block so the image stays visible without the
					// reader having to expand anything, and lands inline where the tool ran rather
					// than with the file pills at the end of the message.
					for (const item of result?.content || []) {
						if (!includeImages || item.type !== 'image' || !item.file_uuid || !orgId) continue;
						try {
							await paceDownload();
							const image = await downloadGeneratedImage(orgId, item.file_uuid);
							if (image) {
								contentHtml += `<img class="tool-image" src="${image.dataUri}" alt="${esc(content.name || 'Generated image')}">`;
								renderedImageUuids.add(item.file_uuid);
							}
						} catch (e) {
							// One unavailable image shouldn't sink the whole export.
							console.error('[Exporter] Failed to embed generated image:', e);
						}
					}
				}
				// tool_result is consumed via its tool_use above
			}

			// Download files sequentially with delay to avoid rate limiting
			const fileResults = [];
			for (let fi = 0; fi < message.files.length; fi++) {
				const file = message.files[fi];
				// Already shown inline by the tool-result path above — don't embed it twice
				// (and don't pay for the download again).
				if (file.file_uuid && renderedImageUuids.has(file.file_uuid)) continue;
				if (file instanceof ClaudeAttachment) {
					const b64 = btoa(unescape(encodeURIComponent(file.extracted_content || '')));
					const mimeType = mime.getType(file.file_name) || 'text/plain';
					fileResults.push(`<a class="file-pill" href="data:${mimeType};base64,${b64}" download="${esc(file.file_name)}">File: ${esc(file.file_name)}</a>`);
					continue;
				}

				// Images dominate an export's size and download time. With them off, keep the record
				// of what was attached without paying for the bytes — or for the pacing delay.
				if (!includeImages && file.file_kind === 'image') {
					fileResults.push(`<span class="file-pill">File: ${esc(file.file_name)}</span>`);
					continue;
				}

				try {
					await paceDownload();
					const blob = await file.download();
					if (!blob) {
						fileResults.push(`<span class="file-pill">File: ${esc(file.file_name)}</span>`);
						continue;
					}

					const dataUri = await blobToDataUri(blob);

					if (file.file_kind === 'image') {
						fileResults.push(`<img src="${dataUri}" alt="${esc(file.file_name)}">`);
					} else {
						fileResults.push(`<a class="file-pill" href="${dataUri}" download="${esc(file.file_name)}">File: ${esc(file.file_name)}</a>`);
					}
				} catch (e) {
					fileResults.push(`<span class="file-pill">File: ${esc(file.file_name)}</span>`);
				}
			}

			contentHtml += fileResults.join('');
			const tsAttr = message.created_at ? ` data-timestamp="${new Date(message.created_at).getTime()}"` : '';
			messagesHtml += `<div class="msg ${roleClass}" id="msg-${message.uuid}"${tsAttr} style="display:none"><div class="msg-header">${role}</div><div class="msg-body">${contentHtml}</div></div>\n`;
		}

		// Assemble from template in a SINGLE replace pass. Chained .replace() calls
		// rescan the already-filled string, so a literal "{{RAW_TXT}}" inside the
		// conversation text (e.g. a chat about this extension quoting the exporter's
		// source) would steal the substitution from the real scaffold placeholder and
		// splice raw text into the middle of the messages. One global pass scans only
		// the template; callback output is never rescanned. The callback also disables
		// $-pattern processing ($` $' $&), which would otherwise splice the template
		// around any dollar sequences occurring in conversation text.
		const template = await getExportTemplate();
		const templateValues = {
			TITLE: esc(title),
			DEFAULT_LEAF: defaultLeaf,
			MESSAGES: messagesHtml,
			TREE_JSON: safeEmbed(JSON.stringify(treeJson)),
			RAW_TXT: safeEmbed(rawTxt),
		};
		const templateResult = template.replace(
			/\{\{(TITLE|DEFAULT_LEAF|MESSAGES|TREE_JSON|RAW_TXT)\}\}/g,
			(_, key) => templateValues[key]
		);
		// console.log(templateResult);
		return templateResult;
	}
	// #endregion

	function buildZipFilename(uuid, filename) {
		const lastDot = filename.lastIndexOf('.');
		if (lastDot === -1) {
			return `${filename}-${uuid}`;
		}
		const name = filename.substring(0, lastDot);
		const ext = filename.substring(lastDot);
		return `${name}-${uuid}${ext}`;
	}

	function buildAttachmentZipFilename(filename) {
		const uuid = crypto.randomUUID();
		const lastDot = filename.lastIndexOf('.');
		if (lastDot === -1) {
			return `${filename}-${uuid}_NOEXTRACT`;
		}
		const name = filename.substring(0, lastDot);
		const ext = filename.substring(lastDot);
		return `${name}-${uuid}_NOEXTRACT${ext}`;
	}

	async function formatZipExport(conversationData, messages, conversationId, loadingModal) {
		const zip = new JSZip();

		// Generate the html content (contains raw txt for re-import)
		const htmlContent = await formatHtmlExport(conversationData, messages, conversationId);
		await addToZip(zip, 'conversation.html', htmlContent);

		// Collect all downloadable files (ClaudeFile and ClaudeCodeExecutionFile)
		const allFiles = messages.flatMap(msg =>
			msg.files.filter(f =>
				(f instanceof ClaudeFile || f instanceof ClaudeCodeExecutionFile) &&
				f.getDownloadUrl()
			)
		);

		// Collect text attachments (ClaudeAttachment - content is inline, no download needed)
		const attachments = messages.flatMap(msg =>
			msg.files.filter(f => f instanceof ClaudeAttachment)
		);

		// Phase 1: Download all files first
		const filesToZipUp = [];
		for (let i = 0; i < allFiles.length; i++) {
			const file = allFiles[i];

			if (loadingModal) {
				loadingModal.setContent(createLoadingContent(`Downloading file ${i + 1}/${allFiles.length}: ${file.file_name}`));
			}

			try {
				const blob = await file.download();
				if (!blob) {
					console.log(`No download URL for ${file.file_name}, skipping`);
					continue;
				}
				const base64 = await new Promise((resolve) => {
					const reader = new FileReader();
					reader.onloadend = () => resolve(reader.result.split(',')[1]);
					reader.readAsDataURL(blob);
				});
				filesToZipUp.push({
					name: `files/${buildZipFilename(file.file_uuid, file.file_name)}`,
					data: base64
				});
				if (i < allFiles.length - 1) {
					await new Promise(r => setTimeout(r, 200));
				}
			} catch (error) {
				console.log(`Failed to download ${file.file_name}:`, error);
			}
		}

		// Phase 2: Add all files to zip
		if (loadingModal) {
			loadingModal.setContent(createLoadingContent('Creating zip file...'));
		}

		for (const file of filesToZipUp) {
			await addToZip(zip, file.name, file.data);
		}

		// Add text attachments (content is inline, no download needed)
		for (const attachment of attachments) {
			const filename = `files/${buildAttachmentZipFilename(attachment.file_name)}`;
			await addToZip(zip, filename, attachment.extracted_content);
		}

		return await zip.generateAsync({ type: 'blob' });
	}
	//#endregion

	async function formatExport(conversationData, messages, format, conversationId, loadingModal, options = {}) {
		switch (format) {
			case 'txt':
				return formatTxtExport(conversationData, messages, conversationId);
			case 'md':
				return formatMdExport(conversationData, messages, conversationId, options.includeThinking, options.includeAttachments);
			case 'jsonl':
				return formatJsonlExport(conversationData, messages, conversationId);
			case 'librechat':
				return formatLibrechatExport(conversationData, messages, conversationId, options, loadingModal);
			case 'raw':
				return formatRawExport(conversationData, messages, conversationId);
			case 'html':
				return formatHtmlExport(conversationData, messages, conversationId, options);
			case 'zip':
				return formatZipExport(conversationData, messages, conversationId, loadingModal);
			default:
				throw new Error(`Unsupported format: ${format}`);
		}
	}

	//#region Import functionality
	async function promptForFile(fileName) {
		return new Promise((resolve) => {
			const content = document.createElement('div');
			const text = document.createElement('p');
			text.className = CLAUDE_CLASSES.TEXT;
			text.textContent = `Failed to get "${fileName}" from zip. Please select it from your computer:`;
			content.appendChild(text);

			const modal = new ClaudeModal('File Missing', content, false);

			modal.addCancel('Skip File', () => {
				resolve(null);
			});

			modal.addConfirm('Select File', async () => {
				const fileInput = document.createElement('input');
				fileInput.type = 'file';

				const file = await new Promise(res => {
					fileInput.onchange = e => res(e.target.files[0]);
					fileInput.click();
				});

				if (file) {
					resolve(file);
				} else {
					resolve(null);
				}
			});

			modal.show();
		});
	}

	function parseAndValidateText(text) {
		const warnings = [];

		// Parse header
		const settingsMatch = text.match(/^Settings: (.+)/m);
		let settings = null;
		if (settingsMatch) {
			try {
				settings = JSON.parse(settingsMatch[1]);
			} catch (e) {
				warnings.push('Failed to parse settings from export header');
			}
		}

		const titleMatch = text.match(/^Title: (.+)/m);
		const title = titleMatch ? titleMatch[1].trim() : 'Imported Conversation';

		// Remove header
		const contentStart = text.search(/\n\[(.+)\]\n/);
		if (contentStart === -1) {
			throw new Error('No messages found in file');
		}

		const lines = text.slice(contentStart).split('\n');

		// First pass: parse into raw message data
		const rawMessages = [];
		let currentRaw = null;
		let currentTag = null;
		let textBuffer = '';

		function flushTextBuffer() {
			if (!textBuffer || !currentTag) return;
			if (currentTag.startsWith('content-')) {
				// Content block
				const contentType = currentTag.substring(8); // Remove "content-" prefix

				if (contentType === 'text') {
					currentRaw.content.push({
						type: 'text',
						text: textBuffer.trim()
					});
				} else {
					// Parse as JSON
					try {
						const jsonData = JSON.parse(textBuffer.trim());
						if (!jsonData.type) jsonData.type = contentType;
						currentRaw.content.push(jsonData);
					} catch (error) {
						warnings.push(`Failed to parse [content-${contentType}] block: ${error.message}`);
					}
				}
			} else {
				// Message property (files_v2, attachments)
				try {
					const jsonData = JSON.parse(textBuffer.trim());
					currentRaw[currentTag] = jsonData;
				} catch (error) {
					warnings.push(`Failed to parse [${currentTag}] block: ${error.message}`);
				}
			}

			textBuffer = '';
		}

		for (const line of lines) {
			const markerMatch = line.match(TAG_REGEX);
			if (markerMatch) {
				const marker = markerMatch[1];
				const timestampStr = markerMatch[2]; // Unix timestamp in milliseconds (if present)

				// Flush previous content
				flushTextBuffer();

				if (marker === ROLES.USER.exportDelimiter || marker === ROLES.ASSISTANT.exportDelimiter) {
					// Role marker - start new message
					const role = marker === ROLES.USER.exportDelimiter ? ROLES.USER.apiName : ROLES.ASSISTANT.apiName;

					// Check for consecutive messages of same role
					if (currentRaw && currentRaw.sender === role) {
						throw new Error(`Consecutive [${marker}] blocks not allowed`);
					}

					// Push previous message
					if (currentRaw) rawMessages.push(currentRaw);

					// Start new raw message
					currentRaw = {
						sender: role,
						content: [],
						files_v2: [],
						attachments: [],
						created_at: timestampStr ? new Date(parseInt(timestampStr)).toISOString() : null
					};

					currentTag = null;
				} else {
					// Content or property tag
					if (!currentRaw) {
						throw new Error(`Found [${marker}] before any message role`);
					}
					currentTag = marker;
				}
			} else {
				// Regular line - add to buffer
				if (textBuffer) textBuffer += '\n';
				textBuffer += line;
			}
		}

		// Flush final content
		flushTextBuffer();
		if (currentRaw) rawMessages.push(currentRaw);

		// Validation
		if (rawMessages.length === 0) {
			throw new Error('No messages found in file');
		}
		if (rawMessages[0].sender !== ROLES.USER.apiName) {
			throw new Error(`Conversation must start with a ${ROLES.USER.exportDelimiter} message`);
		}

		// Convert to ClaudeMessage instances
		const conversation = new ClaudeConversation(getOrgId(), null);
		const messages = rawMessages.map(raw => {
			const msg = new ClaudeMessage(conversation);
			msg.sender = raw.sender;
			msg.content = raw.content;
			msg.created_at = raw.created_at;

			// Parse files_v2 into file instances
			for (const f of raw.files_v2 || []) {
				msg.attachFile(parseFileFromAPI(f, conversation));
			}

			// Parse attachments
			for (const a of raw.attachments || []) {
				msg.attachFile(parseFileFromAPI(a, conversation));
			}

			return msg;
		});

		return { name: title, messages, warnings, settings };
	}

	async function parseZipImport(fileOrZip, loadingModal, includeFiles) {
		let zip;

		// Check if already a JSZip instance (has .file method) or needs loading
		if (fileOrZip.file && typeof fileOrZip.file === 'function') {
			zip = fileOrZip;
		} else {
			// It's a File - load it
			if (loadingModal) {
				loadingModal.setContent(createLoadingContent('Reading zip file...'));
			}

			const base64 = await new Promise((resolve) => {
				const reader = new FileReader();
				reader.onloadend = () => resolve(reader.result.split(',')[1]);
				reader.readAsDataURL(fileOrZip);
			});

			zip = await JSZip.loadAsync(base64, { base64: true });
		}

		// Find and read conversation data (html or legacy txt)
		const htmlFile = zip.file('conversation.html');
		const txtFile = zip.file('conversation.txt');
		let txtContent;
		if (htmlFile) {
			const html = await htmlFile.async('string');
			const match = html.match(/<script id="conversation-raw"[^>]*>([\s\S]*?)<\/script>/);
			if (!match) throw new Error('Invalid zip: conversation.html missing raw data');
			txtContent = match[1].replace(/<\\\//g, '</');
		} else if (txtFile) {
			txtContent = await txtFile.async('string');
		} else {
			throw new Error('Invalid zip: missing conversation.html or conversation.txt');
		}

		const parsedData = parseAndValidateText(txtContent);

		// Extract files from zip if requested
		const zipFiles = [];
		if (includeFiles) {
			// Build a map of available files in the zip (uuid -> zipEntry)
			const filesInZip = new Map();
			zip.folder('files').forEach((relativePath, zipEntry) => {
				// Skip files marked as no-extract (text attachments for archival only)
				if (relativePath.includes('_NOEXTRACT')) {
					return;
				}

				// UUID is 36 chars, positioned before extension (format: {name}-{uuid}.{ext})
				const lastDot = relativePath.lastIndexOf('.');
				const baseName = lastDot === -1 ? relativePath : relativePath.substring(0, lastDot);

				// UUID is last 36 characters, preceded by a dash
				if (baseName.length > 37 && baseName[baseName.length - 37] === '-') {
					const uuid = baseName.substring(baseName.length - 36);
					filesInZip.set(uuid, zipEntry);
				}
			});

			// Get all downloadable files from messages (keep actual file objects for direct mapping)
			const allFiles = parsedData.messages.flatMap(msg =>
				msg.files.filter(f => f instanceof ClaudeFile || f instanceof ClaudeCodeExecutionFile)
			);

			for (let i = 0; i < allFiles.length; i++) {
				const originalFile = allFiles[i];
				const zipEntry = filesInZip.get(originalFile.file_uuid);

				if (loadingModal) {
					loadingModal.setContent(createLoadingContent(`Extracting file ${i + 1}/${allFiles.length}: ${originalFile.file_name}`));
				}

				if (zipEntry) {
					const blob = await zipEntry.async('blob');
					zipFiles.push({ originalFile, blob });
				} else {
					// File not in zip - prompt user
					const userBlob = await promptForFile(originalFile.file_name);
					if (userBlob) {
						zipFiles.push({ originalFile, blob: userBlob });
					}
					// If skipped, file just won't be in zipFiles
				}
			}
		}

		return {
			...parsedData,
			zipFiles
		};
	}

	function convertToPhantomMessages(messages) {
		// Takes ClaudeMessage[], sets UUIDs and parent links, returns same instances
		let parentId = "00000000-0000-4000-8000-000000000000";

		for (const message of messages) {
			const timestamp = message.created_at || new Date().toISOString();

			message.uuid = crypto.randomUUID();
			message.parent_message_uuid = parentId;

			// Ensure timestamps on content items
			for (const contentItem of message.content) {
				if (!contentItem.start_timestamp) contentItem.start_timestamp = timestamp;
				if (!contentItem.stop_timestamp) contentItem.stop_timestamp = timestamp;
				if (!contentItem.citations) contentItem.citations = [];
			}

			if (!message.created_at) message.created_at = timestamp;

			parentId = message.uuid;
		}

		return messages;
	}

	async function storePhantomMessagesAndWait(conversationId, messages) {
		await storePhantomMessages(conversationId, messages.map(m => m.toHistoryJSON()));
	}

	async function finalizeImport(name, messages, model, zipFiles = null, loadingModal = null, settings = null) {
		const accountFeatureSettings = await warnAboutSettingsMismatch(settings);

		const conversation = new ClaudeConversation(getOrgId());
		conversation.prepareNew(name, model, getProjectId(), accountFeatureSettings);

		// Build import message tied to real conversation
		const importMessage = new ClaudeMessage(conversation);
		importMessage.text = "This conversation is imported from the attached chatlog.txt\nSimply say 'Acknowledged' and wait for user input.";
		importMessage.sender = 'human';
		if (model) importMessage.model = model;

		const fileMap = new Map(); // originalFile -> newFile
		// Upload zip files and remap references in phantom messages
		if (zipFiles && zipFiles.length > 0) {
			for (let i = 0; i < zipFiles.length; i++) {
				const { originalFile, blob } = zipFiles[i];

				if (loadingModal) {
					loadingModal.setContent(createLoadingContent(`Uploading file ${i + 1}/${zipFiles.length}: ${originalFile.file_name}`));
				}

				const newFile = await importMessage.addFile(blob, originalFile.file_name);
				fileMap.set(originalFile, newFile);
			}
		}
		// Replace file references in messages (for phantom storage)
		// Only replace ClaudeFile/ClaudeCodeExecutionFile - ClaudeAttachment is handled separately
		for (const msg of messages) {
			const filesToReplace = msg.files.filter(f => f instanceof ClaudeFile || f instanceof ClaudeCodeExecutionFile);
			for (const f of filesToReplace) {
				msg.removeFile(f);
				const newFile = fileMap.get(f);
				if (newFile) msg.attachFile(newFile);
			}
		}

		// Build chatlog content from messages
		const { text: cleanedContent } = ClaudeConversation.buildChatlog(messages, { includeHeader: true });

		// Remove ClaudeAttachments from importMessage - they're inline in chatlog
		for (const f of [...importMessage.files]) {
			if (f instanceof ClaudeAttachment) {
				importMessage.removeFile(f);
			}
		}

		// Add chatlog (conversation metadata - force inline)
		await importMessage.addFile(cleanedContent, "chatlog.txt", true);

		if (loadingModal) {
			loadingModal.setContent(createLoadingContent('Sending import message...'));
		}

		// Send initial message
		await conversation.sendMessageAndWaitForResponse(importMessage);

		// Convert and store phantom messages
		const phantomMessages = convertToPhantomMessages(messages);
		await storePhantomMessagesAndWait(conversation.conversationId, phantomMessages);

		// Navigate to new conversation
		window.location.href = `/chat/${conversation.conversationId}`;
	}

	function showWarningsModal(warnings) {
		const warningList = document.createElement('ul');
		warningList.className = 'list-disc pl-5 space-y-1';
		warnings.forEach(warning => {
			const li = document.createElement('li');
			li.textContent = warning;
			warningList.appendChild(li);
		});

		return new Promise((resolve) => {
			const modal = new ClaudeModal('Import Warnings', warningList);
			modal.addCancel('Cancel', () => resolve(false));
			modal.addConfirm('Import Anyway', () => resolve(true));
			modal.show();
		});
	}
	//#region Raw JSON import
	function parseRawClaudeJson(jsonText) {
		const data = JSON.parse(jsonText);
		const warnings = [];

		if (!data.chat_messages || !Array.isArray(data.chat_messages)) {
			throw new Error('Invalid Claude JSON format: missing chat_messages array');
		}

		if (!data.current_leaf_message_uuid) {
			throw new Error('Invalid Claude JSON format: missing current_leaf_message_uuid');
		}

		// Build lookup map
		const messageMap = new Map();
		for (const msg of data.chat_messages) {
			messageMap.set(msg.uuid, msg);
		}

		// Walk backward from leaf to root
		const branch = [];
		let current = messageMap.get(data.current_leaf_message_uuid);

		while (current) {
			branch.unshift(current);

			const parentId = current.parent_message_uuid;
			if (!parentId || parentId === '00000000-0000-4000-8000-000000000000') {
				break;
			}

			current = messageMap.get(parentId);
		}

		if (branch.length === 0) {
			throw new Error('Could not reconstruct message branch');
		}

		// Check for branches
		const parentCounts = new Map();
		for (const msg of data.chat_messages) {
			const parentId = msg.parent_message_uuid || 'root';
			parentCounts.set(parentId, (parentCounts.get(parentId) || 0) + 1);
		}
		const hasBranches = Array.from(parentCounts.values()).some(count => count > 1);

		if (hasBranches) {
			warnings.push('Multiple branches detected. Importing the current active branch.');
		}

		// Convert to ClaudeMessage instances
		const conversation = new ClaudeConversation(getOrgId(), null);
		const messages = branch.map(raw => {
			const msg = new ClaudeMessage(conversation);
			msg.sender = raw.sender;
			msg.content = raw.content || [];
			msg.created_at = raw.created_at;

			// Parse files_v2 into file instances
			for (const f of raw.files_v2 || []) {
				msg.attachFile(parseFileFromAPI(f, conversation));
			}

			// Parse attachments
			for (const a of raw.attachments || []) {
				msg.attachFile(parseFileFromAPI(a, conversation));
			}

			return msg;
		});

		return {
			name: data.name || 'Imported Conversation',
			messages,
			warnings
		};
	}
	//#endregion

	//#region LibreChat JSON import
	function extractEmbeddedAttachments(text) {
		const attachments = [];
		const attachmentPattern = /\n*=====ATTACHMENT_BEGIN: (.+?)=====\n([\s\S]*?)\n=====ATTACHMENT_END=====/g;

		let match;
		while ((match = attachmentPattern.exec(text)) !== null) {
			const fileName = match[1];
			const content = match[2];

			attachments.push({
				file_name: fileName,
				extracted_content: content,
				file_size: content.length,
				file_type: 'text/plain'
			});
		}

		return attachments;
	}

	function parseLibrechatJson(jsonText) {
		const data = JSON.parse(jsonText);
		const warnings = [];

		if (!data.messages || !Array.isArray(data.messages) || data.messages.length === 0) {
			throw new Error('Invalid LibreChat format: missing or empty messages array');
		}

		// Warn about branches upfront
		if (data.branches) {
			warnings.push('Multiple branches detected. Importing rightmost branch.');
		}

		let rawMessages;

		if (data.recursive) {
			// Recursive format - nested children
			rawMessages = flattenRecursiveTree(data.messages);
		} else {
			// Sequential format - flat with parentMessageId
			rawMessages = extractLinearBranch(data.messages);
		}

		if (rawMessages.length === 0) {
			throw new Error('No messages found in file');
		}

		// Create conversation for ClaudeMessage instances
		const conversation = new ClaudeConversation(getOrgId(), null);

		// Convert to ClaudeMessage instances
		const messages = rawMessages.map(raw => {
			const msg = new ClaudeMessage(conversation);
			msg.sender = raw.isCreatedByUser ? ROLES.USER.apiName : ROLES.ASSISTANT.apiName;
			msg.content = extractLibrechatContent(raw);
			msg.created_at = raw.createdAt;

			// Convert files to attachments (text-based files only)
			const attachmentsToAdd = [];

			// First, check files array
			if (raw.files && Array.isArray(raw.files) && raw.files.length > 0) {
				for (const file of raw.files) {
					if (file.text) {
						attachmentsToAdd.push({
							extracted_content: file.text,
							file_name: file.name || 'unknown',
							file_size: file.bytes || file.text.length,
							file_type: file.type || 'text/plain'
						});
					}
				}
			} else {
				// If no files in array, check for embedded attachments in text
				const textContent = raw.text || '';
				const embeddedAttachments = extractEmbeddedAttachments(textContent);
				attachmentsToAdd.push(...embeddedAttachments);

				// Also check content array
				if (raw.content && Array.isArray(raw.content)) {
					for (const block of raw.content) {
						if (block.type === 'text' && block.text) {
							const embedded = extractEmbeddedAttachments(block.text);
							attachmentsToAdd.push(...embedded);
						}
					}
				}
			}

			// Add all attachments to message
			for (const attData of attachmentsToAdd) {
				msg.attachFile(parseFileFromAPI(attData, conversation));
			}

			return msg;
		});
		// Ensure conversation starts with user message
		if (messages.length > 0 && messages[0].sender !== ROLES.USER.apiName) {
			warnings.push('Conversation did not start with a user message. A placeholder was added.');
			const placeholder = new ClaudeMessage(conversation);
			placeholder.sender = ROLES.USER.apiName;
			placeholder.content = [{ type: 'text', text: '[Conversation imported from LibreChat]' }];
			placeholder.created_at = messages[0].created_at;
			messages.unshift(placeholder);
		}

		return {
			name: data.title || 'Imported Conversation',
			messages,
			warnings
		};
	}

	function extractLibrechatContent(msg) {
		if (msg.content && Array.isArray(msg.content) && msg.content.length > 0) {
			return msg.content.map(block => {
				if (block.type === 'think') {
					return {
						type: 'thinking',
						thinking: block.think || ''
					};
				} else if (block.type === 'text') {
					return {
						type: 'text',
						text: (block.text || '').replace(ATTACHMENT_DELIMITER_REGEX, '').trim()
					};
				} else {
					return block;
				}
			});
		}

		return [{
			type: 'text',
			text: (msg.text || '').replace(ATTACHMENT_DELIMITER_REGEX, '').trim()
		}];
	}

	function extractLinearBranch(messages) {
		const messageMap = new Map();
		for (const msg of messages) {
			messageMap.set(msg.messageId, msg);
		}

		// Last message in array -> walk backward to root
		const lastMessage = messages[messages.length - 1];
		const branch = [];
		let current = lastMessage;

		while (current) {
			branch.unshift(current);

			const parentId = current.parentMessageId;
			if (!parentId || parentId === '00000000-0000-0000-0000-000000000000') {
				break;
			}

			current = messageMap.get(parentId);
		}

		return branch;
	}

	function flattenRecursiveTree(messages) {
		// Start from last root, follow last child at each level
		const branch = [];
		let current = messages[messages.length - 1];

		while (current) {
			branch.push(current);

			if (current.children && current.children.length > 0) {
				current = current.children[current.children.length - 1];
			} else {
				current = null;
			}
		}

		return branch;
	}
	//#endregion

	async function handleImport(model, includeFiles, includeToolCalls) {
		// Trigger file picker
		const fileInput = document.createElement('input');
		fileInput.type = 'file';
		fileInput.accept = '.txt,.json,.zip,.html';

		const file = await new Promise(resolve => {
			fileInput.onchange = e => resolve(e.target.files[0]);
			fileInput.click();
		});

		if (!file) return;

		// Show loading modal
		const loadingModal = createLoadingModal('Importing...');
		loadingModal.show();

		// Parse and validate
		const fileContent = await file.text();
		let parsedData;

		try {
			if (file.name.endsWith('.zip')) {
				// Zip import - includes files
				parsedData = await parseZipImport(file, loadingModal, includeFiles);
			} else if (file.name.endsWith('.txt')) {
				// TXT import - wrap in virtual zip for unified handling
				const zip = new JSZip();
				await addToZip(zip, 'conversation.txt', fileContent);
				parsedData = await parseZipImport(zip, loadingModal, false); // No files in TXT
			} else if (file.name.endsWith('.json')) {
				const jsonData = JSON.parse(fileContent);

				if (jsonData.chat_messages && jsonData.current_leaf_message_uuid) {
					// Raw Claude JSON
					parsedData = parseRawClaudeJson(fileContent);
				} else if (jsonData.messages) {
					// LibreChat JSON
					parsedData = parseLibrechatJson(fileContent);
				} else {
					throw new Error('Unrecognized JSON format');
				}
			} else {
				throw new Error('Unsupported file type');
			}
		} catch (error) {
			// Show error
			showClaudeAlert('Import Error', error.message);
			loadingModal.destroy();
			return;
		}

		let { messages, warnings, name, zipFiles, settings } = parsedData;

		// Filter based on toggles using ClaudeMessage methods
		if (!includeFiles) {
			for (const msg of messages) {
				msg.clearFiles();
			}
			zipFiles = null;
		}

		if (!includeToolCalls) {
			for (const msg of messages) {
				msg.removeToolCalls();
			}
		}

		// Remove token_budget content items
		for (const msg of messages) {
			msg.content = msg.content.filter(item => item.type !== 'token_budget');
		}

		// Show warnings modal if needed
		if (warnings.length > 0) {
			const proceed = await showWarningsModal(warnings);
			if (!proceed) {
				loadingModal.destroy();
				return;
			}
		}

		console.log('Parsed import data:', { name, messages, zipFiles });
		try {
			await finalizeImport(name, messages, model, zipFiles, loadingModal, settings);
			// Navigation happens in finalizeImport, loading modal cleaned up automatically
		} catch (error) {
			loadingModal.destroy();
			if (error.message === 'USER_CANCELLED') return;
			console.error('Import failed:', error);
			if (window.showErrorToast) window.showErrorToast('Import failed: ' + (error.message || error));
			showClaudeAlert('Import Error', error.message || 'Failed to import conversation');
		}
	}

	async function handleReplacePhantom(replaceButton) {
		const conversationId = getConversationId();
		if (!conversationId) {
			showClaudeAlert('Replace Error', 'Not in a conversation');
			return;
		}

		// Trigger file picker
		const fileInput = document.createElement('input');
		fileInput.type = 'file';
		fileInput.accept = '.txt,.json,.zip,.html';

		const file = await new Promise(resolve => {
			fileInput.onchange = e => resolve(e.target.files[0]);
			fileInput.click();
		});

		if (!file) return;

		// Show loading modal
		const loadingModal = createLoadingModal('Replacing phantom messages...');
		loadingModal.show();

		// Parse and validate
		let parsedData;

		try {
			if (file.name.endsWith('.zip')) {
				parsedData = await parseZipImport(file, loadingModal, false);
			} else if (file.name.endsWith('.json')) {
				const fileContent = await file.text();
				parsedData = parseLibrechatJson(fileContent);
			} else {
				const fileContent = await file.text();
				parsedData = parseAndValidateText(fileContent);
			}
		} catch (error) {
			showClaudeAlert('Replace Error', error.message || 'Invalid format');
			loadingModal.destroy();
			return;
		}

		// Show warnings modal if needed
		if (parsedData.warnings.length > 0) {
			const proceed = await showWarningsModal(parsedData.warnings);
			if (!proceed) {
				loadingModal.destroy();
				return;
			}
		}

		try {
			// Convert and store phantom messages (parsedData.messages is ClaudeMessage[])
			const phantomMessages = convertToPhantomMessages(parsedData.messages);
			await storePhantomMessagesAndWait(conversationId, phantomMessages);

			// Reload to show changes
			window.location.reload();
		} catch (error) {
			console.error('Replace failed:', error);
			loadingModal.destroy();
			showClaudeAlert('Replace Error', error.message || 'Failed to replace phantom messages');
		}
	}
	//#endregion

	async function exportSingleConversation(orgId, conversationId, format, extension, exportTree, exportOptions, loadingModal, freshnessHint = null) {
		const conversation = new ClaudeConversation(orgId, conversationId);
		// Bulk export passes the freshness it already learned from the conversation list. Without
		// one there is nothing cheaper than a full fetch — a freshness check costs the same TTFB
		// as the data itself — so skip the cache rather than pay for it twice.
		const conversationData = freshnessHint
			? await conversation.getData(false, freshnessHint)
			: await conversation.getData(true);
		const wasCached = conversation.lastGetDataFromCache;
		const messages = await conversation.getMessages(exportTree);
		const safeName = (conversationData.name || 'untitled').replace(/[<>:"/\\|?*]/g, '_');
		const filename = `Claude_export_${safeName}_${conversationId}.${extension}`;
		const exportContent = await formatExport(conversationData, messages, format, conversationId, loadingModal, exportOptions);
		const blob = exportContent instanceof Blob
			? exportContent
			: new Blob([exportContent], { type: 'text/plain' });
		return { filename, blob, wasCached, content: exportContent };
	}

	async function handleBulkExport(formatSelectValue, exportOptions, modal, projectId = null, exportTree = false, afterDate = null) {
		bulkExportCancelled = false;

		const loadingModal = createLoadingModal('Fetching conversation list...');
		loadingModal.addCancel('Cancel', () => {
			bulkExportCancelled = true;
		});
		loadingModal.show();

		try {
			localStorage.setItem('lastExportFormat', formatSelectValue);

			const parts = formatSelectValue.split("_");
			const format = parts[0];
			const extension = parts[1];
			const orgId = getOrgId();

			// Fetch conversations (project-scoped or all)
			const apiUrl = projectId
				? `/api/organizations/${orgId}/projects/${projectId}/conversations_v2?limit=10000&offset=0`
				: `/api/organizations/${orgId}/chat_conversations_v2?limit=10000&offset=0`;
			const response = await fetch(apiUrl);
			if (!response.ok) throw new Error('Failed to fetch conversations');
			let conversations = (await response.json()).data;
			// Keep only the last 10 conversations (THIS IS FOR TESTING - REMOVE IN RELEASE)
			//conversations = conversations.slice(0, 10);

			// Filter by date if specified
			if (afterDate) {
				conversations = conversations.filter(c => new Date(c.updated_at) >= afterDate);
			}

			if (bulkExportCancelled) {
				loadingModal.destroy();
				return;
			}

			if (!conversations.length) {
				loadingModal.destroy();
				showClaudeAlert('Bulk Export', 'No conversations found.');
				return;
			}

			// The list already tells us, per conversation, everything the cache needs to be
			// judged against — so cached conversations cost an IndexedDB read instead of a
			// full API round trip each.
			const freshness = new Map(conversations.map(c => [c.uuid, {
				updated_at: c.updated_at,
				current_leaf_message_uuid: c.current_leaf_message_uuid
			}]));

			const masterZip = new JSZip();
			let completed = 0;
			const total = conversations.length;
			const delayMs = Math.min(2000, 100 + total);

			// Split into 2 chunks for parallel processing
			const chunk1 = conversations.filter((_, i) => i % 2 === 0);
			const chunk2 = conversations.filter((_, i) => i % 2 === 1);

			async function processChunk(chunk) {
				const results = [];
				for (let i = 0; i < chunk.length; i++) {
					if (bulkExportCancelled) return results;

					const conv = chunk[i];
					try {
						const { filename, blob, wasCached } = await exportSingleConversation(
							orgId, conv.uuid, format, extension, exportTree, exportOptions, loadingModal,
							freshness.get(conv.uuid)
						);
						results.push({ filename, blob });

						// Only delay on cache miss (API call) to avoid rate limiting
						if (!wasCached && i < chunk.length - 1) {
							await new Promise(resolve => setTimeout(resolve, delayMs));
						}
					} catch (error) {
						console.error(`Failed to export conversation ${conv.uuid}:`, error);
					}

					completed++;
					loadingModal.setContent(createLoadingContent(`Exporting ${completed} of ${total} conversations...`));
				}
				return results;
			}

			const [results1, results2] = await Promise.all([
				processChunk(chunk1),
				processChunk(chunk2)
			]);

			// Add to zip sequentially
			const allResults = [...results1, ...results2];
			for (const { filename, blob } of allResults) {
				await addToZip(masterZip, filename, blob);
			}

			// Download project files if exporting a project (skip if cancelled)
			let projectName = 'untitled';
			if (projectId && !bulkExportCancelled) {
				loadingModal.setContent(createLoadingContent('Downloading project files...'));
				const project = new ClaudeProject(orgId, projectId);
				const [projectData, docs, files] = await Promise.all([project.getData(), project.getDocs(), project.getFiles()]);
				projectName = (projectData.name || 'untitled').replace(/[<>:"/\\|?*]/g, '_');

				// Save project instructions if present
				if (projectData.prompt_template && typeof projectData.prompt_template === 'string') {
					await addToZip(masterZip, 'project_instructions.txt', projectData.prompt_template);
				}

				for (const doc of docs) {
					const filename = makeUniqueFilename(doc.file_name, doc.uuid);
					await addToZip(masterZip, `project_files/${filename}`, doc.content);
				}

				for (const file of files) {
					if (bulkExportCancelled) break;

					let downloadUrl;
					if (file.file_kind === 'document' && file.document_asset) {
						downloadUrl = file.document_asset.url;
					} else if (file.file_kind === 'image') {
						downloadUrl = file.preview_url || file.thumbnail_url;
						if (file.preview_asset?.file_variant === 'original') {
							downloadUrl = file.preview_asset.url;
						} else if (file.thumbnail_asset?.file_variant === 'original') {
							downloadUrl = file.thumbnail_asset.url;
						}
					} else {
						downloadUrl = file.preview_url || file.thumbnail_url;
					}

					if (!downloadUrl) continue;

					try {
						const response = await fetch(downloadUrl);
						if (!response.ok) {
							console.error(`Failed to fetch project file ${file.file_name}`);
							continue;
						}
						const blob = await response.blob();
						const filename = makeUniqueFilename(file.file_name, file.file_uuid);

						await addToZip(masterZip, `project_files/${filename}`, blob);
					} catch (error) {
						console.error(`Error downloading project file ${file.file_name}:`, error);
					}
				}
			}

			// Always proceed to zip generation if there are results
			if (allResults.length === 0) {
				loadingModal.destroy();
				return;
			}

			loadingModal.setContent(createLoadingContent(bulkExportCancelled ? 'Generating partial zip file...' : 'Generating zip file...'));
			const masterBlob = await masterZip.generateAsync({ type: 'blob' });

			const url = URL.createObjectURL(masterBlob);
			const link = document.createElement('a');
			link.href = url;
			if (projectId) {
				link.download = `Claude_project_export_${projectName}_${projectId}.zip`;
			} else {
				link.download = `Claude_bulk_export_${new Date().toISOString().slice(0, 10)}.zip`;
			}
			link.click();
			URL.revokeObjectURL(url);

			loadingModal.destroy();
			modal.hide();
		} catch (error) {
			console.error('Bulk export failed:', error);
			if (window.showErrorToast) window.showErrorToast('Bulk export failed: ' + (error.message || error));
			loadingModal.destroy();
			if (!bulkExportCancelled) {
				showClaudeAlert('Export Error', error.message || 'Failed to bulk export conversations');
			}
		}
	}

	async function showExportImportModal() {
		const conversationId = getConversationId();
		const projectId = getProjectId();
		const isInConversation = Boolean(conversationId);
		const isOnProjectPage = Boolean(projectId);

		// Get last used format from localStorage (default to zip for full fidelity)
		const lastFormat = localStorage.getItem('lastExportFormat') || 'html_html';

		// Build the modal content
		const content = document.createElement('div');

		// Variables to hold references (may not be created)
		let formatSelect, toggleInput, thinkingToggleInput, attachmentsToggleInput, imagesToggleInput, dateInput;

		//#region Export section (always shown, context-aware)
		{
			// Format label
			const formatLabel = document.createElement('label');
			formatLabel.className = CLAUDE_CLASSES.LABEL;
			formatLabel.textContent = 'Export Format';
			content.appendChild(formatLabel);

			const exportContainer = document.createElement('div');
			exportContainer.className = 'mb-4 flex gap-2';

			// Format descriptors. `copyable` marks whether the format produces a plain
			// string that can go to the clipboard (zip is binary/Blob, so it cannot).
			const EXPORT_FORMATS = [
				{ value: 'html_html', label: 'HTML (.html)', copyable: true },
				{ value: 'zip_zip', label: 'Zip (.zip)', copyable: false },
				{ value: 'md_md', label: 'Markdown (.md)', copyable: true },
				{ value: 'txt_txt', label: 'Text (.txt)', copyable: true },
				{ value: 'jsonl_jsonl', label: 'SillyTavern (.jsonl)', copyable: true },
				{ value: 'librechat_json', label: 'Librechat (.json)', copyable: true },
				{ value: 'raw_json', label: 'Anthropic JSON (.json)', copyable: true }
			];
			const isCopyable = (v) => EXPORT_FORMATS.find(f => f.value === v)?.copyable ?? false;

			// Fall back if the saved format is no longer offered
			const selectedFormat = EXPORT_FORMATS.some(f => f.value === lastFormat) ? lastFormat : 'html_html';

			// Format select
			formatSelect = createClaudeSelect(
				EXPORT_FORMATS.map(f => ({ value: f.value, label: f.label })),
				selectedFormat
			);
			formatSelect.style.flex = '1';
			exportContainer.appendChild(formatSelect);

			// Export button - label depends on context
			const exportLabel = isInConversation ? 'Export' : (isOnProjectPage ? 'Export Project' : 'Export All');
			const exportButton = createClaudeButton(exportLabel, 'primary');
			exportButton.style.minWidth = '80px';
			exportContainer.appendChild(exportButton);

			// Copy button - single conversation only (bulk/project always produces a zip)
			let copyButton;
			const syncCopyEnabled = () => {
				if (!copyButton) return;
				const ok = isCopyable(formatSelect.value);
				copyButton.disabled = !ok;
				copyButton.classList.toggle('opacity-50', !ok);
				copyButton.classList.toggle('cursor-not-allowed', !ok);
			};
			if (isInConversation) {
				copyButton = createClaudeButton('Copy', 'secondary');
				copyButton.style.minWidth = '64px';
				exportContainer.appendChild(copyButton);
			}

			content.appendChild(exportContainer);

			// Tree option container
			const treeOption = document.createElement('div');
			treeOption.id = 'treeOption';
			treeOption.className = 'mb-4 hidden';

			const initialTreeDefault = ['html', 'zip'].includes(selectedFormat.split('_')[0]);
			const { container: toggleContainer, input: treeToggleInput } = createClaudeToggle('Export entire tree', initialTreeDefault);
			toggleInput = treeToggleInput;
			treeOption.appendChild(toggleContainer);
			content.appendChild(treeOption);

			// Thinking option container (for markdown export)
			const thinkingOption = document.createElement('div');
			thinkingOption.id = 'thinkingOption';
			thinkingOption.className = 'mb-4 hidden';

			const { container: thinkingToggleContainer, input: thinkingInput } = createClaudeToggle('Include thinking', false);
			thinkingToggleInput = thinkingInput;
			thinkingOption.appendChild(thinkingToggleContainer);
			content.appendChild(thinkingOption);

			// Attachments option container (for markdown export)
			const attachmentsOption = document.createElement('div');
			attachmentsOption.id = 'attachmentsOption';
			attachmentsOption.className = 'mb-4 hidden';

			const { container: attachmentsToggleContainer, input: attachmentsInput } = createClaudeToggle('Include text attachments', false);
			attachmentsToggleInput = attachmentsInput;
			attachmentsOption.appendChild(attachmentsToggleContainer);
			content.appendChild(attachmentsOption);

			// Images option (librechat + html). Every image is downloaded and inlined as a base64
			// data URI, so it dominates both file size and export time. Off by default for
			// librechat, where the export is otherwise a small JSON file; on by default for html,
			// which already embeds everything else and is meant to be the high-fidelity archive.
			const imagesOption = document.createElement('div');
			imagesOption.id = 'imagesOption';
			imagesOption.className = 'mb-4 hidden';

			const initialImagesDefault = selectedFormat.split('_')[0] === 'html';
			const { container: imagesToggleContainer, input: imagesInput } = createClaudeToggle('Include images', initialImagesDefault);
			imagesToggleInput = imagesInput;
			imagesOption.appendChild(imagesToggleContainer);
			content.appendChild(imagesOption);

			// Date filter option (bulk export only)
			const dateOption = document.createElement('div');
			dateOption.className = 'mb-4' + (isInConversation ? ' hidden' : '');

			const dateLabel = document.createElement('label');
			dateLabel.className = CLAUDE_CLASSES.LABEL;
			dateLabel.textContent = 'Export conversations updated after:';
			dateOption.appendChild(dateLabel);

			dateInput = createClaudeInput({ type: 'date' });
			dateOption.appendChild(dateInput);
			content.appendChild(dateOption);

			// Show/hide options based on initial value
			const initialFormat = selectedFormat.split('_')[0];
			treeOption.classList.toggle('hidden', !['librechat', 'raw', 'html', 'zip'].includes(initialFormat));
			thinkingOption.classList.toggle('hidden', initialFormat !== 'md');
			attachmentsOption.classList.toggle('hidden', initialFormat !== 'md');
			imagesOption.classList.toggle('hidden', !['librechat', 'html'].includes(initialFormat));
			syncCopyEnabled();

			// Update option visibility on select change
			formatSelect.onchange = () => {
				const format = formatSelect.value.split('_')[0];
				treeOption.classList.toggle('hidden', !['librechat', 'raw', 'html', 'zip'].includes(format));
				thinkingOption.classList.toggle('hidden', format !== 'md');
				attachmentsOption.classList.toggle('hidden', format !== 'md');
				imagesOption.classList.toggle('hidden', !['librechat', 'html'].includes(format));
				toggleInput.checked = ['html', 'zip'].includes(format);
				imagesToggleInput.checked = format === 'html';
				syncCopyEnabled();
			};

			// Export button handler
			exportButton.onclick = async () => {
				const exportOptions = {
					includeThinking: thinkingToggleInput?.checked ?? true,
					includeAttachments: attachmentsToggleInput?.checked ?? false,
					includeImages: imagesToggleInput?.checked ?? false
				};

				if (isInConversation) {
					// Single conversation export
					const loadingModal = createLoadingModal('Exporting...');
					loadingModal.show();

					try {
						localStorage.setItem('lastExportFormat', formatSelect.value);

						const parts = formatSelect.value.split("_");
						const format = parts[0];
						const extension = parts[1];
						const exportTree = toggleInput.checked;
						const orgId = getOrgId();

						const { filename, blob } = await exportSingleConversation(
							orgId, conversationId, format, extension, exportTree, exportOptions, loadingModal
						);

						const url = URL.createObjectURL(blob);
						const link = document.createElement('a');
						link.href = url;
						link.download = filename;
						link.click();
						URL.revokeObjectURL(url);

						loadingModal.destroy();
						modal.hide();
					} catch (error) {
						console.error('Export failed:', error);
						if (window.showErrorToast) window.showErrorToast('Export failed: ' + (error.message || error));
						loadingModal.destroy();
						showClaudeAlert('Export Error', error.message || 'Failed to export conversation');
					}
				} else {
					// Bulk export (all conversations or project-scoped)
					const afterDate = dateInput?.value ? new Date(dateInput.value) : null;
					await handleBulkExport(formatSelect.value, exportOptions, modal, projectId, toggleInput.checked, afterDate);
				}
			};

			// Copy to clipboard handler (single conversation only)
			if (copyButton) copyButton.onclick = async () => {
				if (!isCopyable(formatSelect.value)) return;

				const exportOptions = {
					includeThinking: thinkingToggleInput?.checked ?? true,
					includeAttachments: attachmentsToggleInput?.checked ?? false,
					includeImages: imagesToggleInput?.checked ?? false
				};

				const loadingModal = createLoadingModal('Copying...');
				loadingModal.show();

				try {
					localStorage.setItem('lastExportFormat', formatSelect.value);

					const parts = formatSelect.value.split("_");
					const format = parts[0];
					const extension = parts[1];
					const exportTree = toggleInput.checked;
					const orgId = getOrgId();

					const { content } = await exportSingleConversation(
						orgId, conversationId, format, extension, exportTree, exportOptions, loadingModal
					);

					if (content instanceof Blob) {
						throw new Error('This format cannot be copied to the clipboard.');
					}

					await navigator.clipboard.writeText(content);

					loadingModal.destroy();
					modal.hide();
				} catch (error) {
					console.error('Copy failed:', error);
					loadingModal.destroy();
					showClaudeAlert('Copy Error', error.message || 'Failed to copy conversation');
				}
			};

			// Divider
			const divider = document.createElement('hr');
			divider.className = 'my-4 border-border-300';
			content.appendChild(divider);
		}
		//#endregion

		//#region Import section (always shown)
		// Model label
		const modelLabel = document.createElement('label');
		modelLabel.className = CLAUDE_CLASSES.LABEL;
		modelLabel.textContent = 'Imported Conversation Model';
		content.appendChild(modelLabel);

		const importContainer = document.createElement('div');
		importContainer.className = 'mb-2 flex gap-2';

		// Model select
		const modelList = CLAUDE_MODELS;
		const modelSelect = createClaudeSelect(modelList, modelList[0].value);
		modelSelect.style.flex = '1';
		importContainer.appendChild(modelSelect);

		// Import button
		const importButton = createClaudeButton('Import', 'primary');
		importButton.style.minWidth = '80px';
		importContainer.appendChild(importButton);

		content.appendChild(importContainer);

		// Add toggles
		const importFilesToggle = createClaudeToggle('Import files/attachments', true);
		importFilesToggle.container.classList.add('mb-2', 'mt-2');
		content.appendChild(importFilesToggle.container);

		const importToolCallsToggle = createClaudeToggle('Import tool calls', false);
		importToolCallsToggle.container.classList.add('mb-4');
		content.appendChild(importToolCallsToggle.container);

		// Import note
		const note = document.createElement('p');
		note.className = CLAUDE_CLASSES.TEXT_SM + ' text-text-400';
		note.textContent = 'Imports zip (from this modal) and LibreChat JSON.';
		content.appendChild(note);

		// Import button handler
		importButton.onclick = () =>
			handleImport(
				modelSelect.value,
				importFilesToggle.input.checked,
				importToolCallsToggle.input.checked
			);
		//#endregion

		//#region Replace phantom section (only if in conversation)
		if (isInConversation) {
			// Divider
			const divider2 = document.createElement('hr');
			divider2.className = 'my-4 border-border-300';
			content.appendChild(divider2);

			// Replace phantom messages section
			const replaceLabel = document.createElement('label');
			replaceLabel.className = CLAUDE_CLASSES.LABEL;
			replaceLabel.textContent = 'Replace Phantom Messages';
			content.appendChild(replaceLabel);

			const replaceNote = document.createElement('p');
			replaceNote.className = CLAUDE_CLASSES.TEXT_SM + ' text-text-400';
			replaceNote.textContent = `Replaces the "fake" message history for this conversation.`;
			content.appendChild(replaceNote);

			const replaceButton = createClaudeButton('Replace from File', 'secondary');
			replaceButton.className += ' mb-2';
			content.appendChild(replaceButton);
			replaceButton.onclick = () => handleReplacePhantom(replaceButton);

			// Warning note
			const warningNote = document.createElement('p');
			warningNote.className = CLAUDE_CLASSES.TEXT_SM;
			warningNote.style.color = '#de2929';
			warningNote.innerHTML = '⚠️ <strong>Visual change only:</strong> This replaces what you see in the chat history. The AI\'s context (what it can actually read) remains unchanged.';
			warningNote.className += ' mb-3';
			content.appendChild(warningNote);
		}
		//#endregion

		// Create modal with appropriate title
		const modalTitle = 'Export & Import';
		const modal = new ClaudeModal(modalTitle, content);

		// Override max width
		modal.modal.style.maxWidth = '28rem';

		modal.show();
	}

	function createExportButton() {
		const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 16 16">
        <path d="M8 12V2m0 10 5-5m-5 5L3 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
        <path opacity="0.4" d="M2 15h12v-3H2v3Z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>`;

		const button = createClaudeButton(svgContent, 'icon');

		button.onclick = showExportImportModal;

		return button;
	}

	function initialize() {
		ButtonBar.register({
			buttonClass: 'export-button',
			createFn: createExportButton,
			tooltip: 'Export/Import chat',
			pages: ['chat', 'home', 'project'],
		});
	}

	// Wait for dependencies to be available
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initialize);
	} else {
		initialize();
	}
})();