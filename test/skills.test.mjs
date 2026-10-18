// Offline checks for the skills catalog: which directories lib/skills.js reads and in what order (Cursor's
// included), what discovery makes of them (names, descriptions, the cap, the cache, the deny-list), the two-stage
// routing of a large catalog and the skill refs of a turn (lib/runtime.js), and the tools list_skills / use_skill
// (lib/agents.js). The `skills` catalog of the Agent Server is checked in server.test.mjs.
// Nothing touches the network or the real HOME.
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// isolate HOME (keys.json, config, every skills directory under it) before anything resolves it
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-skills-home-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
delete process.env.AICODE_NO_CURSOR_IMPORT;
const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `aicode-skills-${label}-`));

const Code2Prompt = require('../lib/engine');
const models = require('../lib/models');
const agents = require('../lib/agents');
const config = require('../lib/config');
const skills = require('../lib/skills');
const { createRuntime } = require('../lib/runtime');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '}${name}`); if (!cond) failures++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const names = (list) => list.map((s) => s.name);
const sorted = (list) => [...list].sort();
const byName = (list, name) => list.find((s) => s.name === name);

// --- the skill directories, as a layout under a project and under HOME -------------------------------------
const rootsOf = (cwd) => ({
    cursorProject: path.join(cwd, '.cursor', 'skills'),
    project: path.join(cwd, '.agents', 'skills'),
    claudeProject: path.join(cwd, '.claude', 'skills'),
    cursorUser: path.join(TMP_HOME, '.cursor', 'skills'),
    global: path.join(TMP_HOME, '.agents', 'skills'),
    configGlobal: path.join(TMP_HOME, '.config', 'agents', 'skills'),
    claudeGlobal: path.join(TMP_HOME, '.claude', 'skills'),
    cursorBuiltin: path.join(TMP_HOME, '.cursor', 'skills-cursor'),
});
const ORIGINS = ['cursorProject', 'project', 'claudeProject', 'cursorUser', 'global', 'configGlobal', 'claudeGlobal', 'cursorBuiltin'];
const ORIGIN_NAME = {
    cursorProject: 'cursor-project', project: 'project', claudeProject: 'project', cursorUser: 'cursor-user',
    global: 'global', configGlobal: 'global', claudeGlobal: 'global', cursorBuiltin: 'cursor-builtin',
};

