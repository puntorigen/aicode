// Model registry: providers, tiers, reasoning effort and routing rules.
// Kept separate from the engine so a future agent runtime can reuse it.

const DEFAULT_LOCAL_CONTEXT = 32000;

// The one place provider preference is ordered (user decision: OpenRouter first,
// one key for the whole catalog). Everything that walks providers (the engine
// default, describeProvider, key listings, listModels, the first-run prompts)
// derives its order from this list; never hard-code another one.
const DEFAULT_PROVIDER_ORDER = ['OPENROUTER', 'ANTHROPIC', 'OPENAI', 'GROQ', 'LOCAL'];

// Reasoning effort levels, ascending. Anywhere efforts are compared, use this order.
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// Reasoning "effort" levels, mapped to an extended-thinking token budget.
// Providers that support extended thinking (Anthropic) turn these into a
// thinking budget; providers that don't simply ignore them.
const EFFORT_BUDGETS = {
    none: 0,
    minimal: 1000,
    low: 4000,
    medium: 8000,
    high: 16000,
    xhigh: 32000,   // "extra high"
    max: 64000,
};

// A tier value can be a plain model id (string) or an object { model, effort }.
// The `efforts` map provides a per-model default effort when the tier doesn't
// specify one, so a model keeps its preferred effort regardless of how it's
// selected. Keys follow DEFAULT_PROVIDER_ORDER.
const PROVIDERS = {
    OPENROUTER: {
        contextSize: 128000,
        // "latest" aliases of the live catalog; the catalog's own context length
        // for the resolved model overrides contextSize when a catalog is cached
        tiers: {
            smart: '~anthropic/claude-sonnet-latest',
            fast: '~anthropic/claude-haiku-latest'
        }
    },
    ANTHROPIC: {
        contextSize: 200000,
        tiers: {
            smart: { model: 'claude-opus-4-8', effort: 'xhigh' },
            fast: { model: 'claude-haiku-4-5', effort: 'none' }
        },
        // default reasoning effort per known Anthropic model
        efforts: {
            'claude-opus-4-8': 'xhigh',   // extra high by default
            'claude-fable-5': 'xhigh',    // extra high by default
            'claude-sonnet-5': 'high',
            'claude-haiku-4-5': 'none'
        }
    },
    OPENAI: {
        contextSize: 272000,
        tiers: {
            smart: 'gpt-5.5',
            fast: 'gpt-5.4-mini'
        }
    },
    GROQ: {
        contextSize: 131072,
        tiers: {
            smart: 'openai/gpt-oss-120b',
            fast: 'llama-3.1-8b-instant'
        }
    },
    LOCAL: {
        // context size and model ids come from user config (~/.aicode/keys.json)
        contextSize: DEFAULT_LOCAL_CONTEXT,
        tiers: {}
    }
};

// approximate prices (USD per 1M tokens: input / output) for the cost footer.
// local models are free; unknown models fall back to 0 (footer omits cost).
const PRICES = {
    'gpt-5.5': { in: 1.25, out: 10 },
    'gpt-5.4-mini': { in: 0.25, out: 2 },
    'claude-opus-4-8': { in: 5, out: 25 },
    'claude-fable-5': { in: 5, out: 25 },
    'claude-sonnet-5': { in: 3, out: 15 },
    'claude-haiku-4-5': { in: 1, out: 5 },
    'openai/gpt-oss-120b': { in: 0.15, out: 0.75 },
    'llama-3.3-70b-versatile': { in: 0.59, out: 0.79 },
    'llama-3.1-8b-instant': { in: 0.05, out: 0.08 },
};

// cheap token estimate; only used for routing thresholds
function estimateTokens(text) {
    return Math.ceil(((text || '').length) / 4);
}

// ---- OpenRouter catalog access -------------------------------------------------------
const openrouter = () => require('./openrouter');
const indexes = new WeakMap(); // catalog object -> Map(id -> entry)

