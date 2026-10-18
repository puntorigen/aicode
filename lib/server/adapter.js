// The Agent Server's UI adapter.
// -----------------------------------------------------------------------------
// `runPrompt` talks to a small UI interface (lib/ui.js is the transcript
// renderer, lib/tui/index.mjs the Ink adapter). This is the third implementation:
// instead of painting a terminal it emits protocol messages (see
// docs/aicode-ide.spec.md -> Protocol / UI event mapping) over `send`, and turns
// confirm/select/ask into `prompt.request` round-trips answered by
// `prompt.response`.
//
// Text fields (step labels, notes, prompt messages, raw lines) keep the
// @concepto/console color tokens (*magenta* #cyan# @green@ !blue! ?yellow?)
// untouched: clients render or strip them. Answers, streams, diffs and prompts
// are never altered; debug/note/error/raw payloads are redacted (API keys) and
// made JSON-safe.
//
// Session memory: `getLastAnswer()` is what the agent loop streamed (or answer()/
// markdown() printed). Classic action templates print theirs with log() /
// console.log(), i.e. as notes and raw lines, so the adapter also keeps the text
// of those (`getOutputText()`): a turn without a streamed answer still has one.
'use strict';

const MAX_STRING = 8000;
const MAX_ITEMS = 100;
const MAX_DEPTH = 6;
const MAX_OUTPUTS = 200;
const MAX_OUTPUT_CHARS = 12000;
const MAX_OUTPUT_TEXT = 20000;

// -----------------------------------------------------------------------------
// JSON-safe copies of arbitrary values (debug/note payloads can hold Errors,
// Buffers, class instances and cycles; none of them may break the socket)
// -----------------------------------------------------------------------------
function toWire(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined) return value;
    switch (typeof value) {
        case 'string':
            return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length - MAX_STRING} more chars)` : value;
        case 'number': return Number.isFinite(value) ? value : String(value);
        case 'boolean': return value;
        case 'bigint':
        case 'symbol': return value.toString();
        case 'function': return `[Function${value.name ? ' ' + value.name : ''}]`;
        default: break;
    }
    if (value instanceof Error) {
        return { name: value.name, message: toWire(String(value.message), depth + 1, seen), stack: toWire(String(value.stack || ''), depth + 1, seen) };
    }
    if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
    if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength} bytes]`;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
    if (seen.has(value)) return '[Circular]';
    if (depth >= MAX_DEPTH) return '[…]';
    seen.add(value);
    let out;
    if (Array.isArray(value) || value instanceof Set) {
        const items = Array.from(value);
        out = items.slice(0, MAX_ITEMS).map((item) => toWire(item, depth + 1, seen));
        if (items.length > MAX_ITEMS) out.push(`… ${items.length - MAX_ITEMS} more`);
    } else {
        const source = value instanceof Map ? Object.fromEntries(value) : value;
        out = {};
        for (const key of Object.keys(source).slice(0, MAX_ITEMS)) {
            try { out[key] = toWire(source[key], depth + 1, seen); } catch (e) { out[key] = '[unreadable]'; }
        }
    }
    seen.delete(value); // the same object under two siblings is not a cycle
    return out;
}

// -----------------------------------------------------------------------------
// secret redaction: the values of every *_KEY / *_TOKEN / *_SECRET / *_PASSWORD
// field of the key store and the environment never leave the process
// -----------------------------------------------------------------------------
const SECRET_NAME = /(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_AUTH)$/i;
const MIN_SECRET_LENGTH = 8;

function collectSecrets(keysData) {
    const found = new Set();
    const scan = (source) => {
        for (const [name, value] of Object.entries(source || {})) {
            if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH && SECRET_NAME.test(name)) found.add(value);
        }
    };
    scan(keysData);
    scan(process.env);
    // longest first, so a secret that contains another one is masked whole
    return Array.from(found).sort((a, b) => b.length - a.length);
}

/**
 * `getKeysData` is called on every use (the key store is shared by reference and
 * changes while the server runs). Returns `{ maskText, mask }`: `maskText` for a
 * string, `mask` for any JSON-able value.
 */
function makeRedactor(getKeysData = () => ({})) {
    const maskText = (text) => {
        if (typeof text !== 'string' || text === '') return text;
        let out = text;
        for (const secret of collectSecrets(getKeysData())) {
            if (out.includes(secret)) out = out.split(secret).join('***');
        }
        return out;
    };
    const mask = (value) => {
        if (typeof value === 'string') return maskText(value);
        if (Array.isArray(value)) return value.map(mask);
        if (value && typeof value === 'object') {
            const out = {};
            for (const [key, item] of Object.entries(value)) out[key] = mask(item);
            return out;
        }
        return value;
    };
    return { maskText, mask };
}