// <root>/<dirName>/SKILL.md, from a name and a description or from the raw text
function put(root, dirName, { name = dirName, description = `Does ${dirName}`, raw = null, body = `Steps of ${dirName}.\n` } = {}) {
    const dir = path.join(root, dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), raw !== null ? raw : `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
    return dir;
}

// every directory under HOME that holds skills or settings, and what was cached about them, forgotten
function resetHome() {
    for (const dir of ['.cursor', '.agents', '.config', '.claude', '.aicode']) fs.rmSync(path.join(TMP_HOME, dir), { recursive: true, force: true });
    delete process.env.AICODE_NO_CURSOR_IMPORT;
    skills.clearCache();
    config.reloadConfig();
}

// what a tree holds, with sizes and modification times: to show that discovery changes nothing
function snapshot(dir) {
    const out = [];
    const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            const stat = fs.lstatSync(full);
            out.push(`${path.relative(dir, full)}|${entry.isDirectory() ? 'dir' : stat.size}|${stat.mtimeMs}`);
            if (entry.isDirectory()) walk(full);
        }
    };
    walk(dir);
    return out.sort();
}

// =============================================================================
// [A] the directories
// =============================================================================
console.log('\n[A] directories');
{
    resetHome();
    const cwd = tempDir('dirs');
    const where = (e) => `${path.relative(e.dir.startsWith(cwd) ? cwd : TMP_HOME, e.dir)}|${e.origin}`;
    ok('eight directories: the project\'s before the user\'s, Cursor\'s each next to the generic one it mirrors', same(skills.skillDirs(cwd).map(where), [
        '.cursor/skills|cursor-project', '.agents/skills|project', '.claude/skills|project',
        '.cursor/skills|cursor-user', '.agents/skills|global', '.config/agents/skills|global', '.claude/skills|global', '.cursor/skills-cursor|cursor-builtin',
    ]));

    process.env.AICODE_NO_CURSOR_IMPORT = '1';
    ok('AICODE_NO_CURSOR_IMPORT leaves Cursor\'s user and built-in directories alone, not the repository\'s own', same(skills.skillDirs(cwd).map((e) => e.origin), ['cursor-project', 'project', 'project', 'global', 'global', 'global']));
    const lengthWith = (value) => { process.env.AICODE_NO_CURSOR_IMPORT = value; return skills.skillDirs(cwd).length; };
    ok('...switched on by 1, true, yes, on, in any case, with spaces around', ['1', 'true', 'TRUE', 'Yes', 'ON', ' 1 '].every((v) => lengthWith(v) === 6));
    ok('...and not by 0, no, off, false, an empty value or anything else (not even a word that contains one of those)', ['0', 'no', 'off', 'false', '', ' ', 'maybe', '2', '10', 'yesterday', 'once', 'untrue', 'online'].every((v) => lengthWith(v) === 8));
    delete process.env.AICODE_NO_CURSOR_IMPORT;
    ok('...unset it reads everything', skills.skillDirs(cwd).length === 8);

    process.env.AICODE_NO_CURSOR_IMPORT = '1';
    ok('...when the project is the home directory its .cursor is Cursor\'s, so nothing of it is read', same(skills.skillDirs(TMP_HOME).map((e) => e.origin), ['project', 'project', 'global', 'global', 'global']));
    ok('...a folder inside home is a project like any other', skills.skillDirs(path.join(TMP_HOME, 'work')).length === 6 && skills.skillDirs(path.join(TMP_HOME, 'work'))[0].origin === 'cursor-project');
    ok('...home is home however it is written (a trailing separator)', skills.skillDirs(`${TMP_HOME}${path.sep}`).length === 5);
    delete process.env.AICODE_NO_CURSOR_IMPORT;
    ok('config.cursorImportDisabled reads the environment it is given', config.cursorImportDisabled({ AICODE_NO_CURSOR_IMPORT: '1' }) === true && config.cursorImportDisabled({}) === false && config.cursorImportDisabled({ AICODE_NO_CURSOR_IMPORT: '0' }) === false);
}

// =============================================================================
// [B] discovery: precedence, names, layouts, descriptions, the cap
// =============================================================================
console.log('\n[B] discovery');
{
    resetHome();
    const cwd = tempDir('discover');
    const L = rootsOf(cwd);
    for (const key of ORIGINS) {
        put(L[key], 'dup', { description: `dup from ${key}` });
        put(L[key], `only-${key}`, { description: `only in ${key}` });
    }
    const before = { home: snapshot(TMP_HOME), project: snapshot(cwd) };
    let list = skills.discoverSkills(cwd, { fresh: true });
    ok('every directory is read: eight skills of their own and one name they all have', list.length === 9 && ORIGINS.every((key) => list.some((s) => s.name === `only-${key}`)));
    ok('each skill says where it comes from', ORIGINS.every((key) => byName(list, `only-${key}`).origin === ORIGIN_NAME[key]));
    ok('...and keeps its directory and SKILL.md', byName(list, 'only-global').dir === path.join(L.global, 'only-global') && byName(list, 'only-global').file === path.join(L.global, 'only-global', 'SKILL.md'));
    ok('a name found in several directories is listed once, from the first', list.filter((s) => s.name === 'dup').length === 1 && byName(list, 'dup').description === 'dup from cursorProject' && byName(list, 'dup').origin === 'cursor-project');
    ok('the list follows the order of the directories', same(names(list), ['dup', 'only-cursorProject', 'only-project', 'only-claudeProject', 'only-cursorUser', 'only-global', 'only-configGlobal', 'only-claudeGlobal', 'only-cursorBuiltin']));
    ok('discovery only reads: nothing under HOME or the project changed', same(snapshot(TMP_HOME), before.home) && same(snapshot(cwd), before.project));

    const winners = [];
    for (const key of ORIGINS) {
        winners.push(byName(skills.discoverSkills(cwd, { fresh: true }), 'dup').description);
        fs.rmSync(path.join(L[key], 'dup'), { recursive: true });
    }
    ok('when the first one goes the name belongs to the next directory, in the ranked order', same(winners, ORIGINS.map((key) => `dup from ${key}`)));
    ok('...and when none is left it is gone', byName(skills.discoverSkills(cwd, { fresh: true }), 'dup') === undefined);

    resetHome();
    const cwd2 = tempDir('names');
    const L2 = rootsOf(cwd2);
    put(L2.project, 'x1', { name: 'Review-Code', description: 'upper case wins' });
    put(L2.global, 'x2', { name: 'review-code', description: 'lower case loses' });
    list = skills.discoverSkills(cwd2, { fresh: true });
    ok('names are compared without case: the first spelling stays', list.length === 1 && list[0].name === 'Review-Code' && list[0].description === 'upper case wins');

    resetHome();
    const cwd4 = tempDir('layouts');
    const G = rootsOf(cwd4).global;
    put(G, 'plain-dir', { raw: '---\ndescription: no name in the frontmatter\n---\nbody\n' });
    put(G, 'quoted-dir', { name: '"Quoted Name"', description: 'a quoted name' });
    put(G, 'folder-name', { name: 'name-in-file', description: 'the name in the file wins over the folder' });
    put(G, 'crlf', { raw: '---\r\nname: crlf-skill\r\ndescription: Windows line endings\r\n---\r\nBody\r\n' });
    put(G, 'with-colon', { description: 'Use when: the user asks for it' });
    put(path.join(G, 'catalog'), 'deep-skill', { description: 'one level down' });
    put(path.join(G, 'a', 'b'), 'too-deep', { description: 'two levels down' });
    put(G, 'shadow', { description: 'the shallow one' });
    put(path.join(G, 'shadow'), 'nested', { description: 'shadowed by the shallow one' });
    fs.mkdirSync(path.join(G, 'empty-dir'), { recursive: true });
    fs.mkdirSync(path.join(G, 'broken', 'SKILL.md'), { recursive: true });
    fs.writeFileSync(path.join(G, 'README.md'), '# not a skill\n');
    const linked = tempDir('linked');
    put(linked, 'linked-target', { description: 'reached through a symlink' });
    fs.symlinkSync(path.join(linked, 'linked-target'), path.join(G, 'link'));
    put(linked, 'nested-target', { description: 'reached through a symlink inside a catalog folder' });
    fs.symlinkSync(path.join(linked, 'nested-target'), path.join(G, 'catalog', 'nested-link'));
    list = skills.discoverSkills(cwd4, { fresh: true });
    ok('a name comes from the frontmatter, else from the folder, quotes and CRLF handled', same(sorted(names(list)), sorted(['plain-dir', 'Quoted Name', 'name-in-file', 'crlf-skill', 'with-colon', 'deep-skill', 'shadow', 'linked-target', 'nested-target'])));
    ok('...a catalog layout one level down is read, two levels down is not', byName(list, 'deep-skill') && !byName(list, 'too-deep'));
    ok('...a SKILL.md next to its folder shadows what is nested below it', byName(list, 'shadow').description === 'the shallow one' && !byName(list, 'nested'));
    ok('...a folder without SKILL.md, a SKILL.md that cannot be read and a loose file are skipped', !byName(list, 'empty-dir') && !byName(list, 'broken') && !byName(list, 'README.md'));
    ok('...a symlinked skill folder is followed, in a catalog folder too', byName(list, 'linked-target').description === 'reached through a symlink' && byName(list, 'nested-target').description === 'reached through a symlink inside a catalog folder');
    ok('...a colon inside a description stays in it', byName(list, 'with-colon').description === 'Use when: the user asks for it' && byName(list, 'crlf-skill').description === 'Windows line endings');

    fs.rmSync(G, { recursive: true, force: true });
    put(G, 'long-desc', { description: 'L'.repeat(400) });
    put(G, 'folded', { raw: '---\nname: folded\ndescription: >-\n  first part\n  second part\n---\nbody\n' });
    put(G, 'no-frontmatter', { raw: '# Title\n\nThe first paragraph of the text,\nover two lines.\n\nSecond paragraph.\n' });
    put(G, 'bullets-first', { raw: '# T\n\n- a bullet\n- another\n\n```\ncode\n```\n\nThe real paragraph.\n' });
    put(G, 'headings-only', { raw: '# Only a heading\n## Another one\n' });
    put(G, 'empty-file', { raw: '' });
    put(G, 'blank-desc', { raw: '---\nname: blank-desc\ndescription:\n---\n\nThe body starts here.\nMore of it.\n' });
    put(G, 'fence-only', { raw: '```\nnot a description\n```\n' });
    put(G, 'tilde-fence', { raw: '~~~\ncode here\n~~~\n\nAfter the fence.\n' });
    put(G, 'then-fence', { raw: 'Intro text\n```\ncode\n```\nmore text\n' });
    put(G, 'then-heading', { raw: 'First line\n# A heading\nSecond line\n' });
    put(G, 'then-bullet', { raw: 'First line\n- a bullet\nSecond line\n' });
    put(G, 'then-number', { raw: '1. numbered item\n2. another\n\nAfter the list.\n' });
    put(G, 'then-rule', { raw: 'Above the rule\n---\nBelow the rule\n' });
    put(G, 'cut-at-space', { description: `${'a'.repeat(298)} ${'b'.repeat(100)}` });
    list = skills.discoverSkills(cwd4, { fresh: true });
    ok('a description is cut to 300 characters, ending in an ellipsis', byName(list, 'long-desc').description === `${'L'.repeat(299)}…` && skills.MAX_DESC === 300);
    ok('...a folded block scalar is joined into one line', byName(list, 'folded').description === 'first part second part');
    ok('...without one the first paragraph of the text stands in (not a heading, bullet or code fence)', byName(list, 'no-frontmatter').description === 'The first paragraph of the text, over two lines.' && byName(list, 'bullets-first').description === 'The real paragraph.');
    ok('...also when the frontmatter has the key but no value', byName(list, 'blank-desc').description === 'The body starts here. More of it.');
    ok('...and a skill with nothing to describe it is still listed, by its folder name', byName(list, 'headings-only').description === '' && byName(list, 'empty-file').description === '' && byName(list, 'fence-only').description === '');
    ok('...a tilde fence is skipped like a backtick one, and the text after the fence is the paragraph', byName(list, 'tilde-fence').description === 'After the fence.');
    ok('...the paragraph ends where a code fence, a heading, a list item or a rule begins', byName(list, 'then-fence').description === 'Intro text' && byName(list, 'then-heading').description === 'First line' && byName(list, 'then-bullet').description === 'First line' && byName(list, 'then-rule').description === 'Above the rule');
    ok('...a numbered list is not a paragraph', byName(list, 'then-number').description === 'After the list.');
    ok('...the cut of a long description never leaves a space before the ellipsis', byName(list, 'cut-at-space').description === `${'a'.repeat(298)}…`);

    resetHome();
    const cwd3 = tempDir('cap');
    const L3 = rootsOf(cwd3);
    const pad = (i) => String(i).padStart(3, '0');
    for (let i = 0; i < 120; i++) put(L3.cursorProject, `a${pad(i)}`);
    for (let i = 0; i < 90; i++) put(L3.cursorUser, `b${pad(i)}`);
    list = skills.discoverSkills(cwd3, { fresh: true });
    ok('no more than 200 skills', skills.MAX_SKILLS === 200 && list.length === 200);
    ok('...the first directories keep their place: all 120 of the first, then the first 80 of the next by name', list.filter((s) => s.origin === 'cursor-project').length === 120 && list.filter((s) => s.origin === 'cursor-user').length === 80 && list[199].name === 'b079');
    list[0].name = 'CHANGED';
    list.pop();
    ok('whoever changes the answer does not change what the next call gets', skills.discoverSkills(cwd3)[0].name === 'a000' && skills.discoverSkills(cwd3).length === 200);
    ok('a project that does not exist has no skills of its own and does not throw', same(skills.discoverSkills(path.join(cwd3, 'nope', 'nowhere'), { fresh: true }).filter((s) => s.origin.startsWith('project')), []));
    ok('...nor does a "project" that is not even a path', same(skills.discoverSkills(42), []) && same(skills.discoverSkills(null), []) && same(skills.discoverSkills({}), []));

    // what a scan keeps must not depend on the order the file system lists a folder in (here: the reverse)
    const keptNames = names(skills.discoverSkills(cwd3, { fresh: true }));
    const realReaddir = fs.readdirSync;
    const reversedListing = () => { fs.readdirSync = function (...args) { const out = realReaddir.apply(this, args); return Array.isArray(out) ? out.slice().reverse() : out; }; };
    reversedListing();
    try {
        const reversed = names(skills.discoverSkills(cwd3, { fresh: true }));
        ok('the 200 skills that are kept are the same ones whatever order the file system lists the folders in', reversed.length === 200 && same(reversed, keptNames));
    } finally { fs.readdirSync = realReaddir; }
    resetHome();
    const cwd5 = tempDir('order');
    const G5 = rootsOf(cwd5).global;
    for (const name of ['m1', 'a1', 'z1']) put(G5, name);
    for (const name of ['zeta', 'alpha', 'mid']) put(path.join(G5, 'catalog'), name);
    reversedListing();
    try {
        ok('...and so are folders and catalog folders: read by name', same(names(skills.discoverSkills(cwd5, { fresh: true })), ['a1', 'alpha', 'mid', 'zeta', 'm1', 'z1']));
    } finally { fs.readdirSync = realReaddir; }
}

// =============================================================================
// [C] the cache
// =============================================================================
console.log('\n[C] cache');
{
    resetHome();
    const cwd = tempDir('cache');
    const L = rootsOf(cwd);
    put(L.project, 'first');
    ok('a scan finds what is there', same(names(skills.discoverSkills(cwd)), ['first']));
    put(L.project, 'second');
    ok('a skill added afterwards is not seen at once: the scan is kept', same(names(skills.discoverSkills(cwd)), ['first']));
    ok('{ fresh: true } scans again', same(names(skills.discoverSkills(cwd, { fresh: true })), ['first', 'second']));
    ok('...and that scan is the one kept', same(names(skills.discoverSkills(cwd)), ['first', 'second']));
    put(L.project, 'third');
    skills.clearCache();
    ok('clearCache forgets every scan', same(names(skills.discoverSkills(cwd)), ['first', 'second', 'third']));

    const realNow = Date.now;
    try {
        const t0 = realNow();
        Date.now = () => t0;
        skills.clearCache();
        ok('the scan is kept for 30 seconds', skills.CACHE_TTL_MS === 30000 && skills.discoverSkills(cwd).length === 3);
        put(L.project, 'fourth');
        Date.now = () => t0 + skills.CACHE_TTL_MS - 1;
        ok('...to the last millisecond', skills.discoverSkills(cwd).length === 3);
        Date.now = () => t0 + skills.CACHE_TTL_MS;
        ok('...then it is scanned again', skills.discoverSkills(cwd).length === 4);
    } finally { Date.now = realNow; }

    const other = tempDir('cache-other');
    put(rootsOf(other).project, 'elsewhere');
    ok('two projects never share a scan', same(names(skills.discoverSkills(other)), ['elsewhere']) && !names(skills.discoverSkills(cwd)).includes('elsewhere'));

    // what a scan depends on is part of what it is kept under: none of it can serve a stale answer
    put(L.global, 'from-home-1');
    put(L.cursorUser, 'cursor-only');
    skills.discoverSkills(cwd, { fresh: true });
    ok('(setup) HOME skills are seen', names(skills.discoverSkills(cwd)).includes('from-home-1') && names(skills.discoverSkills(cwd)).includes('cursor-only'));
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-skills-home2-'));
    put(path.join(home2, '.agents', 'skills'), 'from-home-2');
    process.env.HOME = home2;
    process.env.USERPROFILE = home2;
    try {
        const list = names(skills.discoverSkills(cwd));
        ok('another HOME is another scan, at once', list.includes('from-home-2') && !list.includes('from-home-1'));
    } finally { process.env.HOME = TMP_HOME; process.env.USERPROFILE = TMP_HOME; }
    ok('...and back to the first HOME, the scan it had', names(skills.discoverSkills(cwd)).includes('from-home-1') && !names(skills.discoverSkills(cwd)).includes('from-home-2'));
    process.env.AICODE_NO_CURSOR_IMPORT = '1';
    ok('AICODE_NO_CURSOR_IMPORT applies at once', !names(skills.discoverSkills(cwd)).includes('cursor-only') && names(skills.discoverSkills(cwd)).includes('from-home-1'));
    delete process.env.AICODE_NO_CURSOR_IMPORT;
    ok('...and so does leaving it', names(skills.discoverSkills(cwd)).includes('cursor-only'));
    config.saveConfig({ skills: { ignore: ['first'] } });
    ok('a change of the deny-list applies at once', !names(skills.discoverSkills(cwd)).includes('first') && names(skills.discoverSkills(cwd)).includes('second'));
    config.saveConfig({ skills: { ignore: [] } });
    ok('...and so does undoing it', names(skills.discoverSkills(cwd)).includes('first'));
    fs.rmSync(home2, { recursive: true, force: true });
}

// installing a skill refreshes the list at once (`npx skills add` is faked: a script called npx that
// prints its arguments and exits with the code asked for)
console.log('\n[C2] installing');
{
    resetHome();
    const bin = tempDir('fake-npx');
    const writeNpx = (code) => fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/sh\necho "npx $@"\nexit ${code}\n`, { mode: 0o755 });
    const realPath = process.env.PATH;
    const cwd = tempDir('install');
    const L = rootsOf(cwd);
    put(L.project, 'before');
    skills.discoverSkills(cwd);
    put(L.project, 'after');
    try {
        process.env.PATH = `${bin}${path.delimiter}${realPath}`;
        writeNpx(1);
        const failed = await skills.installSkill('owner/repo');
        ok('an install that fails: not ok, with its code and output, and the list is as it was', failed.ok === false && failed.code === 1 && failed.output === 'npx -y skills add owner/repo -y -a universal' && same(names(skills.discoverSkills(cwd)), ['before']));
        writeNpx(0);
        const done = await skills.installSkill('owner/repo', { global: true });
        ok('one that works: ok, globally with -g, and the new skill is in the list at once', done.ok === true && done.code === 0 && done.output === 'npx -y skills add owner/repo -y -a universal -g' && same(names(skills.discoverSkills(cwd)), ['after', 'before']));
        const streamed = [];
        const again = await skills.installSkill('a/b', { onOutput: (text) => streamed.push(text.trim()) });
        ok('...the output is handed over as it comes', again.ok === true && streamed.join('|') === 'npx -y skills add a/b -y -a universal');
        const empty = tempDir('no-npx');
        process.env.PATH = empty;
        const missing = await skills.installSkill('owner/repo');
        ok('with no npx at all: not ok, code -1, and no throw', missing.ok === false && missing.code === -1 && typeof missing.output === 'string' && missing.output.length > 0);
    } finally { process.env.PATH = realPath; }
}

