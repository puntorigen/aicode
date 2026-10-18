// aicode configuration: plain JSON at ~/.aicode/config.json (unlike keys.json,
// which stays encrypted through helpers/db.js). Defaults are deep-merged under
// whatever the user file holds.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
    orvix: { enabled: true, mapBudget: 1500 },
    skills: { ignore: [], allow: [] },
    conversations: { cursorImport: true, sqlite: true },
    ide: { version: '4.141.0', port: 0, open: true, confirm: true },
    server: { port: 7865 },
    models: {
        selected: null,
        recent: [],
        featuredVendors: ['anthropic', 'openai', 'google', 'moonshotai', 'z-ai', 'deepseek', 'x-ai', 'qwen', 'mistralai'],
        catalogTtlHours: 24,
        fallbackOnError: false,
    },
};

let cache = null; // { file, config }
let debugHook = null; // optional (message) => void, set by callers that want the notes

function setConfigDebug(fn) {
    debugHook = typeof fn === 'function' ? fn : null;
}

function note(message) {
    if (debugHook) { try { debugHook(message); } catch (e) { /* ignore */ } }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// objects merge recursively; arrays, scalars and null replace; undefined is ignored
function deepMerge(base, extra) {
    if (!isPlainObject(base) || !isPlainObject(extra)) return clone(extra === undefined ? base : extra);
    const out = clone(base);
    for (const key of Object.keys(extra)) {
        const value = extra[key];
        if (value === undefined) continue;
        if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value);
        else out[key] = clone(value);
    }
    return out;
}

// resolved on every call so tests (and users) that change HOME are honored
function configPath() {
    return path.join(os.homedir(), '.aicode', 'config.json');
}

// the user's file contents ({} when missing or malformed; never throws)
function readRaw() {
    const file = configPath();
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        return { data: {}, malformed: false };
    }
    try {
        const data = JSON.parse(text);
        return { data: isPlainObject(data) ? data : {}, malformed: !isPlainObject(data) };
    } catch (e) {
        note(`config: ignoring malformed ${file}: ${e.message}`);
        return { data: {}, malformed: true };
    }
}

function reloadConfig() {
    const file = configPath();
    cache = { file, config: deepMerge(DEFAULTS, readRaw().data) };
    return cache.config;
}

// cached for the process; refreshed when the resolved path changes
function loadConfig() {
    if (!cache || cache.file !== configPath()) return reloadConfig();
    return cache.config;
}

// deep-merge `partial` into the file's current contents (arrays replace, objects
// merge) and write it back with 2-space JSON; refreshes the cache
function saveConfig(partial) {
    const file = configPath();
    const raw = readRaw();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (raw.malformed) {
        // never destroy a hand-edited file we could not parse
        try { fs.copyFileSync(file, file + '.bak'); } catch (e) { /* best effort */ }
    }
    const merged = deepMerge(raw.data, partial || {});
    const tmpFile = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpFile, file);
    return reloadConfig();
}

const isTruthy = (value) => /^(1|true|yes|on)$/i.test(String(value == null ? '' : value).trim());

// AICODE_NO_CURSOR_IMPORT: nothing is read from Cursor's own directories (its skills, its conversations);
// what belongs to the repository (`.cursor/rules`, `.cursor/skills` of the project) is still used
function cursorImportDisabled(env = process.env) {
    return isTruthy(env.AICODE_NO_CURSOR_IMPORT);
}

module.exports = { DEFAULTS, configPath, loadConfig, reloadConfig, saveConfig, setConfigDebug, deepMerge, cursorImportDisabled };
