// Agent Server message handlers: one function per client -> server message type.
// -----------------------------------------------------------------------------
// Every handler is `(ctx, conn, msg)` and may be async. `ctx` is
// `{ sessions: SessionManager, config: () => Config, keysData, host, version }`
// (`keysData` is the credentials object every runtime shares). A handler
// answers through `conn.send`, or throws a ProtocolError that the dispatcher
// (lib/server/index.js) turns into `error` / `session.error`. The `hello`
// handshake lives in the dispatcher because it decides whether a connection is
// authenticated at all.
'use strict';

const fs = require('fs');
const path = require('path');
const { ProtocolError, SESSION_ID_RE, listSessions, validateFlags, orvixView } = require('./sessions');
const models = require('../models');
const openrouter = require('../openrouter');
const keys = require('../keys');
const plans = require('../plans');
const memory = require('../memory');
const { AGENT_CHOICES } = require('../orvix');

const ORVIX_COMMANDS = ['status', 'index', 'init', 'gain'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const MAX_REFS = 20;
const MAX_OPEN_FILES = 50;
const MAX_SELECTION_CHARS = 4000;
const MAX_KEY_CHARS = 4096;

// responses echo the request `id` when it has one (request/response pairs share it)
function reply(conn, request, payload) {
    conn.send(request && request.id !== undefined ? { ...payload, id: request.id } : payload);
}

function absoluteDirectory(value, { mustExist = true } = {}) {
    if (typeof value !== 'string' || value.trim() === '') throw new ProtocolError('bad_cwd', 'cwd must be a non-empty absolute path');
    if (!path.isAbsolute(value)) throw new ProtocolError('bad_cwd', `cwd must be an absolute path: ${value}`);
    const cwd = path.resolve(value);
    if (mustExist) {
        let stat = null;
        try { stat = fs.statSync(cwd); } catch (e) { /* reported below */ }
        if (!stat) throw new ProtocolError('bad_cwd', `directory not found: ${cwd}`);
        if (!stat.isDirectory()) throw new ProtocolError('bad_cwd', `not a directory: ${cwd}`);
    }
    return cwd;
}

// the session `msg.sessionId` as seen by `conn`, or a `session.error` not_found
function requireSession(ctx, conn, msg) {
    const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
    const session = sessionId ? ctx.sessions.owned(conn, sessionId) : null;
    if (!session) throw new ProtocolError('not_found', `unknown session: ${sessionId || '(missing sessionId)'}`, { sessionId: sessionId || undefined });
    return session;
}

// ---- input sanitizing --------------------------------------------------------------
function sanitizeRefs(refs) {
    if (!Array.isArray(refs)) return [];
    const out = [];
    for (const ref of refs.slice(0, MAX_REFS)) {
        if (!isObject(ref)) continue;
        if (ref.kind === 'conversation' && typeof ref.id === 'string' && ref.id) out.push({ kind: 'conversation', id: ref.id });
        else if (ref.kind === 'skill' && typeof ref.name === 'string' && ref.name) out.push({ kind: 'skill', name: ref.name });
        else if (ref.kind === 'file' && typeof ref.path === 'string' && ref.path) out.push({ kind: 'file', path: ref.path });
    }
    return out;
}

const line = (value) => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);

function sanitizeEditor(editor) {
    if (!isObject(editor)) return null;
    const activeFile = typeof editor.activeFile === 'string' && editor.activeFile ? editor.activeFile : null;
    let selection = null;
    if (isObject(editor.selection) && typeof editor.selection.text === 'string') {
        selection = {
            startLine: line(editor.selection.startLine),
            endLine: line(editor.selection.endLine),
            text: editor.selection.text.slice(0, MAX_SELECTION_CHARS),
        };
    }
    const openFiles = Array.isArray(editor.openFiles)
        ? editor.openFiles.filter((file) => typeof file === 'string' && file).slice(0, MAX_OPEN_FILES)
        : [];
    return { activeFile, selection, openFiles };
}

// ---- credentials and models ----------------------------------------------------------
// the provider named by a `keys.*` message, or a bad_request
function requireProvider(msg) {
    try { return keys.parseProvider(msg.provider); } catch (err) { throw new ProtocolError('bad_request', err.message); }
}