// the cached catalog entry for an OpenRouter model id (null without a cache or a match)
function catalogEntry(id) {
    const catalog = openrouter().loadCatalog();
    if (!catalog || !id) return null;
    let index = indexes.get(catalog);
    if (!index) {
        index = new Map(catalog.models.map((m) => [m.id, m]));
        indexes.set(catalog, index);
    }
    return index.get(id) || null;
}

// resolve the concrete { model, effort } for a provider+tier, honoring optional
// per-provider config overrides (e.g. ANTHROPIC_MODEL=claude-fable-5).
function resolveModelSpec(provider, tier, config = {}) {
    const tier_ = (tier === 'fast') ? 'fast' : 'smart';
    if (provider === 'LOCAL') {
        const model = (tier_ === 'fast' && config.LOCAL_FAST_MODEL) ? config.LOCAL_FAST_MODEL : config.LOCAL_MODEL;
        return { model, effort: config.LOCAL_EFFORT || 'none' };
    }
    const p = PROVIDERS[provider];
    if (!p) return { model: provider, effort: 'none' };
    if (provider === 'OPENROUTER') {
        const smart = config.OPENROUTER_MODEL || p.tiers.smart;
        if (tier_ === 'smart') return { model: smart, effort: config.OPENROUTER_EFFORT || null };
        // the fast alias can vanish from the catalog: then the smart model does the fast work
        let fast = config.OPENROUTER_FAST_MODEL || p.tiers.fast;
        if (openrouter().loadCatalog() && !catalogEntry(fast)) fast = smart;
        return { model: fast, effort: 'none' };
    }
    let spec = p.tiers[tier_];
    if (typeof spec === 'string') spec = { model: spec };
    spec = { ...(spec || {}) };
    // smart-tier model overrides (let users pick e.g. claude-fable-5)
    if (tier_ === 'smart') {
        if (provider === 'ANTHROPIC' && config.ANTHROPIC_MODEL) spec.model = config.ANTHROPIC_MODEL;
        else if (provider === 'GROQ' && config.GROQ_MODEL) spec.model = config.GROQ_MODEL;
        else if (provider === 'OPENAI' && config.OPENAI_MODEL) spec.model = config.OPENAI_MODEL;
    }
    const model = spec.model;
    let effort = spec.effort || (p.efforts && p.efforts[model]) || 'none';
    // per-provider effort override (callOptions only acts on it for Anthropic and OpenRouter)
    const override = config[`${provider}_EFFORT`];
    if (override) effort = override;
    return { model, effort };
}

// resolve the concrete model id for a provider+tier (mirrors createModel)
function modelId(provider, tier, config = {}) {
    return resolveModelSpec(provider, tier, config).model;
}

// Claude 4.7 and later (and every 5.x model) reject budget-based extended
// thinking with `"thinking.type.enabled" is not supported for this model` and
// expect adaptive thinking steered by an effort instead; older models only
// accept a budget. Verified against the live API on 2026-10-17: opus-4-7,
// opus-4-8, fable-5 and sonnet-5 take adaptive only; opus-4-6 and sonnet-4-6
// take both; opus-4-5, sonnet-4-5 and haiku-4-5 take a budget only. Ids that do
// not look like a Claude version keep the budget form (today's behavior).
function rejectsThinkingBudget(model) {
    const m = /^claude-[a-z]+-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(String(model || ''));
    if (!m) return false;
    const major = parseInt(m[1], 10);
    const minor = m[2] ? parseInt(m[2], 10) : 0;
    return major > 4 || (major === 4 && minor >= 7);
}

// the effort values Anthropic's adaptive thinking accepts
const ANTHROPIC_ADAPTIVE_EFFORT = {
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
};

// every Claude model in use can emit 64K tokens; a thinking budget must stay
// below max_tokens, and the API's minimum budget is 1024
const ANTHROPIC_MAX_OUTPUT = 64000;
const ANTHROPIC_MAX_BUDGET = 48000;
const ANTHROPIC_MIN_BUDGET = 1024;

