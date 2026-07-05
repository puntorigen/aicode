// aicode terminal UI layer
// -------------------------------------------------------------
// Owns ALL terminal output for one-shot (non-TUI) runs and exposes a small,
// stable interface that the pipeline + action helpers talk to. The exact same
// interface is re-implemented by the Ink TUI renderer (lib/tui/), so the
// pipeline code in index.js is renderer-agnostic.
//
// It provides:
//   - a color factory (picocolors) honoring NO_COLOR / non-TTY / --quiet
//   - a transient bottom status line (spinner) that always clears itself before
//     any permanent output is printed (fixes the "status printed after answer"
//     ordering defect structurally)
//   - steps with durations, header/footer, markdown rendering, colored diffs
//   - styled prompts via @clack/prompts (ESM, lazy-imported) with a graceful
//     fallback to `prompts` when non-interactive
//
// Pure helpers (colorize, renderMarkdown, renderDiff, StreamMarkdown, ...) are
// exported too so the TUI can reuse them without duplicating logic.

const pc = require('picocolors');

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SYMBOLS = { ok: '✓', fail: '✗', run: '⏺', bullet: '•', arrow: '›', rule: '─', gap: '⋯' };

// -----------------------------------------------------------------------------
// colors
// -----------------------------------------------------------------------------
function makeColors(enabled) {
    return pc.createColors(!!enabled);
}

// Replaces @concepto/console-style inline color tokens so existing action
// strings keep rendering nicely: *magenta* #cyan# @green@ !blue! ?yellow?
const TOKEN_COLORS = { '*': 'magenta', '#': 'cyan', '@': 'green', '!': 'blue', '?': 'yellow' };
function colorize(str, colors) {
    if (str == null) return str;
    let s = String(str);
    for (const [tok, color] of Object.entries(TOKEN_COLORS)) {
        const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(esc + '([^' + esc + '\\n]+)' + esc, 'g');
        s = s.replace(re, (_m, inner) => (colors[color] ? colors[color](inner) : inner));
    }
    return s;
}

// -----------------------------------------------------------------------------
// markdown rendering (marked + marked-terminal, syntax-highlighted code blocks)
// -----------------------------------------------------------------------------
let _markedInstance = null;
function getMarked(width) {
    if (_markedInstance) return _markedInstance;
    const { Marked } = require('marked');
    const TerminalRenderer = require('marked-terminal').default;
    const instance = new Marked();
    instance.setOptions({
        renderer: new TerminalRenderer({
            width: width || (process.stdout.columns || 80),
            reflowText: true,
            tab: 2,
        }),
    });
    _markedInstance = instance;
    return instance;
}

function renderMarkdown(md, opts = {}) {
    if (md == null) return '';
    try {
        const out = getMarked(opts.width).parse(String(md));
        // marked-terminal tends to emit extra trailing blank lines; tidy them up
        return String(out).replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
    } catch (e) {
        return String(md);
    }
}

// -----------------------------------------------------------------------------
// diff rendering (jsdiff line diff -> compact colored unified-ish output)
// -----------------------------------------------------------------------------
function renderDiff(oldStr, newStr, opts = {}) {
    const colors = opts.colors || makeColors(false);
    const context = opts.context == null ? 3 : opts.context;
    const { diffLines } = require('diff');
    const parts = diffLines(String(oldStr == null ? '' : oldStr), String(newStr == null ? '' : newStr));

    // flatten to tagged lines
    const lines = [];
    for (const part of parts) {
        const tag = part.added ? '+' : part.removed ? '-' : ' ';
        const chunk = part.value.split('\n');
        // drop trailing empty element produced by a final newline
        if (chunk.length && chunk[chunk.length - 1] === '') chunk.pop();
        for (const text of chunk) lines.push({ tag, text });
    }

    // collapse long runs of unchanged context
    const out = [];
    let i = 0;
    while (i < lines.length) {
        if (lines[i].tag !== ' ') { out.push(lines[i]); i++; continue; }
        // gather the unchanged run
        let j = i;
        while (j < lines.length && lines[j].tag === ' ') j++;
        const run = lines.slice(i, j);
        const atStart = i === 0;
        const atEnd = j === lines.length;
        if (run.length <= context * 2 + 1) {
            for (const l of run) out.push(l);
        } else {
            const head = atStart ? [] : run.slice(0, context);
            const tail = atEnd ? [] : run.slice(run.length - context);
            for (const l of head) out.push(l);
            out.push({ tag: 'gap', text: `${SYMBOLS.gap} ${run.length - head.length - tail.length} unchanged` });
            for (const l of tail) out.push(l);
        }
        i = j;
    }

    const paint = (l) => {
        if (l.tag === 'gap') return colors.dim('   ' + l.text);
        if (l.tag === '+') return colors.green('+ ' + l.text);
        if (l.tag === '-') return colors.red('- ' + l.text);
        return colors.dim('  ' + l.text);
    };
    return out.map(paint).join('\n');
}

