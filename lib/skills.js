// Agent Skills support (skills.sh / SKILL.md open standard).
// ---------------------------------------------------------------------------
// A skill is a folder containing a SKILL.md with YAML frontmatter (name +
// description) plus markdown instructions and optional scripts/, references/
// and assets/ subfolders. aicode discovers skills already installed by the
// `skills` CLI (npx skills add ...) and can route user requests to them.
//
// Only the frontmatter is parsed at routing time (progressive disclosure); the
// full body is loaded lazily via loadSkill() once a skill is selected. Cursor's
// own skill directories are read (never written), so a catalog of a hundred skills
// is normal: above STAGE_ONE_MIN of them the router first gets a compact catalog and
// picks a few candidates (see stageOnePrompt / resolveCandidates).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const config = require('./config');

// max chars of a skill description injected into the routing prompt
const MAX_DESC = 300;
// the most skills discovery returns: the ones of the directories that come first keep their place
const MAX_SKILLS = 200;
// what discovery found for a project is kept this long
const CACHE_TTL_MS = 30 * 1000;
// above this many skills the router gets a compact catalog first and picks up to MAX_CANDIDATES (stage 1)
const STAGE_ONE_MIN = 12;
const MAX_CANDIDATES = 5;
// how much of a description the compact catalog of stage 1 keeps
const COMPACT_DESC = 100;
// Cursor's own skills that cannot work outside Cursor (they drive its canvas, automations, cloud
// agents, status line, settings and bug bot); left out unless `config.skills.allow` names them
const DEFAULT_IGNORED_SKILLS = ['canvas', 'automate', 'loop', 'new-repo', 'origin', 'share', 'statusline', 'update-cursor-settings', 'review-bugbot', 'review-security'];

// Skill container directories, in priority order (the first skill of a name wins: project shadows
// user, and Cursor's directories sit next to the generic ones they mirror). `origin` is what the
// listings show. The `skills` CLI installs for the agents whose layout we support; aicode's own
// installer targets the `universal` agent, which writes to `.agents/skills/` (project) and
// `~/.config/agents/skills/` (global).
function skillDirs(cwd = process.cwd()) {
    const home = os.homedir();
    const entries = [
        { dir: path.join(cwd, '.cursor', 'skills'), origin: 'cursor-project' },
        { dir: path.join(cwd, '.agents', 'skills'), origin: 'project' },
        { dir: path.join(cwd, '.claude', 'skills'), origin: 'project' },
        { dir: path.join(home, '.cursor', 'skills'), origin: 'cursor-user' },
        { dir: path.join(home, '.agents', 'skills'), origin: 'global' },
        { dir: path.join(home, '.config', 'agents', 'skills'), origin: 'global' },
        { dir: path.join(home, '.claude', 'skills'), origin: 'global' },
        { dir: path.join(home, '.cursor', 'skills-cursor'), origin: 'cursor-builtin' },
    ];
    if (!config.cursorImportDisabled()) return entries;
    // AICODE_NO_CURSOR_IMPORT leaves Cursor's own directories alone, except the project's
    // `.cursor/skills`, which belongs to the repository (not when the "project" is the home
    // directory itself: its `.cursor` is Cursor's)
    const projectIsHome = path.resolve(cwd) === path.resolve(home);
    return entries.filter(({ origin }) => !origin.startsWith('cursor-') || (origin === 'cursor-project' && !projectIsHome));
}

// The names (lower case) that discovery leaves out: the defaults, plus `config.skills.ignore`,
// minus `config.skills.allow`.
function ignoredSkills() {
    let settings = {};
    try { settings = config.loadConfig().skills || {}; } catch (e) { settings = {}; }
    const names = (list) => (Array.isArray(list) ? list : []).map((name) => String(name).trim().toLowerCase()).filter(Boolean);
    const allowed = new Set(names(settings.allow));
    return new Set([...DEFAULT_IGNORED_SKILLS, ...names(settings.ignore)].filter((name) => !allowed.has(name)));
}

const isIgnored = (name) => ignoredSkills().has(String(name == null ? '' : name).trim().toLowerCase());

// Parse the leading YAML frontmatter for simple top-level key: value pairs.
// Deliberately minimal (no yaml dependency): handles quoted values and folded
// block scalars (>-, >, |, |-). Nested/indented keys (e.g. args:) are ignored.
function parseFrontmatter(content) {
    const m = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(content);
    if (!m) return {};
    const out = {};
    const lines = m[1].split(/\r?\n/);
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
    for (let i = 0; i < lines.length; i++) {
        const lm = kv.exec(lines[i]);
        if (!lm) continue;
        const key = lm[1].toLowerCase();
        let val = lm[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        } else if (val === '>-' || val === '>' || val === '|' || val === '|-') {
            // folded/literal block scalar: collect the following indented lines
            const collected = [];
            let j = i + 1;
            while (j < lines.length && (/^\s+\S/.test(lines[j]) || lines[j].trim() === '')) {
                collected.push(lines[j].trim());
                j++;
            }
            val = collected.join(' ').trim();
            i = j - 1;
        }
        out[key] = val;
    }
    return out;
}