// the requested effort when the model lists it; else the nearest lower listed
// one (in EFFORT_ORDER); else the lowest listed one. null when none is usable.
function nearestEffort(effort, supported) {
    const listed = EFFORT_ORDER.filter((e) => supported.includes(e));
    if (listed.length === 0) return null;
    if (listed.includes(effort)) return effort;
    const rank = EFFORT_ORDER.indexOf(effort);
    for (let i = rank - 1; i >= 0; i--) {
        if (listed.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
    }
    return listed[0];
}

// the `reasoning` request object OpenRouter should get for `effort` on `entry`
// (a cached catalog entry, or null), or null for "send nothing"
function openRouterReasoning(effort, entry) {
    const r = entry && entry.reasoning;
    if (r && Array.isArray(r.supportedEfforts)) {
        // forcing reasoning on a model that only offers it is not what "none" asks for
        if (effort === 'none' && !r.supportedEfforts.includes('none')) return null;
        const sent = nearestEffort(effort, r.supportedEfforts);
        return sent ? { effort: sent } : null;
    }
    if (r && r.supportedEfforts === null) return { effort }; // the gateway accepts every value
    if (r) {
        // a reasoning object without an effort control: a token budget when supported
        return r.supportsMaxTokens && effort !== 'none' ? { max_tokens: EFFORT_BUDGETS[effort] } : null;
    }
    return effort !== 'none' ? { effort } : null; // unknown model or no reasoning info
}

// per-call options derived from the resolved effort. Anthropic extended thinking
// and OpenRouter reasoning are emitted, and only for open-ended generation —
// structured (generateObject) calls run without them to avoid tool/thinking
// conflicts. Other providers accept an effort and ignore it.
function callOptions(provider, tier, config = {}, opts = {}) {
    const { model, effort } = resolveModelSpec(provider, tier, config);
    if (opts.structured) return {};
    if (provider === 'ANTHROPIC') {
        const budget = EFFORT_BUDGETS[effort] || 0;
        if (budget <= 0) return {};
        const thinking = rejectsThinkingBudget(model)
            ? { thinking: { type: 'adaptive' }, effort: ANTHROPIC_ADAPTIVE_EFFORT[effort] || 'high' }
            : { thinking: { type: 'enabled', budgetTokens: Math.min(Math.max(budget, ANTHROPIC_MIN_BUDGET), ANTHROPIC_MAX_BUDGET) } };
        return {
            providerOptions: { anthropic: thinking },
            // thinking budget must leave room for the answer; keep headroom
            maxOutputTokens: Math.min(budget + 16000, ANTHROPIC_MAX_OUTPUT),
        };
    }
    if (provider === 'OPENROUTER') {
        if (!effort) return {};
        const entry = catalogEntry(model);
        const reasoning = openRouterReasoning(effort, entry);
        if (!reasoning) return {};
        return {
            providerOptions: { openrouter: { reasoning } },
            maxOutputTokens: Math.min((entry && entry.maxCompletionTokens) || 32000, 64000),
        };
    }
    return {};
}

// estimate the cost (USD) of a call given its model id and token counts. The
// built-in table wins; OpenRouter models fall back to their cached catalog price.
function estimateCost(model, inputTokens, outputTokens) {
    const p = PRICES[model];
    if (p) return ((inputTokens || 0) / 1e6) * p.in + ((outputTokens || 0) / 1e6) * p.out;
    const entry = catalogEntry(model);
    if (entry && entry.pricing) return (inputTokens || 0) * entry.pricing.prompt + (outputTokens || 0) * entry.pricing.completion;
    return 0;
}

const filled = (value) => typeof value === 'string' && value.trim() !== '';

function hasCredentials(provider, config = {}) {
    switch (provider) {
        case 'OPENROUTER': return filled(config.OPENROUTER_KEY);
        case 'OPENAI': return filled(config.OPENAI_KEY);
        case 'GROQ': return filled(config.GROQ_KEY);
        case 'ANTHROPIC': return filled(config.ANTHROPIC_KEY);
        case 'LOCAL': return filled(config.LOCAL_BASE_URL) && filled(config.LOCAL_MODEL);
        default: return false;
    }
}

function contextSizeFor(provider, config = {}) {
    if (provider === 'LOCAL') {
        const size = parseInt(config.LOCAL_CONTEXT, 10);
        return Number.isFinite(size) && size > 0 ? size : DEFAULT_LOCAL_CONTEXT;
    }
    if (provider === 'OPENROUTER') {
        const entry = catalogEntry(resolveModelSpec('OPENROUTER', 'smart', config).model);
        return entry && entry.contextLength > 0 ? entry.contextLength : PROVIDERS.OPENROUTER.contextSize;
    }
    return PROVIDERS[provider] ? PROVIDERS[provider].contextSize : 0;
}

// returns the first provider (by preference order) that has credentials
// and whose context window fits the prompt
function resolveProvider(preferences, config, promptTokens) {
    for (const provider of preferences) {
        if (!PROVIDERS[provider]) continue;
        if (!hasCredentials(provider, config)) continue;
        if (promptTokens >= contextSizeFor(provider, config)) continue;
        return provider;
    }
    return null;
}

// returns an AI SDK LanguageModel instance for provider+tier
function createModel(provider, tier, config = {}) {
    const { model } = resolveModelSpec(provider, tier, config);
    switch (provider) {
        case 'OPENROUTER': {
            const { createOpenRouter } = require('@openrouter/ai-sdk-provider');
            const settings = {
                apiKey: config.OPENROUTER_KEY,
                headers: { 'HTTP-Referer': 'https://github.com/puntorigen/aicode', 'X-Title': 'aicode' },
            };
            // tests point the whole provider at a local stub through the same variable lib/openrouter.js uses
            if (process.env.AICODE_OPENROUTER_API) settings.baseURL = openrouter().apiBase();
            // usage.include turns on OpenRouter usage accounting: responses carry the real cost
            return createOpenRouter(settings)(model, { usage: { include: true } });
        }
        case 'OPENAI': {
            const { createOpenAI } = require('@ai-sdk/openai');
            return createOpenAI({ apiKey: config.OPENAI_KEY })(model);
        }
        case 'ANTHROPIC': {
            const { createAnthropic } = require('@ai-sdk/anthropic');
            return createAnthropic({ apiKey: config.ANTHROPIC_KEY })(model);
        }
        case 'GROQ': {
            const { createGroq } = require('@ai-sdk/groq');
            return createGroq({ apiKey: config.GROQ_KEY })(model);
        }
        case 'LOCAL': {
            const { createOpenAICompatible } = require('@ai-sdk/openai-compatible');
            const local = createOpenAICompatible({
                name: 'local',
                baseURL: config.LOCAL_BASE_URL,
                apiKey: config.LOCAL_API_KEY || 'not-needed'
            });
            return local(model);
        }
        default:
            throw new Error(`Unknown LLM provider: ${provider}`);
    }
}

// ---- model listing (the picker behind the IDE ModelSelector, /model and `aicode models`) --
const loadConfig = () => require('./config').loadConfig();
const round2 = (n) => Math.round(n * 100) / 100;
const perMillion = (perToken) => round2(perToken * 1e6);

const ANTHROPIC_REASONING = (id) => ({
    supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: PROVIDERS.ANTHROPIC.efforts[id] || 'none',
    mandatory: false,
    supportsMaxTokens: true,
});

// the models of a built-in provider: its tier models (and the user's overrides)
function builtinModelIds(provider, keysData) {
    const ids = [];
    const add = (id) => { if (filled(id) && !ids.includes(id)) ids.push(id); };
    if (provider === 'LOCAL') {
        add(keysData.LOCAL_MODEL);
        add(keysData.LOCAL_FAST_MODEL);
        return ids;
    }
    const p = PROVIDERS[provider];
    if (!p) return ids;
    if (p.efforts) Object.keys(p.efforts).forEach(add);
    for (const tier of ['smart', 'fast']) {
        const spec = p.tiers[tier];
        add(typeof spec === 'string' ? spec : spec && spec.model);
    }
    add(keysData[`${provider}_MODEL`]);
    return ids;
}

function builtinInfo(provider, id, keysData) {
    const price = PRICES[id];
    return {
        provider,
        id,
        name: id,
        shortName: id,
        contextLength: contextSizeFor(provider, keysData),
        pricing: price ? { prompt: price.in, completion: price.out } : null,
        supportsTools: true,
        supportsStructuredOutputs: true,
        reasoning: provider === 'ANTHROPIC' ? ANTHROPIC_REASONING(id) : null,
        created: 0,
        groups: [],
        available: hasCredentials(provider, keysData),
    };
}

function openRouterInfo(m, keysData) {
    return {
        provider: 'OPENROUTER',
        id: m.id,
        name: m.name,
        shortName: m.shortName,
        contextLength: m.contextLength,
        pricing: m.pricing ? { prompt: perMillion(m.pricing.prompt), completion: perMillion(m.pricing.completion) } : null,
        supportsTools: m.supportsTools,
        supportsStructuredOutputs: m.supportsStructuredOutputs,
        reasoning: m.reasoning || null,
        created: m.created,
        groups: [],
        available: hasCredentials('OPENROUTER', keysData),
    };
}

/**
 * Every model the user could pick, grouped and ordered like Cursor's picker:
 * recent -> featured -> everything else (newest first).
 * @returns {{ models: object[], selected: object|null, catalog: { fetchedAt: string, count: number, stale: boolean }|null }}
 */
function listModels({ keysData = {}, config, query } = {}) {
    const cfg = config || loadConfig();
    const settings = cfg.models || {};
    const recent = Array.isArray(settings.recent) ? settings.recent : [];
    const vendors = Array.isArray(settings.featuredVendors) ? settings.featuredVendors : [];
    const catalog = openrouter().loadCatalog();

    const routed = catalog ? catalog.models.map((m) => openRouterInfo(m, keysData)) : [];
    const builtin = [];
    for (const provider of DEFAULT_PROVIDER_ORDER.filter((p) => p !== 'OPENROUTER')) {
        for (const id of builtinModelIds(provider, keysData)) builtin.push(builtinInfo(provider, id, keysData));
    }

    // featured: the 3 newest tool-capable, non-alias, non-free models of each featured vendor
    const featuredRouted = [];
    for (const vendor of vendors) {
        routed
            .filter((m) => m.id.startsWith(`${vendor}/`) && m.supportsTools && !m.id.startsWith('~') && !m.id.endsWith(':free'))
            .sort((a, b) => b.created - a.created)
            .slice(0, 3)
            .forEach((m) => featuredRouted.push(m));
    }
    const featuredBuiltin = builtin.filter((m) => m.available);
    const featuredSet = new Set([...featuredRouted, ...featuredBuiltin]);

    let all = [...routed, ...builtin];
    for (const m of all) {
        if (recent.includes(m.id)) m.groups.push('recent');
        if (featuredSet.has(m)) m.groups.push('featured');
    }

    const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length > 0) {
        all = all.filter((m) => {
            const haystack = `${m.id} ${m.name}`.toLowerCase();
            return tokens.every((t) => haystack.includes(t));
        });
    }

    const rank = (m) => (m.groups.includes('recent') ? recent.indexOf(m.id) : Infinity);
    const sections = { recent: [], featured: [], rest: [] };
    for (const m of all) {
        if (m.groups.includes('recent')) sections.recent.push(m);
        else if (m.groups.includes('featured')) sections.featured.push(m);
        else sections.rest.push(m);
    }
    sections.recent.sort((a, b) => rank(a) - rank(b));
    // OpenRouter featured first (vendor order, newest first), then built-in providers in preference order
    const vendorRank = (m) => vendors.indexOf(m.id.split('/')[0]); // featured OpenRouter entries always come from a listed vendor
    const providerRank = (m) => DEFAULT_PROVIDER_ORDER.indexOf(m.provider);
    sections.featured.sort((a, b) => {
        if ((a.provider === 'OPENROUTER') !== (b.provider === 'OPENROUTER')) return a.provider === 'OPENROUTER' ? -1 : 1;
        if (a.provider === 'OPENROUTER') return vendorRank(a) - vendorRank(b) || b.created - a.created;
        return providerRank(a) - providerRank(b);
    });
    sections.rest.sort((a, b) => b.created - a.created || providerRank(a) - providerRank(b));

    return {
        models: [...sections.recent, ...sections.featured, ...sections.rest],
        selected: settings.selected || null,
        catalog: catalog
            ? { fetchedAt: catalog.fetchedAt, count: catalog.models.length, stale: openrouter().isStale(catalog, settings.catalogTtlHours) }
            : null,
    };
}

