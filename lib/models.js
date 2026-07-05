// Model registry: providers, tiers, reasoning effort and routing rules.
// Kept separate from the engine so a future agent runtime can reuse it.

const DEFAULT_LOCAL_CONTEXT = 32000;

// Reasoning "effort" levels, mapped to an extended-thinking token budget.
// Providers that support extended thinking (Anthropic) turn these into a
// thinking budget; providers that don't simply ignore them.
const EFFORT_BUDGETS = {
    none: 0,
    low: 4000,
    medium: 8000,
    high: 16000,
    xhigh: 32000,   // "extra high"
    max: 64000,
};

// A tier value can be a plain model id (string) or an object { model, effort }.
// The `efforts` map provides a per-model default effort when the tier doesn't
// specify one, so a model keeps its preferred effort regardless of how it's
// selected.
const PROVIDERS = {
    OPENAI: {
        contextSize: 272000,
        tiers: {
            smart: 'gpt-5.5',
            fast: 'gpt-5.4-mini'
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
    // per-provider effort override
    if (provider === 'ANTHROPIC' && config.ANTHROPIC_EFFORT) effort = config.ANTHROPIC_EFFORT;
    return { model, effort };
}

// resolve the concrete model id for a provider+tier (mirrors createModel)
function modelId(provider, tier, config = {}) {
    return resolveModelSpec(provider, tier, config).model;
}

// per-call options derived from the resolved effort. Currently only Anthropic
// extended thinking is emitted, and only for open-ended generation — structured
// (generateObject) calls run without thinking to avoid tool/thinking conflicts.
function callOptions(provider, tier, config = {}, opts = {}) {
    const { effort } = resolveModelSpec(provider, tier, config);
    const budget = EFFORT_BUDGETS[effort] || 0;
    if (provider === 'ANTHROPIC' && budget > 0 && !opts.structured) {
        return {
            providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: budget } } },
            // thinking budget must leave room for the answer; keep headroom
            maxOutputTokens: budget + 16000,
        };
    }
    return {};
}

// estimate the cost (USD) of a call given its model id and token counts
function estimateCost(model, inputTokens, outputTokens) {
    const p = PRICES[model];
    if (!p) return 0;
    return ((inputTokens || 0) / 1e6) * p.in + ((outputTokens || 0) / 1e6) * p.out;
}

function hasCredentials(provider, config = {}) {
    switch (provider) {
        case 'OPENAI': return !!(config.OPENAI_KEY && config.OPENAI_KEY.trim());
        case 'GROQ': return !!(config.GROQ_KEY && config.GROQ_KEY.trim());
        case 'ANTHROPIC': return !!(config.ANTHROPIC_KEY && config.ANTHROPIC_KEY.trim());
        case 'LOCAL': return !!(config.LOCAL_BASE_URL && config.LOCAL_BASE_URL.trim() && config.LOCAL_MODEL && config.LOCAL_MODEL.trim());
        default: return false;
    }
}

function contextSizeFor(provider, config = {}) {
    if (provider === 'LOCAL') {
        const size = parseInt(config.LOCAL_CONTEXT, 10);
        return Number.isFinite(size) && size > 0 ? size : DEFAULT_LOCAL_CONTEXT;
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

module.exports = {
    PROVIDERS,
    PRICES,
    EFFORT_BUDGETS,
    estimateTokens,
    resolveModelSpec,
    modelId,
    callOptions,
    estimateCost,
    hasCredentials,
    contextSizeFor,
    resolveProvider,
    createModel,
    DEFAULT_LOCAL_CONTEXT
};
