// Project memory: what the agent knows about a project before its first tool call.
// ---------------------------------------------------------------------------
// Composed from AGENTS.md, Cursor rules (.cursor/rules/**/*.mdc), the legacy
// .cursorrules file and the agent's own notes (.aicode/memory.md). Everything is
// read fresh on every call (once per agent run), so edits made while a session
// is open apply on the next prompt.
//
// Rules follow Cursor's semantics:
//   - alwaysApply: true         → always in the system prompt
//   - globs matching the file   → in the system prompt when the editor's active
//                                 file matches, and appended to the result of
//                                 read_file / edit_file / write_file (once per
//                                 turn) when the agent touches a matching file
//   - description only          → listed under "Available rules"; the agent loads
//                                 one with the read_rule tool
//   - nothing                   → reachable by name through read_rule only

'use strict';

const fs = require('fs');
const path = require('path');
const { minimatch } = require('minimatch');

const AGENTS_FILE = 'AGENTS.md';
const CURSORRULES_FILE = '.cursorrules';
const RULES_DIR = path.join('.cursor', 'rules');
const MEMORY_FILE = path.join('.aicode', 'memory.md');

// per-section caps (characters) and the cap for the whole composed text
const CAPS = { agents: 12000, cursorrules: 6000, rule: 6000, available: 4000, memory: 6000, total: 32000 };
const TRUNCATED = '… [truncated]';
const MAX_RULES = 200;          // rule files considered per project
const MAX_RULE_FILE_CHARS = 64000;
const MAX_DESCRIPTION_CHARS = 240;

// -----------------------------------------------------------------------------
// small helpers
// -----------------------------------------------------------------------------

// Cut `text` to at most `cap` characters without splitting a surrogate pair.
function clip(text, cap) {
    const s = String(text == null ? '' : text);
    if (s.length <= cap) return { text: s, truncated: false };
    let end = cap;
    const last = s.charCodeAt(end - 1);
    if (last >= 0xD800 && last <= 0xDBFF) end--;
    return { text: s.slice(0, end), truncated: true };
}

// Read at most `maxChars` characters of a text file (never the whole file when it
// is huge). Returns null when the path is missing, unreadable or not a file.
function readText(file, maxChars) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const st = fs.fstatSync(fd);
        if (!st.isFile()) return null;
        const want = Math.min(st.size, maxChars * 4 + 4); // a UTF-8 character takes at most 4 bytes
        const buf = Buffer.alloc(want);
        const n = fs.readSync(fd, buf, 0, want, 0);
        const text = buf.toString('utf8', 0, n).replace(/^\uFEFF/, '');
        const cut = clip(text, maxChars);
        return { text: cut.text, truncated: cut.truncated || st.size > n };
    } catch (e) {
        return null;
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
    }
}

function unquote(value) {
    const t = String(value == null ? '' : value).trim();
    if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
        return t.slice(1, -1);
    }
    return t;
}

// Split on commas that are not inside {...} or [...] (so `*.{ts,tsx}` stays whole).
function splitTopLevel(str) {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of String(str)) {
        if (ch === '{' || ch === '[') depth++;
        else if ((ch === '}' || ch === ']') && depth > 0) depth--;
        if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map(unquote).map((s) => s.trim()).filter(Boolean);
}

// `./src/**` and `/src/**` are relative to the project root, like the paths we match.
function normalizeGlob(pattern) {
    return String(pattern).trim().replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

// `globs` may be a comma-separated string, an inline list ([a, b]) or a YAML block list.
function toGlobs(value) {
    let items;
    if (Array.isArray(value)) {
        items = value.flatMap((v) => splitTopLevel(String(v)));
    } else {
        let raw = String(value == null ? '' : value).trim();
        if (raw.startsWith('[') && raw.endsWith(']')) raw = raw.slice(1, -1);
        items = splitTopLevel(raw);
    }
    return items.map(normalizeGlob).filter(Boolean);
}

// Path of `file` relative to `cwd` with forward slashes; null when it is empty or
// outside the project.
function relPathIn(cwd, file) {
    if (!file || typeof file !== 'string') return null;
    const root = path.resolve(cwd);
    const rel = path.relative(root, path.resolve(root, file));
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
}

// -----------------------------------------------------------------------------
// rule files
// -----------------------------------------------------------------------------

// Cursor's .mdc files carry a small YAML header. Cursor writes unquoted globs such
// as `globs: *.ts,*.tsx` (not valid strict YAML), so the header is parsed line by
// line: `key: raw value`, plus `- item` lines for block lists.
function parseFrontmatter(raw) {
    const text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '');
    const m = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
    if (!m) return { meta: {}, body: text };
    const meta = {};
    const lines = (m[1] || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
        if (!kv) continue;
        const key = kv[1].toLowerCase();
        const value = kv[2].trim();
        if (value === '') {
            const items = [];
            while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
                items.push(unquote(lines[++i].replace(/^\s*-\s+/, '')));
            }
            if (items.length) { meta[key] = items; continue; }
        }
        meta[key] = value;
    }
    return { meta, body: text.slice(m[0].length) };
}