// =============================================================================
// [D] the deny-list
// =============================================================================
console.log('\n[D] deny-list');
{
    resetHome();
    const cwd = tempDir('deny');
    const L = rootsOf(cwd);
    const DEFAULT_IGNORED = ['canvas', 'automate', 'loop', 'new-repo', 'origin', 'share', 'statusline', 'update-cursor-settings', 'review-bugbot', 'review-security'];
    for (const name of DEFAULT_IGNORED) put(L.cursorBuiltin, name);
    put(L.cursorBuiltin, 'keep-me');
    ok('by default the ten skills that drive Cursor itself are on it', same(sorted(skills.DEFAULT_IGNORED_SKILLS), sorted(DEFAULT_IGNORED)) && same(sorted(skills.ignoredSkills()), sorted(DEFAULT_IGNORED)));
    ok('...and discovery leaves them out', same(names(skills.discoverSkills(cwd, { fresh: true })), ['keep-me']));
    put(L.project, 'loop');
    skills.clearCache();
    ok('...by name, wherever the skill lives', same(names(skills.discoverSkills(cwd)), ['keep-me']));
    ok('isIgnored ignores case and spaces, and is false for no name', skills.isIgnored('Canvas') && skills.isIgnored(' LOOP ') && !skills.isIgnored('keep-me') && !skills.isIgnored('') && !skills.isIgnored(null) && !skills.isIgnored(undefined));

    config.saveConfig({ skills: { ignore: ['  Keep-Me ', '  ', 7] } });
    ok('config.skills.ignore adds to it, in any case', same(names(skills.discoverSkills(cwd)), []) && skills.isIgnored('keep-me') && skills.isIgnored('7') && !skills.isIgnored(''));
    config.saveConfig({ skills: { ignore: ['keep-me'], allow: ['CANVAS', 'keep-me', ' '] } });
    ok('config.skills.allow lifts a default one, and beats config.skills.ignore', same(sorted(names(skills.discoverSkills(cwd))), ['canvas', 'keep-me']) && !skills.isIgnored('canvas') && skills.isIgnored('loop'));
    config.saveConfig({ skills: { ignore: 'loop', allow: { a: 1 } } });
    ok('a setting that is not a list means nothing', same(sorted(skills.ignoredSkills()), sorted(DEFAULT_IGNORED)));
    config.saveConfig({ skills: { ignore: [], allow: [] } });

    resetHome();
    const cwd2 = tempDir('deny-cap');
    const R = rootsOf(cwd2).cursorProject;
    put(R, 'automate');
    put(R, 'canvas');
    for (let i = 0; i < 202; i++) put(R, `z${String(i).padStart(3, '0')}`);
    const list = skills.discoverSkills(cwd2, { fresh: true });
    ok('what is on the deny-list does not count against the 200', list.length === 200 && list[0].name === 'z000' && list[199].name === 'z199');
}

