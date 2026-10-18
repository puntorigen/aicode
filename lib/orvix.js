// The orvix layer: a semantic code index (symbols and a call graph, kept in
// `.orvix/` inside the project) that aicode uses as its default way to navigate code.
//
// orvix-cli is a normal dependency. This module resolves its entry points, spawns
// them with the node that runs aicode, and wraps every answer in a small,
// never-throwing API: a failure is an `{ error }` value, so a missing or broken
// index costs the agent a tool call, never a turn.
//
//   const orvix = createOrvix(cwd, { sessionId, debug });
//   orvix.enabled            // is the layer active for this project (and why not: orvix.reason)
//   await orvix.ensureIndex()  // build the index in the background when there is none
//   await orvix.find('name')   // [{ id, name, kind, container?, file, startLine, ... }] or { error }
//
// What the orvix 0.2.0 CLI does (and does not do) shapes the design:
// - Its queries only catch up the files listed in `.orvix/dirty`. They never restat
//   the tree. So a write we know about is appended to that log (the next query
//   re-parses just that file); a change we cannot name (a shell command, a merge,
//   an edit made outside aicode) triggers a real `index` run, and queries wait
//   (bounded) for it.
// - `index` does not clear the dirty log; this module trims the part a finished run
//   has taken into account.
// - Its cache files are written in place, not atomically. Index runs are detached
//   from the terminal's process group so an interrupted aicode never leaves a file
//   half written.
// - The index state is shared by every runtime (every IDE session) that uses the
//   same project directory in this process: one build, one debounce, one set of
//   listeners.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const CACHE_DIR = '.orvix';
const BUILDING = 'orvix index is still building; use text search meanwhile';

const INDEX_TIMEOUT_MS = 120000;     // a full build of a large project
const QUERY_TIMEOUT_MS = 10000;
const COMPRESS_TIMEOUT_MS = 3000;
const QUERY_WAIT_MS = 10000;         // how long a query waits for a refresh that is running
const COMPRESS_WAIT_MS = 3000;       // a compression that cannot be shown to be current is skipped
const REINDEX_DEBOUNCE_MS = 1500;
const FAILURE_BACKOFF_MS = 30000;    // no new refresh this soon after a failed one
const MAX_CAPTURE_CHARS = 16 * 1024 * 1024;
const MAX_COMPRESS_CHARS = 2 * 1024 * 1024;
const MIN_INDEXABLE_FILES = 5;
const MAX_WALK_ENTRIES = 4000;
const MAP_BUDGET_MAX = 20000;
const CHARS_PER_TOKEN = 3.5;         // the measure orvix itself uses

// what orvix 0.2.0 parses
const INDEXABLE_EXTENSIONS = [
    '.ts', '.mts', '.cts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyi', '.go', '.rs',
    '.java', '.cs', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.c', '.h',
];
const INDEXABLE = new Set(INDEXABLE_EXTENSIONS);
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'venv', '__pycache__', 'bower_components']);
const AGENT_CHOICES = ['claude', 'codex', 'cursor', 'gemini'];

const isTruthy = (value) => /^(1|true|yes|on)$/i.test(String(value == null ? '' : value).trim());
const oneLine = (text, max = 300) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max);

// resolves after `ms`, or as soon as `promise` settles, whichever comes first (the timer is
// not unref'ed: a caller that waits must keep the process alive)
function withTimeout(promise, ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(undefined), ms);
        Promise.resolve(promise).then(
            (value) => { clearTimeout(timer); resolve(value); },
            () => { clearTimeout(timer); resolve(undefined); },
        );
    });
}

// ---- configuration and discovery ----------------------------------------------------
function settings(config) {
    let base = config;
    if (!base) { try { base = require('./config').loadConfig(); } catch (e) { base = {}; } }
    const section = (base && base.orvix) || {};
    const budget = Math.trunc(Number(section.mapBudget));
    return {
        enabled: section.enabled !== false,
        mapBudget: budget > 0 ? Math.min(budget, MAP_BUDGET_MAX) : 1500,
        bin: typeof section.bin === 'string' && section.bin.trim() !== '' ? section.bin.trim() : null,
    };
}

const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch (e) { return false; } };

/**
 * Where the orvix entry points are: `{ kind: 'pkg', main, query, hook }` for the bundled
 * orvix-cli, `{ kind: 'bin', bin, hook }` when `config.orvix.bin` names an executable that
 * answers every command, or null when orvix cannot run.
 */
