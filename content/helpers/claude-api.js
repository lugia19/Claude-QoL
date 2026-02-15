// claude_api.js

const SUPPORTED_LOCALES = ['en-US', 'de-DE', 'fr-FR', 'ko-KR', 'ja-JP', 'es-419', 'es-ES', 'it-IT', 'hi-IN', 'pt-BR', 'id-ID'];

let _cachedLocale = null;
async function fetchAndCacheLocale() {
	// Check localStorage first
	const cached = localStorage.getItem("claude_qol_locale_cache");
	if (cached) {
		try {
			const { locale, expiry } = JSON.parse(cached);
			if (Date.now() < expiry && SUPPORTED_LOCALES.includes(locale)) {
				return locale;
			}
		} catch (e) { /* invalid cache, refetch */ }
	}

	// Fetch from API
	try {
		const response = await fetch('/api/account_profile');
		if (response.ok) {
			const data = await response.json();
			const locale = SUPPORTED_LOCALES.includes(data.locale) ? data.locale : 'en-US';
			localStorage.setItem("claude_qol_locale_cache", JSON.stringify({
				locale,
				expiry: Date.now() + 24 * 60 * 60 * 1000
			}));
			return locale;
		}
	} catch (e) {
		console.error('Failed to fetch locale:', e);
	}

	// Fallback
	return SUPPORTED_LOCALES.includes(navigator.language) ? navigator.language : 'en-US';
}

function getLocale() {
	return _cachedLocale ?? (SUPPORTED_LOCALES.includes(navigator.language) ? navigator.language : 'en-US');
}

// Initialize on load (fire and forget)
fetchAndCacheLocale().then(locale => { _cachedLocale = locale; });

class ClaudeConversation {
	constructor(orgId, conversationId = null) {
		this.orgId = orgId;
		this.conversationId = conversationId;
		this.created = conversationId ? true : false;
	}

	// Create a new conversation
	async create(name, model = null, projectUuid = null, paprikaMode = false) {
		if (this.conversationId) {
			throw new Error('Conversation already exists');
		}

		this.conversationId = this.generateUuid();
		const bodyJSON = {
			uuid: this.conversationId,
			name: name,
			include_conversation_preferences: true,
			project_uuid: projectUuid,
		};

		if (model) bodyJSON.model = model;
		if (paprikaMode) bodyJSON.paprika_mode = "extended";

		const response = await fetch(`/api/organizations/${this.orgId}/chat_conversations`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(bodyJSON)
		});

		if (!response.ok) {
			throw new Error('Failed to create conversation');
		}

		this.created = true;
		return this.conversationId;
	}

	// Send a message and wait for response
	async sendMessageAndWaitForResponse(promptOrMessage, options = {}) {
		let requestBody;

		if (promptOrMessage instanceof ClaudeMessage) {
			// Use toCompletionJSON() which produces correct format
			requestBody = promptOrMessage.toCompletionJSON();
			// Allow options to override model if provided
			if (options.model) {
				requestBody.model = options.model;
			}
		} else {
			// Existing string prompt behavior
			const {
				model = null,
				parentMessageUuid = '00000000-0000-4000-8000-000000000000',
				attachments = [],
				files = [],
				syncSources = [],
				personalizedStyles = null
			} = options;

			requestBody = {
				prompt: promptOrMessage,
				parent_message_uuid: parentMessageUuid,
				attachments,
				files,
				sync_sources: syncSources,
				personalized_styles: personalizedStyles,
				rendering_mode: "messages"
			};

			if (model !== null) {
				requestBody.model = model;
			}
		}

		// Log time BEFORE sending request
		const requestSentTime = new Date().toISOString();

		const response = await fetch(`/api/organizations/${this.orgId}/chat_conversations/${this.conversationId}/completion`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(requestBody)
		});

		if (!response.ok) {
			console.error(await response.json());
			throw new Error('Failed to send message');
		}

		// Just consume the stream until it's done
		const reader = response.body.getReader();
		const decoder = new TextDecoder();

		try {
			while (true) {
				const { done, value } = await reader.read();

				if (done) break;

				// Decode and check for completion signal
				const chunk = decoder.decode(value, { stream: true });

				if (chunk.includes('event: message_stop')) {
					break;
				}
			}
		} finally {
			reader.releaseLock();
		}

		// Find assistant message created AFTER our request
		// getMessages() now returns ClaudeMessage[], so use .createdAt property
		let assistantMessage;
		let attempts = 0;
		let messages;
		const maxAttempts = 30;

		while (!assistantMessage && attempts < maxAttempts) {
			if (attempts > 0) {
				console.log(`Assistant message not found or too old, waiting 3 seconds and retrying (attempt ${attempts}/${maxAttempts})...`);
				await new Promise(r => setTimeout(r, 3000));
			}
			messages = await this.getMessages(false, true);
			assistantMessage = messages.find(msg =>
				msg.sender === 'assistant' &&
				msg.created_at > requestSentTime
			);
			attempts++;
		}

		if (!assistantMessage) {
			console.error('Messages after retry:', messages);
			console.error('Request sent at:', requestSentTime);
			throw new Error('Completion finished but no assistant message found after retry');
		}

		return assistantMessage;
	}

	// Upload file to code execution environment
	async uploadToCodeExecution(fileOrAttachmentOrBlob, fileName = null) {
		let blob, name;

		if (fileOrAttachmentOrBlob instanceof ClaudeFile) {
			const downloadedBlob = await fileOrAttachmentOrBlob.download();
			name = fileName ?? fileOrAttachmentOrBlob.file_name;
		} else if (fileOrAttachmentOrBlob instanceof ClaudeAttachment) {
			blob = new Blob([fileOrAttachmentOrBlob.extracted_content], { type: 'text/plain' });
			name = fileName ?? fileOrAttachmentOrBlob.file_name;
		} else if (fileOrAttachmentOrBlob instanceof Blob) {
			blob = fileOrAttachmentOrBlob;
			name = fileName ?? 'unnamed';
		} else {
			throw new Error('Expected ClaudeFile, ClaudeAttachment, or Blob');
		}

		// Ensure correct MIME type (for ClaudeFile and raw Blob cases)
		if (!blob || !blob.type || blob.type === 'application/octet-stream') {
			const mimeType = mime.getType(name) || blob?.type || 'application/octet-stream';
			const sourceBlob = blob ?? await fileOrAttachmentOrBlob.download();
			blob = new Blob([sourceBlob], { type: mimeType });
		}

		const formData = new FormData();
		formData.append('file', blob, name);

		const response = await fetch(
			`/api/organizations/${this.orgId}/conversations/${this.conversationId}/wiggle/upload-file`,
			{ method: 'POST', body: formData }
		);

		if (!response.ok) {
			throw new Error(`Failed to upload to code execution: ${response.statusText}`);
		}

		const result = await response.json();
		return new ClaudeCodeExecutionFile(result, this.orgId, this.conversationId);
	}

	// Lazy load conversation data
	async getData(tree = false, forceRefresh = false) {
		if (!this.conversationData || forceRefresh || (tree && !this.conversationData.chat_messages)) {
			const response = await fetch(
				`/api/organizations/${this.orgId}/chat_conversations/${this.conversationId}?tree=${tree}&rendering_mode=messages&render_all_tools=true&skip_uuid_injection=true`
			);
			if (!response.ok) {
				throw new Error('Failed to get conversation data');
			}
			this.conversationData = await response.json();
		}
		return this.conversationData;
	}

	// Get messages (now uses getData)
	async getMessages(tree = false, forceRefresh = false) {
		const data = await this.getData(tree, forceRefresh);
		return (data.chat_messages || []).map(msg =>
			ClaudeMessage.fromHistoryJSON(this, msg)
		);
	}

	// Find longest leaf from a message ID
	findLongestLeaf(startMessageId) {
		const messageMap = new Map();
		for (const msg of this.conversationData.chat_messages) {
			messageMap.set(msg.uuid, msg);
		}

		// Get all children of the message we're starting from
		const children = Array.from(messageMap.values()).filter(
			msg => msg.parent_message_uuid === startMessageId
		);
		// No children -> it's a leaf, just return
		if (children.length === 0) {
			const message = messageMap.get(startMessageId);
			return {
				leafId: startMessageId,
				depth: 0,
				timestamp: new Date(message.created_at).getTime()
			};
		}

		let longestPath = { leafId: null, depth: -1, timestamp: 0 };
		// For each child, find its longest leaf (recursion)
		for (const child of children) {
			const result = this.findLongestLeaf(child.uuid);
			const totalDepth = result.depth + 1;	//Account for the fact we're looking at the parent of this message
			// If this path is longer than the previous longest, or same length but newer, update
			if (totalDepth > longestPath.depth ||
				(totalDepth === longestPath.depth && result.timestamp > longestPath.timestamp)) {
				longestPath = {
					leafId: result.leafId,
					depth: totalDepth,
					timestamp: result.timestamp
				};
			}
		}

		return longestPath;
	}

	// Navigate to a specific leaf
	async setCurrentLeaf(leafId) {
		const url = `/api/organizations/${this.orgId}/chat_conversations/${this.conversationId}/current_leaf_message_uuid`;

		const response = await fetch(url, {
			method: 'PUT',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ current_leaf_message_uuid: leafId })
		});

		if (!response.ok) {
			throw new Error('Failed to set current leaf');
		}
	}

	// Delete conversation
	async delete() {
		const response = await fetch(`/api/organizations/${this.orgId}/chat_conversations/${this.conversationId}`, {
			method: 'DELETE'
		});

		if (!response.ok) {
			console.error('Failed to delete conversation');
		}
	}

	// Extract text from message content (works with both raw JSON and ClaudeMessage)
	static extractMessageText(message) {
		// ClaudeMessage has .content array just like raw JSON, so same logic works
		if (!message.content || message.content.length === 0) return '';

		const textPieces = [];

		function extractFromContent(content) {
			if (content.text) {
				textPieces.push(content.text);
			}
			if (content.input) {
				textPieces.push(JSON.stringify(content.input));
			}
			if (content.content) {
				// Handle nested content array
				if (Array.isArray(content.content)) {
					for (const nestedContent of content.content) {
						extractFromContent(nestedContent);
					}
				}
				// Handle single nested content object
				else if (typeof content.content === 'object') {
					extractFromContent(content.content);
				}
			}
		}

		// Process all content items in the message
		for (const content of message.content) {
			extractFromContent(content);
		}

		return textPieces.join('\n');
	}

	generateUuid() {
		return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
			const r = Math.random() * 16 | 0;
			const v = c === 'x' ? r : (r & 0x3 | 0x8);
			return v.toString(16);
		});
	}
}