// ---- model specs and selections --------------------------------------------------------
const PROVIDER_PREFIX = /^(openrouter|openai|anthropic|groq|local):(.*)$/is;

function unknownModel(spec) {
    return new Error(`unknown model: ${spec} (use provider:model, see "aicode models")`);
}

/**
 * `[provider:]modelId[@effort]` (or a Cursor-style phrase like "sonnet 5.5 max")
 * -> ModelSelection. Throws when nothing matches. Credentials are not checked here.
 */
function parseModelSpec(spec, { keysData = {}, config } = {}) {
    let text = String(spec === undefined || spec === null ? '' : spec).trim();
    if (text === '') throw unknownModel(spec);

    let effort = null;
    const at = text.lastIndexOf('@');
    if (at > 0) {
        const given = text.slice(at + 1).trim().toLowerCase();
        if (!EFFORT_ORDER.includes(given)) throw new Error(`unknown effort "${text.slice(at + 1)}" in "${spec}" (use ${EFFORT_ORDER.join(', ')})`);
        effort = given;
        text = text.slice(0, at).trim();
        if (text === '') throw unknownModel(spec);
    }

    const prefixed = PROVIDER_PREFIX.exec(text);
    if (prefixed) {
        const model = prefixed[2].trim();
        if (model === '') throw unknownModel(spec);
        return { provider: prefixed[1].toUpperCase(), model, effort };
    }

    // a bare id: OpenRouter ids carry a vendor prefix or are "~" aliases
    if (text.includes('/') || text.startsWith('~')) return { provider: 'OPENROUTER', model: text, effort };

    // an exact id of a built-in provider, in preference order
    for (const provider of DEFAULT_PROVIDER_ORDER.filter((p) => p !== 'OPENROUTER')) {
        if (builtinModelIds(provider, keysData).includes(text)) return { provider, model: text, effort };
    }

    // a catalog id without its vendor prefix
    const catalog = openrouter().loadCatalog();
    if (catalog) {
        const wanted = text.toLowerCase();
        const hit = catalog.models.find((m) => { const id = m.id.toLowerCase(); return id === wanted || id.endsWith(`/${wanted}`); });
        if (hit) return { provider: 'OPENROUTER', model: hit.id, effort };
    }

    // a phrase: search the picker, "max" at the end meaning the MAX effort
    let query = text;
    const maxed = /(?:\s+|[-.])max$/i.exec(query);
    if (maxed) { query = query.slice(0, maxed.index).trim(); if (effort === null) effort = 'max'; }
    if (query !== '') {
        const found = listModels({ keysData, config, query }).models.find((m) => m.supportsTools);
        if (found) return { provider: found.provider, model: found.id, effort };
    }
    throw unknownModel(spec);
}