// the value of a `keys.set`: a trimmed key string, or { baseURL, model, fastModel? } for LOCAL
function keyValue(provider, value) {
    const bad = (message) => new ProtocolError('invalid_key', message);
    if (provider === 'LOCAL') {
        if (!isObject(value)) throw bad('LOCAL takes { baseURL, model, fastModel? }');
        for (const field of ['baseURL', 'model', 'fastModel']) {
            if (value[field] !== undefined && typeof value[field] !== 'string') throw bad(`${field} must be a string`);
            if (typeof value[field] === 'string' && value[field].length > MAX_KEY_CHARS) throw bad(`${field} is too long`);
        }
        let url = null;
        try { url = new URL(String(value.baseURL || '').trim()); } catch (e) { /* reported below */ }
        if (!url || !/^https?:$/.test(url.protocol)) throw bad('baseURL must be an http(s) URL');
        if (String(value.model || '').trim() === '') throw bad('model must not be empty');
        return value;
    }
    if (typeof value !== 'string') throw bad('the key must be a string');
    if (value.trim() === '') throw bad('empty key');
    if (value.length > MAX_KEY_CHARS) throw bad('the key is too long');
    return value;
}

// ---- turns -----------------------------------------------------------------------------
// what must hold before a turn starts in `session`
function assertReady(ctx, session) {
    const fail = (code, message) => new ProtocolError(code, message, { sessionId: session.id });
    if (session.busy) throw fail('busy', 'a turn is already running in this session');
    const described = ctx.sessions.describe(session);
    if (!described.provider) throw fail('no_provider', 'no API key configured — add one in Settings');
    const problem = ctx.sessions.selectionProblem(session);
    if (problem) throw problem;
}

// ---- catalogs ----------------------------------------------------------------------------
// `catalog.get` kinds: what a client lists in pickers and cards. Each answers `items` for `cwd` and a
// `query` (words that must all appear in the item's text).
const wordsOf = (query) => String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
const matches = (words, ...fields) => {
    const haystack = fields.join('\n').toLowerCase();
    return words.every((word) => haystack.includes(word));
};
const CATALOGS = {
    // [{ path, title, overview, todos: [{ id, content, status }], updatedAt }], newest first
    plans: (cwd, query) => plans.listPlans(cwd, { query }),
    // [{ name, description, globs, alwaysApply, file }]: the project rules (.cursor/rules and .cursorrules)
    rules: (cwd, query) => {
        const words = wordsOf(query);
        return memory.loadRules(cwd)
            .filter((rule) => matches(words, rule.name, rule.description))
            .map(({ name, description, globs, alwaysApply, file }) => ({ name, description, globs, alwaysApply, file }));
    },
};

// one stale catalog refresh at a time, started after answering a models.list
let backgroundRefresh = null;
function refreshInBackground(apiKey) {
    if (backgroundRefresh) return;
    backgroundRefresh = openrouter.fetchCatalog({ apiKey, force: true })
        .catch(() => { /* the cache keeps serving */ })
        .finally(() => { backgroundRefresh = null; });
}