// -----------------------------------------------------------------------------
// progressive markdown for streamed answers (paragraph + fenced-block buffered)
// -----------------------------------------------------------------------------
class StreamMarkdown {
    constructor(render) {
        this.render = render; // (md) => string
        this.buf = '';
        this.para = [];
        this.inFence = false;
        this.fence = [];
    }
    _isFence(line) { return /^\s*```/.test(line); }
    _flushPara() {
        if (this.para.length === 0) return '';
        const md = this.para.join('\n');
        this.para = [];
        return this.render(md);
    }
    _line(line) {
        if (this.inFence) {
            this.fence.push(line);
            if (this._isFence(line)) {
                this.inFence = false;
                const block = this.fence.join('\n');
                this.fence = [];
                return this.render(block);
            }
            return '';
        }
        if (this._isFence(line)) {
            const pre = this._flushPara();
            this.inFence = true;
            this.fence = [line];
            return pre;
        }
        if (line.trim() === '') {
            return this._flushPara();
        }
        this.para.push(line);
        return '';
    }
    push(chunk) {
        this.buf += chunk;
        let out = '';
        let idx;
        while ((idx = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, idx);
            this.buf = this.buf.slice(idx + 1);
            out += this._line(line);
        }
        return out;
    }
    flush() {
        let out = '';
        if (this.buf.length) { out += this._line(this.buf); this.buf = ''; }
        if (this.inFence && this.fence.length) {
            // unterminated fence: render what we have + a synthetic close
            out += this.render(this.fence.join('\n') + '\n```');
            this.fence = []; this.inFence = false;
        }
        out += this._flushPara();
        return out;
    }
}

// -----------------------------------------------------------------------------
// pure line formatters (shared by the transcript UI class and the Ink TUI)
// -----------------------------------------------------------------------------
function formatHeader({ name = 'aicode', version = '', cwd = '', provider = '', model = '' } = {}, c) {
    const parts = [c.bold(c.cyan(name)) + (version ? c.dim(' v' + version) : '')];
    if (cwd) parts.push(c.dim(cwd));
    const chip = [provider, model].filter(Boolean).join('/');
    if (chip) parts.push(c.magenta(chip));
    return parts.join(c.dim('  ·  '));
}

function formatFooter(summary = {}, c) {
    const bits = [];
    if (summary.model) bits.push(summary.model);
    if (summary.inputTokens != null || summary.outputTokens != null) {
        bits.push(`${fmtTokens(summary.inputTokens)} in / ${fmtTokens(summary.outputTokens)} out`);
    }
    if (summary.cost != null && summary.cost > 0) bits.push(`~$${summary.cost.toFixed(summary.cost < 0.01 ? 4 : 2)}`);
    if (summary.elapsedMs != null) bits.push(`${(summary.elapsedMs / 1000).toFixed(1)}s`);
    if (bits.length === 0) return '';
    return c.dim(`${SYMBOLS.rule} ${bits.join(' · ')}`);
}

function formatStep({ ok = true, label = '', elapsed = '0.0', extra = '' } = {}, c) {
    const symbol = ok ? c.green(SYMBOLS.ok) : c.red(SYMBOLS.fail);
    let line = `${symbol} ${colorize(label, c)} ${c.dim('(' + elapsed + 's)')}`;
    if (extra) line += '  ' + c.dim(extra);
    return line;
}

function formatFileWritten(file, { created = false, lines = null } = {}, c) {
    const verb = created ? 'created' : 'updated';
    const symbol = created ? c.green('+') : c.cyan('~');
    const suffix = lines != null ? c.dim(` (${lines} line${lines === 1 ? '' : 's'})`) : '';
    return `${symbol} ${verb} ${c.bold(file)}${suffix}`;
}

function formatNote(message, data, color, c) {
    const paint = c[color] || c.cyan;
    let out = paint(colorize(String(message), c));
    if (data !== undefined && data !== null && data !== '') out += '\n' + c.dim(formatData(data));
    return out;
}

function formatError(err, { debug = false } = {}, c) {
    const msg = err && err.message ? err.message : String(err);
    let out = c.bold(c.red(SYMBOLS.fail + ' ' + msg));
    if (debug && err && err.stack) out += '\n' + c.dim(err.stack);
    else out += '\n' + c.dim('  run with -d for the full stack trace');
    return out;
}