/**
 * Validate a client-supplied ModelSelection: its shape and, when `keysData` is
 * given, that the provider has credentials there.
 * @returns {{ ok: true, selection: object } | { ok: false, code: 'unknown_model'|'no_credentials', message: string }}
 */
function checkSelection(selection, keysData) {
    const bad = (code, message) => ({ ok: false, code, message });
    if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) {
        return bad('unknown_model', 'a model selection is an object { provider, model, effort }');
    }
    const provider = typeof selection.provider === 'string' ? selection.provider.toUpperCase() : '';
    if (!PROVIDERS[provider]) return bad('unknown_model', `unknown provider: ${selection.provider}`);
    const model = typeof selection.model === 'string' ? selection.model.trim() : '';
    if (model === '') return bad('unknown_model', 'the model must be a non-empty string');
    const effort = selection.effort === undefined ? null : selection.effort;
    if (effort !== null && !EFFORT_ORDER.includes(effort)) return bad('unknown_model', `the effort must be null or one of: ${EFFORT_ORDER.join(', ')}`);
    if (keysData && !hasCredentials(provider, keysData)) return bad('no_credentials', `no credentials for ${provider}`);
    return { ok: true, selection: { provider, model, effort } };
}

/**
 * Remember `selection` as the default for every surface: config.models.selected
 * plus the front of config.models.recent (deduplicated, at most 8). `null`
 * forgets the default.
 */