function locate(cfg = {}) {
    let pkg = null;
    try {
        // the package has no `exports` map, so its package.json resolves
        const root = path.dirname(require.resolve('orvix-cli/package.json'));
        pkg = {
            main: path.join(root, 'dist', 'main.js'),
            query: path.join(root, 'dist', 'query.js'),
            hook: path.join(root, 'hooks', 'orvix-compress.mjs'),
        };
    } catch (e) { pkg = null; }
    const hook = pkg && isFile(pkg.hook) ? pkg.hook : null;
    if (cfg.bin) return { kind: 'bin', bin: cfg.bin, hook };
    if (pkg && isFile(pkg.main) && isFile(pkg.query)) return { kind: 'pkg', main: pkg.main, query: pkg.query, hook };
    return null;
}

const mainCommand = (location, args) => (location.kind === 'bin' ? { cmd: location.bin, args } : { cmd: process.execPath, args: [location.main, ...args] });
const queryCommand = (location, args) => (location.kind === 'bin' ? { cmd: location.bin, args } : { cmd: process.execPath, args: [location.query, ...args] });

// a `.git` entry (a directory, or a file in a worktree or submodule) in the directory or above it
function insideGit(root) {
    let dir = root;
    for (;;) {
        if (fs.existsSync(path.join(dir, '.git'))) return true;
        const parent = path.dirname(dir);
        if (parent === dir) return false;
        dir = parent;
    }
}

// indexable files below `root`, counting stops at `limit` (a bounded walk: it never crawls a big tree)
function countIndexable(root, limit = MIN_INDEXABLE_FILES) {
    let found = 0;
    let visited = 0;
    const stack = [root];
    while (stack.length && found < limit && visited < MAX_WALK_ENTRIES) {
        const dir = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
        for (const entry of entries) {
            visited++;
            if (entry.isDirectory()) {
                if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) stack.push(path.join(dir, entry.name));
            } else if (entry.isFile() && INDEXABLE.has(path.extname(entry.name).toLowerCase())) {
                if (++found >= limit) break;
            }
        }
    }
    return found;
}

const realPath = (dir) => { try { return fs.realpathSync(dir); } catch (e) { return path.resolve(dir); } };

/** `{ enabled, reason }`: whether orvix is active for `root`, and the reason when it is not. */
function decide(root, cfg, location, env = process.env) {
    if (isTruthy(env.AICODE_NO_ORVIX)) return { enabled: false, reason: 'AICODE_NO_ORVIX is set' };
    if (cfg.enabled === false) return { enabled: false, reason: 'orvix.enabled is false in the configuration' };
    if (!location) return { enabled: false, reason: 'orvix-cli is not installed' };
    const real = realPath(root);
    // a home directory or a filesystem root is never worth indexing
    if (real === realPath(os.homedir()) || real === path.parse(real).root) return { enabled: false, reason: 'not indexing a home directory or a filesystem root' };
    if (isFile(path.join(root, CACHE_DIR, 'symbols.json'))) return { enabled: true, reason: null }; // the project already uses orvix
    if (insideGit(root)) return { enabled: true, reason: null };
    if (countIndexable(root) >= MIN_INDEXABLE_FILES) return { enabled: true, reason: null };
    return { enabled: false, reason: `not a git repository and fewer than ${MIN_INDEXABLE_FILES} source files` };
}

// ---- processes -------------------------------------------------------------------------
/**
 * Spawn `cmd` and collect its output: `{ child, promise }`, the promise resolving (never rejecting)
 * `{ code, stdout, stderr, timedOut, error? }`. A detached run lives in its own process group and
 * is unref'ed: the terminal's Ctrl-C and aicode's own exit do not interrupt it.
 */
function execute(cmd, args, { cwd, timeoutMs = 0, input, detached = false, env } = {}) {
    let child = null;
    const promise = new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        let timer = null;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve({ stdout, stderr, timedOut, ...result });
        };
        try {
            child = spawn(cmd, args, {
                cwd,
                env: env || process.env,
                detached,
                windowsHide: true,
                stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
            });
        } catch (error) {
            finish({ code: -1, error });
            return;
        }
        child.on('error', (error) => finish({ code: -1, error }));
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { if (stdout.length < MAX_CAPTURE_CHARS) stdout += chunk; });
        child.stderr.on('data', (chunk) => { if (stderr.length < MAX_CAPTURE_CHARS) stderr += chunk; });
        child.on('close', (code) => finish({ code: code === null ? -1 : code }));
        if (timeoutMs > 0) {
            timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (e) { /* already gone */ } }, timeoutMs);
        }
        if (input !== undefined) {
            child.stdin.on('error', () => { /* the child exited before reading everything */ });
            child.stdin.end(input);
        }
        if (detached) {
            child.unref();
            try { child.stdout.unref(); child.stderr.unref(); } catch (e) { /* not a socket on this platform */ }
        }
    });
    return { child, promise };
}