function formatDiff(file, oldStr, newStr, c) {
    return c.bold('# ' + file) + '\n' + renderDiff(oldStr, newStr, { colors: c, context: 3 });
}

// -----------------------------------------------------------------------------
// transient status line (spinner)
// -----------------------------------------------------------------------------
class StatusLine {
    constructor(stream, colors) {
        this.stream = stream;
        this.colors = colors;
        this.text = '';
        this.active = false;
        this.frame = 0;
        this.timer = null;
        this.painted = false;
    }
    start(text = '') {
        this.text = text;
        this.active = true;
        if (!this.timer) this.timer = setInterval(() => this._paint(), 90);
        if (this.timer.unref) this.timer.unref();
        this._paint();
    }
    set(text) { this.text = text; if (this.active) this._paint(); }
    _paint() {
        if (!this.active) return;
        this.clear();
        const spinner = this.colors.cyan(SPINNER_FRAMES[this.frame = (this.frame + 1) % SPINNER_FRAMES.length]);
        const cols = (this.stream.columns || 80) - 3;
        let line = this.text || '';
        // strip newlines and clamp width so the transient line never wraps
        line = line.replace(/\s*\n\s*/g, ' ');
        if (stripAnsiLen(line) > cols) line = clampAnsi(line, cols) + this.colors.dim('…');
        this.stream.write(`${spinner} ${line}`);
        this.painted = true;
    }
    clear() {
        if (this.painted) { this.stream.write('\r\x1b[K'); this.painted = false; }
    }
    stop() {
        this.active = false;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        this.clear();
    }
}

// naive ansi-aware length + clamp (good enough for status truncation)
function stripAnsiLen(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, '').length; }
function clampAnsi(s, max) {
    let out = '', visible = 0, i = 0;
    while (i < s.length && visible < max) {
        if (s[i] === '\x1b') {
            const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
            if (m) { out += m[0]; i += m[0].length; continue; }
        }
        out += s[i]; visible++; i++;
    }
    return out;
}

// -----------------------------------------------------------------------------
// UI (transcript / plain renderer)
// -----------------------------------------------------------------------------
class UI {
    constructor(options = {}) {
        this.stream = options.stream || process.stdout;
        const isTTY = !!this.stream.isTTY;
        this.quiet = !!options.quiet;
        this.plain = options.plain != null ? !!options.plain : !isTTY;
        const colorOn = options.color != null ? !!options.color : (isTTY && !process.env.NO_COLOR && !this.plain);
        this.colors = makeColors(colorOn);
        this.debugEnabled = !!options.debug;
        this.width = () => (this.stream.columns || 80);
        this.status_ = new StatusLine(this.stream, this.colors);
        this._streamer = null;
        this._clackPromise = null;
    }

    get c() { return this.colors; }

    // write a permanent line, guaranteeing the transient status is cleared first
    _out(text = '') {
        const wasActive = this.status_.active;
        this.status_.clear();
        this.stream.write(text.endsWith('\n') ? text : text + '\n');
        if (wasActive && !this.plain) this.status_._paint();
    }

    colorize(str) { return colorize(str, this.colors); }
    renderMarkdown(md) { return renderMarkdown(md, { width: this.width() }); }

    // ---- header / footer -----------------------------------------------------
    header(info = {}) {
        if (this.quiet || this.plain) return;
        this._out('\n' + formatHeader(info, this.colors) + '\n');
    }

    footer(summary = {}) {
        if (this.quiet || this.plain) return;
        const line = formatFooter(summary, this.colors);
        if (line) this._out('\n' + line);
    }

    // ---- steps ----------------------------------------------------------------
    step(label, meta = '') {
        const start = Date.now();
        if (!this.quiet && !this.plain) this.status_.start(this.colorize(label) + this.colors.dim(' …'));
        const finish = (ok, text, extra) => {
            if (this.quiet) return;
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            this._out(formatStep({ ok, label: text || label, elapsed, extra: extra || '' }, this.colors));
        };
        return {
            update: (t) => { if (!this.plain) this.status_.set(this.colorize(t)); },
            done: (extra) => { this.status_.active && this.status_.stop(); finish(true, label, extra || meta); },
            fail: (text) => { this.status_.active && this.status_.stop(); finish(false, text || label); },
        };
    }

    // ---- transient status (progress shim target) ------------------------------
    status(text) {
        if (this.quiet) return;
        if (this.plain) { return; }
        if (!this.status_.active) this.status_.start(this.colorize(text));
        else this.status_.set(this.colorize(text));
    }
    statusStart(text) { if (!this.quiet && !this.plain) this.status_.start(this.colorize(text || this.status_.text)); }
    statusStop() { this.status_.stop(); }