const IDENTITY_REDACTOR = { maskText: (t) => t, mask: (v) => v };

const asText = (value) => (value == null ? '' : String(value));

// -----------------------------------------------------------------------------
// the adapter
// -----------------------------------------------------------------------------
/**
 * @param {(message: object) => void} send   delivers one protocol message
 * @param {string} sessionId                 stamped on every message
 * @param {object} [options]
 * @param {() => boolean} [options.isDebug]  `ui.debug` is only emitted when this is true
 * @param {{maskText, mask}} [options.redact] see makeRedactor
 * @param {Map} [options.pendingPrompts]     the session's pending prompts (id -> entry)
 * @param {() => string} [options.nextPromptId] allocates prompt ids (server-wide unique)
 */
function makeWsAdapter(send, sessionId, options = {}) {
    const isDebug = typeof options.isDebug === 'function' ? options.isDebug : () => false;
    const redact = options.redact || IDENTITY_REDACTOR;
    const pending = options.pendingPrompts instanceof Map ? options.pendingPrompts : new Map();
    let promptSeq = 0;
    const nextPromptId = typeof options.nextPromptId === 'function' ? options.nextPromptId : () => `p${++promptSeq}`;

    let stepSeq = 0;
    let diffSeq = 0;
    let streamOpen = false;
    let streamBuf = '';
    let lastAnswer = '';
    let lastDiffId = null;
    let outputs = []; // text of this turn's notes / raw lines (see getOutputText)

    const emit = (type, payload = {}) => {
        try { send({ type, sessionId, ...payload }); } catch (e) { /* a closed socket must not break the turn */ }
    };
    const safe = (value) => redact.mask(toWire(value));
    const remember = (text) => { if (text.trim() !== '') lastAnswer = text; };
    const collect = (text) => {
        if (text.trim() !== '' && outputs.length < MAX_OUTPUTS) outputs.push(text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) : text);
    };

    // ---- prompts ---------------------------------------------------------------
    const requestPrompt = (kind, message, extra = {}, choices = null) => new Promise((resolve) => {
        const id = nextPromptId();
        pending.set(id, { kind, choices, resolve });
        const request = { id, kind, message: asText(message), ...extra };
        if (kind === 'confirm' && lastDiffId) request.diffId = lastDiffId;
        emit('prompt.request', request);
    });

    const normalizeAnswer = (entry, value) => {
        if (entry.kind === 'confirm') return value === true;
        if (entry.kind === 'select') {
            const hit = (entry.choices || []).find((choice) => choice.value === value || (typeof value === 'string' && String(choice.value) === value));
            return hit ? hit.value : null;
        }
        return typeof value === 'string' ? value : null; // ask
    };

    /** Resolve a pending prompt with the client's answer. False when `id` is not pending. */
    function answerPrompt(id, value) {
        const entry = pending.get(id);
        if (!entry) return false;
        pending.delete(id);
        entry.resolve(normalizeAnswer(entry, value));
        emit('prompt.resolved', { id, cancelled: false });
        return true;
    }

    /** Resolve every pending prompt as cancelled (confirm -> false, select/ask -> null). */
    function cancelPrompts() {
        for (const [id, entry] of Array.from(pending)) {
            pending.delete(id);
            entry.resolve(entry.kind === 'confirm' ? false : null);
            emit('prompt.resolved', { id, cancelled: true });
        }
    }

    const api = {
        colorize: (text) => (text == null ? text : String(text)),
        renderMarkdown: (md) => asText(md),

        header(info = {}) { emit('ui.header', { info: safe(info) }); },
        footer(summary = {}) { emit('ui.footer', { usage: safe(summary) }); },

        step(label, meta = '') {
            const stepId = `s${++stepSeq}`;
            const started = Date.now();
            let ended = false;
            emit('ui.step.start', { stepId, label: asText(label) });
            const end = (ok, text, extra) => {
                if (ended) return;
                ended = true;
                lastDiffId = null;
                emit('ui.step.end', { stepId, ok, label: text, elapsed: ((Date.now() - started) / 1000).toFixed(1), extra: extra || '' });
            };
            return {
                update: (text) => { if (!ended) emit('ui.step.update', { stepId, label: asText(text) }); },
                done: (extra) => end(true, asText(label), asText(extra || meta)),
                fail: (text) => end(false, asText(text || label), ''),
            };
        },

        status(text) { emit('ui.status', { text: asText(text) }); },
        statusStart(text) { emit('ui.status', { text: asText(text) }); },
        statusStop() { emit('ui.status.stop'); },

        streamStart() {
            streamOpen = true;
            streamBuf = '';
            emit('ui.stream.start');
        },
        streamChunk(chunk) {
            const text = asText(chunk);
            if (!streamOpen) api.streamStart();
            if (text === '') return;
            streamBuf += text;
            emit('ui.stream.chunk', { text });
        },
        streamEnd() {
            const text = streamBuf;
            streamOpen = false;
            streamBuf = '';
            if (text.trim() === '') return; // nothing streamed: nothing to close or remember
            lastAnswer = text;
            emit('ui.stream.end', { text });
        },
        isStreaming() { return streamOpen; },

        answer(text, { markdown = false } = {}) {
            const value = asText(text);
            remember(value);
            emit('ui.answer', { text: value, markdown: !!markdown });
        },
        markdown(md) {
            const value = asText(md);
            remember(value);
            emit('ui.markdown', { text: value });
        },
        raw(text) {
            const value = redact.maskText(asText(text));
            collect(value);
            emit('ui.raw', { text: value });
        },
        note(message, data, color = 'cyan') {
            const value = redact.maskText(asText(message));
            if (color !== 'yellow') collect(value); // yellow notes are warnings, not output
            emit('ui.note', { message: value, data: safe(data), color });
        },
        debug(message, data) {
            if (!isDebug()) return;
            emit('ui.debug', { message: redact.maskText(asText(message)), data: safe(data) });
        },

        diff(file, oldStr, newStr) {
            const diffId = `d${++diffSeq}`;
            lastDiffId = diffId;
            emit('ui.diff', { diffId, file: asText(file), oldText: asText(oldStr), newText: asText(newStr) });
        },
        fileWritten(file, opts = {}) {
            lastDiffId = null;
            emit('ui.fileWritten', { file: asText(file), created: !!(opts && opts.created), lines: opts && opts.lines != null ? opts.lines : null });
        },
        error(err) {
            const message = err && err.message ? err.message : asText(err);
            emit('ui.error', { message: redact.maskText(message), stack: redact.maskText(err && err.stack ? String(err.stack) : '') });
        },

        confirm(message, opts = {}) {
            const extra = {};
            if (opts && opts.initial !== undefined) extra.initial = opts.initial;
            return requestPrompt('confirm', message, extra);
        },
        select(message, choices = [], opts = {}) {
            const list = (Array.isArray(choices) ? choices : []).map((choice) => {
                const item = { title: choice.title != null ? String(choice.title) : String(choice.value), value: choice.value };
                if (choice.description != null) item.description = String(choice.description);
                return item;
            });
            const extra = { choices: list };
            if (opts && opts.initial !== undefined) extra.initial = opts.initial;
            return requestPrompt('select', message, extra, list);
        },
        ask(message, opts = {}) {
            const extra = {};
            if (opts && opts.placeholder !== undefined) extra.placeholder = opts.placeholder;
            return requestPrompt('ask', message, extra);
        },
        // API keys reach the server through `keys.set` only (masked in every listing);
        // the runtime must not turn an `ask` into a key prompt for this client
        canAskSecrets: false,

        progressShim() {
            return { text: (t) => api.status(t), start: () => api.statusStart(), stop: () => api.statusStop() };
        },
        // optional UI method: a plan file was written (modes work); the transcript
        // UI and the TUI print a note instead
        planCreated({ path: planPath, title, overview, todos } = {}) {
            emit('plan.created', {
                path: redact.maskText(asText(planPath)),
                title: redact.maskText(asText(title)),
                overview: redact.maskText(asText(overview)),
                todos: safe(todos || []),
            });
        },
        dispose() { /* nothing to tear down */ },

        // ---- session memory (same contract as the TUI adapter) --------------------
        getLastAnswer() { return lastAnswer; },
        // the notes/raw lines of this turn, for turns that never streamed an answer
        getOutputText() { return outputs.join('\n\n').slice(0, MAX_OUTPUT_TEXT); },
        resetAnswer() { lastAnswer = ''; outputs = []; },
        get lastDiffId() { return lastDiffId; },

        // ---- prompt plumbing used by the session layer ------------------------------
        answerPrompt,
        cancelPrompts,
        pendingPromptCount() { return pending.size; },
        // end-of-turn cleanup: a stream or diff left dangling by a cancelled turn
        // must not leak into the next one
        endTurn() {
            streamOpen = false;
            streamBuf = '';
            lastDiffId = null;
            cancelPrompts();
        },
    };
    return api;
}

module.exports = { makeWsAdapter, makeRedactor, toWire, collectSecrets };