class ClaudeFile {
	constructor(apiData) {
		this.file_uuid = apiData.file_uuid;
		this.file_name = apiData.file_name;
		this.file_kind = apiData.file_kind; // 'image' | 'document'
		this.preview_asset = apiData.preview_asset || null;
		this.document_asset = apiData.document_asset || null;
		this.thumbnail_asset = apiData.thumbnail_asset || null;
		this.preview_url = apiData.preview_url || null;
		this.thumbnail_url = apiData.thumbnail_url || null;
		this.raw_data = apiData; // Store raw data for reference
	}

	getDownloadUrl() {
		// Try preview first (images)
		if (this.preview_asset?.url) {
			return this.preview_asset.url;
		}

		// Try document (PDFs, etc.)
		if (this.document_asset?.url) {
			return this.document_asset.url;
		}

		// Try direct URLs
		if (this.preview_url) {
			return this.preview_url;
		}

		// Last resort: thumbnail
		if (this.thumbnail_asset?.url) {
			return this.thumbnail_asset.url;
		}

		if (this.thumbnail_url) {
			return this.thumbnail_url;
		}

		return null;
	}

	async download() {
		const url = this.getDownloadUrl();
		if (!url) {
			return null;
		}

		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Failed to download file ${this.file_name}`);
		}

		return await response.blob();
	}


	toApiFormat() {
		return {
			file_uuid: this.file_uuid,
			file_name: this.file_name,
			file_kind: this.file_kind,
			preview_asset: this.preview_asset,
			document_asset: this.document_asset,
			thumbnail_asset: this.thumbnail_asset,
			preview_url: this.preview_url,
			thumbnail_url: this.thumbnail_url
		};
	}

	static async upload(orgId, blob, fileName) {
		const mimeType = mime.getType(fileName) || 'application/octet-stream';
		const typedBlob = new Blob([blob], { type: mimeType });

		// Direct upload for images and PDFs, conversion for other documents
		const isDirectUpload = mimeType.startsWith('image/') || mimeType === 'application/pdf';
		console.log(`[ClaudeFile] Uploading file "${fileName}" as ${isDirectUpload ? 'direct upload' : 'document conversion'} (MIME: ${mimeType})`);
		if (isDirectUpload) {
			// Regular file upload
			const formData = new FormData();
			formData.append('file', typedBlob, fileName);

			const response = await fetch(`/api/${orgId}/upload`, {
				method: 'POST',
				body: formData
			});

			if (!response.ok) {
				throw new Error(`Failed to upload file ${fileName}`);
			}

			const data = await response.json();
			return new ClaudeFile(data);
		} else {
			// Document conversion -> returns ClaudeAttachment
			const formData = new FormData();
			formData.append('file', typedBlob, fileName);

			const response = await fetch(`/api/organizations/${orgId}/convert_document`, {
				method: 'POST',
				body: formData
			});

			if (!response.ok) {
				throw new Error(`Failed to convert document ${fileName}`);
			}

			const data = await response.json();
			return new ClaudeAttachment(data);
		}
	}

	static fromJSON(json) {
		return new ClaudeFile(json);
	}
}

class ClaudeAttachment {
	constructor({ extracted_content, file_name, file_size, file_type }) {
		this.extracted_content = extracted_content;
		this.file_name = file_name;
		this.file_size = file_size;
		this.file_type = file_type;
	}

	toApiFormat() {
		return {
			extracted_content: this.extracted_content,
			file_name: this.file_name,
			file_size: this.file_size,
			file_type: this.file_type
		};
	}

	static fromText(text, fileName, fileType = 'text/plain') {
		return new ClaudeAttachment({
			extracted_content: text,
			file_name: fileName,
			file_size: text.length,
			file_type: fileType
		});
	}

	static fromJSON(json) {
		return new ClaudeAttachment(json);
	}
}

class ClaudeCodeExecutionFile {
	constructor(apiData, orgId, conversationId) {
		this.file_uuid = apiData.file_uuid;
		this.file_name = apiData.file_name;
		this.sanitized_name = apiData.sanitized_name;
		this.path = apiData.path; // "/mnt/user-data/uploads/..."
		this.size_bytes = apiData.size_bytes;
		this.file_kind = apiData.file_kind;
		this.created_at = apiData.created_at;

		// Asset properties (same as ClaudeFile)
		this.preview_asset = apiData.preview_asset || null;
		this.document_asset = apiData.document_asset || null;
		this.thumbnail_asset = apiData.thumbnail_asset || null;
		this.preview_url = apiData.preview_url || null;
		this.thumbnail_url = apiData.thumbnail_url || null;

		// Stored for download
		this.orgId = orgId;
		this.conversationId = conversationId;

		// For inline attachment mode (text files with code exec ON)
		this.extracted_content = apiData.extracted_content || null;
		this.force_attachment_mode = false;
	}

	getDownloadUrl() {
		// Prefer wiggle endpoint for code execution files
		if (this.orgId && this.conversationId && this.path) {
			return `/api/organizations/${this.orgId}/conversations/${this.conversationId}/wiggle/download-file?path=${encodeURIComponent(this.path)}`;
		}

		// Fall back to asset URLs
		if (this.preview_asset?.url) {
			return this.preview_asset.url;
		}
		if (this.document_asset?.url) {
			return this.document_asset.url;
		}
		if (this.preview_url) {
			return this.preview_url;
		}
		if (this.thumbnail_asset?.url) {
			return this.thumbnail_asset.url;
		}
		if (this.thumbnail_url) {
			return this.thumbnail_url;
		}

		return null;
	}

	async download() {
		const url = this.getDownloadUrl();
		if (!url) {
			throw new Error('Cannot download: missing orgId, conversationId, or path');
		}

		const response = await fetch(url);

		if (!response.ok) {
			throw new Error(`Failed to download file ${this.file_name}`);
		}

		return await response.blob();
	}

	toApiFormat() {
		return {
			file_uuid: this.file_uuid,
			file_name: this.file_name,
			sanitized_name: this.sanitized_name,
			path: this.path,
			size_bytes: this.size_bytes,
			file_kind: this.file_kind,
			created_at: this.created_at,
			preview_asset: this.preview_asset,
			document_asset: this.document_asset,
			thumbnail_asset: this.thumbnail_asset,
			preview_url: this.preview_url,
			thumbnail_url: this.thumbnail_url
		};
	}

	static fromJSON(json, orgId = null, conversationId = null) {
		return new ClaudeCodeExecutionFile(json, orgId, conversationId);
	}
}

// Unified file parsing - takes API data and returns appropriate class
function parseFileFromAPI(apiData, conversation = null) {
	// Code execution file - has path property
	if (apiData.path) {
		return ClaudeCodeExecutionFile.fromJSON(apiData, conversation?.orgId, conversation?.conversationId);
	}

	// Attachment - has extracted_content
	if (apiData.extracted_content !== undefined) {
		return ClaudeAttachment.fromJSON(apiData);
	}

	// Regular file - has file_uuid
	if (apiData.file_uuid) {
		return ClaudeFile.fromJSON(apiData);
	}

	throw new Error('Unknown file format');
}

class ClaudeMessage {
	constructor(conversation, historyJson = null) {
		this.conversation = conversation;

		// Core
		this.uuid = null;
		this.parent_message_uuid = '00000000-0000-4000-8000-000000000000';
		this.sender = 'human';
		this.index = 0;

		// Content (text is derived from content, not stored separately)
		this.content = [];

		// Timestamps
		this.created_at = null;
		this.updated_at = null;

		// Files
		this._files = [];

		// Other
		this.sync_sources = [];
		this.truncated = false;

		// Completion-specific (defaults)
		this.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		this.locale = getLocale();

		this.model = null;
		this.tools = [];
		this.personalized_styles = [];
		this.rendering_mode = 'messages';

		if (historyJson) {
			this._parseFromHistory(historyJson);
		}
	}

	get files() { return this._files; }

	_parseFromHistory(json) {
		this.uuid = json.uuid;
		this.parent_message_uuid = json.parent_message_uuid;
		this.sender = json.sender;
		this.index = json.index;
		this.content = json.content || [];
		this.created_at = json.created_at;
		this.updated_at = json.updated_at;
		this.truncated = json.truncated || false;
		this.sync_sources = json.sync_sources || [];

		// Parse files_v2 into file instances
		for (const f of json.files_v2 || []) {
			this.attachFile(parseFileFromAPI(f, this.conversation));
		}

		// Parse attachments
		for (const a of json.attachments || []) {
			this.attachFile(parseFileFromAPI(a, this.conversation));
		}
	}

	// Helper to get/set text content for human messages
	get text() {
		const textBlocks = this.content.filter(c => c.type === 'text');
		return textBlocks.map(b => b.text).join('\n\n');
	}

	set text(value) {
		// Replace content with single text block
		this.content = [{ type: 'text', text: value }];
	}

	async addFile(input, filename = null, forceAttachmentMode = false) {
		const data = await this.conversation.getData();
		const codeExecutionEnabled = data.settings?.enabled_monkeys_in_a_barrel === true;

		// Let's make sure the input blob isn't a text file first...
		if (input instanceof Blob) {
			const isText = await isLikelyTextFile(input)
			if (isText) {
				const textContent = await input.text();
				input = textContent;
			}
		}

		// Handle string input (text content)
		if (typeof input === 'string') {
			const name = filename || 'text.txt';
			if (codeExecutionEnabled) {
				const blob = new Blob([input], { type: 'text/plain' });
				const result = await this.conversation.uploadToCodeExecution(blob, name);
				result.extracted_content = input;  // Store text content for inline attachment mode
				result.force_attachment_mode = forceAttachmentMode;
				this._files.push(result);
				return result;
			} else {
				const result = ClaudeAttachment.fromText(input, name);
				this._files.push(result);
				return result;
			}
		}

		// Handle Blob input (new file upload)
		if (input instanceof Blob) {
			const name = filename || 'file';
			if (codeExecutionEnabled) {
				const result = await this.conversation.uploadToCodeExecution(input, name);
				result.force_attachment_mode = forceAttachmentMode;
				this._files.push(result);
				return result;
			} else {
				const result = await ClaudeFile.upload(this.conversation.orgId, input, name);
				this._files.push(result);
				return result;
			}
		}

		// Handle existing file objects - re-upload to this conversation
		// (Files cannot be shared across conversations, they must be re-uploaded)
		if (input instanceof ClaudeFile ||
			input instanceof ClaudeCodeExecutionFile ||
			input instanceof ClaudeAttachment) {

			// Attachments don't need upload if code execution is off
			if (input instanceof ClaudeAttachment && !codeExecutionEnabled) {
				this._files.push(input);
				return input;
			}

			// Download and re-upload
			let blob, fileName, extractedContent = null;
			if (input instanceof ClaudeFile) {
				blob = await input.download();
				fileName = input.file_name;
			} else if (input instanceof ClaudeAttachment) {
				blob = new Blob([input.extracted_content], { type: 'text/plain' });
				fileName = input.file_name;
				extractedContent = input.extracted_content;  // Preserve text content
			} else if (input instanceof ClaudeCodeExecutionFile) {
				blob = await input.download();
				fileName = input.file_name;
				extractedContent = input.extracted_content;  // Preserve text content
			}

			let result;
			if (codeExecutionEnabled) {
				result = await this.conversation.uploadToCodeExecution(blob, fileName);
				if (extractedContent !== null) {
					result.extracted_content = extractedContent;  // Transfer to new file
				}
				result.force_attachment_mode = forceAttachmentMode;
			} else {
				result = await ClaudeFile.upload(this.conversation.orgId, blob, fileName);
			}
			this._files.push(result);
			return result;
		}

		throw new Error('addFile: unsupported input type');
	}

	removeFile(fileOrId) {
		// Accept either a string (uuid/filename) or a file object
		const id = typeof fileOrId === 'string'
			? fileOrId
			: (fileOrId.file_uuid || fileOrId.file_name);
		this._files = this._files.filter(f =>
			(f.file_uuid || f.file_name) !== id
		);
	}

	clearFiles() {
		this._files = [];
	}

	/**
	 * Attach an existing file object WITHOUT uploading.
	 *
	 * IMPORTANT: The file MUST already exist in this conversation.
	 * Use cases:
	 * - Phantom messages (visual display only, real files attached to latest message)
	 * - Editing messages (files already uploaded to this conversation)
	 * - Internal parsing (reconstructing from API/JSON)
	 *
	 * For files from OTHER conversations, use addFile() which will re-upload them.
	 * Files cannot be shared across conversations - they must be re-uploaded.
	 *
	 * For bulk replacement: use clearFiles() then loop with attachFile()
	 *
	 * @param {ClaudeFile|ClaudeCodeExecutionFile|ClaudeAttachment} fileObj - The file to attach
	 * @param {boolean|null} forceAttachmentMode - For ClaudeCodeExecutionFile only: override
	 *        the length-based decision for inline attachment mode. Set to true to force inline,
	 *        false to force reference-only, or null to use default length-based behavior.
	 */
	attachFile(fileObj, forceAttachmentMode = null) {
		if (!(fileObj instanceof ClaudeFile ||
			fileObj instanceof ClaudeCodeExecutionFile ||
			fileObj instanceof ClaudeAttachment)) {
			throw new Error('attachFile requires a file instance (ClaudeFile, ClaudeCodeExecutionFile, or ClaudeAttachment)');
		}
		this._files.push(fileObj);
		if (forceAttachmentMode !== null && fileObj instanceof ClaudeCodeExecutionFile) {
			fileObj.force_attachment_mode = forceAttachmentMode;
		}
		return fileObj;
	}

	removeToolCalls() {
		this.content = this.content.filter(item =>
			item.type !== 'tool_use' && item.type !== 'tool_result'
		);
	}

	_getFilesJSON() {
		const ATTACHMENT_CHAR_LIMIT = 15000;
		const files_v2 = [];
		const files_completion = [];
		const files_history = [];
		const attachments = [];

		for (const f of this._files) {
			if (f instanceof ClaudeAttachment) {

				attachments.push(f.toApiFormat());
			} else if (f instanceof ClaudeCodeExecutionFile) {
				// Check if this should be inlined as attachment
				let shouldInline = false;
				if (f.extracted_content !== null) {
					shouldInline = f.force_attachment_mode ||
						f.extracted_content.length <= ATTACHMENT_CHAR_LIMIT;
				}

				if (shouldInline) {
					// Short text files: inline as attachment ONLY (not in files)
					attachments.push({
						extracted_content: f.extracted_content,
						file_name: f.file_name,
						file_size: f.extracted_content.length,
						file_type: 'text/plain'
					});
				} else {
					// Large files or non-text: include in files array
					const apiFormat = f.toApiFormat();
					files_v2.push(apiFormat);
					files_completion.push(f.file_uuid);

					// Images go in files_history
					if (f.file_kind === 'image') {
						files_history.push(apiFormat);
					}
				}
			} else {
				// ClaudeFile
				const apiFormat = f.toApiFormat();
				files_v2.push(apiFormat);
				files_completion.push(f.file_uuid);

				// Only images go in files_history
				if (f.file_kind === 'image') {
					files_history.push(apiFormat);
				}
			}
		}

		return { files_v2, files_completion, files_history, attachments };
	}

	// toHistoryJSON - use files_history
	toHistoryJSON() {
		const { files_v2, files_history, attachments } = this._getFilesJSON();

		return {
			uuid: this.uuid,
			text: this.text,
			content: this.content,
			sender: this.sender,
			index: this.index,
			created_at: this.created_at,
			updated_at: this.updated_at,
			truncated: this.truncated,
			attachments,
			files: files_history,
			files_v2,
			sync_sources: this.sync_sources,
			parent_message_uuid: this.parent_message_uuid
		};
	}

	toCompletionJSON() {
		// Validate: can only send human messages
		if (this.sender !== 'human') {
			throw new Error('Cannot send non-human message as completion');
		}

		// Extract prompt from content
		const textBlocks = this.content.filter(c => c.type === 'text');
		if (textBlocks.length === 0) {
			throw new Error('Message has no text content');
		}
		if (textBlocks.length > 1) {
			throw new Error('Cannot send message with multiple text blocks as completion');
		}

		const { files_completion, attachments } = this._getFilesJSON();

		return {
			prompt: textBlocks[0].text,
			parent_message_uuid: this.parent_message_uuid,
			timezone: this.timezone,
			personalized_styles: this.personalized_styles,
			locale: this.locale,
			model: this.model,
			tools: this.tools,
			attachments,
			files: files_completion,
			sync_sources: this.sync_sources,
			rendering_mode: this.rendering_mode
		};
	}

	//Does NOT do any filtering, remove unwanted content before calling this
	toChatlogString() {
		const parts = [];
		const allowedContentTypes = ['text', 'tool_use', 'tool_result'];

		// Format content
		for (const item of this.content) {
			if (!allowedContentTypes.includes(item.type)) continue;
			if (item.type === 'text') {
				parts.push(item.text);
			} else {
				parts.push(JSON.stringify(item));
			}
		}

		// Format files
		for (const f of this._files) {
			if (f instanceof ClaudeAttachment) {
				parts.push(`<${f.file_name}>\n${f.extracted_content}\n</${f.file_name}>`);
			} else {
				parts.push(`[File: ${f.file_name} (${f.file_kind})]`);
			}
		}

		return parts.join('\n\n');
	}

	static fromHistoryJSON(conversation, json) {
		return new ClaudeMessage(conversation, json);
	}
}

class ClaudeProject {
	constructor(orgId, projectId) {
		this.orgId = orgId;
		this.projectId = projectId;
		this.projectData = null;
		this.cachedDocs = null;
		this.cachedFiles = null;
	}

	// Get project data
	async getData(forceRefresh = false) {
		if (!this.projectData || forceRefresh) {
			const response = await fetch(`/api/organizations/${this.orgId}/projects/${this.projectId}`);
			if (!response.ok) {
				throw new Error('Failed to fetch project data');
			}
			this.projectData = await response.json();
		}
		return this.projectData;
	}

	// Get syncs
	async getSyncs() {
		const response = await fetch(`/api/organizations/${this.orgId}/projects/${this.projectId}/syncs`);
		if (!response.ok) {
			throw new Error('Failed to fetch project syncs');
		}
		return await response.json();
	}

	// Get docs (attachments) - always fetch, but cache result
	async getDocs() {
		const response = await fetch(`/api/organizations/${this.orgId}/projects/${this.projectId}/docs`);
		if (!response.ok) {
			throw new Error('Failed to fetch project docs');
		}
		this.cachedDocs = await response.json();
		return this.cachedDocs;
	}

	// Get files - always fetch, but cache result
	async getFiles() {
		const response = await fetch(`/api/organizations/${this.orgId}/projects/${this.projectId}/files`);
		if (!response.ok) {
			throw new Error('Failed to fetch project files');
		}
		this.cachedFiles = await response.json();
		return this.cachedFiles;
	}

	// Download attachment (doc) - content is already in the docs response
	async downloadAttachment(docId) {
		// Read from cache if available
		if (!this.cachedDocs) {
			await this.getDocs();
		}

		const doc = this.cachedDocs.find(d => d.uuid === docId);

		if (!doc) {
			throw new Error(`Doc ${docId} not found`);
		}

		// Create blob from content
		const blob = new Blob([doc.content], { type: 'text/plain' });

		// Trigger download
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = doc.file_name;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	// Download file - needs to determine URL based on file type
	async downloadFile(fileId) {
		// Read from cache if available
		if (!this.cachedFiles) {
			await this.getFiles();
		}

		const file = this.cachedFiles.find(f => f.file_uuid === fileId);

		if (!file) {
			throw new Error(`File ${fileId} not found`);
		}

		let downloadUrl;

		// Determine download URL based on file type
		if (file.file_kind === 'document' && file.document_asset) {
			// PDF or document - use document_asset URL
			downloadUrl = file.document_asset.url;
		} else if (file.file_kind === 'image') {
			// Image - prefer preview_url over thumbnail_url
			downloadUrl = file.preview_url || file.thumbnail_url;

			// Or look for original asset if available
			if (file.preview_asset?.file_variant === 'original') {
				downloadUrl = file.preview_asset.url;
			} else if (file.thumbnail_asset?.file_variant === 'original') {
				downloadUrl = file.thumbnail_asset.url;
			}
		} else {
			// Fallback to preview_url if available
			downloadUrl = file.preview_url || file.thumbnail_url;
		}

		if (!downloadUrl) {
			throw new Error(`No download URL found for file ${fileId}`);
		}

		// Fetch the actual file content
		const response = await fetch(downloadUrl);
		if (!response.ok) {
			throw new Error(`Failed to download file ${fileId}`);
		}

		const blob = await response.blob();

		// Trigger download
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = file.file_name;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	// Download all files and attachments as a zip
	async downloadAll() {

		// Fetch project data and file lists
		const [projectData, docs, files] = await Promise.all([
			this.getData(),
			this.getDocs(),
			this.getFiles()
		]);

		const projectName = projectData.name || 'project';

		// Create zip
		const zip = new JSZip();

		// Add docs (content is already available)
		for (const doc of docs) {
			// Add UUID to filename to avoid collisions
			const filename = this._makeUniqueFilename(doc.file_name, doc.uuid);
			zip.file(filename, doc.content);
		}

		// Fetch and add files
		for (const file of files) {
			let downloadUrl;

			// Determine download URL based on file type
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

			if (!downloadUrl) {
				continue;
			}

			try {
				const response = await fetch(downloadUrl);
				if (!response.ok) {
					console.error(`[ClaudeProject] Failed to fetch ${file.file_name}`);
					continue;
				}
				const blob = await response.blob();

				// Add UUID to filename to avoid collisions
				const filename = this._makeUniqueFilename(file.file_name, file.file_uuid);
				zip.file(filename, blob);
			} catch (error) {
				console.error(`[ClaudeProject] Error downloading ${file.file_name}:`, error);
			}
		}

		// Generate zip and trigger download
		const zipBlob = await zip.generateAsync({ type: 'blob' });

		const url = URL.createObjectURL(zipBlob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${projectName}.zip`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	// Helper to make unique filenames
	_makeUniqueFilename(filename, uuid) {
		// Split filename into name and extension
		const lastDot = filename.lastIndexOf('.');
		if (lastDot === -1) {
			// No extension
			return `${filename}-${uuid}`;
		}

		const name = filename.substring(0, lastDot);
		const ext = filename.substring(lastDot);
		return `${name}-${uuid}${ext}`;
	}
}


/**
 * Fetches account settings from the API.
 * WARNING: Only LIMITED settings are returned (artifacts, code execution).
 * To get complete settings, use conversation.getData().settings instead.
 */
async function getAccountSettings() {
	const response = await fetch('/api/account');
	if (!response.ok) {
		throw new Error('Failed to fetch account settings');
	}
	return await response.json();
}

/**
 * Updates account settings via the API (PATCH).
 * Can modify ALL settings (not just the limited ones returned by getAccountSettings).
 * Changes are account-wide and affect all new conversations until changed again.
 * @param {Object} settings - Settings to update
 */
async function updateAccountSettings(settings) {
	const response = await fetch('https://claude.ai/api/account/settings', {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(settings)
	});
	if (!response.ok) throw new Error('Failed to update account settings');
	return await response.json();
}

/**
 * Ensures a conversation has the desired settings (artifacts and code execution).
 * If there's a mismatch, prompts user to cancel, continue anyway, or switch.
 *
 * @param {ClaudeConversation} conversation - The newly created conversation
 * @param {Object} desiredSettings - The desired settings object from source conversation
 * @param {boolean} forceSwitch - If true, skip user prompt and always switch to desired settings
 * @returns {Promise<{conversation: ClaudeConversation, restoreSettings: (() => Promise<void>) | null}>}
 *          conversation: The conversation (same or recreated)
 *          restoreSettings: Call after first message to restore original account settings (null if not needed)
 * @throws {Error} USER_CANCELLED if user cancels (only when forceSwitch is false)
 */
// Notable gotcha: A conversation which has no messages will continue to exist in "limbo" until the first message is sent, changing settings to match the account-wide ones.
// This is why delaying the restoreSettings call until after the first message is important.
async function ensureSettingsState(conversation, desiredSettings, forceSwitch = false) {
	const convData = await conversation.getData();
	const currentSettings = convData.settings || {};

	// Extract relevant settings (default to false if missing)
	const desiredArtifacts = desiredSettings?.preview_feature_uses_artifacts === true;
	const desiredCE = desiredSettings?.enabled_monkeys_in_a_barrel === true;
	const currentArtifacts = currentSettings.preview_feature_uses_artifacts === true;
	const currentCE = currentSettings.enabled_monkeys_in_a_barrel === true;

	// Check what differs
	const artifactsMismatch = desiredArtifacts !== currentArtifacts;
	const ceMismatch = desiredCE !== currentCE;

	// If not forcing and no mismatch, return early
	if (!forceSwitch && !artifactsMismatch && !ceMismatch) {
		return { conversation, restoreSettings: async () => { } };
	}

	// If not forcing, prompt user for action
	if (!forceSwitch) {
		// Build mismatch description
		const mismatches = [];
		if (artifactsMismatch) {
			mismatches.push(`Artifacts: Originally ${desiredArtifacts ? 'ON' : 'OFF'} | Currently ${currentArtifacts ? 'ON' : 'OFF'}`);
		}
		if (ceMismatch) {
			mismatches.push(`Code Execution: Originally ${desiredCE ? 'ON' : 'OFF'} | Currently ${currentCE ? 'ON' : 'OFF'}`);
		}

		const result = await showClaudeThreeOption(
			'Settings Mismatch',
			`Source conversation has different settings:\n${mismatches.join('\n')}\n\nWhat would you like to do?`,
			{
				left: { text: 'Cancel', variant: 'secondary' },
				middle: { text: 'Continue anyway', variant: 'secondary' },
				right: { text: 'Switch to match', variant: 'primary' }
			}
		);

		if (result === 'left') {
			await conversation.delete();
			throw new Error('USER_CANCELLED');
		}

		if (result === 'middle') {
			return { conversation, restoreSettings: async () => { } };
		}
		// result === 'right' falls through to switch logic below
	}

	// Switch logic: delete conversation, apply settings, recreate
	await conversation.delete();
	await updateAccountSettings({
		preview_feature_uses_artifacts: desiredArtifacts,
		enabled_monkeys_in_a_barrel: desiredCE
	});
	// Create new conversation with correct settings (still in "limbo" until first message)
	const newConversation = new ClaudeConversation(conversation.orgId);
	await newConversation.create(convData.name, convData.model, convData.project?.uuid);
	// Return cleanup function - caller must invoke after first message to restore settings
	return {
		conversation: newConversation,
		restoreSettings: async () => {
			await updateAccountSettings({
				preview_feature_uses_artifacts: currentArtifacts,
				enabled_monkeys_in_a_barrel: currentCE
			});
		}
	};
}

async function downloadFile(url) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to download from ${url}`);
	}
	return await response.blob();
}

async function downloadFiles(files) {
	const downloadedFiles = [];

	for (const file of files) {
		try {
			const blob = await downloadFile(file.url);
			downloadedFiles.push({
				data: blob,
				name: file.name,
				kind: file.kind,
				originalUuid: file.uuid
			});
		} catch (error) {
			console.error(`Failed to download file ${file.name}:`, error);
		}
	}

	return downloadedFiles;
}

// Sync source processing
async function processSyncSource(orgId, syncsource) {
	const response = await fetch(`/api/organizations/${orgId}/sync/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			sync_source_config: syncsource?.config,
			sync_source_type: syncsource?.type
		})
	});

	if (!response.ok) {
		console.error(`Failed to process sync source: ${response.statusText}`);
		return null;
	}

	const result = await response.json();
	return result.uuid;
}

