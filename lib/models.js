// Model registry: providers, tiers and routing rules.
// Kept separate from the engine so a future agent runtime can reuse it.

const DEFAULT_LOCAL_CONTEXT = 32000;

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
            smart: 'claude-sonnet-5',
            fast: 'claude-haiku-4-5'
        }
    },
    GROQ: {
        contextSize: 131072,
        tiers: {
            smart: 'llama-3.3-70b-versatile',
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
    'claude-sonnet-5': { in: 3, out: 15 },
    'claude-haiku-4-5': { in: 1, out: 5 },
    'llama-3.3-70b-versatile': { in: 0.59, out: 0.79 },
    'llama-3.1-8b-instant': { in: 0.05, out: 0.08 },
};

// cheap token estimate; only used for routing thresholds
function estimateTokens(text) {
    return Math.ceil(((text || '').length) / 4);
}

// resolve the concrete model id for a provider+tier (mirrors createModel)
function modelId(provider, tier, config = {}) {
    const tier_ = (tier === 'fast') ? 'fast' : 'smart';
    if (provider === 'LOCAL') {
        return (tier_ === 'fast' && config.LOCAL_FAST_MODEL) ? config.LOCAL_FAST_MODEL : config.LOCAL_MODEL;
    }
    return PROVIDERS[provider] ? PROVIDERS[provider].tiers[tier_] : provider;
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
    const tier_ = (tier === 'fast') ? 'fast' : 'smart';
    switch (provider) {
        case 'OPENAI': {
            const { createOpenAI } = require('@ai-sdk/openai');
            const openai = createOpenAI({ apiKey: config.OPENAI_KEY });
            return openai(PROVIDERS.OPENAI.tiers[tier_]);
        }
        case 'ANTHROPIC': {
            const { createAnthropic } = require('@ai-sdk/anthropic');
            const anthropic = createAnthropic({ apiKey: config.ANTHROPIC_KEY });
            return anthropic(PROVIDERS.ANTHROPIC.tiers[tier_]);
        }
        case 'GROQ': {
            const { createGroq } = require('@ai-sdk/groq');
            const groq = createGroq({ apiKey: config.GROQ_KEY });
            return groq(PROVIDERS.GROQ.tiers[tier_]);
        }
        case 'LOCAL': {
            const { createOpenAICompatible } = require('@ai-sdk/openai-compatible');
            const local = createOpenAICompatible({
                name: 'local',
                baseURL: config.LOCAL_BASE_URL,
                apiKey: config.LOCAL_API_KEY || 'not-needed'
            });
            const modelId = (tier_ === 'fast' && config.LOCAL_FAST_MODEL) ? config.LOCAL_FAST_MODEL : config.LOCAL_MODEL;
            return local(modelId);
        }
        default:
            throw new Error(`Unknown LLM provider: ${provider}`);
    }
}

module.exports = {
    PROVIDERS,
    PRICES,
    estimateTokens,
    modelId,
    estimateCost,
    hasCredentials,
    contextSizeFor,
    resolveProvider,
    createModel,
    DEFAULT_LOCAL_CONTEXT
};
