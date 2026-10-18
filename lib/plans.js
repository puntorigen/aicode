// Plan files: .aicode/plans/<kebab-title>.plan.md
// ---------------------------------------------------------------------------
// A plan is a markdown file in the format Cursor uses for its own plans: a small
// frontmatter (name, overview, todos with a status) and the plan itself as the body.
//
//   - `write_plan` (Plan mode) creates one,
//   - `plan_todo` (Agent mode) moves a todo along while the plan is implemented,
//   - the IDE (`plan.implement`, `catalog.get`), the TUI (`/plan`) and the CLI (`--plan`)
//     list them and start an implementation turn from one.
//
// The frontmatter is read and rewritten with a few regular expressions: the format is small,
// and a YAML dependency would be the only thing that needed it. Everything a plan holds as
// a string is written JSON-quoted (valid YAML), and read back leniently: plain, double- and
// single-quoted values and `>` / `|` block scalars all work, so a plan Cursor wrote can be
// listed and implemented too.

'use strict';

const fs = require('fs');
const path = require('path');

const PLANS_DIR = '.aicode/plans';
const PLAN_SUFFIX = '.plan.md';
const STATUSES = ['pending', 'in_progress', 'completed'];
// the implement flow puts the whole plan into one prompt: a plan bigger than this is neither written nor implemented
const MAX_PLAN_BYTES = 100 * 1024;
const MAX_SLUG_CHARS = 60;
const MAX_LISTED_PLANS = 50;
const MAX_NAME_ATTEMPTS = 1000;

const toPosix = (p) => String(p).split(path.sep).join('/');
const plansDir = (cwd) => path.join(cwd, '.aicode', 'plans');
const quote = (value) => JSON.stringify(String(value == null ? '' : value));

// a path relative to some directory that stays inside it ("..foo" is a file name, "../foo" is outside)
const isInside = (rel) => rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);

/** "Add a /health endpoint" -> "add-a-health-endpoint" (accents dropped; "plan" when nothing is left) */
function kebab(title) {
    const slug = String(title == null ? '' : title)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+/, '')
        .slice(0, MAX_SLUG_CHARS)
        .replace(/-+$/, '');
    return slug || 'plan';
}

/** `abs` as shown to the user: relative to the project with forward slashes, or absolute when it lies outside it */
function displayPath(cwd, abs) {
    const rel = path.relative(cwd, abs);
    return isInside(rel) ? toPosix(rel) : abs;
}

/** `.aicode/plans/$kebab(title).plan.md`, with `-2`, `-3`, … appended while the name is taken */
function uniquePlanPath(cwd, title) {
    const dir = plansDir(cwd);
    const base = kebab(title);
    for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
        const abs = path.join(dir, `${n === 1 ? base : `${base}-${n}`}${PLAN_SUFFIX}`);
        if (!fs.existsSync(abs)) return { abs, rel: displayPath(cwd, abs) };
    }
    throw new Error(`too many plans named like "${base}" in ${PLANS_DIR}`);
}

/** The text of a plan file. Strings in the frontmatter are always JSON-quoted. */
function renderPlan({ title, overview = '', markdown = '', todos = [] }) {
    const lines = ['---', `name: ${quote(title)}`, `overview: ${quote(overview)}`];
    if (todos.length === 0) {
        lines.push('todos: []');
    } else {
        lines.push('todos:');
        for (const todo of todos) {
            lines.push(`  - id: ${quote(todo.id)}`, `    content: ${quote(todo.content)}`, `    status: ${STATUSES.includes(todo.status) ? todo.status : 'pending'}`);
        }
    }
    lines.push('isProject: false', '---');
    const body = String(markdown);
    return `${lines.join('\n')}\n${body}${body.endsWith('\n') ? '' : '\n'}`;
}

// ---- reading ------------------------------------------------------------------------

