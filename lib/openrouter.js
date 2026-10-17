// OpenRouter REST helpers: the model catalog (cached on disk) and key
// verification. The provider itself (chat completions) goes through
// @openrouter/ai-sdk-provider in lib/models.js; this module only talks to the
// public catalog and account endpoints.
//
// AICODE_OPENROUTER_API overrides the base URL (default https://openrouter.ai/api/v1)
// so tests can point everything at a local stub.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_API = 'https://openrouter.ai/api/v1';
const CATALOG_TIMEOUT_MS = 15000;
const KEY_TIMEOUT_MS = 10000;
const HOUR_MS = 60 * 60 * 1000;

// resolved on every call so tests (and users) that change the env or HOME are honored
const apiBase = () => String(process.env.AICODE_OPENROUTER_API || DEFAULT_API).replace(/\/+$/, '');
const cacheFile = () => path.join(os.homedir(), '.aicode', 'cache', 'openrouter-models.json');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// "0.000002" -> 0.000002; anything unparseable or negative (the API uses "-1" for
// routers whose price depends on the routed model) is not a price
function parsePrice(value) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * One entry of the API's `data` array -> OpenRouterModel, or null when the entry
 * is not usable as a chat model (batch variants, models without text output).
 *
 * `reasoning.supportedEfforts` keeps three states apart because callOptions
 * treats them differently: an array (the listed efforts), `null` (the API sent
 * null: the gateway accepts every effort) and absent (the model has a reasoning
 * object but exposes no effort control).
 */
function normalizeModel(raw) {
    if (!isObject(raw) || typeof raw.id !== 'string' || raw.id === '') return null;
    const id = raw.id;
    if (id.endsWith(':batch')) return null;
    const architecture = isObject(raw.architecture) ? raw.architecture : {};
    const outputs = Array.isArray(architecture.output_modalities) ? architecture.output_modalities : [];
    if (!outputs.includes('text')) return null;

    const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name : id;
    const split = name.indexOf(': ');
    const provider = isObject(raw.top_provider) ? raw.top_provider : {};
    const parameters = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];

    let pricing = null;
    if (isObject(raw.pricing)) {
        const prompt = parsePrice(raw.pricing.prompt);
        const completion = parsePrice(raw.pricing.completion);
        if (prompt !== null && completion !== null) pricing = { prompt, completion };
    }

    let reasoning = null;
    if (isObject(raw.reasoning)) {
        const r = raw.reasoning;
        reasoning = {};
        if (Array.isArray(r.supported_efforts)) reasoning.supportedEfforts = r.supported_efforts.filter((e) => typeof e === 'string');
        else if (r.supported_efforts === null) reasoning.supportedEfforts = null;
        reasoning.defaultEffort = typeof r.default_effort === 'string' ? r.default_effort : null;
        reasoning.mandatory = r.mandatory === true;
        reasoning.supportsMaxTokens = r.supports_max_tokens === true;
    }

    const contextLength = Number.isFinite(raw.context_length) ? raw.context_length
        : (Number.isFinite(provider.context_length) ? provider.context_length : 0);
    return {
        id,
        name,
        shortName: split >= 0 ? name.slice(split + 2) : name,
        contextLength,
        maxCompletionTokens: Number.isFinite(provider.max_completion_tokens) ? provider.max_completion_tokens : null,
        pricing,
        supportsTools: parameters.includes('tools'),
        supportsStructuredOutputs: parameters.includes('structured_outputs'),
        reasoning,
        created: Number.isFinite(raw.created) ? raw.created : 0,
        isAlias: id.startsWith('~'),
        isFree: id.endsWith(':free'),
    };
}

// ---- cache ---------------------------------------------------------------------------
let memo = null; // { key, catalog }

/** The cached catalog, or null when there is none (or it is unreadable). Synchronous. */
function loadCatalog() {
    const file = cacheFile();
    let stat;
    try { stat = fs.statSync(file); } catch (e) { return null; }
    const key = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (memo && memo.key === key) return memo.catalog;
    let catalog = null;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (isObject(parsed) && Array.isArray(parsed.models)) {
            catalog = { fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : '', models: parsed.models.filter((m) => isObject(m) && typeof m.id === 'string') };
        }
    } catch (e) { catalog = null; }
    memo = { key, catalog };
    return catalog;
}

function writeCache(catalog) {
    const file = cacheFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmpFile = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(catalog) + '\n', 'utf8');
    fs.renameSync(tmpFile, file);
    memo = null;
}

/** True when the catalog is missing, undated, or older than `ttlHours`. */
function isStale(catalog, ttlHours = 24) {
    if (!catalog || !catalog.fetchedAt) return true;
    const fetched = Date.parse(catalog.fetchedAt);
    if (!Number.isFinite(fetched)) return true;
    return Date.now() - fetched > Number(ttlHours) * HOUR_MS;
}

/**
 * The model catalog. Without `force`, a fresh cache is returned without touching
 * the network. A failed fetch falls back to the cache when there is one (and
 * tells `onError(err)`, so a caller can still report the failure); without a
 * cache it throws.
 * @returns {Promise<{ fetchedAt: string, models: object[] }>}
 */
async function fetchCatalog({ apiKey, force = false, onError } = {}) {
    const cached = loadCatalog();
    if (!force && cached && !isStale(cached, require('./config').loadConfig().models.catalogTtlHours)) return cached;
    try {
        const headers = { Accept: 'application/json' };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        const res = await fetch(`${apiBase()}/models`, { headers, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`OpenRouter catalog request failed: HTTP ${res.status}`);
        const body = await res.json();
        if (!isObject(body) || !Array.isArray(body.data)) throw new Error('OpenRouter catalog response has no "data" list');
        const models = body.data.map(normalizeModel).filter(Boolean);
        // an empty answer must not replace a good cache
        if (models.length === 0) throw new Error('OpenRouter catalog response has no usable models');
        const catalog = { fetchedAt: new Date().toISOString(), models };
        try { writeCache(catalog); } catch (e) { /* a read-only home must not break the lookup itself */ }
        return catalog;
    } catch (err) {
        if (typeof onError === 'function') { try { onError(err); } catch (e) { /* a reporting hook must not break the lookup */ } }
        if (cached) return cached;
        throw err;
    }
}

/**
 * Check a key against GET /key. Never throws.
 * @returns {Promise<{ ok: true, label, usage, limit, limitRemaining, isFreeTier } | { ok: false, error: string }>}
 */
async function verifyKey(apiKey) {
    try {
        const res = await fetch(`${apiBase()}/key`, {
            headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(KEY_TIMEOUT_MS),
        });
        if (res.status === 200) {
            const body = await res.json().catch(() => ({}));
            const data = isObject(body) && isObject(body.data) ? body.data : (isObject(body) ? body : {});
            const pick = (value) => (value === undefined ? null : value);
            return {
                ok: true,
                label: pick(data.label),
                usage: pick(data.usage),
                limit: pick(data.limit),
                limitRemaining: pick(data.limit_remaining),
                isFreeTier: pick(data.is_free_tier),
            };
        }
        if (res.status === 401 || res.status === 403) return { ok: false, error: 'invalid key' };
        return { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
    }
}

module.exports = { fetchCatalog, loadCatalog, isStale, normalizeModel, verifyKey, apiBase, cacheFile };