// =============================================================================
// [E] routing helpers: the compact catalog and the names a model hands back
// =============================================================================
console.log('\n[E] routing helpers');
{
    const sample = [
        { name: 'alpha', description: 'a'.repeat(150) },
        { name: 'beta', description: '  two\n  lines \t here  ' },
        { name: 'gamma', description: '' },
        { name: 'delta' },
        { name: 'eps', description: `${'w'.repeat(99)} tail` },
    ];
    ok('above 12 skills the router picks candidates first; five at most; 100 characters of each description', skills.STAGE_ONE_MIN === 12 && skills.MAX_CANDIDATES === 5 && skills.COMPACT_DESC === 100);
    ok('compactCatalog: a line per skill, `- name: ` and the first 100 characters on one line', skills.compactCatalog(sample) === ['- alpha: ' + 'a'.repeat(100), '- beta: two lines here', '- gamma', '- delta', '- eps: ' + 'w'.repeat(99)].join('\n'));
    ok('...an empty catalog is empty text', skills.compactCatalog([]) === '');
    ok('the instruction asks for up to five exact names, or an empty list', skills.STAGE_ONE_INSTRUCTION === 'Pick up to 5 installed skills that could fulfill this request better than a generic coding assistant; return exact names only, or an empty list.');
    ok('stageOnePrompt: the request, the compact catalog, then the instruction', skills.stageOnePrompt('make a QR code', sample) === `# Request\nmake a QR code\n\n# Installed skills\n${skills.compactCatalog(sample)}\n\n${skills.STAGE_ONE_INSTRUCTION}`);

    const eight = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((name) => ({ name, description: name }));
    const pick = (raw, max) => skills.resolveCandidates(eight, raw, max).map((s) => s.name).join();
    ok('resolveCandidates: exact names, in the order given, in any case', pick(['c', 'a']) === 'c,a' && pick(['C', 'A']) === 'c,a');
    ok('...a name a model dresses up (a dash, "skill:", quotes, backticks) still counts', pick(['- b', 'skill: c', '"d"', '`e`', '\'a\'']) === 'b,c,d,e,a');
    ok('...each way of dressing it up on its own: a dash, a star, "skill:" in any case, each kind of quote, a colon', [['- b', 'b'], ['* b', 'b'], ['skill: c', 'c'], ['Skill:c', 'c'], ['"d"', 'd'], ['\'d\'', 'd'], ['`d`', 'd'], ['b:', 'b'], ['  - "b"  ', 'b']].every(([raw, expected]) => pick([raw]) === expected));
    ok('...a name that merely contains what the model said is not that skill', same(skills.resolveCandidates([{ name: 'review-code' }], ['review']), []) && same(skills.resolveCandidates([{ name: 'review-code' }], ['review-code-x']), []));
    ok('...invented names and repeats are dropped', pick(['zz', 'a', 'a', 'A', 'nope', 'b']) === 'a,b');
    ok('...five at most, the first five', pick(['a', 'b', 'c', 'd', 'e', 'f', 'g']) === 'a,b,c,d,e');
    ok('...another limit', pick(['a', 'b', 'c'], 2) === 'a,b' && pick(['a', 'b'], 0) === '' && pick(['a', 'b', 'c'], 8) === 'a,b,c');
    ok('...anything that is not a list gives none', same(skills.resolveCandidates(eight, 'a'), []) && same(skills.resolveCandidates(eight, null), []) && same(skills.resolveCandidates(eight, undefined), []) && same(skills.resolveCandidates(eight, { 0: 'a' }), []));
    ok('...and an item that is not a name is skipped', pick([5, null, undefined, '', '  ', {}, [], 'b']) === 'b');
    ok('...what it returns are the entries of the list, not copies', skills.resolveCandidates(eight, ['b'])[0] === eight[1]);
    ok('findSkill: the exact name, any case, spaces around ignored', skills.findSkill(eight, ' C ') === eight[2] && skills.findSkill(eight, 'c') === eight[2]);
    ok('...never a part of a name, never an empty one, never one that is not there', skills.findSkill([{ name: 'review-code' }], 'review') === undefined && skills.findSkill(eight, '') === undefined && skills.findSkill(eight, '  ') === undefined && skills.findSkill(eight, null) === undefined && skills.findSkill(eight, 'zz') === undefined && skills.findSkill([], 'a') === undefined);
}