function stripFrontmatter(content) {
    const m = /^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/.exec(content);
    return m ? content.slice(m[0].length).replace(/^\s+/, '') : content;
}

// A SKILL.md without a description (some have no frontmatter at all) is described by the first
// paragraph of its text that is not a heading, a list item or a code block, so that routing has
// something to go on.
function firstParagraph(content) {
    const paragraph = [];
    let fenced = false;
    for (const line of stripFrontmatter(content).split(/\r?\n/)) {
        const text = line.trim();
        if (/^(```|~~~)/.test(text)) { fenced = !fenced; if (paragraph.length) break; continue; }
        if (fenced) continue;
        if (text === '') { if (paragraph.length) break; continue; }
        if (/^(#|---+$|[-*]\s|\d+\.\s)/.test(text)) { if (paragraph.length) break; continue; }
        paragraph.push(text);
    }
    return paragraph.join(' ');
}

function readSkillMeta(file, origin) {
    try {
        const content = fs.readFileSync(file, 'utf8');
        const fm = parseFrontmatter(content);
        const dir = path.dirname(file);
        const name = String(fm.name || path.basename(dir)).trim();
        if (!name) return null;
        let description = String(fm.description || '').trim() || firstParagraph(content);
        if (description.length > MAX_DESC) description = description.slice(0, MAX_DESC - 1).trimEnd() + '…';
        return { name, description, dir, file, origin };
    } catch (e) {
        return null;
    }
}

// find SKILL.md files inside a container dir: flat (skills/<name>/SKILL.md) and
// one extra level for catalog layouts (skills/<cat>/<name>/SKILL.md). A shallow
// SKILL.md shadows anything nested below it.
function findSkillFiles(containerDir) {
    const results = [];
    let entries;
    try { entries = fs.readdirSync(containerDir, { withFileTypes: true }); } catch (e) { return results; }
    // by name, so that the cap on the number of skills never depends on the file system's order
    const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    entries.sort(byName);
    for (const e of entries) {
        if (!e.isDirectory() && !e.isSymbolicLink()) continue;
        const lvl1 = path.join(containerDir, e.name);
        const direct = path.join(lvl1, 'SKILL.md');
        if (safeExists(direct)) { results.push(direct); continue; }
        let sub;
        try { sub = fs.readdirSync(lvl1, { withFileTypes: true }); } catch (err) { continue; }
        sub.sort(byName);
        for (const s of sub) {
            if (!s.isDirectory() && !s.isSymbolicLink()) continue;
            const nested = path.join(lvl1, s.name, 'SKILL.md');
            if (safeExists(nested)) results.push(nested);
        }
    }
    return results;
}

function safeExists(p) {
    try { return fs.existsSync(p); } catch (e) { return false; }
}

function scanSkills(cwd, ignored) {
    const byName = new Map();
    for (const { dir, origin } of skillDirs(cwd)) {
        for (const file of findSkillFiles(dir)) {
            const meta = readSkillMeta(file, origin);
            if (!meta) continue;
            const key = meta.name.toLowerCase();
            if (ignored.has(key)) continue;
            if (byName.has(key)) continue; // higher-priority dir already provided it
            byName.set(key, meta);
            if (byName.size >= MAX_SKILLS) return Array.from(byName.values());
        }
    }
    return Array.from(byName.values());
}

// what the last scan of a project found: key -> { at, list }
const cache = new Map();
const clearCache = () => cache.clear();

// Discover installed skills across the known directories. Returns
// [{ name, description, dir, file, origin }], in precedence order: the first skill of
// a name (compared in lower case) shadows the others, and the ones on the deny-list are
// left out. A scan is kept for CACHE_TTL_MS per project (and per home, switch and
// deny-list, so none of those can serve a stale answer); `fresh` rescans. Never throws.
function discoverSkills(cwd = process.cwd(), { fresh = false } = {}) {
    try {
        const ignored = ignoredSkills();
        const key = [path.resolve(cwd), os.homedir(), config.cursorImportDisabled() ? 'no-cursor' : '', [...ignored].sort().join(',')].join('\0');
        const hit = cache.get(key);
        let list;
        if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) {
            list = hit.list;
        } else {
            list = scanSkills(cwd, ignored);
            cache.set(key, { at: Date.now(), list });
        }
        return list.map((skill) => ({ ...skill })); // a copy: a caller cannot change what the next one sees
    } catch (e) {
        return [];
    }
}

// ---- routing a large catalog ---------------------------------------------------------------
// With more than STAGE_ONE_MIN skills the router would have to read every description; instead a
// first, cheap call sees one line per skill and names the few that could apply, and the
// classification then only offers those (with their full descriptions).
const STAGE_ONE_INSTRUCTION = `Pick up to ${MAX_CANDIDATES} installed skills that could fulfill this request better than a generic coding assistant; return exact names only, or an empty list.`;

const oneLine = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();

// `- name: the first COMPACT_DESC characters of the description`, one line per skill
function compactCatalog(list) {
    return list.map((skill) => {
        const description = oneLine(skill.description).slice(0, COMPACT_DESC).trimEnd();
        return description ? `- ${skill.name}: ${description}` : `- ${skill.name}`;
    }).join('\n');
}

function stageOnePrompt(request, list) {
    return `# Request\n${request}\n\n# Installed skills\n${compactCatalog(list)}\n\n${STAGE_ONE_INSTRUCTION}`;
}

// a name as a model may hand it back: with a dash or `skill:` in front, or in quotes
const cleanName = (raw) => oneLine(raw)
    .replace(/^[-*]\s+/, '')
    .replace(/^skill:\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/:$/, '')
    .trim()
    .toLowerCase();

// The skills of `list` that the names `names` point to (exact names, any case), in the order
// given, without repeats and without invented ones, at most `max`.
function resolveCandidates(list, names, max = MAX_CANDIDATES) {
    const out = [];
    if (!Array.isArray(names)) return out;
    for (const raw of names) {
        if (out.length >= max) break;
        const wanted = cleanName(raw);
        if (!wanted) continue;
        const match = list.find((skill) => skill.name.toLowerCase() === wanted);
        if (match && !out.includes(match)) out.push(match);
    }
    return out;
}

// the skill called `name` (compared in lower case), or undefined
function findSkill(list, name) {
    const wanted = oneLine(name).toLowerCase();
    return wanted ? list.find((skill) => skill.name.toLowerCase() === wanted) : undefined;
}

// Load the full SKILL.md body (frontmatter stripped) and a listing of bundled
// files under scripts/, references/ and assets/ (paths relative to the skill
// dir, contents not inlined).
function loadSkill(skill) {
    const content = fs.readFileSync(skill.file, 'utf8');
    const body = stripFrontmatter(content);
    const files = [];
    for (const sub of ['scripts', 'references', 'assets']) {
        walkList(path.join(skill.dir, sub), skill.dir, files, 2);
    }
    return { body, files };
}

function walkList(dir, root, out, depth) {
    if (depth < 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walkList(full, root, out, depth - 1);
        else out.push(path.relative(root, full));
    }
}

// Install a skill via the skills.sh CLI (`npx skills add <source>`). Targets the
// `universal` agent so it lands in a directory aicode scans. Returns
// { ok, code, output }. Never rejects.
function installSkill(source, opts = {}) {
    const { global = false, inherit = false, onOutput } = opts;
    const args = ['-y', 'skills', 'add', String(source), '-y', '-a', 'universal'];
    if (global) args.push('-g');
    return new Promise((resolve) => {
        let output = '';
        let proc;
        try {
            proc = spawn('npx', args, {
                cwd: process.cwd(),
                env: { ...process.env, CI: 'true', npm_config_yes: 'yes' },
                stdio: inherit ? 'inherit' : 'pipe',
            });
        } catch (err) {
            return resolve({ ok: false, code: -1, output: err.message });
        }
        if (!inherit && proc.stdout && proc.stderr) {
            const onData = (d) => { const s = d.toString(); output += s; if (onOutput) onOutput(s); };
            proc.stdout.on('data', onData);
            proc.stderr.on('data', onData);
        }
        proc.on('error', (err) => resolve({ ok: false, code: -1, output: (output + '\n' + err.message).trim() }));
        proc.on('close', (code) => {
            if (code === 0) clearCache(); // the new skill shows up at once
            resolve({ ok: code === 0, code, output: output.trim() });
        });
    });
}

module.exports = {
    discoverSkills, loadSkill, installSkill, skillDirs, parseFrontmatter, stripFrontmatter,
    clearCache, ignoredSkills, isIgnored, findSkill,
    compactCatalog, stageOnePrompt, resolveCandidates,
    MAX_SKILLS, MAX_DESC, STAGE_ONE_MIN, MAX_CANDIDATES, COMPACT_DESC, CACHE_TTL_MS, DEFAULT_IGNORED_SKILLS, STAGE_ONE_INSTRUCTION,
};