// -> Rule = { name, description, globs, alwaysApply, body, file }
function parseRule(raw, name, file, { truncated = false } = {}) {
    const { meta, body } = parseFrontmatter(raw);
    const description = clip(unquote(meta.description || '').replace(/\s+/g, ' ').trim(), MAX_DESCRIPTION_CHARS).text;
    const alwaysApply = /^true$/i.test(unquote(meta.alwaysapply || ''));
    let text = body.trim();
    if (truncated) text += '\n' + TRUNCATED;
    return { name, description, globs: toGlobs(meta.globs), alwaysApply, body: text, file };
}

// The legacy single-file rules (.cursorrules) as an always-on rule named after the file.
function loadLegacyRule(cwd) {
    const read = readText(path.join(path.resolve(cwd), CURSORRULES_FILE), MAX_RULE_FILE_CHARS);
    const body = read ? read.text.trim() : '';
    if (!body) return null;
    return {
        name: CURSORRULES_FILE, description: '', globs: [], alwaysApply: true,
        body: body + (read.truncated ? '\n' + TRUNCATED : ''), file: CURSORRULES_FILE,
    };
}

// Every rule under `cwd`: .cursorrules first (when present), then every
// .cursor/rules/**/*.mdc sorted by name. Symlinked files are followed, symlinked
// directories are not (no cycles). Empty rules are skipped.
function loadRules(cwd) {
    const legacy = loadLegacyRule(cwd);
    const found = loadRuleFiles(cwd);
    return legacy ? [legacy, ...found] : found;
}

function loadRuleFiles(cwd) {
    const root = path.join(path.resolve(cwd), RULES_DIR);
    const found = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            if (found.length >= MAX_RULES) return;
            const abs = path.join(dir, entry.name);
            let isDir = entry.isDirectory();
            let isFile = entry.isFile();
            if (entry.isSymbolicLink()) {
                try { isFile = fs.statSync(abs).isFile(); isDir = false; } catch (e) { continue; }
            }
            if (isDir) { walk(abs); continue; }
            if (!isFile || !entry.name.endsWith('.mdc')) continue;
            const read = readText(abs, MAX_RULE_FILE_CHARS);
            if (!read) continue;
            const name = path.relative(root, abs).split(path.sep).join('/').replace(/\.mdc$/, '');
            const file = path.relative(path.resolve(cwd), abs).split(path.sep).join('/');
            const rule = parseRule(read.text, name, file, { truncated: read.truncated });
            if (rule.body) found.push(rule);
        }
    };
    walk(root);
    found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return found;
}

// Does any of the rule's globs match the cwd-relative path `rel`?
function matchesGlobs(rule, rel) {
    if (!rel || !rule || !rule.globs || !rule.globs.length) return false;
    return rule.globs.some((pattern) => {
        try { return minimatch(rel, pattern, { dot: true, matchBase: !pattern.includes('/') }); }
        catch (e) { return false; }
    });
}

// Look a rule up by name: exact, then case-insensitive, then without a `.mdc`
// suffix, then by unique basename.
function findRule(rules, name) {
    const list = rules || [];
    const wanted = String(name == null ? '' : name).trim().replace(/\.mdc$/i, '');
    if (!wanted) return null;
    const exact = list.find((r) => r.name === wanted);
    if (exact) return exact;
    const lower = wanted.toLowerCase();
    const loose = list.find((r) => r.name.toLowerCase() === lower);
    if (loose) return loose;
    const byBase = list.filter((r) => r.name.split('/').pop().toLowerCase() === lower);
    return byBase.length === 1 ? byBase[0] : null;
}

// -----------------------------------------------------------------------------
// composition
// -----------------------------------------------------------------------------

function block(heading, text, truncated) {
    return `${heading}\n${text}${truncated ? '\n' + TRUNCATED : ''}`;
}