// =============================================================================
// [F] the tools list_skills and use_skill
// =============================================================================
console.log('\n[F] list_skills and use_skill');
{
    resetHome();
    const defs = await agents.loadAgents();
    const stubUI = { step: () => ({ done() { }, fail() { }, update() { } }), streamChunk() { }, streamEnd() { }, statusStop() { }, status() { }, isStreaming: () => false };
    const toolsFor = (dir) => agents.buildTools({
        engine: new Code2Prompt({ template: path.join(ROOT, 'actions', 'default.md'), OPENAI_KEY: 'test' }),
        ctx: { userDirectory: dir, language: 'English', personality: 'friendly-and-concise', readFile: async () => '' },
        ui: stubUI, agents: defs, depth: 0, cwd: dir, mode: 'agent',
    }, defs.main.tools);
    const run = (tool, input) => tool.execute(input, { toolCallId: 'x', messages: [] });

    const dir = tempDir('tools');
    const L = rootsOf(dir);
    let tools = toolsFor(dir);
    ok('list_skills with none installed says so', await run(tools.list_skills, {}) === 'no skills installed');
    ok('...and use_skill says there is nothing to choose from', (await run(tools.use_skill, { name: 'x' })).error === 'skill \'x\' not found. Available: (none)');
    put(L.project, 'pdf-tool', { description: 'Read and merge PDF files' });
    put(L.cursorUser, 'deploy', { description: 'Ship it to staging' });
    put(L.global, 'zebra', { description: 'Stripes' });
    skills.clearCache();
    const PDF = 'pdf-tool (project): Read and merge PDF files';
    const DEPLOY = 'deploy (cursor-user): Ship it to staging';
    const ZEBRA = 'zebra (global): Stripes';
    ok('list_skills: a line per skill, `name (origin): description`, in the order of the directories', await run(tools.list_skills, {}) === [PDF, DEPLOY, ZEBRA].join('\n'));
    ok('...a query keeps those with every one of its words in the name or description, any case', await run(tools.list_skills, { query: 'pdf merge' }) === PDF && await run(tools.list_skills, { query: 'STAGING' }) === DEPLOY && await run(tools.list_skills, { query: 'zeb' }) === ZEBRA);
    ok('...a capital letter in the name or description does not matter either way', await run(tools.list_skills, { query: 'ship STAG' }) === DEPLOY && await run(tools.list_skills, { query: 'READ' }) === PDF);
    ok('...a blank query is no query', await run(tools.list_skills, { query: '   ' }) === [PDF, DEPLOY, ZEBRA].join('\n') && await run(tools.list_skills, { query: '' }) === [PDF, DEPLOY, ZEBRA].join('\n'));
    ok('...a query nothing answers says so, with how many are installed', await run(tools.list_skills, { query: ' nothing  here ' }) === 'no skill matches "nothing  here" (3 installed)');

    const files = put(L.project, 'with-files', { description: 'has bundled files', body: 'Do the thing.\n' });
    fs.mkdirSync(path.join(files, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(files, 'scripts', 'run.sh'), '#!/bin/sh\n');
    skills.clearCache();
    let result = await run(tools.use_skill, { name: 'WITH-FILES' });
    ok('use_skill: the name, where it is from, its folder, the bundled files and the instructions without the frontmatter', result.name === 'with-files' && result.origin === 'project' && result.dir === files && same(result.files, ['scripts/run.sh']) && result.instructions === 'Do the thing.\n');
    result = await run(tools.use_skill, { name: 'ith-fil' });
    ok('...a part of a name finds it too, when no skill has exactly that name', result.name === 'with-files');
    ok('...spaces around the name do not matter', (await run(tools.use_skill, { name: '  With-Files ' })).name === 'with-files');
    put(L.project, 'ith-fil', { description: 'a skill whose name is that part' });
    put(L.project, 'a-ith-fil-too', { description: 'listed before it, and contains its name' });
    skills.clearCache();
    ok('...an exact name wins over a name that merely contains it, even one listed earlier', (await run(tools.use_skill, { name: 'ith-fil' })).name === 'ith-fil');
    result = await run(tools.use_skill, { name: 'nope' });
    ok('an unknown name lists the installed ones, in the order of the directories', result.error === 'skill \'nope\' not found. Available: a-ith-fil-too, ith-fil, pdf-tool, with-files, deploy, zebra');
    result = await run(tools.use_skill, { name: '' });
    ok('...no name is not "a part of every name": nothing is loaded', typeof result.error === 'string' && result.error.startsWith('skill \'\' not found') && !('instructions' in result));
    ok('...nor is a name of blanks, or no name at all', typeof (await run(tools.use_skill, { name: '   ' })).error === 'string' && typeof (await run(tools.use_skill, { name: undefined })).error === 'string');

    put(L.cursorBuiltin, 'canvas', { description: 'Cursor canvas', body: 'CANVAS_BODY\n' });
    skills.clearCache();
    result = await run(tools.use_skill, { name: 'canvas' });
    ok('a skill on the deny-list is not found, and the error says why', typeof result.error === 'string' && result.error.includes('(it is on the list of skills that need Cursor; config.skills.allow lifts that)'));
    ok('...and list_skills does not show it', !(await run(tools.list_skills, { query: 'canvas' })).includes('canvas (') && (await run(tools.list_skills, { query: 'canvas' })).startsWith('no skill matches'));
    config.saveConfig({ skills: { allow: ['canvas'] } });
    result = await run(tools.use_skill, { name: 'canvas' });
    ok('...config.skills.allow brings it back', result.name === 'canvas' && result.origin === 'cursor-builtin' && result.instructions === 'CANVAS_BODY\n');
    config.saveConfig({ skills: { allow: [] } });

    // a long catalog: the list is cut, and says how to get the rest
    resetHome();
    const many = tempDir('tools-many');
    const M = rootsOf(many).project;
    const num = (i) => String(i).padStart(2, '0');
    for (let i = 0; i < 61; i++) put(M, `many-${num(i)}`, { description: `Many skill ${num(i)}` });
    tools = toolsFor(many);
    let lines = (await run(tools.list_skills, {})).split('\n');
    ok('list_skills lists 60 and says how many more there are', lines.length === 61 && lines[0] === 'many-00 (project): Many skill 00' && lines[59] === 'many-59 (project): Many skill 59' && lines[60] === '… 1 more of 61: pass a query to narrow the list');
    fs.rmSync(path.join(M, 'many-60'), { recursive: true });
    skills.clearCache();
    lines = (await run(tools.list_skills, {})).split('\n');
    ok('...exactly 60 is listed whole', lines.length === 60 && lines[59] === 'many-59 (project): Many skill 59');
    for (let i = 60; i < 75; i++) put(M, `many-${num(i)}`, { description: `Many skill ${num(i)}` });
    skills.clearCache();
    lines = (await run(tools.list_skills, {})).split('\n');
    ok('...a longer catalog says how many it keeps back', lines.length === 61 && lines[60] === '… 15 more of 75: pass a query to narrow the list');
    lines = (await run(tools.list_skills, { query: 'many-6' })).split('\n');
    ok('...a query brings the rest into view', lines.length === 10 && lines[0] === 'many-60 (project): Many skill 60' && lines[9] === 'many-69 (project): Many skill 69');
    result = await run(tools.use_skill, { name: 'zzz' });
    ok('an unknown name with a long catalog lists the first 60 and the number left out', result.error.includes('many-59, … (15 more: list_skills with a query)') && !result.error.includes('many-60'));
}

// =============================================================================
// [G] a turn: the two-stage routing and the skill refs
// =============================================================================
console.log('\n[G] routing a turn');
{
    resetHome();
    // --- provider plumbing -> mock model
    let MOCK = null;
    let lastTier = null;
    models.resolveProvider = (prefs) => (prefs && prefs.length ? prefs[0] : null);
    models.createModel = (provider, tier) => { lastTier = tier; return MOCK; };
    models.callOptions = () => ({});
    models.modelId = () => 'mock-model';
    models.estimateCost = () => 0;
    models.estimateTokens = () => 10;

    const STOP = { unified: 'stop', raw: 'stop' };
    const USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
    const ANALYSIS = {
        type_of: 'question', english: 'say hello', language: 'English', action_file: '', action_reason: 'n/a',
        personality_file: '', personality_reason: 'n/a', needs_agent: false, skill_name: '',
    };
    const start = [{ type: 'stream-start', warnings: [] }, { type: 'response-metadata', id: 'r', modelId: 'mock' }];
    const say = (text) => [...start, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: STOP, usage: USAGE }];
    const userText = (prompt) => prompt.filter((m) => m.role === 'user').map((m) => m.content.map((p) => p.text || '').join('')).join('\n');
    const systemOf = (prompt) => prompt.filter((m) => m.role === 'system').map((m) => m.content).join('\n');

    // `stageOne(prompt)` is what the pre-selection call answers: a list of names, or an Error to throw
    function makeMock({ analysis = {}, stageOne = () => [] } = {}) {
        const counts = { router: 0, template: 0, stream: 0, skillRoute: 0 };
        const routerPrompts = [];
        const skillPrompts = [];
        const calls = [];
        const prompts = [];
        const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify({ schema: value }) }], finishReason: STOP, usage: USAGE, warnings: [] });
        const model = new MockLanguageModelV3({
            doGenerate: async (options) => {
                const text = userText(options.prompt);
                if (text.includes(skills.STAGE_ONE_INSTRUCTION)) {
                    counts.skillRoute++;
                    skillPrompts.push(text);
                    calls.push({ kind: 'skills', tier: lastTier });
                    const picked = stageOne(text);
                    if (picked instanceof Error) throw picked;
                    return json({ candidates: picked });
                }
                if (text.includes('Analyze the following user input text')) {
                    counts.router++;
                    routerPrompts.push(text);
                    calls.push({ kind: 'router', tier: lastTier });
                    return json({ ...ANALYSIS, ...analysis });
                }
                counts.template++;
                calls.push({ kind: 'template', tier: lastTier });
                return json({ answer: 'TEMPLATE_ANSWER' });
            },
            doStream: async (options) => {
                counts.stream++;
                prompts.push(options.prompt);
                return { stream: convertArrayToReadableStream(say('Hello from the mock.')) };
            },
        });
        return { model, counts, routerPrompts, skillPrompts, calls, prompts };
    }

    function makeUI() {
        const events = [];
        return {
            events,
            step: (label) => {
                events.push(['step', label]);
                return { update() { }, done: (extra) => events.push(['step.done', label, extra]), fail: (text) => events.push(['step.fail', label, text]) };
            },
            status: (t) => events.push(['status', t]),
            statusStart() { }, statusStop() { },
            streamChunk() { }, streamEnd() { },
            isStreaming: () => false,
            note: (m, detail, color) => events.push(['note', String(m), color]),
            error: (e) => events.push(['error', String((e && e.message) || e)]),
            debug() { },
            footer: (s) => events.push(['footer', s]),
            answer: (t) => events.push(['answer', t]),
            raw: (t) => events.push(['raw', t]),
            renderMarkdown: (t) => t,
            progressShim: () => ({ text() { }, start() { }, stop() { } }),
            confirm: async () => true,
            ask: async () => '',
            select: async () => null,
            diff() { }, fileWritten() { }, planCreated() { },
        };
    }
    const has = (ui, kind, pred = () => true) => ui.events.some((e) => e[0] === kind && pred(e));
    // what the turn told the user besides the answer (the template path hands its answer over as a note)
    const notesOf = (ui) => ui.events.filter((e) => e[0] === 'note' && e[1] !== 'TEMPLATE_ANSWER').map((e) => e[1]);
    // ... and they are all warnings (yellow)
    const allYellow = (ui) => { const notes = ui.events.filter((e) => e[0] === 'note' && e[1] !== 'TEMPLATE_ANSWER'); return notes.length > 0 && notes.every((e) => e[2] === 'yellow'); };
    const analyzed = (ui) => (ui.events.find((e) => e[0] === 'step.done' && e[1] === 'analyzing request') || [])[2] || '';

    // a project with `count` skills, s01 .. sNN: a description longer than 100 characters, ending in a marker that
    // only the full description shows (the compact catalog stops at 100)
    const nn = (n) => String(n).padStart(2, '0');
    function project(count) {
        const cwd = tempDir('turn');
        fs.writeFileSync(path.join(cwd, 'hello.js'), 'console.log("hello");\n');
        for (let i = 1; i <= count; i++) {
            put(path.join(cwd, '.agents', 'skills'), `s${nn(i)}`, { description: `Skill ${nn(i)}: ${'does a thing '.repeat(8)}TAIL${nn(i)}`, body: `Steps of skill ${nn(i)}: do STEP_${nn(i)}.\n` });
        }
        return cwd;
    }
    async function turn({ cwd, input = 'please make me a QR code', analysis = {}, stageOne, opts = {}, flags = {} }) {
        const mock = makeMock({ analysis, stageOne });
        MOCK = mock.model;
        const rt = createRuntime({ cwd, keysData: { OPENAI_KEY: 'k' }, flags: { ...flags } });
        const ui = makeUI();
        const usage = await rt.runPrompt(input, ui, opts);
        return { ui, mock, usage };
    }
    const all = (n) => Array.from({ length: n }, (_, i) => i + 1);
    const offered = (prompt, n) => prompt.includes(`skill:s${nn(n)}\ndescription:\n`);

    // up to twelve skills the router reads them all
    let cwd = project(12);
    let r = await turn({ cwd });
    ok('12 skills: no pre-selection call', r.mock.counts.skillRoute === 0 && r.mock.counts.router === 1);
    ok('...the router is offered all twelve with their full descriptions, and may name one', all(12).every((n) => offered(r.mock.routerPrompts[0], n) && r.mock.routerPrompts[0].includes(`TAIL${nn(n)}`)) && r.mock.routerPrompts[0].includes('# 5. Only if one of the following installed skills'));
    ok('...the turn costs the router and the answer: two calls', r.usage.calls === 2 && same(r.mock.calls.map((c) => c.kind), ['router', 'template']));
    ok('...without a skill chosen the template path runs', r.mock.counts.template === 1 && r.mock.counts.stream === 0 && !analyzed(r.ui).startsWith('skill:'));

    // the deny-list is not part of the count, nor of what is offered
    put(rootsOf(cwd).cursorBuiltin, 'canvas');
    skills.clearCache();
    r = await turn({ cwd });
    ok('a skill on the deny-list is not the thirteenth: still no pre-selection, and it is not offered', r.mock.counts.skillRoute === 0 && !r.mock.routerPrompts[0].includes('skill:canvas'));
    fs.rmSync(path.join(TMP_HOME, '.cursor'), { recursive: true, force: true });
    skills.clearCache();

    // thirteen: the catalog is too long for the router
    cwd = project(13);
    const request = 'please use the third one';
    r = await turn({ cwd, input: request, stageOne: () => ['s03', 's07'] });
    const stage = r.mock.skillPrompts[0];
    ok('13 skills: a pre-selection call comes first, then the router, then the answer', r.mock.counts.skillRoute === 1 && same(r.mock.calls.map((c) => c.kind), ['skills', 'router', 'template']) && r.usage.calls === 3);
    ok('...the pre-selection is a fast-tier call, like the router', r.mock.calls[0].tier === 'fast' && r.mock.calls[1].tier === 'fast');
    ok('...it sees the request, one compact line for each of the 13, and the instruction', stage.startsWith(`# Request\n${request}\n\n# Installed skills\n`) && stage.includes(skills.compactCatalog(skills.discoverSkills(cwd))) && all(13).every((n) => stage.includes(`- s${nn(n)}: Skill ${nn(n)}: does a thing`)) && stage.endsWith(skills.STAGE_ONE_INSTRUCTION));
    ok('...the compact lines stop at 100 characters: the end of a description is not in it', !stage.includes('TAIL'));
    ok('...the router is offered only the two it named, with their full descriptions', offered(r.mock.routerPrompts[0], 3) && offered(r.mock.routerPrompts[0], 7) && r.mock.routerPrompts[0].includes('TAIL03') && r.mock.routerPrompts[0].includes('TAIL07') && all(13).filter((n) => n !== 3 && n !== 7).every((n) => !r.mock.routerPrompts[0].includes(`skill:s${nn(n)}\n`)));
    ok('...the request reaches the pre-selection in full when it is not verbatim', (await turn({ cwd, input: `${'H'.repeat(2000)}${'M'.repeat(7000)}${'T'.repeat(1000)}`, stageOne: () => [] })).mock.skillPrompts[0].includes(`${'H'.repeat(2000)}${'M'.repeat(7000)}${'T'.repeat(1000)}`));

    r = await turn({ cwd, stageOne: () => ['s07'], analysis: { skill_name: 's07' } });
    ok('a candidate the router then picks is the skill followed: the agent loop with its instructions', r.mock.counts.stream === 1 && r.mock.counts.template === 0 && systemOf(r.mock.prompts[0]).includes('STEP_07') && analyzed(r.ui).startsWith('skill:s07'));
    r = await turn({ cwd, stageOne: () => ['s01'], analysis: { skill_name: 's10' } });
    ok('...a skill the pre-selection did not offer is not used even if the router names it', r.mock.counts.stream === 0 && r.mock.counts.template === 1 && !analyzed(r.ui).startsWith('skill:'));
    r = await turn({ cwd, stageOne: () => ['S01', 's01', 'nope', 's02', '- s03', 'skill: s04', 's05', 's06', 's07'] });
    ok('...names that are invented or repeated are dropped, and the router sees five at most', [1, 2, 3, 4, 5].every((n) => offered(r.mock.routerPrompts[0], n)) && !offered(r.mock.routerPrompts[0], 6) && !offered(r.mock.routerPrompts[0], 7) && !r.mock.routerPrompts[0].includes('nope'));
    r = await turn({ cwd, stageOne: () => [] });
    ok('an empty pre-selection: the router is offered no skill and is not asked for one', !r.mock.routerPrompts[0].includes('installed skills') && !r.mock.routerPrompts[0].includes('skill:s') && r.mock.counts.template === 1 && !has(r.ui, 'error'));
    r = await turn({ cwd, stageOne: () => new Error('the pre-selection failed') });
    ok('a pre-selection that fails (whichever provider is tried) costs the skills of the turn, not the turn', r.mock.counts.skillRoute >= 1 && !r.mock.routerPrompts[0].includes('installed skills') && r.mock.counts.template === 1 && !has(r.ui, 'error') && !has(r.ui, 'step.fail') && notesOf(r.ui).length === 0 && r.usage.calls === 2);

    // a verbatim input (a plan to implement) reaches the pre-selection as the same excerpt the router gets
    const long = `${'H'.repeat(2000)}${'M'.repeat(7000)}${'T'.repeat(1000)}`;
    r = await turn({ cwd, input: long, opts: { verbatim: true }, stageOne: () => [] });
    ok('a verbatim input is shown to the pre-selection as an excerpt, like the router', r.mock.skillPrompts[0].includes(`${'H'.repeat(2000)}\n[... 7000 characters omitted ...]\n${'T'.repeat(1000)}`) && !r.mock.skillPrompts[0].includes('MMMMMMMMMM'));

    // skill refs: the user named a skill
    cwd = project(20);
    r = await turn({ cwd, opts: { refs: [{ kind: 'skill', name: 'S05' }] }, analysis: { skill_name: 's09' } });
    ok('a skill ref: no pre-selection even with 20 skills, and the router is offered none', r.mock.counts.skillRoute === 0 && r.mock.counts.router === 1 && !r.mock.routerPrompts[0].includes('installed skills') && !r.mock.routerPrompts[0].includes('skill:s'));
    ok('...the skill is followed (the agent loop with its instructions), whatever the router says', r.mock.counts.stream === 1 && systemOf(r.mock.prompts[0]).includes('STEP_05') && !systemOf(r.mock.prompts[0]).includes('STEP_09') && analyzed(r.ui).startsWith('skill:s05'));
    ok('...nothing is said about it', notesOf(r.ui).length === 0 && !has(r.ui, 'error'));
    r = await turn({ cwd, stageOne: () => ['s02'], opts: { refs: [{ kind: 'skill', name: 'nope' }] } });
    ok('a ref to a skill that does not exist: a note, and the turn is routed as usual', notesOf(r.ui).join('|') === 'skill not found: nope' && allYellow(r.ui) && r.mock.counts.skillRoute === 1 && offered(r.mock.routerPrompts[0], 2));
    r = await turn({ cwd, stageOne: () => [], opts: { refs: [{ kind: 'skill', name: 'nope' }, { kind: 'skill', name: 'S05' }, { kind: 'skill', name: 'NOPE' }] } });
    ok('...one that does is still followed, and the missing one is mentioned once', r.mock.counts.skillRoute === 0 && systemOf(r.mock.prompts[0]).includes('STEP_05') && notesOf(r.ui).join('|') === 'skill not found: nope');
    r = await turn({ cwd, opts: { refs: [{ kind: 'skill', name: ' s05 ' }, { kind: 'skill', name: 's06' }, { kind: 'skill', name: 'zzz' }, { kind: 'skill', name: 'S05' }] } });
    ok('several skills named: the first is followed, and the note names the others that exist', systemOf(r.mock.prompts[0]).includes('STEP_05') && !systemOf(r.mock.prompts[0]).includes('STEP_06') && notesOf(r.ui).join('|') === 'skill not found: zzz|one skill is followed per turn: s05 (not loaded: s06)' && allYellow(r.ui));
    r = await turn({ cwd, stageOne: () => [], opts: { refs: [{ kind: 'skill' }, { kind: 'skill', name: '   ' }, { kind: 'skill', name: 5 }, { kind: 'file', name: 's05' }, { kind: 'rule', name: 's05' }, null, 'skill:s05', 7] } });
    ok('refs that name no skill are ignored: no note, and the turn is routed as usual', notesOf(r.ui).length === 0 && r.mock.counts.skillRoute === 1 && r.mock.counts.stream === 0);
    r = await turn({ cwd, stageOne: () => [], opts: { refs: 'skill:s05' } });
    ok('refs that are not a list are ignored too', notesOf(r.ui).length === 0 && r.mock.counts.skillRoute === 1);

    // a skill on the deny-list can be named once the user allows it
    put(rootsOf(cwd).cursorBuiltin, 'canvas', { body: 'Steps: do CANVAS_STEP.\n' });
    skills.clearCache();
    r = await turn({ cwd, opts: { refs: [{ kind: 'skill', name: 'canvas' }] }, stageOne: () => [] });
    ok('a ref to a skill on the deny-list is not found, and the note says why', notesOf(r.ui).join('|') === 'skill not found: canvas (it is on the list of skills that need Cursor; config.skills.allow lifts that)' && allYellow(r.ui) && r.mock.counts.stream === 0);
    config.saveConfig({ skills: { allow: ['canvas'] } });
    r = await turn({ cwd, opts: { refs: [{ kind: 'skill', name: 'canvas' }] } });
    ok('...with config.skills.allow it is followed', systemOf(r.mock.prompts[0]).includes('CANVAS_STEP') && analyzed(r.ui).startsWith('skill:canvas') && notesOf(r.ui).length === 0);
    config.saveConfig({ skills: { allow: [] } });

    // a skill whose SKILL.md cannot be loaded any more: a note, and the usual routing
    const gone = project(14);
    skills.discoverSkills(gone, { fresh: true });
    fs.rmSync(path.join(gone, '.agents', 'skills', 's05', 'SKILL.md'));
    r = await turn({ cwd: gone, opts: { refs: [{ kind: 'skill', name: 's05' }] } });
    ok('a skill that disappeared since the scan: "could not load", and the turn goes on', notesOf(r.ui).join('|') === 'could not load the skill s05' && allYellow(r.ui) && r.mock.counts.stream === 0 && r.mock.counts.template === 1 && !has(r.ui, 'error'));

    // a short catalog goes to the router as it always did; what the router names is matched to a skill
    cwd = project(3);
    r = await turn({ cwd, analysis: { skill_name: 'S02' } });
    ok('a short catalog needs no pre-selection, and the router\'s pick is matched without case', r.mock.counts.skillRoute === 0 && analyzed(r.ui).startsWith('skill:s02') && systemOf(r.mock.prompts[0]).includes('STEP_02'));
    r = await turn({ cwd, analysis: { skill_name: 'the s03 skill' } });
    ok('...a name the router wraps in words still finds the skill inside it', analyzed(r.ui).startsWith('skill:s03'));
    r = await turn({ cwd, analysis: { skill_name: 'zzz' } });
    ok('...a name that matches nothing is no skill', !analyzed(r.ui).startsWith('skill:') && r.mock.counts.template === 1);
}

fs.rmSync(TMP_HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
