// skill-interceptor.js
// Hides the encryption key skill (databases.js keeps the key in it) from every list claude.ai shows
// skills in: the skills list, and the library endpoints behind Customize (/library/mine,
// /library/discover/home and the like), where it appears as an item whose description is the key.
(function() {
	'use strict';
	const log = createLogger('SkillInterceptor');

	const HIDDEN_SKILL_NAME = 'qol-encryptionkey-do-not-delete';
	// Legacy encryption-key styles that have since been converted into skills.
	// They carry this marker in their description rather than a known name.
	const HIDDEN_DESCRIPTION_MARKER = 'QOL_ENCRYPT_NODELETE';

	// A skill, library item or one of its components that is (or wraps) the key.
	function isKeySkill(entry) {
		if (!entry || typeof entry !== 'object') return false;
		if (entry.name === HIDDEN_SKILL_NAME || entry.display_name === HIDDEN_SKILL_NAME) return true;
		if (typeof entry.description === 'string' && entry.description.includes(HIDDEN_DESCRIPTION_MARKER)) return true;
		return Array.isArray(entry.components) && entry.components.some(isKeySkill);
	}

	// Drops key entries from every array in the response, however deep (library responses nest them
	// in items, blocks[].items, ...), collecting them in `dropped`.
	function dropKeySkills(value, dropped = []) {
		if (Array.isArray(value)) {
			for (let i = value.length - 1; i >= 0; i--) {
				if (isKeySkill(value[i])) dropped.push(...value.splice(i, 1));
				else dropKeySkills(value[i], dropped);
			}
		} else if (value && typeof value === 'object') {
			for (const child of Object.values(value)) dropKeySkills(child, dropped);
		}
		return dropped;
	}

	// Library responses count items per source in facets.sources (the Customize filter menu): take the
	// dropped ones off, so the counts don't give a hidden item away. A facet without a marketplace counts
	// its whole source.
	function uncountFacets(data, dropped) {
		const sources = data?.facets?.sources;
		if (!Array.isArray(sources)) return;
		for (const { provenance } of dropped) {
			if (!provenance) continue;
			for (const facet of sources) {
				const matches = facet.source === provenance.source && (facet.marketplace_id == null || facet.marketplace_id === provenance.marketplace_id);
				if (matches && facet.count > 0) facet.count--;
			}
		}
	}

	const isSkillListUrl = (url) => url.includes('/skills/list-skills') || /\/api\/organizations\/[^/]+\/library\//.test(url);

	const originalFetch = window.fetch;
	window.fetch = async (...args) => {
		const [input, config] = args;
		if (!isSkillListUrl(ClaudeExtNet.getFetchUrl(input)) || ClaudeExtNet.getFetchMethod(input, config) !== 'GET') {
			return originalFetch(...args);
		}
		const response = await originalFetch(...args);
		if (!response.ok) return response;
		try {
			const data = await response.clone().json();
			const dropped = dropKeySkills(data);
			if (!dropped.length) return response;
			uncountFacets(data, dropped);
			log(`Filtered ${dropped.length} encryption key skill entr${dropped.length === 1 ? 'y' : 'ies'}`);
			return ClaudeExtNet.jsonResponse(response, data);
		} catch (e) {
			log.warn('Failed to parse skills response:', e.message);
			return response;
		}
	};
})();