// Check if user is pro/free
async function getUserType(orgId) {
	const response = await fetch(`/api/bootstrap/${orgId}/statsig`, {
		method: 'GET',
		headers: { 'Content-Type': 'application/json' },
	});

	if (!response.ok) {
		console.error('Failed to fetch user type');
		return 'unknown';
	}

	const data = await response.json();
	const orgType = data?.user?.custom?.orgType;
	return orgType === 'claude_free' ? 'free' : 'pro';
}

// UUID generator
function generateUuid() {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
		const r = Math.random() * 16 | 0;
		const v = c === 'x' ? r : (r & 0x3 | 0x8);
		return v.toString(16);
	});
}

function getOrgId() {
	const cookies = document.cookie.split(';');
	for (const cookie of cookies) {
		const [name, value] = cookie.trim().split('=');
		if (name === 'lastActiveOrg') {
			return value;
		}
	}
	throw new Error('Could not find organization ID');
}

function getConversationId() {
	const match = window.location.pathname.match(/\/chat\/([a-f0-9-]+)/);
	return match ? match[1] : null;
}

async function isLikelyTextFile(file) {
	// First check browser-provided MIME type
	if (file.type && file.type.startsWith('text/')) {
		return true;
	}

	// Check MIME type from library
	const mimeType = mime.getType(file.name);
	if (mimeType) {
		// text/* types are obviously text
		if (mimeType.startsWith('text/')) {
			return true;
		}
		// Many code/data files have application/* types but are text
		const textLikeTypes = [
			'application/javascript',
			'application/json',
			'application/xml',
			'application/x-sh',
			'application/x-python',
			'application/x-ruby',
			'application/x-perl',
			'application/x-php',
			'application/sql',
			'application/graphql',
			'application/ld+json',
			'application/x-yaml',
			'application/toml',
		];
		if (textLikeTypes.includes(mimeType) || mimeType.endsWith('+xml') || mimeType.endsWith('+json')) {
			return true;
		}
	}

	// Fallback: Try to read first 1KB to check if it's text
	try {
		const slice = file.slice(0, 1024);
		const arrayBuffer = await slice.arrayBuffer();
		const bytes = new Uint8Array(arrayBuffer);

		// Check for null bytes (binary files often have these)
		for (let i = 0; i < bytes.length; i++) {
			if (bytes[i] === 0) {
				return false; // Likely binary
			}
		}

		// Check if most bytes are printable ASCII or common UTF-8
		let printableCount = 0;
		for (let i = 0; i < bytes.length; i++) {
			const byte = bytes[i];
			// Printable ASCII, tab, newline, carriage return, or valid UTF-8 start bytes
			if ((byte >= 32 && byte <= 126) || byte === 9 || byte === 10 || byte === 13 || byte >= 128) {
				printableCount++;
			}
		}

		// If >90% of bytes are printable, likely text
		return (printableCount / bytes.length) > 0.9;
	} catch (error) {
		console.error('Error checking file type:', error);
		// Default to allowing it if we can't check
		return true;
	}
}