/** A scalar value as written in the frontmatter (double-quoted, single-quoted or plain). */
function scalar(raw) {
    const value = String(raw).trim();
    if (value.startsWith('"')) {
        try { return JSON.parse(value); } catch (e) { return value.replace(/^"|"\s*$/g, ''); }
    }
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
    return value;
}

const indentOf = (line) => /^[ \t]*/.exec(line)[0].length;

/**
 * The value of the key on line `i`, whose text after the colon is `rest` and which sits at column
 * `keyIndent`. A `>` / `|` block scalar takes the lines indented deeper than the key. Returns the value
 * and the index of the first line after it.
 */
function readValue(lines, i, rest, keyIndent) {
    if (!/^[>|][+-]?\d*[ \t]*(?:#.*)?$/.test(rest.trim())) return { value: scalar(rest), next: i + 1 };
    const folded = rest.trim().startsWith('>');
    const body = [];
    let next = i + 1;
    for (; next < lines.length; next++) {
        const line = lines[next].replace(/\r$/, '');
        if (line.trim() === '') { body.push(''); continue; }
        if (indentOf(line) <= keyIndent) break;
        body.push(line);
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    const shared = Math.min(...body.filter((line) => line !== '').map(indentOf));
    const text = body.map((line) => line.slice(Number.isFinite(shared) ? shared : 0));
    return { value: folded ? text.join(' ').trim() : text.join('\n'), next };
}

const TOP_KEY = /^([A-Za-z_][\w-]*):[ \t]*(.*?)\r?$/;
const FIELD = /^([ \t]*)([A-Za-z_][\w-]*):[ \t]*(.*?)\r?$/;
const ITEM = /^([ \t]*)-[ \t]+([A-Za-z_][\w-]*):[ \t]*(.*?)\r?$/;

/**
 * The items of the `todos:` list whose first line is `start`, appended to `todos` with their values and
 * where their `status` line and last line sit. Returns the index of the first line after the list.
 */
function readTodos(lines, start, todos) {
    let i = start;
    let item = null;
    while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '' || /^[ \t]*#/.test(line)) { i++; continue; }
        const starts = ITEM.exec(line);
        if (!starts && !/^[ \t]/.test(line)) break; // the next top-level key ends the list
        let key;
        let rest;
        let keyIndent;
        if (starts) {
            const afterDash = line.slice(starts[1].length + 1);
            keyIndent = starts[1].length + 1 + (afterDash.length - afterDash.trimStart().length); // the column of the key, after "- "
            item = { id: '', content: '', status: 'pending', statusLine: -1, last: i, fieldIndent: ' '.repeat(keyIndent) };
            todos.push(item);
            key = starts[2];
            rest = starts[3];
        } else {
            const field = FIELD.exec(line);
            if (!field || !item) { i++; continue; }
            keyIndent = field[1].length;
            item.fieldIndent = field[1];
            key = field[2];
            rest = field[3];
        }
        const { value, next } = readValue(lines, i, rest, keyIndent);
        if (key === 'id' || key === 'content' || key === 'status') {
            item[key] = value;
            if (key === 'status') item.statusLine = i;
        }
        item.last = next - 1;
        i = next;
    }
    return i;
}

/** The frontmatter of `text` and where it sits in the file; null when there is none. */
function frontmatter(text) {
    const bom = String(text).startsWith('\uFEFF') ? '\uFEFF' : '';
    const source = bom ? String(text).slice(1) : String(text);
    const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
    if (!m) return null;
    const start = m[0].indexOf('\n') + 1;
    return { bom, source, front: m[1], start, end: start + m[1].length, body: source.slice(m[0].length) };
}

/** `{ name, overview, todos: [{ id, content, status }], body }` of a plan file's text; null without a frontmatter. */
function parsePlan(text) {
    const fm = frontmatter(text);
    if (!fm) return null;
    const lines = fm.front.split('\n');
    const fields = {};
    const todos = [];
    let i = 0;
    while (i < lines.length) {
        const top = TOP_KEY.exec(lines[i]);
        if (!top) { i++; continue; }
        if (top[1] === 'todos') {
            // `todos: []` (or any inline value) has no items to read
            i = top[2].trim() === '' ? readTodos(lines, i + 1, todos) : i + 1;
            continue;
        }
        const { value, next } = readValue(lines, i, top[2], 0);
        fields[top[1]] = value;
        i = next;
    }
    return {
        name: fields.name || '',
        overview: fields.overview || '',
        todos: todos.map((todo) => ({ id: todo.id, content: todo.content, status: STATUSES.includes(todo.status) ? todo.status : 'pending' })),
        body: fm.body,
    };
}

// ---- rewriting ------------------------------------------------------------------------

/**
 * `text` with the status of todo `id` replaced (nothing else in the file is touched), and the updated todo
 * list. Throws a readable Error for an unknown status, a file that is not a plan, or an unknown id.
 */
function setTodoStatus(text, id, status) {
    if (!STATUSES.includes(status)) throw new Error(`status must be one of: ${STATUSES.join(', ')}`);
    const fm = frontmatter(text);
    if (!fm) throw new Error('not a plan file: it has no frontmatter');
    const lines = fm.front.split('\n');
    const todos = [];
    for (let i = 0; i < lines.length; i++) {
        const top = TOP_KEY.exec(lines[i]);
        if (top && top[1] === 'todos' && top[2].trim() === '') { readTodos(lines, i + 1, todos); break; }
    }
    const todo = todos.find((t) => t.id === id);
    if (!todo) throw new Error(`todo '${id}' not found in the plan. Todos: ${todos.map((t) => t.id).join(', ') || '(none)'}`);
    if (todo.statusLine >= 0) {
        lines[todo.statusLine] = lines[todo.statusLine].replace(/^([ \t]*(?:-[ \t]+)?status:[ \t]*)[^\r\n]*/, `$1${status}`);
    } else {
        // a todo with no status line gets one after its last line, in the same indentation and line ending
        // (the last line of the frontmatter has lost its "\r": the closing delimiter took it)
        const cr = fm.source.slice(0, fm.start).endsWith('\r\n') ? '\r' : '';
        if (todo.last === lines.length - 1) {
            lines[todo.last] += cr;
            lines.push(`${todo.fieldIndent}status: ${status}`);
        } else {
            lines.splice(todo.last + 1, 0, `${todo.fieldIndent}status: ${status}${cr}`);
        }
    }
    const updated = fm.bom + fm.source.slice(0, fm.start) + lines.join('\n') + fm.source.slice(fm.end);
    return { text: updated, todos: parsePlan(updated).todos };
}

// ---- files on disk --------------------------------------------------------------------

/** The real path of `abs` when it is a file inside `dir` (symbolic links resolved), else null. */
function insideDirectory(dir, abs) {
    try {
        const real = fs.realpathSync(abs);
        return isInside(path.relative(fs.realpathSync(dir), real)) ? real : null;
    } catch (e) {
        return null;
    }
}

/** The plan file `p` (relative to the project) for `plan_todo`: it must be a `.plan.md` file under .aicode/plans/. */
function editablePlanFile(cwd, p) {
    const refuse = () => new Error(`plan_todo only edits plan files under ${PLANS_DIR}/ (not ${p})`);
    const abs = path.resolve(cwd, String(p || ''));
    if (!abs.endsWith(PLAN_SUFFIX) || !isInside(path.relative(plansDir(cwd), abs))) throw refuse();
    if (!fs.existsSync(abs)) throw new Error(`plan not found: ${displayPath(cwd, abs)}`);
    if (!insideDirectory(plansDir(cwd), abs)) throw refuse();
    return abs;
}

// the start of a file, at most `max` bytes
function readHead(abs, max) {
    const fd = fs.openSync(abs, 'r');
    try {
        const buffer = Buffer.alloc(max);
        const n = fs.readSync(fd, buffer, 0, max, 0);
        return buffer.toString('utf8', 0, n);
    } finally {
        fs.closeSync(fd);
    }
}

function describePlan(cwd, abs, stat) {
    let text = '';
    try { text = readHead(abs, MAX_PLAN_BYTES); } catch (e) { return null; }
    const parsed = parsePlan(text);
    return {
        path: displayPath(cwd, abs),
        title: (parsed && parsed.name) || path.basename(abs, PLAN_SUFFIX),
        overview: (parsed && parsed.overview) || '',
        todos: parsed ? parsed.todos : [],
        updatedAt: new Date(stat.mtimeMs).toISOString(),
        mtimeMs: stat.mtimeMs,
    };
}

/**
 * The plans of the project, newest first: `[{ path, title, overview, todos, updatedAt }]`. A `query`
 * keeps those whose title, overview or path contain every word of it.
 */
function listPlans(cwd, { query = '', limit = MAX_LISTED_PLANS } = {}) {
    const dir = plansDir(cwd);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return []; }
    const found = [];
    for (const name of names) {
        if (!name.endsWith(PLAN_SUFFIX)) continue;
        const abs = path.join(dir, name);
        let stat = null;
        try { stat = fs.statSync(abs); } catch (e) { continue; }
        if (!stat.isFile()) continue;
        const item = describePlan(cwd, abs, stat);
        if (item) found.push(item);
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1));
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const wanted = words.length === 0 ? found : found.filter((item) => {
        const haystack = `${item.title}\n${item.overview}\n${item.path}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
    });
    return wanted.slice(0, limit).map(({ mtimeMs, ...item }) => item);
}

/** The path of the most recently modified plan of the project, or null. */
function latestPlan(cwd) {
    const [newest] = listPlans(cwd, { limit: 1 });
    return newest ? newest.path : null;
}

// ---- the implement flow ---------------------------------------------------------------

/**
 * The plan file `p` as the implement flow reads it: `{ abs, rel, text }`. `p` is relative to `cwd` (or
 * absolute); with `insideProject` it must lie inside `cwd` (a network client names the file). Throws a
 * readable Error when the file is missing, not a file, too big or, with `insideProject`, outside.
 */
function readPlanFile(cwd, p, { insideProject = false } = {}) {
    const given = String(p == null ? '' : p).trim();
    if (given === '') throw new Error('give the path of a plan file');
    const abs = path.resolve(cwd, given);
    let stat = null;
    try { stat = fs.statSync(abs); } catch (e) { throw new Error(`plan not found: ${given}`); }
    if (!stat.isFile()) throw new Error(`not a file: ${given}`);
    if (insideProject && !insideDirectory(cwd, abs)) throw new Error(`the plan must be inside the project: ${given}`);
    if (stat.size > MAX_PLAN_BYTES) throw new Error(`the plan is too large to implement (${Math.ceil(stat.size / 1024)} KB, the limit is ${MAX_PLAN_BYTES / 1024} KB): ${given}`);
    return { abs, rel: displayPath(cwd, abs), text: fs.readFileSync(abs, 'utf8') };
}

/** The input text of an implement turn; `extra` (more instructions from the user) goes after the plan. */
function implementText(rel, content, extra = '') {
    const head = `Implement the plan at ${rel}. Work through its todos in order: call plan_todo to mark a todo in_progress when you start it and completed once it is done and verified. The plan follows.\n\n`;
    const more = String(extra || '').trim();
    return more ? `${head}${String(content).replace(/\n+$/, '')}\n\nAdditional instructions: ${more}` : `${head}${content}`;
}

module.exports = {
    PLANS_DIR, PLAN_SUFFIX, STATUSES, MAX_PLAN_BYTES,
    kebab, displayPath, uniquePlanPath, renderPlan, parsePlan, setTodoStatus,
    editablePlanFile, listPlans, latestPlan, readPlanFile, implementText,
};