    // ---- streaming answer ------------------------------------------------------
    streamStart() {
        this.status_.stop();
        this._streamer = new StreamMarkdown((md) => this.renderMarkdown(md));
    }
    streamChunk(chunk) {
        if (!this._streamer) this.streamStart();
        const rendered = this._streamer.push(chunk);
        if (rendered) this.stream.write(rendered);
    }
    streamEnd() {
        if (!this._streamer) return;
        const rest = this._streamer.flush();
        if (rest) this.stream.write(rest);
        this._streamer = null;
    }
    isStreaming() { return !!this._streamer; }

    // ---- answer / notes / errors ----------------------------------------------
    answer(text, { markdown = false } = {}) {
        if (markdown) this._out('\n' + this.renderMarkdown(text));
        else this._out(this.colorize(text));
    }
    markdown(md) { this._out('\n' + this.renderMarkdown(md)); }

    // print a pre-formatted line verbatim (used for sandbox console.log passthrough)
    raw(text) { this._out(String(text)); }

    note(message, data, color = 'cyan') {
        this._out(formatNote(message, data, color, this.colors));
    }

    debug(message, data) {
        if (!this.debugEnabled) return;
        this._out(this.colors.dim('· ' + this.colorize(String(message))));
        if (data !== undefined && data !== null && data !== '') this._out(this.colors.dim(formatData(data)));
    }

    diff(file, oldStr, newStr) {
        if (this.quiet) return;
        this._out('\n' + formatDiff(file, oldStr, newStr, this.colors));
    }

    fileWritten(file, opts = {}) {
        if (this.quiet) return;
        this._out(formatFileWritten(file, opts, this.colors));
    }

    error(err) {
        this._out('\n' + formatError(err, { debug: this.debugEnabled }, this.colors));
    }

    // ---- prompts ---------------------------------------------------------------
    async _clack() {
        if (this.plain || !this.stream.isTTY) return null;
        if (!this._clackPromise) this._clackPromise = import('@clack/prompts').catch(() => null);
        return await this._clackPromise;
    }

    async confirm(message, { initial = true } = {}) {
        this.statusStop();
        const clack = await this._clack();
        if (clack) {
            const res = await clack.confirm({ message: this.colorize(message), initialValue: initial });
            if (clack.isCancel(res)) return false;
            return res === true;
        }
        const prompts = require('prompts');
        const res = await prompts({ type: 'confirm', name: 'value', initial, message: this.colorize(message) });
        return res.value === true;
    }

    async select(message, choices, { initial = 0 } = {}) {
        this.statusStop();
        const clack = await this._clack();
        if (clack) {
            const res = await clack.select({
                message: this.colorize(message),
                options: choices.map((ch) => ({ value: ch.value, label: ch.title != null ? ch.title : String(ch.value), hint: ch.description })),
                initialValue: choices[initial] ? choices[initial].value : undefined,
            });
            if (clack.isCancel(res)) return undefined;
            return res;
        }
        const prompts = require('prompts');
        const res = await prompts({ type: 'select', name: 'value', message: this.colorize(message), choices, initial });
        return res.value;
    }

    async ask(message, { placeholder } = {}) {
        this.statusStop();
        const clack = await this._clack();
        if (clack) {
            const res = await clack.text({ message: this.colorize(message), placeholder });
            if (clack.isCancel(res)) return undefined;
            return res;
        }
        const prompts = require('prompts');
        const res = await prompts({ type: 'text', name: 'value', message: this.colorize(message) });
        return res.value;
    }

    // progress shim so existing action templates (progress.text/start/stop) work
    progressShim() {
        return {
            text: (t) => this.status(t),
            start: () => this.statusStart(),
            stop: () => this.statusStop(),
        };
    }

    // cleanly tear down any active status line (called on run end / error)
    dispose() { this.status_.stop(); }
}

// -----------------------------------------------------------------------------
// small formatting helpers
// -----------------------------------------------------------------------------
function fmtTokens(n) {
    if (n == null) return '?';
    if (n < 1000) return String(n);
    return (n / 1000).toFixed(1) + 'k';
}

function formatData(data) {
    if (typeof data === 'string') return data;
    try { return JSON.stringify(data, null, 2); } catch (e) { return String(data); }
}

function createUI(options = {}) { return new UI(options); }

module.exports = {
    createUI,
    UI,
    makeColors,
    colorize,
    renderMarkdown,
    renderDiff,
    StreamMarkdown,
    fmtTokens,
    formatData,
    formatHeader,
    formatFooter,
    formatStep,
    formatFileWritten,
    formatNote,
    formatError,
    formatDiff,
    SPINNER_FRAMES,
    SYMBOLS,
};
