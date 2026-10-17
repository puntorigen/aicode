// Agent Server message handlers: one function per client -> server message type.
// -----------------------------------------------------------------------------
// Every handler is `(ctx, conn, msg)` and may be async. `ctx` is
// `{ sessions: SessionManager, config: () => Config, host, version }`. A handler
// answers through `conn.send`, or throws a ProtocolError that the dispatcher
// (lib/server/index.js) turns into `error` / `session.error`. The `hello`
// handshake lives in the dispatcher because it decides whether a connection is
// authenticated at all.
'use strict';

const fs = require('fs');
const path = require('path');
const { ProtocolError, SESSION_ID_RE, listSessions, validateFlags } = require('./sessions');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const MAX_REFS = 20;
const MAX_OPEN_FILES = 50;
const MAX_SELECTION_CHARS = 4000;

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

// ---- handlers ------------------------------------------------------------------------
const handlers = {
    // session.create { cwd, flags? } -> session.created
    'session.create': (ctx, conn, msg) => {
        const cwd = absoluteDirectory(msg.cwd);
        const flags = validateFlags(msg.flags);
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
        const fail = (code, message) => new ProtocolError(code, message, { sessionId: session.id });
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (text.trim() === '') throw fail('bad_request', 'text must be a non-empty string');
        if (session.busy) throw fail('busy', 'a turn is already running in this session');
        const described = ctx.sessions.describe(session);
        if (!described.provider) throw fail('no_provider', 'no API key configured — add one in Settings');
        await ctx.sessions.runTurn(session, text, {
            refs: sanitizeRefs(msg.refs),
            editor: sanitizeEditor(msg.editor),
            requestId: msg.id,
        });
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
};

module.exports = { handlers, reply, absoluteDirectory, sanitizeRefs, sanitizeEditor };