const parseJson = (text) => { try { return JSON.parse(text); } catch (e) { return undefined; } };

// ---- result shapes ------------------------------------------------------------------------
// the fields the model needs (byte offsets stay inside orvix)
function shapeSymbol(symbol) {
    return {
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        ...(symbol.container ? { container: symbol.container } : {}),
        file: symbol.file,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        signature: symbol.signature,
        exported: !!symbol.exported,
    };
}

/**
 * orvix answers a reference that matches several symbols on stderr:
 *   "ok" matches 2 symbols:
 *   okjz9  test/a.js:326 const longDir = project(...)
 *   okotu  lib/b.mjs:23 const h = React.createElement ←2
 * -> { ambiguous: true, message, candidates: [{ id, file, startLine, signature }] }, else null
 */
function parseAmbiguous(stderr) {
    const lines = String(stderr || '').split('\n').map((line) => line.replace(/\s+$/, '')).filter(Boolean);
    const header = lines.findIndex((line) => /\bmatches \d+ symbols?:$/.test(line));
    if (header === -1) return null;
    const candidates = [];
    for (const line of lines.slice(header + 1)) {
        const m = /^\s*(\S+)\s+(.+?):(\d+)\s+(.*?)(?:\s+←\d+)?\s*$/.exec(line);
        if (m) candidates.push({ id: m[1], file: m[2], startLine: Number(m[3]), signature: m[4] });
    }
    if (candidates.length === 0) return null;
    return { ambiguous: true, message: lines[header], candidates };
}

/**
 * Keep only the blocks of an `orvix map` text whose file is `sub` or below it, then fit the result to
 * `tokens`. A block is a file path (no indent) followed by its indented symbol lines; the footer
 * ("… 33 files (693 symbols) not shown") describes the unfiltered map and is dropped.
 */
function filterMap(text, sub, tokens) {
    const wanted = String(sub || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!wanted || wanted === '.') return text;
    const blocks = [];
    for (const line of text.split('\n')) {
        if (line === '' || /^…/.test(line)) continue;
        if (/^\s/.test(line)) { if (blocks.length) blocks[blocks.length - 1].lines.push(line); } else blocks.push({ file: line.trim(), lines: [line] });
    }
    const kept = blocks.filter((block) => block.file === wanted || block.file.startsWith(wanted + '/'));
    if (kept.length === 0) return `no indexed symbols under ${wanted}`;
    const limit = Math.max(200, Math.floor(tokens * CHARS_PER_TOKEN));
    const out = [];
    let used = 0;
    for (let i = 0; i < kept.length; i++) {
        const block = kept[i].lines.join('\n');
        if (used + block.length + 1 > limit && out.length > 0) {
            out.push(`… ${kept.length - i} more files under ${wanted} not shown (raise the budget or ask for a narrower path)`);
            break;
        }
        out.push(block);
        used += block.length + 1;
    }
    return out.join('\n');
}

// ---- shell commands that cannot change files ------------------------------------------------
const READ_ONLY_COMMANDS = new Set([
    'ls', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'pwd', 'echo', 'printf', 'which', 'whereis',
    'type', 'wc', 'file', 'stat', 'tree', 'du', 'df', 'date', 'env', 'printenv', 'whoami', 'uname', 'hostname', 'id', 'diff', 'cmp', 'sort',
    'uniq', 'cut', 'tr', 'basename', 'dirname', 'realpath', 'readlink', 'true', 'false', 'test', '[', 'cd', 'jq', 'md5', 'md5sum', 'shasum',
    'sha256sum', 'find',
]);
const READ_ONLY_GIT = new Set([
    'status', 'log', 'diff', 'show', 'rev-parse', 'blame', 'grep', 'ls-files', 'describe', 'shortlog', 'rev-list', 'cat-file', 'ls-tree',
    'remote', 'branch', 'tag', 'config', 'reflog',
]);

/**
 * Could running this shell command have changed project files? A conservative guess: only
 * well-known read-only commands (and git queries) are exempt, and any redirection, command
 * substitution or `find -delete/-exec` brings the doubt back.
 */
