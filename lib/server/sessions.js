// Agent Server sessions.
// -----------------------------------------------------------------------------
// A session is one conversation: a project directory (`cwd`), its own Runtime
// (and therefore its own mutable `flags`), the trimmed history that gives the
// agent loop memory, and whatever is pending on the client (prompts, IDE calls).
// Sessions live in memory while a client is attached, stay for a while after it
// disconnects (so a page reload can `session.resume`) and are persisted per turn
// under ~/.aicode/projects/<slug>/sessions/<id>.jsonl in the same shape as Cursor
// transcripts, so lib/conversations.js can read both with one parser.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { trimSessionHistory } = require('../history');
const { projectSlug } = require('../conversations');
const { makeWsAdapter, makeRedactor } = require('./adapter');

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TITLE_MAX = 80;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_IDE_TIMEOUT_MS = 10 * 1000;
const MODES = ['auto', 'agent', 'plan', 'ask'];
// what `session.done` carries when a turn produced no usage summary (crashed before the first call)
const EMPTY_USAGE = Object.freeze({ model: '', models: {}, inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 });

/** A request-level failure that maps to an `error` / `session.error` message. */
class ProtocolError extends Error {
    constructor(code, message, { sessionId } = {}) {
        super(message);
        this.name = 'ProtocolError';
        this.code = code;
        if (sessionId) this.sessionId = sessionId;
    }
}

// -----------------------------------------------------------------------------
// persistence
// -----------------------------------------------------------------------------
const aicodeDir = () => path.join(os.homedir(), '.aicode');

// `projectSlug('/')` is '' (every character is a separator): keep a stable name
const slugFor = (cwd) => projectSlug(cwd) || 'root';

function sessionsDir(cwd) {
    return path.join(aicodeDir(), 'projects', slugFor(cwd), 'sessions');
}

function sessionFile(cwd, id) {
    if (!SESSION_ID_RE.test(String(id))) throw new Error(`invalid session id: ${id}`);
    return path.join(sessionsDir(cwd), `${id}.jsonl`);
}

const titleOf = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);

function messageText(entry) {
    const content = entry && entry.message ? entry.message.content : null;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter((part) => part && part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
}

/** Parse a session transcript: `{ header, turns: [{ role, text }] }` (null when unreadable). */
function parseSessionFile(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
    let header = null;
    const turns = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch (e) { continue; } // a torn last line is skipped
        if (!entry || typeof entry !== 'object') continue;
        if (entry.type === 'session') { if (!header) header = entry; continue; }
        if (entry.role === 'user' || entry.role === 'assistant') turns.push({ role: entry.role, text: messageText(entry) });
    }
    return { header, turns };
}

/** The persisted sessions of a project, newest first. */
function listSessions(cwd) {
    const dir = sessionsDir(cwd);
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return []; }
    const out = [];
    for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const id = name.slice(0, -'.jsonl'.length);
        if (!SESSION_ID_RE.test(id)) continue;
        const file = path.join(dir, name);
        const parsed = parseSessionFile(file);
        if (!parsed) continue;
        let stat;
        try { stat = fs.statSync(file); } catch (e) { continue; }
        const users = parsed.turns.filter((turn) => turn.role === 'user');
        const header = parsed.header || {};
        out.push({
            id,
            title: header.title || titleOf(users[0] && users[0].text),
            createdAt: header.createdAt || stat.birthtime.toISOString(),
            updatedAt: stat.mtime.toISOString(),
            turns: users.length,
        });
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return out;
}

/** Find a persisted session by id alone (any project): `{ file, header, turns }` or null. */
function loadPersisted(id) {
    if (!SESSION_ID_RE.test(String(id))) return null;
    const root = path.join(aicodeDir(), 'projects');
    let slugs;
    try { slugs = fs.readdirSync(root); } catch (e) { return null; }
    for (const slug of slugs) {
        const file = path.join(root, slug, 'sessions', `${id}.jsonl`);
        if (!fs.existsSync(file)) continue;
        const parsed = parseSessionFile(file);
        if (parsed && parsed.header && typeof parsed.header.cwd === 'string') return { file, ...parsed };
    }
    return null;
}

function appendTurn(session, text, answer) {
    const file = sessionFile(session.cwd, session.id);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const lines = [];
    if (!fs.existsSync(file)) {
        lines.push({ type: 'session', id: session.id, cwd: session.cwd, createdAt: session.createdAt, title: session.title });
    }
    lines.push({ role: 'user', message: { content: [{ type: 'text', text }] } });
    lines.push({ role: 'assistant', message: { content: [{ type: 'text', text: answer }] } });
    lines.push({ type: 'turn_ended' });
    fs.appendFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', { mode: 0o600 });
}

