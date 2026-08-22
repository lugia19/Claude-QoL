// extra-models.js
(function () {
    'use strict';

    // The section a re-enabled model lands in within the dropdown.
    const TARGET_SECTION = 'overflow';

    const EXTRA_MODELS = [
        {
            // --- Legacy shape: account.memberships[].organization.claude_ai_bootstrap_models_config ---
            bootstrap: {
                model: 'claude-opus-4-5-20251101',
                name: 'Opus 4.5',
                inactive: false,
                overflow: true,
                notice_text: 'Opus consumes usage limits faster than other models',
                paprika_modes: ['extended'],
                thinking_modes: [
                    {
                        description: 'Think longer for complex tasks',
                        description_key: 'amber_river_echo',
                        id: 'extended',
                        is_default: false,
                        mode: 'extended',
                        paprika_mode_value: 'extended',
                        selection_title: 'Extended',
                        selection_title_key: 'crimson_peak_summit',
                        title: 'Extended thinking',
                        title_key: 'golden_forest_whisper'
                    }
                ]
            },

            // --- New shape: top-level model_selector_config[].models[] ---
            // Mirrors the entry Claude already ships in the `chat` surface (where it's
            // deprecated), so it renders consistently when injected into other surfaces.
            selector: {
                id: 'claude-opus-4-5-20251101',
                name: 'Opus 4.5',
                description: 'Most capable for ambitious work',
                notice_text: 'Opus consumes usage limits faster than other models',
                section: TARGET_SECTION,
                capabilities: {
                    compass: true,
                    gsuite_tools: true,
                    mm_images: true,
                    mm_pdf: true,
                    web_search: true
                },
                thinking: {
                    type: 'effort_and_mode',
                    description: 'Higher effort means more thorough responses, but takes longer and uses your limits faster.',
                    effort_options: [
                        { id: 'low', name: 'Low', description: 'Quick replies to simple questions' },
                        { id: 'medium', name: 'Medium', description: 'Balanced for everyday work' },
                        {
                            id: 'high',
                            name: 'High',
                            description: 'Complex, detailed work',
                            recommended: true,
                            badge: { message: 'Default', variant: 'neutral' }
                        }
                    ],
                    mode_options: [
                        { id: 'extended', name: 'Extended', description: 'Always uses deep reasoning' },
                        { id: 'off', name: 'Off' }
                    ]
                },
                hard_limit: 190000
            }
        },
        {
            // No legacy bootstrap entry — 4.6 only ever shipped in the new shape.
            selector: {
                id: 'claude-opus-4-6',
                name: 'Opus 4.6',
                short_name: 'Opus',
                notice_text: 'Opus consumes usage limits faster than other models',
                section: TARGET_SECTION,
                capabilities: {
                    compass: true,
                    gsuite_tools: true,
                    mm_images: true,
                    mm_pdf: true,
                    web_search: true
                },
                thinking: {
                    type: 'effort_and_mode',
                    description: 'Higher effort means more thorough responses, but takes longer and uses your limits faster.',
                    effort_options: [
                        { id: 'low', name: 'Low', description: 'Quick replies to simple questions' },
                        {
                            id: 'medium',
                            name: 'Medium',
                            description: 'Balanced for everyday work',
                            recommended: true,
                            badge: { message: 'Default', variant: 'neutral' }
                        },
                        { id: 'high', name: 'High', description: 'Complex, detailed work' },
                        {
                            id: 'max',
                            name: 'Max',
                            description: 'The hardest problems. Takes longest.',
                            tooltip: {
                                content: 'May use excessive tokens resulting in long response times and may hit token limits. Use sparingly for the hardest tasks.'
                            }
                        }
                    ],
                    mode_options: [
                        { id: 'extended', name: 'Extended', description: 'Always uses deep reasoning' },
                        { id: 'off', name: 'Off' }
                    ]
                },
                hard_limit: 449000,
                supports_fast_mode: true,
                voice_model: 'claude-opus-4-8',
                notice: {
                    title: null,
                    text: 'Opus consumes usage limits faster than other models',
                    cta: null,
                    is_dismissible: false
                }
            }
        }
    ];

    // Patch 1: legacy bootstrap config (kept for compatibility).
    function patchBootstrapConfig(data) {
        if (!data?.account?.memberships) return;
        for (const membership of data.account.memberships) {
            const config = membership?.organization?.claude_ai_bootstrap_models_config;
            if (!Array.isArray(config)) continue;
            for (const extra of EXTRA_MODELS) {
                const entry = extra.bootstrap;
                if (!entry) continue;
                const existing = config.find(e => e.model === entry.model);
                if (existing) {
                    existing.inactive = false;
                } else {
                    config.push({ ...entry, inactive: false });
                }
            }
        }
    }

    // Patch 2: the new top-level model_selector_config (what the dropdown actually reads).
    function patchModelSelectorConfig(data) {
        if (!Array.isArray(data?.model_selector_config)) return;
        for (const surface of data.model_selector_config) {
            if (!Array.isArray(surface?.models)) continue;
            for (const extra of EXTRA_MODELS) {
                const sel = extra.selector;
                const existing = surface.models.find(m => m.id === sel.id);
                if (existing) {
                    // Already listed (e.g. as "deprecated") — just make it visible.
                    existing.section = sel.section;
                } else {
                    // Absent from this surface — inject a fresh, per-surface copy.
                    surface.models.push(structuredClone(sel));
                }
            }
        }
    }

    function patchModelSelectorState(data) {
        if (!Array.isArray(data?.model_selector_state)) return;
        for (const surface of data.model_selector_state) {
            if (!Array.isArray(surface?.thinking_by_model)) continue;
            for (const extra of EXTRA_MODELS) {
                const id = extra.selector.id;
                if (surface.thinking_by_model.some(t => t.id === id)) continue;
                surface.thinking_by_model.push({
                    id,
                    thinking: { type: 'effort_and_mode', effort: 'high', mode: 'extended' }
                });
            }
        }
    }

    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
        const [input] = args;

        let url;
        if (input instanceof URL) {
            url = input.href;
        } else if (typeof input === 'string') {
            url = input;
        } else if (input instanceof Request) {
            url = input.url;
        }

        if (url && url.includes('/edge-api/bootstrap/') && url.includes('/app_start')) {
            const response = await originalFetch(...args);
            if (!response.ok) return response;

            const data = await response.json();

            patchBootstrapConfig(data);
            patchModelSelectorConfig(data);
            patchModelSelectorState(data);

            const newHeaders = new Headers(response.headers);
            newHeaders.delete('content-length'); // let the runtime recompute it

            return new Response(JSON.stringify(data), {
                status: response.status,
                statusText: response.statusText,
                headers: newHeaders
            });
        }

        return originalFetch(...args);
    };
})();