const CLAUDE_MODELS = [
	{ value: 'claude-opus-4-6', label: 'Opus 4.6' },
	{ value: 'claude-opus-4-5-20251101', label: 'Opus 4.5' },
	{ value: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
	{ value: 'claude-opus-4-1-20250805', label: 'Opus 4.1' },
	{ value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
	{ value: 'claude-sonnet-4-20250514', label: 'Sonnet 4' },
	{ value: 'claude-opus-4-20250514', label: 'Opus 4' },
	{ value: 'claude-3-opus-20240229', label: 'Opus 3' },
	{ value: 'claude-3-5-haiku-20241022', label: 'Haiku 3.5' }
]

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';
const FAST_MODEL = 'claude-haiku-4-5-20251001';

// Test function for verifying ClaudeMessage and file classes work correctly
// Usage: window.testClaudeAPI() or window.testClaudeAPI({ sendMessage: true })
window.testClaudeAPI = async function (options = {}) {
	const { sendMessage = false } = options;
	const results = { passed: [], failed: [], warnings: [] };

	function pass(test) {
		console.log(`✅ ${test}`);
		results.passed.push(test);
	}

	function fail(test, error) {
		console.error(`❌ ${test}:`, error);
		results.failed.push({ test, error: error.message || error });
	}

	function warn(msg) {
		console.warn(`⚠️ ${msg}`);
		results.warnings.push(msg);
	}

	console.log('=== ClaudeAPI Test Suite ===\n');

	// Get current conversation
	const conversationId = getConversationId();
	if (!conversationId) {
		fail('Get conversation ID', 'Not on a conversation page');
		return results;
	}
	pass('Get conversation ID');

	const orgId = getOrgId();
	pass('Get org ID');

	const conversation = new ClaudeConversation(orgId, conversationId);

	// Test getData
	let convData;
	try {
		convData = await conversation.getData();
		pass('ClaudeConversation.getData()');
		console.log(`  Conversation: "${convData.name}"`);
		console.log(`  Code execution: ${convData.settings?.enabled_monkeys_in_a_barrel ? 'ON' : 'OFF'}`);
	} catch (e) {
		fail('ClaudeConversation.getData()', e);
		return results;
	}

	// Test getMessages
	let messages;
	try {
		messages = await conversation.getMessages();
		pass(`ClaudeConversation.getMessages() - ${messages.length} messages`);

		// Verify they're ClaudeMessage instances
		if (messages.every(m => m instanceof ClaudeMessage)) {
			pass('All messages are ClaudeMessage instances');
		} else {
			fail('All messages are ClaudeMessage instances', 'Some messages are not ClaudeMessage');
		}
	} catch (e) {
		fail('ClaudeConversation.getMessages()', e);
		return results;
	}

	// Test ClaudeMessage properties on first user message
	const userMsg = messages.find(m => m.sender === 'human');
	if (userMsg) {
		console.log('\n--- Testing ClaudeMessage on first user message ---');

		// Test text getter
		try {
			const text = userMsg.text;
			pass(`text getter: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`);
		} catch (e) {
			fail('text getter', e);
		}

		// Test files getter
		try {
			const files = userMsg.files;
			pass(`files getter: ${files.length} files`);
			for (const f of files) {
				const type = f instanceof ClaudeFile ? 'ClaudeFile' :
					f instanceof ClaudeCodeExecutionFile ? 'ClaudeCodeExecutionFile' :
						f instanceof ClaudeAttachment ? 'ClaudeAttachment' : 'Unknown';
				console.log(`    - ${f.file_name} (${type})`);
			}
		} catch (e) {
			fail('files getter', e);
		}

		// Test toHistoryJSON
		try {
			const json = userMsg.toHistoryJSON();
			if (json.uuid && json.sender && json.content) {
				pass('toHistoryJSON() produces valid structure');
			} else {
				fail('toHistoryJSON()', 'Missing required fields');
			}
		} catch (e) {
			fail('toHistoryJSON()', e);
		}

		// Test fromHistoryJSON roundtrip
		try {
			const json = userMsg.toHistoryJSON();
			const restored = ClaudeMessage.fromHistoryJSON(conversation, json);
			if (restored.uuid === userMsg.uuid &&
				restored.text === userMsg.text &&
				restored.files.length === userMsg.files.length) {
				pass('fromHistoryJSON() roundtrip preserves data');
			} else {
				fail('fromHistoryJSON() roundtrip', 'Data mismatch');
			}
		} catch (e) {
			fail('fromHistoryJSON() roundtrip', e);
		}

		// Test toChatlogString
		try {
			const chatlog = userMsg.toChatlogString();
			if (typeof chatlog === 'string' && chatlog.length > 0) {
				pass(`toChatlogString(): ${chatlog.length} chars`);
			} else {
				fail('toChatlogString()', 'Empty or invalid result');
			}
		} catch (e) {
			fail('toChatlogString()', e);
		}
	} else {
		warn('No user message found to test ClaudeMessage properties');
	}

	// Test file operations
	console.log('\n--- Testing File Operations ---');

	// Find messages with files
	const msgWithFiles = messages.find(m => m.files.length > 0);
	if (msgWithFiles) {
		const file = msgWithFiles.files[0];
		console.log(`Testing with file: ${file.file_name}`);

		// Test parseFileFromAPI
		try {
			const apiData = file.toApiFormat();
			const parsed = parseFileFromAPI(apiData, conversation);
			const expectedType = file.constructor.name;
			const actualType = parsed.constructor.name;
			if (expectedType === actualType) {
				pass(`parseFileFromAPI() correctly identifies ${expectedType}`);
			} else {
				fail('parseFileFromAPI()', `Expected ${expectedType}, got ${actualType}`);
			}
		} catch (e) {
			fail('parseFileFromAPI()', e);
		}

		// Test download (if not ClaudeAttachment)
		if (!(file instanceof ClaudeAttachment)) {
			try {
				const downloadUrl = file.getDownloadUrl();
				if (downloadUrl) {
					pass(`getDownloadUrl(): ${downloadUrl.slice(0, 60)}...`);

					const blob = await file.download();
					if (blob && blob.size > 0) {
						pass(`download(): ${blob.size} bytes`);

						// Test addFile with existing file (re-upload)
						try {
							const reuploadTestMsg = new ClaudeMessage(conversation);
							const reuploaded = await reuploadTestMsg.addFile(file);
							if (reuploaded) {
								const reuploadType = reuploaded.constructor.name;
								pass(`addFile(existingFile) returned ${reuploadType}: ${reuploaded.file_name}`);
							} else {
								fail('addFile(existingFile)', 'Returned null');
							}
						} catch (e) {
							fail('addFile(existingFile)', e);
						}
					} else {
						fail('download()', 'Empty blob');
					}
				} else {
					warn('No download URL available for file');
				}
			} catch (e) {
				fail('File download/reupload', e);
			}
		} else {
			pass('ClaudeAttachment detected (no download needed - inline content)');
		}
	} else {
		warn('No messages with files found - skipping file tests');
	}

	// Test ClaudeMessage modification methods
	console.log('\n--- Testing ClaudeMessage Modification ---');

	// Create a fresh message for testing modifications
	const testMsg = new ClaudeMessage(conversation);
	testMsg.text = 'Test message content';

	// Test text setter
	if (testMsg.text === 'Test message content') {
		pass('text setter works');
	} else {
		fail('text setter', 'Text not set correctly');
	}

	// Test clearFiles
	testMsg.attachFile(ClaudeAttachment.fromText('test', 'test.txt'));
	testMsg.clearFiles();
	if (testMsg.files.length === 0) {
		pass('clearFiles() removes all files');
	} else {
		fail('clearFiles()', 'Files not cleared');
	}

	// Test removeToolCalls
	testMsg.content = [
		{ type: 'text', text: 'Hello' },
		{ type: 'tool_use', id: '123', name: 'test' },
		{ type: 'tool_result', tool_use_id: '123' }
	];
	testMsg.removeToolCalls();
	if (testMsg.content.length === 1 && testMsg.content[0].type === 'text') {
		pass('removeToolCalls() strips tool content');
	} else {
		fail('removeToolCalls()', `Expected 1 text item, got ${testMsg.content.length} items`);
	}

	// Test addFile with string (creates attachment or code exec file)
	console.log('\n--- Testing addFile ---');
	try {
		const addedFile = await testMsg.addFile('Test file content', 'test-content.txt');
		const expectedType = convData.settings?.enabled_monkeys_in_a_barrel
			? 'ClaudeCodeExecutionFile'
			: 'ClaudeAttachment';
		const actualType = addedFile.constructor.name;
		if (actualType === expectedType) {
			pass(`addFile(string) creates ${expectedType}`);
		} else {
			warn(`addFile(string) created ${actualType}, expected ${expectedType}`);
		}
	} catch (e) {
		fail('addFile(string)', e);
	}

	// Test toCompletionJSON
	console.log('\n--- Testing toCompletionJSON ---');
	const completionMsg = new ClaudeMessage(conversation);
	completionMsg.text = 'Test prompt';
	completionMsg.sender = 'human';

	try {
		const completionJson = completionMsg.toCompletionJSON();
		if (completionJson.prompt === 'Test prompt' &&
			completionJson.parent_message_uuid &&
			Array.isArray(completionJson.attachments) &&
			Array.isArray(completionJson.files)) {
			pass('toCompletionJSON() produces valid structure');
		} else {
			fail('toCompletionJSON()', 'Missing required fields');
		}
	} catch (e) {
		fail('toCompletionJSON()', e);
	}

	// Optional: Send a test message with all files reuploaded
	if (sendMessage) {
		console.log('\n--- Testing sendMessageAndWaitForResponse ---');
		warn('This will send a real message to Claude!');

		const testPrompt = new ClaudeMessage(conversation);
		testPrompt.text = 'This is a test message from testClaudeAPI(). Please respond with just "Test received." and nothing else.';
		testPrompt.sender = 'human';

		// Collect all unique files from all messages
		const allFiles = [];
		const seenIds = new Set();
		for (const msg of messages) {
			for (const file of msg.files) {
				const id = file.file_uuid || file.file_name;
				if (!seenIds.has(id)) {
					seenIds.add(id);
					allFiles.push(file);
				}
			}
		}

		console.log(`Found ${allFiles.length} unique files to reupload`);

		// Re-upload all files using addFile()
		for (const fileToReupload of allFiles) {
			try {
				const reuploaded = await testPrompt.addFile(fileToReupload);
				const action = fileToReupload instanceof ClaudeAttachment ? 'Included' : 'Re-uploaded';
				pass(`${action} file via addFile(): ${reuploaded.file_name} (${reuploaded.constructor.name})`);
			} catch (e) {
				fail(`addFile(${fileToReupload.file_name})`, e.message);
			}
		}

		// Also add a new text attachment via addFile(string)
		try {
			const testContent = `Test attachment created at ${new Date().toISOString()}`;
			const newAttachment = await testPrompt.addFile(testContent, 'test-attachment.txt');
			pass(`addFile(string) created: ${newAttachment.file_name} (${newAttachment.constructor.name})`);
		} catch (e) {
			fail('addFile(string)', e.message);
		}

		try {
			const response = await conversation.sendMessageAndWaitForResponse(testPrompt);
			if (response && response.uuid) {
				pass(`Message sent and response received: ${response.uuid}`);
				console.log(`  Response text: "${response.text.slice(0, 100)}..."`);
			} else {
				fail('sendMessageAndWaitForResponse()', 'No response received');
			}
		} catch (e) {
			fail('sendMessageAndWaitForResponse()', e);
		}
	}

	// Summary
	console.log('\n=== Test Summary ===');
	console.log(`Passed: ${results.passed.length}`);
	console.log(`Failed: ${results.failed.length}`);
	console.log(`Warnings: ${results.warnings.length}`);

	if (results.failed.length > 0) {
		console.log('\nFailed tests:');
		for (const f of results.failed) {
			console.log(`  - ${f.test}: ${f.error}`);
		}
	}

	return results;
};