// -----------------------------------------------------------------------------
// flags
// -----------------------------------------------------------------------------
function defaultFlags(client, config) {
    const ide = (config && config.ide) || {};
    return {
        confirm: client === 'ide' ? ide.confirm !== false : false,
        local: false,
        mode: 'auto',
        language: null,
        quiet: false,
        debug: false,
        modelPreferences: null,
        model: null,
    };
}

const knownProviders = () => Object.keys(require('../models').PROVIDERS);

/**
 * Validate a (partial) flags object from a client. Returns the cleaned partial;
 * throws ProtocolError (`bad_flags`, or `unknown_model`) without touching anything.
 */
function validateFlags(partial, { sessionId } = {}) {
    if (partial === undefined || partial === null) return {};
    const bad = (message, code = 'bad_flags') => new ProtocolError(code, message, { sessionId });
    if (typeof partial !== 'object' || Array.isArray(partial)) throw bad('flags must be an object');
    const out = {};
    for (const [key, value] of Object.entries(partial)) {
        switch (key) {
            case 'confirm':
            case 'local':
            case 'quiet':
            case 'debug':
                if (typeof value !== 'boolean') throw bad(`flag ${key} must be a boolean`);
                out[key] = value;
                break;
            case 'mode':
                if (!MODES.includes(value)) throw bad(`flag mode must be one of: ${MODES.join(', ')}`);
                out.mode = value;
                break;
            case 'language':
                if (value !== null && typeof value !== 'string') throw bad('flag language must be a string or null');
                out.language = value ? value : null;
                break;
            case 'modelPreferences': {
                if (value === null) { out.modelPreferences = null; break; }
                if (!Array.isArray(value) || !value.every((p) => typeof p === 'string')) throw bad('flag modelPreferences must be an array of provider names or null');
                const names = value.map((p) => p.toUpperCase());
                const unknown = names.find((p) => !knownProviders().includes(p));
                if (unknown) throw bad(`unknown provider in modelPreferences: ${unknown}`);
                out.modelPreferences = names;
                break;
            }
            case 'model':
                // model selection arrives with the models work; clearing is always fine
                if (value !== null) throw bad('model selection is not available', 'unknown_model');
                out.model = null;
                break;
            default:
                throw bad(`unknown flag: ${key}`);
        }
    }
    return out;
}

// `--local` needs a configured local model server
function localProblem(runtime) {
    const keys = (runtime && runtime.keysData) || {};
    if ((keys.LOCAL_BASE_URL || '').trim() !== '' && (keys.LOCAL_MODEL || '').trim() !== '') return null;
    return new ProtocolError('no_credentials', 'no local model configured (set LOCAL_BASE_URL and LOCAL_MODEL, or run "aicode --local" once)');
}

// -----------------------------------------------------------------------------
// the manager
// -----------------------------------------------------------------------------
class SessionManager {
    /**
     * @param {object} options
     * @param {(cwd: string, flags: object, extras: {ide: object|null, debug: Function}) => object} options.runtimeFactory
     * @param {() => object} options.getConfig  returns the loaded Config
     * @param {Function} [options.debug]        (message, data) server-side log hook (never receives secrets)
     * @param {number} [options.ttlMs]          how long a detached session is kept in memory
     * @param {number} [options.ideTimeoutMs]   how long an `ide.call` waits for `ide.result`
     */
    constructor({ runtimeFactory, getConfig, debug = null, ttlMs = DEFAULT_TTL_MS, ideTimeoutMs = DEFAULT_IDE_TIMEOUT_MS }) {
        if (typeof runtimeFactory !== 'function') throw new TypeError('SessionManager: runtimeFactory is required');
        this.runtimeFactory = runtimeFactory;
        this.getConfig = getConfig || (() => ({}));
        this.debug = typeof debug === 'function' ? debug : null;
        this.ttlMs = ttlMs;
        this.ideTimeoutMs = ideTimeoutMs;
        this.sessions = new Map();
        // prompt and IDE-call ids are unique across the server: `prompt.response`
        // and `ide.result` carry no sessionId
        this.promptSeq = 0;
        this.ideSeq = 0;
    }

    log(message, data) {
        if (this.debug) { try { this.debug(message, data); } catch (e) { /* logging must not break a session */ } }
    }

    get(id) { return this.sessions.get(id) || null; }

    /** The session `id` if it is attached to `conn`, else null. */
    owned(conn, id) {
        const session = this.sessions.get(id);
        return session && session.conn === conn ? session : null;
    }