function persistSelection(selection) {
    const config = require('./config');
    if (selection === null) {
        config.saveConfig({ models: { selected: null } });
        return;
    }
    const stored = config.loadConfig().models.recent;
    const recent = Array.isArray(stored) ? stored : [];
    config.saveConfig({
        models: {
            selected: { provider: selection.provider, model: selection.model, effort: selection.effort },
            recent: [selection.model, ...recent.filter((id) => id !== selection.model)].slice(0, 8),
        },
    });
}

/**
 * Pick (or, with null, clear) the model of a session: validate, store it on
 * `flags.model` and, unless `persist` is false, remember it as the default.
 * Throws an Error carrying `.code` ('unknown_model' | 'no_credentials').
 * @returns {object|null} the stored selection
 */
function selectModel(flags, selection, keysData, { persist = true } = {}) {
    if (selection === null) {
        flags.model = null;
        if (persist) persistSelection(null);
        return null;
    }
    const checked = checkSelection(selection, keysData);
    if (!checked.ok) {
        const err = new Error(checked.message);
        err.code = checked.code;
        throw err;
    }
    flags.model = checked.selection;
    if (persist) persistSelection(checked.selection);
    return checked.selection;
}

// the short display name of a selection ("Claude Sonnet 5.5"), and the chip text
// for it ("Claude Sonnet 5.5 MAX")
function shortNameOf(selection) {
    if (selection.provider === 'OPENROUTER') {
        const entry = catalogEntry(selection.model);
        if (entry) return entry.shortName;
    }
    return selection.model;
}

function chipFor(selection) {
    return {
        provider: selection.provider.toLowerCase(),
        model: shortNameOf(selection) + (selection.effort === 'max' ? ' MAX' : ''),
    };
}

module.exports = {
    PROVIDERS,
    PRICES,
    EFFORT_BUDGETS,
    EFFORT_ORDER,
    DEFAULT_PROVIDER_ORDER,
    estimateTokens,
    resolveModelSpec,
    modelId,
    callOptions,
    rejectsThinkingBudget,
    estimateCost,
    hasCredentials,
    contextSizeFor,
    resolveProvider,
    createModel,
    listModels,
    parseModelSpec,
    checkSelection,
    persistSelection,
    selectModel,
    shortNameOf,
    chipFor,
    DEFAULT_LOCAL_CONTEXT
};
