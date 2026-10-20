// project-prefix.js (MAIN world, document_start, after bard-host.js)
// Prefixes the names of chats that are in a project with the project's name ("Project: chat"), so
// they stand out in the sidebar. Done in the data rather than the DOM: the sidebar list
// (chat_conversations_v2) and every StreamTimeline conversation.title, since the page copies an open
// chat's title back into its sidebar entry. The chat's header shows the prefix too, and so does the
// rename field: a name that already starts with the prefix (saved that way) is left alone. Untitled
// chats stay untitled, since the page polls the list for their generated title.
//
// Setting: "Show project names in chat titles" (extension-settings.js), off by default, mirrored per
// org to localStorage (org-mirror.js, 'project_prefix'). A change applies on the next page load.
(function () {
	'use strict';

	if (readOrgMirror('project_prefix') !== true) return;

	const log = createLogger('ProjectPrefix');

	const projectNames = new Map(); // project uuid -> promise of its name (null: unknown)

	function prefixed(name, projectName) {
		if (!name || !projectName) return name;
		const prefix = `${projectName}: `;
		return name.startsWith(prefix) ? name : prefix + name;
	}

	// The project's name: known from the sidebar list, or fetched once (the snapshot only has its id).
	function projectName(orgId, projectId) {
		if (!projectNames.has(projectId)) {
			projectNames.set(projectId, QolBardHost.rawFetch(`/api/organizations/${orgId}/projects/${projectId}`)
				.then(response => (response.ok ? response.json() : null))
				.then(project => project?.name ?? null)
				.catch((e) => {
					log.warn(`no name for project ${projectId}:`, e);
					projectNames.delete(projectId);
					return null;
				}));
		}
		return projectNames.get(projectId);
	}

	// ======== Sidebar list ========

	const originalFetch = window.fetch;
	window.fetch = async (...args) => {
		const [input, config] = args;
		const url = ClaudeExtNet.getFetchUrl(input);
		if (!url.includes('/chat_conversations_v2') || ClaudeExtNet.getFetchMethod(input, config) !== 'GET') {
			return originalFetch(...args);
		}
		const response = await originalFetch(...args);
		if (!response.ok) return response;
		try {
			const data = await response.clone().json();
			let changed = false;
			for (const conversation of data?.data ?? []) {
				const project = conversation.project;
				if (!project?.uuid || !project.name) continue;
				projectNames.set(project.uuid, Promise.resolve(project.name));
				const name = prefixed(conversation.name, project.name);
				if (name === conversation.name) continue;
				conversation.name = name;
				changed = true;
			}
			return changed ? ClaudeExtNet.jsonResponse(response, data) : response;
		} catch (e) {
			log.warn('Failed to parse the conversation list:', e.message);
			return response;
		}
	};

	// ======== Open chats ========

	// A snapshot waits for an unknown project's name; live updates only use names already known
	// (the snapshot came first and fetched it).
	async function prefixTitle(update, ctx) {
		const conversation = update.conversation;
		if (!conversation?.title || !conversation.project_id || !ctx.orgId) return false;
		const projectId = conversation.project_id;
		if (!ctx.within && !projectNames.has(projectId)) return false;
		const name = ctx.within ? (await ctx.within(projectName(ctx.orgId, projectId)))?.value : await projectNames.get(projectId);
		const title = prefixed(conversation.title, name);
		if (title === conversation.title) return false;
		conversation.title = title;
		return true;
	}

	QolBardHost.onSnapshot(prefixTitle, { label: 'project-prefix' });
	QolBardHost.onLiveUpdate(prefixTitle, { label: 'project-prefix' });
})();