    // ---- creation / resume ---------------------------------------------------------
    create(conn, cwd, partialFlags = {}) {
        const flags = { ...defaultFlags(conn.client, this.getConfig()), ...partialFlags };
        return this._build({ id: crypto.randomUUID(), cwd, flags, conn, createdAt: new Date().toISOString(), history: [], title: '' });
    }

    /**
     * Attach `conn` to an existing session: from memory, else rebuilt from its
     * persisted file. Returns `{ session, turns }` (the full transcript), or null
     * when the id is unknown.
     */
    resume(conn, id) {
        let session = this.sessions.get(id) || null;
        if (session) {
            this.attach(session, conn);
        } else {
            const persisted = loadPersisted(id);
            if (!persisted) return null;
            const cwd = persisted.header.cwd;
            if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
                throw new ProtocolError('bad_cwd', `the project directory of this session no longer exists: ${cwd}`);
            }
            const history = trimSessionHistory(persisted.turns.map((turn) => ({ role: turn.role, content: turn.text })));
            session = this._build({
                id,
                cwd,
                flags: defaultFlags(conn.client, this.getConfig()),
                conn,
                createdAt: persisted.header.createdAt || new Date().toISOString(),
                history,
                title: persisted.header.title || '',
            });
        }
        const parsed = parseSessionFile(sessionFile(session.cwd, session.id));
        return { session, turns: parsed ? parsed.turns : [] };
    }

    _build({ id, cwd, flags, conn, createdAt, history, title }) {
        const session = {
            id,
            cwd,
            flags,
            runtime: null,
            adapter: null,
            history,
            busy: false,
            abort: null,
            pendingPrompts: new Map(),
            pendingIdeCalls: new Map(),
            createdAt,
            title,
            conn: null,
            expiryTimer: null,
            send: (message) => { if (session.conn) session.conn.send(message); },
        };
        const redact = makeRedactor(() => session.runtime && session.runtime.keysData);
        session.adapter = makeWsAdapter(session.send, id, {
            isDebug: () => !!session.flags.debug,
            redact,
            pendingPrompts: session.pendingPrompts,
            nextPromptId: () => `p${++this.promptSeq}`,
        });
        const extras = {
            ide: conn.client === 'ide' ? this._ideBridge(session) : null,
            debug: (message, data) => session.adapter.debug(message, data),
        };
        const runtime = this.runtimeFactory(cwd, flags, extras);
        session.runtime = runtime;
        // the runtime owns the flags object it was handed (it reads it live)
        if (runtime && runtime.flags && runtime.flags !== flags) Object.assign(runtime.flags, flags);
        session.flags = (runtime && runtime.flags) || flags;
        if (session.flags.local) {
            const problem = localProblem(runtime);
            if (problem) throw problem;
        }
        this.sessions.set(id, session);
        this.attach(session, conn);
        return session;
    }

    attach(session, conn) {
        if (session.conn && session.conn !== conn) {
            // taken over by a newer connection (a reloaded page can resume before
            // the old socket's close arrives): the old one stops receiving events
            session.conn.sessions.delete(session.id);
            this._interrupt(session);
        }
        if (session.expiryTimer) { clearTimeout(session.expiryTimer); session.expiryTimer = null; }
        session.conn = conn;
        conn.sessions.add(session.id);
    }

    /** `conn` went away: abort its running turns and keep the sessions for `ttlMs`. */
    detach(conn) {
        for (const id of Array.from(conn.sessions)) {
            const session = this.sessions.get(id);
            if (!session || session.conn !== conn) continue;
            session.conn = null;
            this._interrupt(session);
            this._scheduleExpiry(session);
        }
        conn.sessions.clear();
    }

    _scheduleExpiry(session) {
        if (session.expiryTimer) clearTimeout(session.expiryTimer);
        session.expiryTimer = setTimeout(() => {
            session.expiryTimer = null;
            if (session.conn) return; // somebody resumed it
            if (session.busy) { this._scheduleExpiry(session); return; } // still unwinding an aborted turn
            this.sessions.delete(session.id);
            this.log('session expired', { sessionId: session.id });
        }, this.ttlMs);
        if (session.expiryTimer.unref) session.expiryTimer.unref();
    }

    // ---- turns ---------------------------------------------------------------------
    /**
     * Run one turn. The caller has checked `session.busy`; `busy` is set before
     * the first await, so two quick `session.input` messages cannot both start.
     */
    async runTurn(session, text, { refs, editor, modeOverride, requestId } = {}) {
        session.busy = true;
        const controller = new AbortController();
        session.abort = controller;
        const adapter = session.adapter;
        adapter.resetAnswer();
        let usage = null;
        try {
            const opts = { signal: controller.signal, history: session.history.slice(), sessionId: session.id };
            if (refs && refs.length) opts.refs = refs;
            if (editor) opts.editor = editor;
            if (modeOverride) opts.modeOverride = modeOverride;
            usage = await session.runtime.runPrompt(text, adapter, opts);
        } catch (err) {
            adapter.error(err);
        }
        const cancelled = controller.signal.aborted;
        // the streamed answer, else what classic action templates logged
        const answer = adapter.getLastAnswer() || adapter.getOutputText();
        adapter.endTurn();
        // a turn counts as memory only when it finished with an answer
        if (!cancelled && answer && answer.trim() !== '') {
            session.history = trimSessionHistory([
                ...session.history,
                { role: 'user', content: text },
                { role: 'assistant', content: answer },
            ]);
            if (!session.title) session.title = titleOf(text);
            try { appendTurn(session, text, answer); } catch (err) { this.log('could not persist the session', { sessionId: session.id, error: err.message }); }
        }
        session.busy = false;
        session.abort = null;
        const done = { type: 'session.done', sessionId: session.id, usage: usage || EMPTY_USAGE };
        if (requestId !== undefined) done.id = requestId;
        if (cancelled) done.cancelled = true;
        session.send(done);
    }

    /** Abort the running turn and resolve its pending prompts. False when idle. */
    cancel(session) {
        if (!session.busy) return false;
        this._interrupt(session);
        return true;
    }

    _interrupt(session) {
        if (session.busy && session.abort) session.abort.abort();
        session.adapter.cancelPrompts();
        for (const [id, call] of Array.from(session.pendingIdeCalls)) {
            clearTimeout(call.timer);
            session.pendingIdeCalls.delete(id);
            call.reject(new Error('IDE call cancelled'));
        }
    }

    // ---- flags -----------------------------------------------------------------------
    /** Validate and merge a partial flags object; returns the full flags. */
    setFlags(session, partial) {
        const cleaned = validateFlags(partial, { sessionId: session.id });
        if (cleaned.local === true) {
            const problem = localProblem(session.runtime);
            if (problem) throw new ProtocolError(problem.code, problem.message, { sessionId: session.id });
        }
        Object.assign(session.flags, cleaned);
        return { ...session.flags };
    }

    // ---- IDE RPC ---------------------------------------------------------------------
    _ideBridge(session) {
        return {
            call: (method, args) => new Promise((resolve, reject) => {
                const conn = session.conn;
                const fail = () => new Error(`IDE did not answer: ${method}`);
                if (!conn) { reject(fail()); return; }
                const id = `i${++this.ideSeq}`;
                const timer = setTimeout(() => {
                    session.pendingIdeCalls.delete(id);
                    reject(fail());
                }, this.ideTimeoutMs);
                if (timer.unref) timer.unref();
                session.pendingIdeCalls.set(id, { resolve, reject, timer });
                conn.send({ type: 'ide.call', id, sessionId: session.id, method, args: args || {} });
            }),
        };
    }

    /** `ide.result`: settle the pending call `id` of one of `conn`'s sessions. False when unknown. */
    resolveIdeResult(conn, id, { result, error } = {}) {
        for (const sessionId of conn.sessions) {
            const session = this.sessions.get(sessionId);
            const call = session && session.pendingIdeCalls.get(id);
            if (!call) continue;
            clearTimeout(call.timer);
            session.pendingIdeCalls.delete(id);
            if (error !== undefined && error !== null) call.reject(new Error(typeof error === 'string' ? error : (error.message || JSON.stringify(error))));
            else call.resolve(result);
            return true;
        }
        return false;
    }

    // ---- views -----------------------------------------------------------------------
    /** The fields `session.created` / `session.resumed` share. */
    describe(session) {
        let chip = { provider: '', model: '' };
        try {
            const described = session.runtime.describeProvider && session.runtime.describeProvider();
            if (described) chip = { provider: described.provider || '', model: described.model || '' };
        } catch (e) { /* the chip is display-only */ }
        return {
            cwd: session.cwd,
            flags: { ...session.flags },
            provider: chip.provider,
            model: chip.model,
            // the orvix layer is wired in with the orvix work; until then it is off
            orvix: { enabled: false, symbols: 0, indexing: false },
        };
    }

    closeAll() {
        for (const session of this.sessions.values()) {
            if (session.expiryTimer) { clearTimeout(session.expiryTimer); session.expiryTimer = null; }
            session.conn = null;
            this._interrupt(session);
        }
        this.sessions.clear();
    }
}

module.exports = {
    SessionManager,
    ProtocolError,
    SESSION_ID_RE,
    MODES,
    EMPTY_USAGE,
    defaultFlags,
    validateFlags,
    sessionsDir,
    sessionFile,
    parseSessionFile,
    listSessions,
    loadPersisted,
    titleOf,
};