// ---- handlers ------------------------------------------------------------------------
const handlers = {
    // session.create { cwd, flags? } -> session.created
    'session.create': (ctx, conn, msg) => {
        const cwd = absoluteDirectory(msg.cwd);
        const flags = validateFlags(msg.flags, { keysData: ctx.keysData });
        const session = ctx.sessions.create(conn, cwd, flags);
        reply(conn, msg, { type: 'session.created', sessionId: session.id, ...ctx.sessions.describe(session) });
    },

    // session.resume { sessionId } -> session.resumed (memory first, else the persisted file)
    'session.resume': (ctx, conn, msg) => {
        const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
        const found = SESSION_ID_RE.test(sessionId) ? ctx.sessions.resume(conn, sessionId) : null;
        if (!found) throw new ProtocolError('not_found', `unknown session: ${sessionId || '(missing sessionId)'}`);
        const { session, turns } = found;
        const { cwd, flags, provider, model, orvix } = ctx.sessions.describe(session);
        reply(conn, msg, { type: 'session.resumed', sessionId: session.id, cwd, flags, provider, model, orvix, turns });
    },

    // session.list { cwd } -> session.list { sessions }
    'session.list': (ctx, conn, msg) => {
        const cwd = absoluteDirectory(msg.cwd, { mustExist: false });
        reply(conn, msg, { type: 'session.list', sessions: listSessions(cwd) });
    },

    // session.input { sessionId, text, refs?, editor? } -> ui.* ..., session.done
    'session.input': async (ctx, conn, msg) => {
        const session = requireSession(ctx, conn, msg);
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (text.trim() === '') throw new ProtocolError('bad_request', 'text must be a non-empty string', { sessionId: session.id });
        assertReady(ctx, session);
        await ctx.sessions.runTurn(session, text, {
            refs: sanitizeRefs(msg.refs),
            editor: sanitizeEditor(msg.editor),
            requestId: msg.id,
        });
    },

    // plan.implement { sessionId, path } -> ui.* ..., session.done: a turn in Agent mode whose input is
    // the plan file (the same flow as `/plan build` and `aicode --plan`). Only a file of the session's
    // project can be named: the path comes from a client.
    'plan.implement': async (ctx, conn, msg) => {
        const session = requireSession(ctx, conn, msg);
        const fail = (message) => new ProtocolError('bad_request', message, { sessionId: session.id });
        if (typeof msg.path !== 'string' || msg.path.trim() === '') throw fail('path must be the plan file to implement');
        let plan;
        try { plan = plans.readPlanFile(session.cwd, msg.path, { insideProject: true }); } catch (err) { throw fail(err.message); }
        assertReady(ctx, session);
        await ctx.sessions.runTurn(session, plans.implementText(plan.rel, plan.text), { modeOverride: 'agent', verbatim: true, requestId: msg.id });
    },

    // session.cancel { sessionId }
    'session.cancel': (ctx, conn, msg) => {
        const session = requireSession(ctx, conn, msg);
        ctx.sessions.cancel(session);
    },

    // session.flags { sessionId, flags } -> session.flags { sessionId, flags }
    'session.flags': (ctx, conn, msg) => {
        const session = requireSession(ctx, conn, msg);
        const flags = ctx.sessions.setFlags(session, msg.flags);
        reply(conn, msg, { type: 'session.flags', sessionId: session.id, flags });
    },

    // prompt.response { id, value } answers a pending prompt.request
    'prompt.response': (ctx, conn, msg) => {
        if (typeof msg.id !== 'string' || msg.id === '') throw new ProtocolError('bad_request', 'prompt.response needs the id of the prompt.request');
        for (const sessionId of conn.sessions) {
            const session = ctx.sessions.get(sessionId);
            if (!session || !session.pendingPrompts.has(msg.id)) continue;
            if (msg.sessionId !== undefined && msg.sessionId !== sessionId) continue;
            session.adapter.answerPrompt(msg.id, msg.value);
            return;
        }
        throw new ProtocolError('unknown_prompt', `no pending prompt: ${msg.id}`);
    },

    // ide.result { id, result?, error? } answers an ide.call
    'ide.result': (ctx, conn, msg) => {
        if (typeof msg.id !== 'string' || msg.id === '') throw new ProtocolError('bad_request', 'ide.result needs the id of the ide.call');
        if (!ctx.sessions.resolveIdeResult(conn, msg.id, { result: msg.result, error: msg.error })) {
            throw new ProtocolError('unknown_call', `no pending ide.call: ${msg.id}`);
        }
    },

    // orvix.command { sessionId, command: 'status'|'index'|'init'|'gain', agents? } -> orvix.status
    'orvix.command': async (ctx, conn, msg) => {
        const session = requireSession(ctx, conn, msg);
        const fail = (code, message) => new ProtocolError(code, message, { sessionId: session.id });
        const command = typeof msg.command === 'string' ? msg.command : '';
        if (!ORVIX_COMMANDS.includes(command)) throw fail('bad_request', `command must be one of: ${ORVIX_COMMANDS.join(', ')}`);
        let agents = [];
        if (command === 'init' && msg.agents !== undefined) {
            if (!Array.isArray(msg.agents) || msg.agents.some((name) => typeof name !== 'string')) throw fail('bad_request', 'agents must be an array of strings');
            agents = msg.agents.map((name) => name.trim().toLowerCase()).filter(Boolean);
            const unknown = agents.filter((name) => !AGENT_CHOICES.includes(name));
            if (unknown.length) throw fail('bad_request', `unknown agent: ${unknown.join(', ')} (use ${AGENT_CHOICES.join(', ')})`);
        }
        const orvix = session.runtime && session.runtime.orvix;
        const answer = (extra) => reply(conn, msg, { type: 'orvix.status', sessionId: session.id, ...orvixView(orvix), ...extra });
        if (!orvix) { answer({ output: 'the code index is not available in this session' }); return; }
        const off = () => `the code index is off for this project: ${orvix.reason || 'disabled'}`;

        if (command === 'status') {
            answer(orvix.enabled ? {} : { output: off() });
        } else if (command === 'index') {
            if (!orvix.enabled) { answer({ output: off() }); return; }
            const res = await orvix.indexNow();
            const s = res.summary;
            answer({
                output: res.ok
                    ? (s ? `${s.files} files, ${s.symbols} symbols (${s.added} added, ${s.updated} updated, ${s.removed} removed)` : 'indexed')
                    : `indexing failed: ${res.error}`,
            });
        } else if (command === 'init') {
            const res = await orvix.init({ agents });
            answer({ output: res.output || (res.ok ? 'done' : 'orvix init failed') });
        } else {
            const total = await orvix.gain();
            if (total.error) { answer({ output: total.error }); return; }
            answer({
                saved: total.saved,
                output: `${total.compressions} compression${total.compressions === 1 ? '' : 's'}, ${total.saved} tokens saved (${total.before} → ${total.after})`,
            });
        }
    },

    // catalog.get { id, kind, cwd, query? } -> catalog.result { id, kind, items }
    'catalog.get': (ctx, conn, msg) => {
        const kind = typeof msg.kind === 'string' ? msg.kind : '';
        const list = Object.prototype.hasOwnProperty.call(CATALOGS, kind) ? CATALOGS[kind] : null;
        if (!list) throw new ProtocolError('bad_request', `unknown catalog kind: ${kind || '(missing)'}. Available: ${Object.keys(CATALOGS).join(', ')}`);
        const cwd = absoluteDirectory(msg.cwd);
        const query = typeof msg.query === 'string' ? msg.query : '';
        reply(conn, msg, { type: 'catalog.result', kind, items: list(cwd, query) });
    },

    // models.list { id, query?, refresh? } -> models.result
    'models.list': async (ctx, conn, msg) => {
        const query = typeof msg.query === 'string' && msg.query.trim() !== '' ? msg.query : undefined;
        const apiKey = ctx.keysData.OPENROUTER_KEY;
        let error;
        if (msg.refresh === true) {
            // answer from the cache when the fetch fails, and say so
            try {
                await openrouter.fetchCatalog({ apiKey, force: true, onError: (err) => { error = `could not refresh the OpenRouter catalog: ${err.message}`; } });
            } catch (err) {
                error = `could not load the OpenRouter catalog: ${err.message}`;
            }
        }
        const listing = models.listModels({ keysData: ctx.keysData, config: ctx.config(), query });
        reply(conn, msg, {
            type: 'models.result',
            models: listing.models,
            selected: listing.selected,
            catalog: listing.catalog,
            ...(error ? { error } : {}),
        });
        if (msg.refresh !== true && listing.catalog && listing.catalog.stale) refreshInBackground(apiKey);
    },

    // keys.list { id } -> keys.status (masked values only: raw keys never leave the server)
    'keys.list': (ctx, conn, msg) => {
        reply(conn, msg, { type: 'keys.status', providers: keys.listProviders(ctx.keysData) });
    },

    // keys.set { id, provider, value } -> keys.status
    'keys.set': (ctx, conn, msg) => {
        const provider = requireProvider(msg);
        const value = keyValue(provider, msg.value);
        try {
            keys.setKey(provider, value, ctx.keysData);
        } catch (err) {
            throw new ProtocolError('invalid_key', err.message);
        }
        reply(conn, msg, { type: 'keys.status', providers: keys.listProviders(ctx.keysData) });
    },

    // keys.remove { id, provider } -> keys.status
    'keys.remove': (ctx, conn, msg) => {
        const provider = requireProvider(msg);
        keys.removeKey(provider, ctx.keysData);
        reply(conn, msg, { type: 'keys.status', providers: keys.listProviders(ctx.keysData) });
    },

    // keys.test { id, provider } -> keys.testResult
    'keys.test': async (ctx, conn, msg) => {
        const provider = requireProvider(msg);
        const result = await keys.testKey(provider, ctx.keysData);
        reply(conn, msg, { type: 'keys.testResult', provider, ok: result.ok, detail: result.detail });
    },
};

module.exports = { handlers, reply, absoluteDirectory, sanitizeRefs, sanitizeEditor };