// Sections arrive in priority order; each is capped on its own, then the whole is
// held to CAPS.total (the section that crosses the line is cut, later ones dropped).
function compose(sections) {
    const out = [];
    const included = [];
    let used = 0;
    for (const s of sections) {
        const own = clip(s.body, s.cap);
        const text = block(s.heading, own.text, own.truncated || s.truncated);
        const sep = out.length ? 2 : 0;
        if (used + sep + text.length > CAPS.total) {
            const room = CAPS.total - used - sep - s.heading.length - TRUNCATED.length - 2;
            if (room > 200) {
                out.push(block(s.heading, clip(own.text, room).text, true));
                if (s.rule) included.push(s.rule);
            }
            break;
        }
        out.push(text);
        used += sep + text.length;
        if (s.rule) included.push(s.rule);
    }
    return { text: out.join('\n\n'), included };
}

// The project memory for one agent run.
//   -> { text, rules, injected }
//      text      the markdown for the system prompt ('' when there is nothing)
//      rules     every parsed Rule (including .cursorrules, as an alwaysApply rule)
//      injected  names of the rules whose text made it into `text`
function readProjectMemory(cwd, { activeFile = null } = {}) {
    const root = path.resolve(cwd);
    const rel = relPathIn(root, activeFile);
    const rules = loadRules(root);
    const sections = [];

    const agentsMd = readText(path.join(root, AGENTS_FILE), CAPS.agents);
    if (agentsMd && agentsMd.text.trim()) {
        sections.push({ heading: `## ${AGENTS_FILE}`, body: agentsMd.text.trim(), truncated: agentsMd.truncated, cap: CAPS.agents });
    }

    const legacy = rules.find((r) => r.file === CURSORRULES_FILE);
    if (legacy) sections.push({ heading: `## Rule: ${legacy.name}`, body: legacy.body, cap: CAPS.cursorrules, rule: legacy });

    for (const rule of rules) {
        if (!rule.alwaysApply || rule === legacy) continue;
        sections.push({ heading: `## Rule: ${rule.name}`, body: rule.body, cap: CAPS.rule, rule });
    }
    for (const rule of rules) {
        if (rule.alwaysApply || !matchesGlobs(rule, rel)) continue;
        sections.push({ heading: `## Rule: ${rule.name} (applies to ${rel})`, body: rule.body, cap: CAPS.rule, rule });
    }

    // rules that are neither always on nor matching: the ones with a description are listed
    const shown = new Set(sections.filter((s) => s.rule).map((s) => s.rule));
    const listed = rules.filter((r) => !shown.has(r) && r.description);
    if (listed.length) {
        const lines = [
            'These project rules exist but are not loaded. Call `read_rule` with a name to read one in full when it is relevant to the task.',
            ...listed.map((r) => `- ${r.name} — ${r.description}`),
        ];
        sections.push({ heading: '## Available rules', body: lines.join('\n'), cap: CAPS.available });
    }

    const notes = readText(path.join(root, MEMORY_FILE), CAPS.memory);
    if (notes && notes.text.trim()) {
        sections.push({ heading: `## ${MEMORY_FILE.split(path.sep).join('/')}`, body: notes.text.trim(), truncated: notes.truncated, cap: CAPS.memory });
    }

    const composed = compose(sections);
    return { text: composed.text, rules, injected: composed.included.map((r) => r.name) };
}

// -----------------------------------------------------------------------------
// per-turn state (glob rules are appended to tool results once per turn)
// -----------------------------------------------------------------------------

// `ctx` is the per-turn context object (a new one for every prompt), so it keys the
// state and sub-agents that share it also share what was already injected.
const TURN_STATE = new WeakMap();

function turnState(ctx) {
    if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return { injected: new Set() };
    let state = TURN_STATE.get(ctx);
    if (!state) { state = { injected: new Set() }; TURN_STATE.set(ctx, state); }
    return state;
}

function markInjected(state, names) {
    for (const name of names || []) state.injected.add(name);
}

// Text to append to the result of a tool that touched `file`: every glob rule that
// matches it and has not been shown yet this turn ('' when there is none).
function ruleNotices(rules, cwd, file, state) {
    if (!rules || !rules.length) return '';
    const rel = relPathIn(cwd, file);
    if (!rel) return '';
    let out = '';
    for (const rule of rules) {
        if (rule.alwaysApply || state.injected.has(rule.name) || !matchesGlobs(rule, rel)) continue;
        state.injected.add(rule.name);
        const body = clip(rule.body, CAPS.rule);
        out += `\n\n# Applicable rule: ${rule.name}\n${body.text}${body.truncated ? '\n' + TRUNCATED : ''}`;
    }
    return out;
}

module.exports = {
    readProjectMemory, loadRules, parseRule, parseFrontmatter, toGlobs, matchesGlobs, findRule,
    turnState, markInjected, ruleNotices, relPathIn,
    CAPS, TRUNCATED, MEMORY_FILE, AGENTS_FILE, CURSORRULES_FILE, RULES_DIR,
};
