// Provider credentials: listing (masked), saving, removing and testing.
//
// Keys live in the encrypted ~/.aicode/keys.json (helpers/db.js). The process
// keeps ONE `keysData` object (index.js loads it, createRuntime keeps it by
// reference), so a key saved here is visible to every later turn of every
// session without a restart. Raw key values never leave this module towards a
// client: callers only ever see `masked`.
'use strict';

const fs = require('fs');
const EncryptedJsonDB = require('../helpers/db');
const models = require('./models');
const openrouter = require('./openrouter');

// provider -> keys.json field; the order is DEFAULT_PROVIDER_ORDER without LOCAL
const PROVIDER_KEYS = {
    OPENROUTER: 'OPENROUTER_KEY',
    ANTHROPIC: 'ANTHROPIC_KEY',
    OPENAI: 'OPENAI_KEY',
    GROQ: 'GROQ_KEY',
};

// environment variables read as a fallback for a field (OPENROUTER_API_KEY is
// OpenRouter's own conventional name)
const ENV_NAMES = {
    OPENROUTER_KEY: ['OPENROUTER_KEY', 'OPENROUTER_API_KEY'],
    ANTHROPIC_KEY: ['ANTHROPIC_KEY'],
    OPENAI_KEY: ['OPENAI_KEY'],
    GROQ_KEY: ['GROQ_KEY'],
    REPLICATE_API_TOKEN: ['REPLICATE_API_TOKEN'],
};

const LOCAL_FIELDS = ['LOCAL_BASE_URL', 'LOCAL_MODEL', 'LOCAL_FAST_MODEL', 'LOCAL_API_KEY'];
const TEST_TIMEOUT_MS = 20000;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

const envValue = (field) => {
    for (const name of ENV_NAMES[field] || [field]) {
        if (text(process.env[name]) !== '') return process.env[name];
    }
    return '';
};

/** `sk-or-…4f2a`: first 6 characters, an ellipsis and the last 4; short values are fully hidden. */
function maskKey(value) {
    const v = text(value);
    return v.length < 12 ? '••••' : `${v.slice(0, 6)}…${v.slice(-4)}`;
}

/** An ids like "openrouter" / "OpenAI" -> "OPENROUTER" / "OPENAI"; throws for anything else. */
function parseProvider(name) {
    const provider = String(name === undefined || name === null ? '' : name).trim().toUpperCase();
    if (!PROVIDER_KEYS[provider] && provider !== 'LOCAL') {
        throw new Error(`unknown provider: ${name} (use ${Object.keys(PROVIDER_KEYS).concat('LOCAL').map((p) => p.toLowerCase()).join(', ')})`);
    }
    return provider;
}

// the stored (decrypted) file; {} when missing or unreadable
function readStored() {
    try { return new EncryptedJsonDB('keys.json').load() || {}; } catch (e) { return {}; }
}

function writeStored(data) {
    const db = new EncryptedJsonDB('keys.json');
    db.save(data);
    // credentials: owner-only (best effort; the db class writes with the default mode)
    try { fs.chmodSync(db.filename, 0o600); } catch (e) { /* not fatal */ }
}

/**
 * keys.json plus the environment, in memory only: environment values are never
 * written back to the file (the interactive CLI start-up does that on its own).
 * `onWarn(message)` is told when the stored file cannot be read.
 */
function loadKeys({ onWarn } = {}) {
    let data = {};
    try {
        data = new EncryptedJsonDB('keys.json').load() || {};
    } catch (err) {
        if (typeof onWarn === 'function') onWarn(`Could not read ~/.aicode/keys.json (${err.message}); continuing without stored keys.`);
    }
    for (const field of Object.keys(ENV_NAMES)) {
        if (!text(data[field])) {
            const fromEnv = envValue(field);
            if (fromEnv) data[field] = fromEnv;
        }
    }
    return data;
}

// where a configured value came from: the stored file wins; otherwise the environment
function sourceOf(field, value, stored) {
    if (text(stored[field]) !== '') return 'keys.json';
    const names = ENV_NAMES[field] || [field];
    if (names.some((name) => text(process.env[name]) === value)) return 'env';
    return 'keys.json';
}

// a base URL with any user:password part removed (it is shown in listings)
function publicUrl(value) {
    try {
        const url = new URL(value);
        if (!url.username && !url.password) return value;
        url.username = '';
        url.password = '';
        return url.toString();
    } catch (e) {
        return value;
    }
}

/**
 * One row per provider, in DEFAULT_PROVIDER_ORDER (LOCAL last):
 * `{ provider, configured, masked, source, model }`.
 */