function commandMayChangeFiles(command) {
    const text = String(command == null ? '' : command);
    if (text.trim() === '') return false;
    if (/\$\(|`/.test(text)) return true;
    const cleaned = text.replace(/\d*>&\d+/g, '').replace(/&?>+\s*\/dev\/null/g, '').replace(/\d*>+\s*\/dev\/null/g, '');
    if (cleaned.includes('>')) return true;
    for (const segment of cleaned.split(/&&|\|\||[;|&\n]/)) {
        const words = segment.trim().split(/\s+/).filter((word) => word !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
        if (words.length === 0) continue;
        const name = words[0];
        if (name === 'git') {
            const sub = words.slice(1).find((word) => !word.startsWith('-'));
            if (!sub || !READ_ONLY_GIT.has(sub)) return true;
            continue;
        }
        if (!READ_ONLY_COMMANDS.has(name)) return true;
        if (name === 'find' && words.some((word) => /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(word))) return true;
    }
    return false;
}

// ---- state shared by every runtime of one project directory -----------------------------------
const STATES = new Map();

function stateFor(root) {
    const key = realPath(root);
    let state = STATES.get(key);
    if (!state) {
        state = {
            key,
            indexRun: null,          // the index run in flight (a promise), if any
            firstBuild: false,       // that run is building the index from nothing
            timer: null,             // the debounce before a refresh
            unknown: false,          // a change happened that only an index run can pick up
            gen: 0,                  // bumped by every such change
            failedAt: 0,
            lastError: null,
            lastSummary: null,
            countMemo: null,         // symbol count, memoized per symbols.json stamp
            excludeResult: null,
            catchUp: null,           // the query that applies the dirty log, if running
            listeners: new Set(),
            lastEmitted: '',
        };
        STATES.set(key, state);
    }
    return state;
}

/**
 * Keep `.orvix/` out of `git status` without touching the project's `.gitignore`: the pattern goes to
 * the repository's `info/exclude`. A directory that is not a repository, or that already ignores
 * `.orvix/` some other way, is left alone.
 */
function excludeFromGit(root, state) {
    if (state.excludeResult) return state.excludeResult;
    let result;
    try {
        const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true });
        // the trailing slash makes git treat the (possibly not yet created) path as a directory
        const ignored = git(['check-ignore', '-q', '.orvix/']);
        if (ignored.error || ignored.status === null) result = { done: false, reason: 'git is not available' };
        else if (ignored.status === 0) result = { done: true, already: true };
        else if (ignored.status !== 1) result = { done: false, reason: 'not a git repository' };
        else {
            const where = git(['rev-parse', '--git-path', 'info/exclude']);
            if (where.status !== 0 || !where.stdout.trim()) {
                result = { done: false, reason: 'not a git repository' };
            } else {
                const file = path.resolve(root, where.stdout.trim());
                let current = '';
                try { current = fs.readFileSync(file, 'utf8'); } catch (e) { current = ''; }
                if (!current.split(/\r?\n/).some((line) => /^\/?\.orvix\/?$/.test(line.trim()))) {
                    fs.mkdirSync(path.dirname(file), { recursive: true });
                    fs.appendFileSync(file, (current === '' || current.endsWith('\n') ? '' : '\n') + '.orvix/\n');
                }
                result = { done: true, file };
            }
        }
    } catch (e) {
        result = { done: false, reason: e.message };
    }
    state.excludeResult = result;
    return result;
}

const dirtyPath = (root) => path.join(root, CACHE_DIR, 'dirty');

function dirtySize(root) {
    try { return fs.statSync(dirtyPath(root)).size; } catch (e) { return 0; }
}

// drop the first `handled` bytes of the dirty log: the entries a finished index run has taken into account
function trimDirty(root, handled) {
    if (!handled) return;
    try {
        const file = dirtyPath(root);
        const buffer = fs.readFileSync(file);
        if (buffer.length <= handled) fs.rmSync(file, { force: true });
        else fs.writeFileSync(file, buffer.subarray(handled));
    } catch (e) { /* the log is only a hint */ }
}

// the number of symbols in `.orvix/symbols.json`, or null when there is no usable index
function symbolCount(root, state) {
    const file = path.join(root, CACHE_DIR, 'symbols.json');
    let stat;
    try { stat = fs.statSync(file); } catch (e) { return null; }
    const memo = state.countMemo;
    if (memo && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) return memo.count;
    let count = null;
    const data = parseJson((() => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; } })());
    if (data && typeof data === 'object' && data.symbols && typeof data.symbols === 'object') count = Object.keys(data.symbols).length;
    state.countMemo = { mtimeMs: stat.mtimeMs, size: stat.size, count };
    return count;
}

// ---- the instance ----------------------------------------------------------------------------------
/**
 * @param {string} cwd
 * @param {object} [options]
 * @param {string} [options.sessionId]  the orvix hook's `session_id`: a file is compressed once per session
 * @param {Function} [options.debug]    (message, data)
 * @param {object} [options.config]     a config object (default: the loaded config.json)
 */
function createOrvix(cwd, { sessionId, debug, config } = {}) {
    const root = path.resolve(cwd || process.cwd());
    const cfg = settings(config);
    const log = typeof debug === 'function' ? (message, data) => { try { debug(message, data); } catch (e) { /* logging is optional */ } } : () => { };
    const id = sessionId || crypto.randomUUID();
    const location = locate(cfg);
    const decision = decide(root, cfg, location);
    const enabled = decision.enabled;
    const state = stateFor(root);

    const count = () => symbolCount(root, state);
    const status = () => ({
        enabled,
        symbols: enabled ? (count() || 0) : 0,
        indexing: !!state.indexRun,
        dirty: !!(state.unknown || dirtySize(root) > 0),
    });

    // tell the listeners when the visible status changed
    const notify = () => {
        if (state.listeners.size === 0) return;
        const snapshot = status();
        const key = JSON.stringify(snapshot);
        if (key === state.lastEmitted) return;
        state.lastEmitted = key;
        for (const listener of Array.from(state.listeners)) {
            try { listener(snapshot); } catch (e) { /* a listener must not break the index */ }
        }
    };

    const backingOff = () => state.failedAt > 0 && Date.now() - state.failedAt < FAILURE_BACKOFF_MS;

    // one index run at a time for the project (shared with every other runtime of it)
    const startIndex = () => {
        if (state.indexRun) return state.indexRun;
        if (state.timer) { clearTimeout(state.timer); state.timer = null; }
        excludeFromGit(root, state);
        const generation = state.gen;
        const handled = dirtySize(root);
        state.firstBuild = count() === null;
        const { cmd, args } = mainCommand(location, ['index', '--json', root]);
        log('orvix: indexing', { root, firstBuild: state.firstBuild });
        const { promise } = execute(cmd, args, { cwd: root, timeoutMs: INDEX_TIMEOUT_MS, detached: true });
        state.indexRun = promise.then((res) => {
            state.indexRun = null;
            state.firstBuild = false;
            let result;
            if (res.code === 0) {
                const summary = parseJson(res.stdout) || null;
                trimDirty(root, handled);
                state.lastError = null;
                state.failedAt = 0;
                state.lastSummary = summary;
                if (state.gen === generation) state.unknown = false;
                result = { ok: true, summary, symbols: (summary && summary.symbols) ?? count() ?? 0 };
            } else {
                const reason = res.error ? res.error.message : (res.timedOut ? 'timed out' : oneLine(res.stderr || res.stdout) || `exit ${res.code}`);
                state.lastError = reason;
                state.failedAt = Date.now();
                result = { ok: false, error: reason };
                log('orvix: index failed', { error: reason });
            }
            notify();
            // a change arrived while the run was working: another pass picks it up
            if (result.ok && state.unknown) scheduleIndex();
            return result;
        });
        notify();
        return state.indexRun;
    };

    const scheduleIndex = () => {
        if (!enabled) return;
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => { state.timer = null; if (!backingOff()) startIndex(); }, REINDEX_DEBOUNCE_MS);
        if (state.timer.unref) state.timer.unref(); // `flush()` starts it at exit
    };

    // a change only an index run can pick up has happened
    const touch = () => { state.unknown = true; state.gen++; };

    // wait (bounded) until the index reflects every change we know of
    const fresh = async (maxWaitMs) => {
        if (state.unknown && !state.indexRun && !backingOff()) startIndex();
        if (state.indexRun) await withTimeout(state.indexRun, maxWaitMs);
        return !state.unknown && !state.indexRun;
    };

    // the first thing every query needs: orvix usable, an index to ask
    const unavailable = () => {
        if (!enabled) return { error: `orvix is not active for this project (${decision.reason})` };
        if (state.firstBuild && state.indexRun) return { error: BUILDING };
        if (count() === null) {
            if (!backingOff()) { startIndex(); return { error: BUILDING }; }
            return { error: `orvix index is not available (${state.lastError || 'the build failed'}); use text search` };
        }
        return null;
    };

    // the hook that rewrites a tool result only trusts an index that is current: apply the dirty log first
    const applyDirtyLog = async () => {
        if (dirtySize(root) === 0) return;
        if (!state.catchUp) {
            const { cmd, args } = queryCommand(location, location.kind === 'bin' ? ['map', root, '-b', '1'] : ['map', '-p', root, '-b', '1']);
            state.catchUp = execute(cmd, args, { cwd: root, timeoutMs: QUERY_TIMEOUT_MS }).promise.finally(() => { state.catchUp = null; });
        }
        await state.catchUp;
    };

    const runQuery = async (sub, positional) => {
        const blocked = unavailable();
        if (blocked) return blocked;
        await fresh(QUERY_WAIT_MS);
        const { cmd, args } = queryCommand(location, [sub, ...positional, '-p', root, '--json']);
        const res = await execute(cmd, args, { cwd: root, timeoutMs: QUERY_TIMEOUT_MS }).promise;
        if (res.error) return { error: `could not run orvix: ${res.error.message}` };
        if (res.timedOut) return { error: 'orvix timed out' };
        return res;
    };

    const cleanReference = (value) => {
        const ref = String(value == null ? '' : value).trim();
        if (ref === '') return { error: 'empty symbol id or name' };
        // the query CLI reads a leading dash as an option
        if (ref.startsWith('-')) return { error: 'a symbol id or name cannot start with "-"' };
        return ref;
    };

    const symbolList = (res) => {
        if (res.error) return { error: res.error };
        if (res.code === 0) {
            const list = parseJson(res.stdout);
            return Array.isArray(list) ? list.map(shapeSymbol) : { error: 'orvix returned an unexpected answer' };
        }
        return parseAmbiguous(res.stderr) || { error: oneLine(res.stderr || res.stdout) || 'orvix failed' };
    };

    return {
        enabled,
        reason: decision.reason,
        root,
        sessionId: id,
        mapBudget: cfg.mapBudget,

        /** `{ enabled, symbols, indexing, dirty }` */
        status,

        /** Call `listener(status)` whenever the status changes; returns the function that stops it. */
        onStatus(listener) {
            state.listeners.add(listener);
            return () => { state.listeners.delete(listener); };
        },

        /**
         * Make sure there is an index: when there is none, build it in the background. With a `ui`
         * (anything with `step(label)`) the build is shown as a step; `result.step.detach(note)` ends
         * that step early (a turn that finishes before the build does).
         */
        async ensureIndex({ ui } = {}) {
            if (!enabled) return { enabled: false, building: false, symbols: 0, step: null };
            excludeFromGit(root, state);
            if (count() === null && !state.indexRun && !backingOff()) startIndex();
            const building = !!(state.firstBuild && state.indexRun);
            let step = null;
            if (building && ui && typeof ui.step === 'function') {
                try {
                    const shown = ui.step('indexing symbols (orvix)');
                    let ended = false;
                    const end = (fn) => { if (ended) return; ended = true; try { fn(); } catch (e) { /* the UI is best-effort */ } };
                    state.indexRun.then((res) => end(() => (res.ok ? shown.done(`${res.symbols} symbols`) : shown.fail(`orvix: ${res.error}`))));
                    step = { detach: (note) => end(() => shown.done(note)) };
                } catch (e) { step = null; }
            }
            return { enabled: true, building, symbols: count() || 0, step };
        },

        /** Resolves true when an index exists, waiting up to `timeoutMs` for a first build that is running. */
        async ready(timeoutMs = 0) {
            if (!enabled) return false;
            if (state.firstBuild && state.indexRun && timeoutMs > 0) await withTimeout(state.indexRun, timeoutMs);
            return count() !== null && !(state.firstBuild && state.indexRun);
        },

        /**
         * A project file changed. With paths (relative to the project or absolute) only those files are
         * re-parsed, by the next query; without, anything may have changed and an index run is scheduled.
         */
        markDirty(files) {
            if (!enabled) return;
            if (Array.isArray(files) && files.length > 0) {
                const entries = [];
                for (const file of files) {
                    const rel = path.relative(root, path.resolve(root, String(file)));
                    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
                    if (!INDEXABLE.has(path.extname(rel).toLowerCase())) continue;
                    entries.push(rel.split(path.sep).join('/'));
                }
                if (entries.length === 0) return;
                // no index yet, or one being built from nothing: the dirty log would not be read
                if (state.firstBuild || count() === null || !fs.existsSync(path.join(root, CACHE_DIR))) {
                    touch();
                    scheduleIndex();
                    return;
                }
                try { fs.appendFileSync(dirtyPath(root), entries.join('\n') + '\n'); } catch (e) { touch(); scheduleIndex(); return; }
                notify();
                return;
            }
            touch();
            scheduleIndex();
            notify();
        },

        /** Run an index pass now (cancelling the debounce); resolves `{ ok, summary?, error? }`. */
        indexNow() {
            if (!enabled) return Promise.resolve({ ok: false, disabled: true, error: decision.reason });
            return startIndex();
        },

        /** Start a pending refresh immediately (the process is about to exit; the run survives it). */
        flush() {
            if (enabled && state.timer) { clearTimeout(state.timer); state.timer = null; if (!backingOff()) startIndex(); }
        },

        /** Wait until nothing is scheduled or running (bounded); for tests and orderly shutdowns. */
        async settle(timeoutMs = INDEX_TIMEOUT_MS) {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                if (enabled && state.timer) { clearTimeout(state.timer); state.timer = null; if (!backingOff()) startIndex(); }
                if (!state.indexRun) return;
                const left = deadline - Date.now();
                if (left <= 0) return;
                await withTimeout(state.indexRun, left);
            }
        },

        /**
         * The ranked symbol map as text, fitted to `budget` tokens (default: config.orvix.mapBudget).
         * `path` keeps one directory or file; `wait: false` answers from the index as it is (the system
         * brief wants speed, not the last edit). `{ error }` when there is no usable index.
         */
        async map(budget, { path: sub, wait = true } = {}) {
            const blocked = unavailable();
            if (blocked) return blocked;
            if (wait) await fresh(QUERY_WAIT_MS);
            const asked = Math.trunc(Number(budget));
            const tokens = Math.min(asked > 0 ? asked : cfg.mapBudget, MAP_BUDGET_MAX);
            const fetched = sub ? Math.min(tokens * 8, MAP_BUDGET_MAX) : tokens;
            const run = location.kind === 'bin'
                ? mainCommand(location, ['map', root, '-b', String(fetched)])
                : queryCommand(location, ['map', '-p', root, '-b', String(fetched)]);
            const res = await execute(run.cmd, run.args, { cwd: root, timeoutMs: QUERY_TIMEOUT_MS }).promise;
            if (res.error) return { error: `could not run orvix: ${res.error.message}` };
            if (res.timedOut) return { error: 'orvix timed out' };
            if (res.code !== 0) return { error: oneLine(res.stderr || res.stdout) || 'orvix failed' };
            const text = res.stdout.replace(/\s+$/, '');
            return sub ? filterMap(text, sub, tokens) : text;
        },

        /** Symbols whose name or signature matches `query`: `[shape]`, or `{ error }`. */
        async find(query) {
            const q = String(query == null ? '' : query).trim();
            if (q === '') return { error: 'empty query' };
            if (q.startsWith('-')) return { error: 'a query cannot start with "-"' };
            return symbolList(await runQuery('find', [q]));
        },

        /**
         * One symbol and its exact source: `{ ...shape, source }`. `idOrName` is an id, a short id prefix or
         * a name; several matches answer `{ ambiguous: true, message, candidates }`, none `{ error }`.
         */
        async show(idOrName) {
            const ref = cleanReference(idOrName);
            if (typeof ref !== 'string') return ref;
            const res = await runQuery('show', [ref]);
            if (res.error) return { error: res.error };
            if (res.code === 0) {
                const symbol = parseJson(res.stdout);
                if (!symbol || typeof symbol !== 'object') return { error: 'orvix returned an unexpected answer' };
                return { ...shapeSymbol(symbol), source: String(symbol.source == null ? '' : symbol.source) };
            }
            return parseAmbiguous(res.stderr) || { error: oneLine(res.stderr || res.stdout) || 'orvix failed' };
        },

        /** The symbols that call this one: `[shape]`, `{ ambiguous, ... }` or `{ error }`. */
        async whoCalls(idOrName) {
            const ref = cleanReference(idOrName);
            if (typeof ref !== 'string') return ref;
            return symbolList(await runQuery('who-calls', [ref]));
        },

        /** The symbols this one calls. */
        async calls(idOrName) {
            const ref = cleanReference(idOrName);
            if (typeof ref !== 'string') return ref;
            return symbolList(await runQuery('calls', [ref]));
        },

        /**
         * Let orvix's PostToolUse hook shrink a tool result it can describe more cheaply (a big indexed
         * file as its symbol map, search hits as their enclosing symbols). Anything it does not recognize,
         * or an index that is not current, leaves `text` exactly as it was.
         * @param {'Read'|'Grep'|'Bash'} toolName
         * @param {object} toolInput  { file_path } | { pattern } | { command }
         */
        async compress(toolName, toolInput, text) {
            try {
                if (!enabled || !location || !location.hook) return text;
                if (typeof text !== 'string' || text === '' || text.length > MAX_COMPRESS_CHARS) return text;
                if (count() === null || (state.firstBuild && state.indexRun)) return text;
                await fresh(COMPRESS_WAIT_MS);
                if (state.unknown || state.indexRun) return text;
                await applyDirtyLog();
                const payload = JSON.stringify({
                    session_id: id,
                    cwd: root,
                    hook_event_name: 'PostToolUse',
                    tool_name: toolName,
                    tool_input: toolInput || {},
                    tool_response: text,
                });
                const res = await execute(process.execPath, [location.hook], { cwd: root, timeoutMs: COMPRESS_TIMEOUT_MS, input: payload }).promise;
                if (res.code !== 0 || res.stdout.trim() === '') return text;
                const out = (parseJson(res.stdout) || {}).hookSpecificOutput;
                if (!out || typeof out.updatedToolOutput !== 'string') return text;
                return typeof out.additionalContext === 'string' && out.additionalContext !== ''
                    ? `${out.updatedToolOutput}\n\n${out.additionalContext}`
                    : out.updatedToolOutput;
            } catch (e) {
                return text;
            }
        },

        /** What the compressions have saved so far: `{ compressions, before, after, saved, ratio }`, or `{ error }`. */
        async gain() {
            if (!location) return { error: 'orvix-cli is not installed' };
            const { cmd, args } = mainCommand(location, ['gain', '--json', root]);
            const res = await execute(cmd, args, { cwd: root, timeoutMs: QUERY_TIMEOUT_MS }).promise;
            if (res.error) return { error: `could not run orvix: ${res.error.message}` };
            if (res.code !== 0) return { error: oneLine(res.stderr || res.stdout) || 'orvix failed' };
            const parsed = parseJson(res.stdout);
            return parsed && parsed.total ? parsed.total : { error: 'orvix returned an unexpected answer' };
        },

        /**
         * `orvix init`: write the agents' instruction files (AGENTS.md, .gitignore, ...) and build the index.
         * This is the only path that edits those files, and only because the user asked for it.
         * Resolves `{ ok, code, output }`.
         */
        async init({ agents } = {}) {
            if (!location) return { ok: false, code: -1, output: 'orvix-cli is not installed' };
            const list = (Array.isArray(agents) ? agents : []).map((name) => String(name).trim().toLowerCase()).filter(Boolean);
            const unknown = list.filter((name) => !AGENT_CHOICES.includes(name));
            if (unknown.length) return { ok: false, code: -1, output: `unknown agent: ${unknown.join(', ')} (use ${AGENT_CHOICES.join(', ')})` };
            const { cmd, args } = mainCommand(location, ['init', root, ...(list.length ? ['-a', ...list] : [])]);
            const res = await execute(cmd, args, { cwd: root, timeoutMs: INDEX_TIMEOUT_MS }).promise;
            // init indexes the project itself, so nothing is left pending; the symbol count is new to the listeners
            notify();
            const output = `${res.stdout}${res.stderr}`.trim();
            return { ok: res.code === 0, code: res.code, output: res.error ? `could not run orvix: ${res.error.message}` : output };
        },

        /** Run any orvix command with the terminal attached (`aicode orvix …`); resolves the exit code. */
        passthrough(args) {
            if (!location) return Promise.resolve(127);
            excludeFromGit(root, state);
            const { cmd, args: argv } = mainCommand(location, args);
            return new Promise((resolve) => {
                let child;
                try { child = spawn(cmd, argv, { cwd: root, stdio: 'inherit', windowsHide: true }); } catch (e) { resolve(127); return; }
                child.on('error', () => resolve(127));
                child.on('close', (code) => resolve(code === null ? 1 : code));
            });
        },
    };
}

module.exports = {
    createOrvix,
    locate,
    decide,
    settings,
    parseAmbiguous,
    filterMap,
    commandMayChangeFiles,
    BUILDING,
    CACHE_DIR,
    INDEXABLE_EXTENSIONS,
    AGENT_CHOICES,
};
