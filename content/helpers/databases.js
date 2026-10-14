// databases.js
(function () {
	'use strict';
	const log = createLogger('Database');

	// ======== HELPERS ========
	window.ClaudeSearchShared = window.ClaudeSearchShared || {};

	window.ClaudeSearchShared.getRelativeTime = function (timestamp) {
		const now = Date.now();
		const messageTime = new Date(timestamp).getTime();
		const diff = now - messageTime;

		const seconds = Math.floor(diff / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);
		const days = Math.floor(hours / 24);
		const weeks = Math.floor(days / 7);
		const months = Math.floor(days / 30);
		const years = Math.floor(days / 365);

		const rtf = new Intl.RelativeTimeFormat(currentLocale(), { numeric: 'auto', style: 'narrow' });
		if (years > 0) return rtf.format(-years, 'year');
		if (months > 0) return rtf.format(-months, 'month');
		if (weeks > 0) return rtf.format(-weeks, 'week');
		if (days > 0) return rtf.format(-days, 'day');
		if (hours > 0) return rtf.format(-hours, 'hour');
		if (minutes > 0) return rtf.format(-minutes, 'minute');
		return rtf.format(0, 'second');
	};

	window.ClaudeSearchShared.simplifyText = function (text) {
		return text
			.toLowerCase()
			.replace(/[*_`~[\]()]/g, '')  // Remove markdown chars
			.replace(/\s+/g, ' ')           // Normalize whitespace
			.replace(/[""'']/g, '"')        // Normalize quotes
			.trim();
	};

	// ======== QUERY MATCHING ========
	// A query wrapped in slashes (`/pattern/`) is treated as a case-insensitive regex, everything
	// else is scanned literally. Anything trailing the closing slash means "not regex", so `/foo/i`
	// searches for that literally.
	window.ClaudeSearchShared.compileQuery = function (query) {
		const literal = { regex: null, lower: (query || '').toLowerCase() };
		if (!query || query.length <= 2) return literal;
		if (!query.startsWith('/') || !query.endsWith('/')) return literal;

		try {
			// 'm' so ^ and $ anchor to lines rather than to the whole conversation blob, which is
			// what anyone typing ^ in a search box means.
			return { regex: new RegExp(query.slice(1, -1), 'gim'), lower: null };
		} catch {
			// Half-typed or invalid pattern - fall back to a literal search rather than throwing.
			// Throwing here is what made the old code silently drop to title-only results.
			return literal;
		}
	};

	// Max matches counted in a single text, so a pattern like /\s/ can't pile up a million
	// offset objects per conversation across the whole corpus.
	const MAX_MATCHES_PER_TEXT = 10000;

	// All occurrences of `matcher` within `text`, as {start, end} offsets.
	window.ClaudeSearchShared.findMatches = function (text, matcher) {
		if (!text || !matcher) return [];
		const out = [];

		if (matcher.regex) {
			// The compiled regex is stateful and gets reused across every conversation in a search.
			matcher.regex.lastIndex = 0;
			let m;
			while ((m = matcher.regex.exec(text)) !== null) {
				if (m[0].length > 0) {
					out.push({ start: m.index, end: m.index + m[0].length });
					if (out.length >= MAX_MATCHES_PER_TEXT) break;
				}
				// Zero-width matches (/x*/, /(?:)/) never advance lastIndex on their own.
				if (m.index === matcher.regex.lastIndex) matcher.regex.lastIndex++;
			}
			return out;
		}

		if (!matcher.lower) return [];
		const lowerText = text.toLowerCase();
		let from = 0;
		while (true) {
			const i = lowerText.indexOf(matcher.lower, from);
			if (i === -1) break;
			out.push({ start: i, end: i + matcher.lower.length });
			if (out.length >= MAX_MATCHES_PER_TEXT) break;
			from = i + matcher.lower.length;
		}
		return out;
	};

	window.ClaudeSearchShared.fuzzyMatch = function (searchText, targetText) {
		// Get words from search text (ignore very short words)
		const searchWords = searchText
			.toLowerCase()
			.split(/\s+/)
			.filter(word => word.length > 2);

		const targetLower = targetText.toLowerCase();

		// Count how many search words appear in target
		const matchedWords = searchWords.filter(word => targetLower.includes(word));

		const matchRatio = matchedWords.length / searchWords.length;
		return matchRatio >= 0.85;
	};

	// ======== ENCRYPTION AND PER-ORG DATABASES ========
	// Several orgs can share this storage (switching orgs in one profile), so each org has its own
	// databases (ClaudeExportDB_<orgId>, ClaudePhantomMessagesDB_<orgId>) and its own key, kept in that
	// org's ENCRYPTION_SKILL_NAME skill. Nothing here ever touches another org's data.
	const ENCRYPTION_SKILL_NAME = 'qol-encryptionkey-do-not-delete';
	const _orgs = new Map(); // orgId -> promise of the org's { orgId, key, keyHash, cacheDB, phantomDB }, or null

	// The current org's key and databases, or null (logged out, or no key could be fetched or made:
	// then nothing is stored, rather than stored in plaintext).
	function getOrg() {
		const orgId = getActiveOrgId();
		if (!orgId) return Promise.resolve(null);
		if (!_orgs.has(orgId)) _orgs.set(orgId, _initOrg(orgId));
		return _orgs.get(orgId);
	}

	async function _initOrg(orgId) {
		const cacheDB = new Dexie(`ClaudeExportDB_${orgId}`);
		cacheDB.version(1).stores({ conversations: 'uuid' }); // { uuid, updated_at, data }
		const phantomDB = new Dexie(`ClaudePhantomMessagesDB_${orgId}`);
		phantomDB.version(1).stores({ phantomMessages: 'conversationId' }); // { conversationId, encryptedData }

		const keySkill = await _fetchKeySkill(orgId);
		if (keySkill === undefined) return null; // couldn't ask
		let rawKey;
		if (keySkill) {
			log('Found encryption key skill:', keySkill.id);
			rawKey = Uint8Array.from(atob(keySkill.description.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
		} else {
			// No skill: this org's data is unreadable (its key is gone). Start over with a new key.
			log('No encryption key skill found, wiping this org\'s data...');
			await Promise.all([cacheDB.conversations.clear(), phantomDB.phantomMessages.clear()]);
			rawKey = await _createKeySkill(orgId);
			if (!rawKey) return null;
		}
		const keyHash = await _computeKeyHash(rawKey);
		log('Key hash:', keyHash);
		const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
		const org = { orgId, key, keyHash, cacheDB, phantomDB };
		await _claimLegacyPhantoms(org); // before the first read, so a fork's phantoms are there
		writePhantomIdsMirror(org);
		return org;
	}

	// The org's key skill, null if it has none, undefined if the skills couldn't be listed.
	async function _fetchKeySkill(orgId) {
		for (let attempt = 0; attempt < 10; attempt++) {
			try {
				const skillsData = await listSkills(orgId);
				return (skillsData.skills || []).find(s => s.name === ENCRYPTION_SKILL_NAME) ?? null;
			} catch (e) {
				if (attempt < 9) {
					log.warn(`Failed to fetch skills (attempt ${attempt + 1}/10), retrying...`);
					await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
					continue;
				}
				log.warn('Failed to fetch skills after 10 attempts, not storing anything this page load:', e.message);
				return undefined;
			}
		}
	}

	// A new random key, saved as the org's (disabled) key skill. Null if that fails.
	async function _createKeySkill(orgId) {
		const rawKey = crypto.getRandomValues(new Uint8Array(16)); // 128-bit
		const base64Key = btoa(String.fromCharCode(...rawKey))
			.replace(/=+$/, '')
			.replace(/\+/g, '-')
			.replace(/\//g, '_');
		for (let attempt = 0; attempt < 10; attempt++) {
			try {
				const skill = await createSkill(orgId, ENCRYPTION_SKILL_NAME, base64Key);
				log('Created encryption key skill:', skill.id);
				await disableSkill(orgId, skill.id);
				log('Disabled encryption key skill');
				return rawKey;
			} catch (e) {
				if (attempt < 9) {
					log.warn(`Failed to create key skill (attempt ${attempt + 1}/10), retrying...`);
					await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
					continue;
				}
				log.warn('Failed to create key skill after 10 attempts, not storing anything this page load:', e.message);
				return null;
			}
		}
	}

	async function _computeKeyHash(rawKey) {
		const hash = await crypto.subtle.digest('SHA-256', rawKey);
		const hex = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
		return hex.substring(0, 8);
	}

	// Encrypt: returns { v: 1, keyHash, data: base64(iv + ciphertext) }
	async function encryptData(data, org) {
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const encoded = new TextEncoder().encode(JSON.stringify(data));
		const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, org.key, encoded);
		const combined = new Uint8Array(iv.length + ciphertext.byteLength);
		combined.set(iv);
		combined.set(new Uint8Array(ciphertext), iv.length);
		let binary = '';
		for (let i = 0; i < combined.length; i++) binary += String.fromCharCode(combined[i]);
		return { v: 1, keyHash: org.keyHash, data: btoa(binary) };
	}

	const isEncrypted = (item) => !!(item && typeof item === 'object' && item.v && item.keyHash);

	async function decryptData(item, org) {
		if (item.keyHash !== org.keyHash) {
			throw new Error(`Key mismatch: item encrypted with ${item.keyHash}, current key is ${org.keyHash}`);
		}
		const combined = Uint8Array.from(atob(item.data), c => c.charCodeAt(0));
		const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: combined.slice(0, 12) }, org.key, combined.slice(12));
		return JSON.parse(new TextDecoder().decode(decrypted));
	}

	// Row `id` with row[field] decrypted, or null. A row that won't decrypt (its key was replaced) is
	// deleted.
	async function readRow(table, id, field) {
		const org = await getOrg();
		const row = org && await table(org).get(id);
		if (!row?.[field]) return null;
		try {
			return { ...row, [field]: await decryptData(row[field], org) };
		} catch (e) {
			log.warn(`Decryption failed for ${id}, deleting entry`);
			await table(org).delete(id);
			return null;
		}
	}

	// Encrypts `data` into row[field] and stores the row. False when there's no key to encrypt with.
	async function writeRow(table, row, field, data) {
		const org = await getOrg();
		if (!org) {
			log.warn('No encryption key for this org, not storing', Object.values(row)[0]);
			return false;
		}
		await table(org).put({ ...row, [field]: await encryptData(data, org) });
		return true;
	}

	const cacheTable = (org) => org.cacheDB.conversations;
	const phantomTable = (org) => org.phantomDB.phantomMessages;

	// ======== LEGACY DATABASES ========
	// Before per-org databases, every org shared ClaudePhantomMessagesDB (and ClaudeExportDB). Each org
	// moves the phantoms encrypted with its key into its own database, re-encrypting plaintext ones
	// (from before encryption; whichever org loads first takes those, as the old bulk encryption did).
	// Rows of an org that hasn't loaded yet stay; the database goes once it's empty. The conversation
	// cache is just a cache, so its legacy database is simply deleted (deleteOldDatabases).
	const LEGACY_PHANTOM_DB = 'ClaudePhantomMessagesDB';

	async function _claimLegacyPhantoms(org) {
		try {
			if (!(await Dexie.exists(LEGACY_PHANTOM_DB))) return;
			const legacy = await new Dexie(LEGACY_PHANTOM_DB).open(); // dynamic mode: whatever schema it has
			const table = legacy.table('phantomMessages');
			// Take them out in one transaction, so two orgs initializing at once can't both take the same
			// plaintext rows. A crash before they're stored below loses them; the page rebuilds phantoms
			// from the fork's chatlog.txt.
			const mine = await legacy.transaction('rw', table, async () => {
				const rows = (await table.toArray()).filter(r => !isEncrypted(r.encryptedData) || r.encryptedData.keyHash === org.keyHash);
				await table.bulkDelete(rows.map(r => r.conversationId));
				return rows;
			});
			if (mine.length) {
				const moved = await Promise.all(mine.map(async ({ conversationId, encryptedData }) => ({
					conversationId,
					encryptedData: isEncrypted(encryptedData) ? encryptedData : await encryptData(encryptedData, org),
				})));
				await phantomTable(org).bulkPut(moved);
				log(`Moved ${moved.length} phantom conversations into this org's database`);
			}
			const left = await table.count();
			legacy.close();
			// Not awaited: an open connection elsewhere (a tab still on an older version) blocks it.
			if (!left) Dexie.delete(LEGACY_PHANTOM_DB).catch(() => { });
		} catch (e) {
			log.warn('Moving legacy phantoms failed:', e.message);
		}
	}

	// One-time migration: delete databases left behind by removed features (the global text search)
	// and the shared pre-per-org conversation cache.
	async function deleteOldDatabases() {
		for (const name of ['ClaudeSearchDB', 'ClaudeExportDB']) {
			try {
				if (!(await Dexie.exists(name))) continue;
				await Dexie.delete(name);
				log('Deleted old database:', name);
			} catch (e) {
				log.warn('Failed to delete old database', name, e.message);
			}
		}
		localStorage.removeItem('global_search_queries');
	}

	deleteOldDatabases();
	getOrg(); // eagerly load this org's key

	// ======== CONVERSATION CACHE ========
	window.ClaudeSearchShared.conversationCache = {
		// { uuid, updated_at, data } or null
		async get(conversationId) {
			return readRow(cacheTable, conversationId, 'data');
		},
		async put(conversationId, updatedAt, data) {
			await writeRow(cacheTable, { uuid: conversationId, updated_at: updatedAt }, 'data', data);
		},
	};

	// ======== PHANTOM MESSAGES ========
	// Which conversations have phantoms, mirrored per org to the page's localStorage (ids only,
	// org-mirror.js) so that phantom-messages.js (MAIN) can tell synchronously, and only holds those
	// chats' snapshots.
	async function writePhantomIdsMirror(org) {
		try {
			writeOrgMirror('phantom_ids', await phantomTable(org).toCollection().primaryKeys());
		} catch (e) {
			log.warn('Could not mirror the phantom conversation ids:', e.message);
		}
	}

	async function storePhantomMessagesDB(conversationId, messages) {
		if (await writeRow(phantomTable, { conversationId }, 'encryptedData', { messages, timestamp: Date.now() })) {
			await writePhantomIdsMirror(await getOrg());
		}
	}

	async function getPhantomMessagesDB(conversationId) {
		return (await readRow(phantomTable, conversationId, 'encryptedData'))?.encryptedData.messages ?? null;
	}

	async function clearPhantomMessagesDB(conversationId) {
		const org = await getOrg();
		if (!org) return;
		await phantomTable(org).delete(conversationId);
		await writePhantomIdsMirror(org);
	}

	// Expose for direct use in isolated world
	window.ClaudeSearchShared.storePhantomMessages = storePhantomMessagesDB;
	window.ClaudeSearchShared.getPhantomMessages = getPhantomMessagesDB;
	window.ClaudeSearchShared.clearPhantomMessages = clearPhantomMessagesDB;

	// ======== MAIN world access (claude-api.js's _dbCall) ========
	// db-serve.js (document_start) answers MAIN from the start of the page load; its handlers wait
	// for this.
	resolveQolDb(window.ClaudeSearchShared);
})();