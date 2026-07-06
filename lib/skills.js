// Agent Skills support (skills.sh / SKILL.md open standard).
// ---------------------------------------------------------------------------
// A skill is a folder containing a SKILL.md with YAML frontmatter (name +
// description) plus markdown instructions and optional scripts/, references/
// and assets/ subfolders. aicode discovers skills already installed by the
// `skills` CLI (npx skills add ...) and can route user requests to them.
//
// Only the frontmatter is parsed at routing time (progressive disclosure); the
// full body is loaded lazily via loadSkill() once a skill is selected.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// max chars of a skill description injected into the routing prompt
const MAX_DESC = 300;
// safety cap on the number of skills injected into the routing prompt
const MAX_SKILLS = 60;

// Skill container directories, in priority order (project shadows global).
// These mirror where the `skills` CLI installs for the agents whose layout we
// support; aicode's own installer targets the `universal` agent which writes to
// `.agents/skills/` (project) and `~/.config/agents/skills/` (global).
function skillDirs(cwd = process.cwd()) {
    const home = os.homedir();
    return [
        { dir: path.join(cwd, '.agents', 'skills'), origin: 'project' },
        { dir: path.join(cwd, '.claude', 'skills'), origin: 'project' },
        { dir: path.join(home, '.agents', 'skills'), origin: 'global' },
        { dir: path.join(home, '.config', 'agents', 'skills'), origin: 'global' },
        { dir: path.join(home, '.claude', 'skills'), origin: 'global' },
    ];
}

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

function readSkillMeta(file, origin) {
    try {
        const content = fs.readFileSync(file, 'utf8');
        const fm = parseFrontmatter(content);
        const dir = path.dirname(file);
        const name = String(fm.name || path.basename(dir)).trim();
        if (!name) return null;
        let description = String(fm.description || '').trim();
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
    for (const e of entries) {
        if (!e.isDirectory() && !e.isSymbolicLink()) continue;
        const lvl1 = path.join(containerDir, e.name);
        const direct = path.join(lvl1, 'SKILL.md');
        if (safeExists(direct)) { results.push(direct); continue; }
        let sub;
        try { sub = fs.readdirSync(lvl1, { withFileTypes: true }); } catch (err) { continue; }
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

// Discover installed skills across the known directories. Returns
// [{ name, description, dir, file, origin }], project-scoped skills first and
// shadowing global ones with the same name. Never throws.
function discoverSkills(cwd = process.cwd()) {
    const byName = new Map();
    for (const { dir, origin } of skillDirs(cwd)) {
        for (const file of findSkillFiles(dir)) {
            const meta = readSkillMeta(file, origin);
            if (!meta) continue;
            const key = meta.name.toLowerCase();
            if (byName.has(key)) continue; // higher-priority dir already provided it
            byName.set(key, meta);
            if (byName.size >= MAX_SKILLS) return Array.from(byName.values());
        }
    }
    return Array.from(byName.values());
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
        proc.on('close', (code) => resolve({ ok: code === 0, code, output: output.trim() }));
    });
}

module.exports = { discoverSkills, loadSkill, installSkill, skillDirs, parseFrontmatter, stripFrontmatter };