function listProviders(keysData = {}) {
    const stored = readStored();
    const rows = [];
    for (const provider of models.DEFAULT_PROVIDER_ORDER) {
        if (provider === 'LOCAL') {
            const configured = models.hasCredentials('LOCAL', keysData);
            rows.push({
                provider,
                configured,
                masked: configured ? publicUrl(text(keysData.LOCAL_BASE_URL)) : null,
                source: configured ? 'keys.json' : null,
                model: configured ? models.modelId('LOCAL', 'smart', keysData) : null,
            });
            continue;
        }
        const field = PROVIDER_KEYS[provider];
        const value = text(keysData[field]);
        const configured = value !== '';
        rows.push({
            provider,
            configured,
            masked: configured ? maskKey(value) : null,
            source: configured ? sourceOf(field, value, stored) : null,
            model: configured ? models.modelId(provider, 'smart', keysData) : null,
        });
    }
    return rows;
}

/**
 * Save a credential: `value` is the key string, or `{ baseURL, model, fastModel? }`
 * for LOCAL. Mutates `keysData` in place and writes ONLY the changed fields to
 * keys.json (so keys that merely came from the environment are not copied to disk).
 */
function setKey(provider, value, keysData) {
    const name = parseProvider(provider);
    const changes = {};
    if (name === 'LOCAL') {
        const given = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const baseURL = text(given.baseURL);
        const model = text(given.model);
        if (baseURL === '' || model === '') throw new Error('empty key');
        changes.LOCAL_BASE_URL = baseURL;
        changes.LOCAL_MODEL = model;
        if (text(given.fastModel) !== '') changes.LOCAL_FAST_MODEL = text(given.fastModel);
    } else {
        const key = text(value);
        if (key === '') throw new Error('empty key');
        changes[PROVIDER_KEYS[name]] = key;
    }
    const stored = readStored();
    Object.assign(stored, changes);
    writeStored(stored);
    Object.assign(keysData, changes);
    return keysData;
}

/** Forget a credential (the field(s) of the provider) in memory and in keys.json. */
function removeKey(provider, keysData) {
    const name = parseProvider(provider);
    const fields = name === 'LOCAL' ? LOCAL_FIELDS : [PROVIDER_KEYS[name]];
    const stored = readStored();
    for (const field of fields) {
        delete stored[field];
        delete keysData[field];
    }
    writeStored(stored);
    return keysData;
}

// error text without any key value that might be echoed back by a provider
function scrub(message, keysData) {
    let out = String(message || '');
    for (const [name, value] of Object.entries(keysData || {})) {
        if (/(KEY|TOKEN|SECRET)$/i.test(name) && typeof value === 'string' && value.length >= 8) out = out.split(value).join('***');
    }
    return out;
}

/**
 * Check that a configured credential works.
 * OPENROUTER: GET /key. Every other provider: one tiny completion on its fast tier.
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
async function testKey(provider, keysData) {
    let name;
    try { name = parseProvider(provider); } catch (err) { return { ok: false, detail: err.message }; }
    if (!models.hasCredentials(name, keysData)) return { ok: false, detail: 'not configured' };

    if (name === 'OPENROUTER') {
        const res = await openrouter.verifyKey(keysData.OPENROUTER_KEY);
        if (!res.ok) return { ok: false, detail: scrub(res.error, keysData) };
        const label = res.label || 'key';
        // `null` is "unknown", not zero: Number(null) would read as an empty account
        const left = res.limitRemaining === null || res.limitRemaining === undefined || res.limitRemaining === '' ? NaN : Number(res.limitRemaining);
        const remaining = res.limit === null || res.limit === undefined
            ? 'unlimited'
            : `${Number.isFinite(left) ? left.toFixed(2) : '?'} credits left`;
        return { ok: true, detail: `${label} · ${remaining}` };
    }

    const id = models.modelId(name, 'fast', keysData);
    try {
        const { generateText } = require('ai');
        await generateText({
            model: models.createModel(name, 'fast', keysData),
            prompt: 'Reply with the single word OK.',
            maxOutputTokens: 5,
            abortSignal: AbortSignal.timeout(TEST_TIMEOUT_MS),
            maxRetries: 0,
        });
        return { ok: true, detail: `${id} answered` };
    } catch (err) {
        return { ok: false, detail: scrub(err && err.message ? err.message : err, keysData) };
    }
}

module.exports = {
    PROVIDER_KEYS,
    ENV_NAMES,
    maskKey,
    parseProvider,
    loadKeys,
    listProviders,
    setKey,
    removeKey,
    testKey,
};
