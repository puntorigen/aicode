// Offline checks for project memory (lib/memory.js): AGENTS.md, Cursor rules
// (.cursor/rules/**/*.mdc), the legacy .cursorrules and .aicode/memory.md, how
// they are composed into the agent's system prompt, the glob rules appended to
// tool results, and the read_rule tool. Nothing touches the network.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const Code2Prompt = require('../lib/engine');
const agents = require('../lib/agents');
const memory = require('../lib/memory');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '}${name}`); if (!cond) failures++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const TMP = [];
function project(files = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-mem-'));
    TMP.push(dir);
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    return dir;
}
const rule = (header, body) => `---\n${header}\n---\n${body}\n`;
const heading = (text, h) => text.indexOf(h);

// the layout the spec describes: AGENTS.md (with an orvix block), .cursorrules,
// a.mdc (alwaysApply), b.mdc (globs "*.ts"), c.mdc (description only), memory.md
const ORVIX_BLOCK = '<!-- orvix:start -->\n## Codebase navigation (orvix)\nUse `orvix map --budget 2000` first.\n<!-- orvix:end -->';
const LAYOUT = {
    'AGENTS.md': `Project conventions: AGENTS_MARK.\n\n${ORVIX_BLOCK}\n`,
    '.cursorrules': 'LEGACY_MARK: keep answers terse.\n',
    '.cursor/rules/a.mdc': rule('description: Always on\nalwaysApply: true', 'RULE_A_MARK applies to everything.'),
    '.cursor/rules/b.mdc': rule('globs: "*.ts"', 'RULE_B_MARK typescript style.'),
    '.cursor/rules/c.mdc': rule('description: Database migration checklist', 'RULE_C_MARK write reversible migrations.'),
    '.aicode/memory.md': '- (2026-01-01) MEMORY_MARK the test command is npm test\n',
};

// =============================================================================
// [A] rule files: front matter, globs, flags
// =============================================================================
console.log('\n[A] parsing rule files');
{
    const parse = (header, body = 'BODY') => memory.parseRule(rule(header, body), 'r', '.cursor/rules/r.mdc');

    let r = parse('description: Style guide\nglobs: "*.ts"\nalwaysApply: false', 'Use tabs.');
    ok('description, quoted glob, alwaysApply false and the body', r.description === 'Style guide' && same(r.globs, ['*.ts']) && r.alwaysApply === false && r.body === 'Use tabs.');
    ok('the rule keeps its name and file', r.name === 'r' && r.file === '.cursor/rules/r.mdc');
    ok('unquoted comma-separated globs (how Cursor writes them)', same(parse('globs: *.ts,*.tsx').globs, ['*.ts', '*.tsx']));
    ok('commas inside braces do not split a glob', same(parse('globs: src/**/*.{ts,tsx}, docs/*.md').globs, ['src/**/*.{ts,tsx}', 'docs/*.md']));
    ok('an inline list', same(parse('globs: [a.ts, "b.ts", \'c.ts\']').globs, ['a.ts', 'b.ts', 'c.ts']));
    ok('a YAML block list', same(parse('globs:\n  - "src/**/*.py"\n  - tests/*.py\ndescription: Python').globs, ['src/**/*.py', 'tests/*.py']));
    ok('keys after a block list still parse', parse('globs:\n  - a.py\ndescription: Python').description === 'Python');
    ok('no globs means an empty list', same(parse('description: x').globs, []));
    ok('./ and a leading / are relative to the project root', same(parse('globs: ./src/**, /docs/*.md').globs, ['src/**', 'docs/*.md']));
    ok('alwaysApply true, quoted and any case', parse('alwaysApply: true').alwaysApply === true && parse('alwaysApply: "true"').alwaysApply === true && parse('alwaysApply: TRUE').alwaysApply === true);
    ok('anything else is not alwaysApply', parse('alwaysApply: yes').alwaysApply === false && parse('description: x').alwaysApply === false);
    ok('a colon inside the description is kept', parse('description: Rule: be kind').description === 'Rule: be kind');
    ok('the description is one trimmed line, capped', parse(`description: "${'word '.repeat(100)}"`).description.length <= 240 && !parse('description: "a   b"').description.includes('  '));
    ok('key names are case-insensitive', parse('Description: Hi\nAlwaysApply: true\nGlobs: x.ts').description === 'Hi');

    const crlf = memory.parseRule('---\r\ndescription: Win\r\nglobs: *.ts\r\nalwaysApply: true\r\n---\r\nLine one\r\nLine two\r\n', 'w', 'w.mdc');
    ok('CRLF files parse the same', crlf.description === 'Win' && same(crlf.globs, ['*.ts']) && crlf.alwaysApply === true && crlf.body === 'Line one\r\nLine two');
    const bom = memory.parseRule('\uFEFF---\ndescription: Bom\n---\nBody', 'b', 'b.mdc');
    ok('a byte-order mark is ignored', bom.description === 'Bom' && bom.body === 'Body');
    const plain = memory.parseRule('Just a note, no header.\n', 'p', 'p.mdc');
    ok('a file without a header is all body', plain.body === 'Just a note, no header.' && plain.description === '' && !plain.alwaysApply && plain.globs.length === 0);
    const open = memory.parseRule('---\ndescription: never closed\nBody continues\n', 'o', 'o.mdc');
    ok('a header that never closes is not a header', open.description === '' && open.body.startsWith('---'));
    const empty = memory.parseRule('---\n---\nBody after an empty header', 'e', 'e.mdc');
    ok('an empty header is fine', empty.body === 'Body after an empty header');
    ok('a horizontal rule in the body is not mistaken for the header end', memory.parseRule('---\ndescription: D\n---\nA\n\n---\n\nB', 'h', 'h.mdc').body === 'A\n\n---\n\nB');
    ok('a truncated file ends with the marker', memory.parseRule(rule('description: x', 'Big'), 'm', 'm.mdc', { truncated: true }).body.endsWith(memory.TRUNCATED));
}

// =============================================================================
// [B] discovering rules on disk
// =============================================================================
console.log('\n[B] loading rules');
{
    const dir = project({
        '.cursor/rules/zeta.mdc': rule('description: last', 'Z'),
        '.cursor/rules/alpha.mdc': rule('alwaysApply: true', 'A'),
        '.cursor/rules/frontend/react.mdc': rule('globs: *.tsx', 'R'),
        '.cursor/rules/frontend/deep/vue.mdc': rule('globs: *.vue', 'V'),
        '.cursor/rules/notes.md': 'not a rule file',
        '.cursor/rules/empty.mdc': '---\ndescription: nothing inside\n---\n   \n',
        '.cursor/rules/README.txt': 'ignore me',
    });
    const rules = memory.loadRules(dir);
    ok('every non-empty .mdc is a rule, sorted by name; nested names use /', same(rules.map((r) => r.name), ['alpha', 'frontend/deep/vue', 'frontend/react', 'zeta']));
    ok('files that are not .mdc, and empty rules, are skipped', !rules.some((r) => r.name === 'notes' || r.name === 'empty' || r.name === 'README'));
    ok('file is the project-relative path', rules.find((r) => r.name === 'frontend/react').file === '.cursor/rules/frontend/react.mdc');
    ok('no .cursor/rules directory means no rules', same(memory.loadRules(project({ 'x.txt': '1' })), []));
    const withLegacy = memory.loadRules(project({ '.cursorrules': 'Old style rules.\n', '.cursor/rules/m.mdc': rule('description: m', 'M') }));
    ok('.cursorrules is the first rule, always on, named after the file', same(withLegacy.map((r) => r.name), ['.cursorrules', 'm']) && withLegacy[0].alwaysApply === true && withLegacy[0].body === 'Old style rules.' && withLegacy[0].file === '.cursorrules' && withLegacy[0].description === '');
    ok('a blank .cursorrules is no rule', same(memory.loadRules(project({ '.cursorrules': '  \n' })), []));
    ok('a missing project directory is not an error', same(memory.loadRules(path.join(dir, 'does-not-exist')), []));

    const linked = project({ 'real/shared.mdc': rule('alwaysApply: true', 'SHARED'), '.cursor/rules/.keep': '' });
    let symlinks = true;
    try {
        fs.symlinkSync(path.join(linked, 'real', 'shared.mdc'), path.join(linked, '.cursor', 'rules', 'shared.mdc'));
        fs.symlinkSync(path.join(linked, 'real'), path.join(linked, '.cursor', 'rules', 'dirlink'), 'dir');
    } catch (e) { symlinks = false; }
    if (symlinks) {
        const names = memory.loadRules(linked).map((r) => r.name);
        ok('a symlinked rule file is followed', names.includes('shared'));
        ok('a symlinked directory is not (no cycles)', !names.some((n) => n.startsWith('dirlink')));
    } else {
        console.log('  skip  symlinks unavailable on this platform');
    }

    const many = {};
    for (let i = 0; i < 205; i++) many[`.cursor/rules/r${String(i).padStart(3, '0')}.mdc`] = rule('description: d', `body ${i}`);
    ok('at most 200 rule files are read', memory.loadRules(project(many)).length === 200);

    const huge = project({ '.cursor/rules/big.mdc': rule('description: Big', 'x'.repeat(200000)) });
    const big = memory.loadRules(huge)[0];
    ok('a huge rule file is cut and flagged', big.body.length < 70000 && big.body.endsWith(memory.TRUNCATED) && big.description === 'Big');
}

// =============================================================================
// [C] composition: order, content, the active file
// =============================================================================
console.log('\n[C] composing the project memory');
{
    const dir = project(LAYOUT);

    const none = memory.readProjectMemory(dir);
    ok('returns text, rules and the names that made it into the text', typeof none.text === 'string' && Array.isArray(none.rules) && Array.isArray(none.injected));
    ok('AGENTS.md is injected verbatim, orvix block included', none.text.includes(`## AGENTS.md\nProject conventions: AGENTS_MARK.\n\n${ORVIX_BLOCK}`));
    ok('.cursorrules is an always-on rule', none.text.includes('## Rule: .cursorrules\nLEGACY_MARK: keep answers terse.'));
    ok('alwaysApply rules are loaded', none.text.includes('## Rule: a\nRULE_A_MARK applies to everything.'));
    ok('a glob rule is not loaded without an active file', !none.text.includes('RULE_B_MARK') && !none.text.includes('## Rule: b'));
    ok('a rule with only a description is listed, not loaded', none.text.includes('- c — Database migration checklist') && !none.text.includes('RULE_C_MARK'));
    ok('a rule without a description that is not active is not listed', !/^- b\b/m.test(none.text));
    ok('the list tells the agent to use read_rule', /## Available rules\n[^\n]*`read_rule`/.test(none.text));
    ok('the agent notes come last', none.text.includes('## .aicode/memory.md\n- (2026-01-01) MEMORY_MARK the test command is npm test'));
    const order = ['## AGENTS.md', '## Rule: .cursorrules', '## Rule: a', '## Available rules', '## .aicode/memory.md'].map((h) => heading(none.text, h));
    ok('order: AGENTS.md, .cursorrules, always rules, available rules, notes', order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])));
    ok('injected names the rules in the text', same(none.injected, ['.cursorrules', 'a']));
    ok('rules lists every rule, .cursorrules first', same(none.rules.map((r) => r.name), ['.cursorrules', 'a', 'b', 'c']));
    ok('.cursorrules is alwaysApply', none.rules[0].alwaysApply === true && none.rules[0].file === '.cursorrules');

    const active = memory.readProjectMemory(dir, { activeFile: 'x.ts' });
    ok('a glob rule loads when it matches the active file', active.text.includes('## Rule: b (applies to x.ts)\nRULE_B_MARK typescript style.'));
    const order2 = ['## AGENTS.md', '## Rule: .cursorrules', '## Rule: a\n', '## Rule: b (applies to x.ts)', '## Available rules', '## .aicode/memory.md'].map((h) => heading(active.text, h));
    ok('order: glob rules sit after the always-on ones and before the list', order2.every((i, n) => i >= 0 && (n === 0 || i > order2[n - 1])));
    ok('the matching rule is reported as injected', same(active.injected, ['.cursorrules', 'a', 'b']));
    ok('a loaded rule is not listed again', !/^- b\b/m.test(active.text));
    ok('a rule that does not match the active file stays out', !memory.readProjectMemory(dir, { activeFile: 'x.md' }).text.includes('RULE_B_MARK'));
    ok('the pattern *.ts matches in any directory', memory.readProjectMemory(dir, { activeFile: 'src/deep/y.ts' }).text.includes('(applies to src/deep/y.ts)'));
    ok('an absolute active file inside the project is made relative', memory.readProjectMemory(dir, { activeFile: path.join(dir, 'src', 'z.ts') }).text.includes('(applies to src/z.ts)'));
    ok('an active file outside the project is ignored', !memory.readProjectMemory(dir, { activeFile: path.join(os.tmpdir(), 'other', 'q.ts') }).text.includes('RULE_B_MARK') && !memory.readProjectMemory(dir, { activeFile: '../q.ts' }).text.includes('RULE_B_MARK'));
    ok('null and empty active files are fine', !memory.readProjectMemory(dir, { activeFile: null }).text.includes('RULE_B_MARK') && !memory.readProjectMemory(dir, { activeFile: '' }).text.includes('RULE_B_MARK'));

    // an alwaysApply rule that also has globs is loaded once, as an always-on rule
    const both = project({ '.cursor/rules/both.mdc': rule('alwaysApply: true\nglobs: *.ts', 'BOTH_MARK') });
    const bothText = memory.readProjectMemory(both, { activeFile: 'a.ts' }).text;
    ok('alwaysApply wins over globs: one section, no "applies to"', bothText.split('BOTH_MARK').length === 2 && !bothText.includes('(applies to'));

    // nothing at all
    const bare = memory.readProjectMemory(project());
    ok('an empty project has no memory', bare.text === '' && same(bare.rules, []) && same(bare.injected, []));
    ok('a project directory that does not exist has none either', memory.readProjectMemory(path.join(dir, 'nope')).text === '');

    // a directory named AGENTS.md, and blank files
    const odd = project({ '.cursorrules': '  \n', '.aicode/memory.md': '\n\n' });
    fs.mkdirSync(path.join(odd, 'AGENTS.md'));
    ok('a directory called AGENTS.md and blank files add nothing', memory.readProjectMemory(odd).text === '');

    // the project memory is re-read on every call
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'Changed convention: NEW_AGENTS_MARK.\n');
    fs.writeFileSync(path.join(dir, '.cursor', 'rules', 'late.mdc'), rule('alwaysApply: true', 'LATE_MARK'));
    const fresh = memory.readProjectMemory(dir).text;
    ok('AGENTS.md and the rules are read fresh each time', fresh.includes('NEW_AGENTS_MARK') && !fresh.includes('Project conventions') && fresh.includes('LATE_MARK'));
}

// =============================================================================
// [D] size caps
// =============================================================================
console.log('\n[D] size caps');
{
    const M = memory.TRUNCATED;
    const rep = (ch, n) => ch.repeat(n);

    // AGENTS.md: 12000 characters, the rest cut
    let t = memory.readProjectMemory(project({ 'AGENTS.md': rep('a', 20000) })).text;
    ok('AGENTS.md is cut at 12000 characters and flagged', t === `## AGENTS.md\n${rep('a', 12000)}\n${M}`);
    t = memory.readProjectMemory(project({ 'AGENTS.md': rep('a', 12000) })).text;
    ok('exactly 12000 characters is not cut', t === `## AGENTS.md\n${rep('a', 12000)}`);
    t = memory.readProjectMemory(project({ 'AGENTS.md': rep('a', 3000000) })).text;
    ok('a multi-megabyte AGENTS.md is read in part and flagged', t.length === 13 + 12000 + 1 + M.length && t.endsWith(M));
    t = memory.readProjectMemory(project({ 'AGENTS.md': rep('a', 11999) + '\u{1F600}tail' })).text;
    ok('a cut never splits a surrogate pair', t === `## AGENTS.md\n${rep('a', 11999)}\n${M}` && !/[\uD800-\uDBFF]\n/.test(t));
    t = memory.readProjectMemory(project({ 'AGENTS.md': '\u00e9'.repeat(15000) })).text;
    ok('the cap counts characters, not bytes', t === `## AGENTS.md\n${'\u00e9'.repeat(12000)}\n${M}`);

    // .cursorrules, rules and notes: 6000 each
    t = memory.readProjectMemory(project({ '.cursorrules': rep('c', 9000) })).text;
    ok('.cursorrules is cut at 6000', t === `## Rule: .cursorrules\n${rep('c', 6000)}\n${M}`);
    t = memory.readProjectMemory(project({ '.cursor/rules/long.mdc': rule('alwaysApply: true', rep('r', 9000)) })).text;
    ok('an always-on rule is cut at 6000', t === `## Rule: long\n${rep('r', 6000)}\n${M}`);
    t = memory.readProjectMemory(project({ '.cursor/rules/g.mdc': rule('globs: *.ts', rep('g', 9000)) }), { activeFile: 'a.ts' }).text;
    ok('a glob rule is cut at 6000', t === `## Rule: g (applies to a.ts)\n${rep('g', 6000)}\n${M}`);
    t = memory.readProjectMemory(project({ '.aicode/memory.md': rep('m', 9000) })).text;
    ok('the agent notes are cut at 6000', t === `## .aicode/memory.md\n${rep('m', 6000)}\n${M}`);

    // the list of available rules
    const many = {};
    for (let i = 0; i < 60; i++) many[`.cursor/rules/rule-${String(i).padStart(2, '0')}.mdc`] = rule(`description: ${rep('d', 200)}`, 'b');
    t = memory.readProjectMemory(project(many)).text;
    const list = t.slice(t.indexOf('## Available rules'));
    ok('the list of available rules is cut at 4000', list.length <= '## Available rules\n'.length + 4000 + 1 + M.length && list.endsWith(M));

    // the whole text: 32000
    const crowded = { 'AGENTS.md': rep('A', 12000), '.cursorrules': rep('L', 6000), '.aicode/memory.md': 'NOTES_MARK' };
    for (const n of ['a', 'b', 'c', 'd']) crowded[`.cursor/rules/${n}.mdc`] = rule('alwaysApply: true', rep(n.toUpperCase(), 6000));
    const full = memory.readProjectMemory(project(crowded));
    ok('the total is held to 32000, the section that crosses the line is cut to fit', full.text.length === 32000 && full.text.endsWith(M));
    ok('what does not fit is dropped (the notes come last)', !full.text.includes('NOTES_MARK') && !full.text.includes('## .aicode/memory.md'));
    ok('only rules that made it into the text are reported as injected', same(full.injected, ['.cursorrules', 'a', 'b', 'c']) && !full.injected.includes('d'));
    ok('every rule is still known', same(full.rules.map((r) => r.name), ['.cursorrules', 'a', 'b', 'c', 'd']));

    // a sliver of room is not worth a fragment: the next section is dropped whole
    const tight = { 'AGENTS.md': rep('A', 12000), '.cursorrules': rep('L', 6000) };
    for (const n of ['a', 'b']) tight[`.cursor/rules/${n}.mdc`] = rule('alwaysApply: true', rep(n.toUpperCase(), 6000));
    tight['.cursor/rules/c.mdc'] = rule('alwaysApply: true', rep('C', 1800));
    tight['.cursor/rules/d.mdc'] = rule('alwaysApply: true', rep('D', 3000));
    const snug = memory.readProjectMemory(project(tight));
    ok('under 200 characters of room: the section is dropped, not fragmented', snug.text.length < 32000 && snug.text.length > 31700 && !snug.text.includes('## Rule: d') && !snug.text.endsWith(M));
    ok('and it is not reported as injected', same(snug.injected, ['.cursorrules', 'a', 'b', 'c']));
}

// =============================================================================
// [E] glob matching and the per-turn notices
// =============================================================================
console.log('\n[E] glob rules and notices');
{
    const mk = (globs, name = 'g', extra = {}) => ({ name, description: '', globs, alwaysApply: false, body: `BODY_${name}`, file: `${name}.mdc`, ...extra });
    const m = (globs, file) => memory.matchesGlobs(mk(globs), file);

    ok('a pattern without a slash matches the basename anywhere', m(['*.ts'], 'a.ts') && m(['*.ts'], 'src/a/b/c.ts') && !m(['*.ts'], 'a.js'));
    ok('a pattern with a slash is anchored at the project root', m(['src/*.ts'], 'src/a.ts') && !m(['src/*.ts'], 'lib/src/a.ts') && !m(['src/*.ts'], 'src/deep/a.ts'));
    ok('** crosses directories', m(['src/**/*.tsx'], 'src/a/b/c.tsx') && !m(['src/**/*.tsx'], 'lib/a.tsx'));
    ok('braces expand', m(['*.{ts,tsx}'], 'a.tsx') && m(['*.{ts,tsx}'], 'a.ts') && !m(['*.{ts,tsx}'], 'a.js'));
    ok('dot files and dot directories match', m(['*.ts'], '.hidden/x.ts') && m(['**/*.ts'], '.config/x.ts') && m(['.env*'], '.env.local'));
    ok('any one of several globs is enough', m(['*.md', '*.ts'], 'a.ts'));
    ok('a rule without globs never matches', !m([], 'a.ts'));
    ok('an empty or missing path never matches', !m(['*'], '') && !m(['*'], null) && !memory.matchesGlobs(null, 'a.ts'));
    ok('a malformed pattern is just a miss', (() => { try { return m(['[', '{a'], 'a.ts') === false; } catch (e) { return false; } })());

    const rules = [mk(['*.ts'], 'ts'), mk(['*.py'], 'py'), mk([], 'manual'), mk(['*.ts'], 'always', { alwaysApply: true }), mk(['src/**'], 'src')];
    const state = memory.turnState({});
    let out = memory.ruleNotices(rules, '/proj', 'src/a.ts', state);
    ok('every matching glob rule is appended, as "# Applicable rule"', out === '\n\n# Applicable rule: ts\nBODY_ts\n\n# Applicable rule: src\nBODY_src');
    ok('a rule is appended once per turn', memory.ruleNotices(rules, '/proj', 'src/b.ts', state) === '');
    ok('alwaysApply rules are never appended (they are already in the prompt)', !out.includes('always'));
    ok('rules that do not match, and rules without globs, are not appended', !out.includes('py') && !out.includes('manual'));
    out = memory.ruleNotices(rules, '/proj', 'x.py', state);
    ok('a different rule still appears later in the turn', out === '\n\n# Applicable rule: py\nBODY_py');
    ok('a new turn starts with a clean slate', memory.ruleNotices(rules, '/proj', 'a.ts', memory.turnState({})).includes('# Applicable rule: ts'));
    ok('markInjected hides the rules already in the prompt', (() => { const s = memory.turnState({}); memory.markInjected(s, ['ts']); return memory.ruleNotices(rules, '/proj', 'a.ts', s) === ''; })());
    ok('the state belongs to the context object: the same ctx shares it', (() => { const ctx = {}; return memory.turnState(ctx) === memory.turnState(ctx) && memory.turnState(ctx) !== memory.turnState({}); })());
    ok('paths outside the project and empty paths add nothing', memory.ruleNotices(rules, '/proj', '../a.ts', memory.turnState({})) === '' && memory.ruleNotices(rules, '/proj', '', memory.turnState({})) === '' && memory.ruleNotices(rules, '/proj', '/elsewhere/a.ts', memory.turnState({})) === '');
    ok('an absolute path inside the project works', memory.ruleNotices(rules, '/proj', '/proj/lib/a.ts', memory.turnState({})).includes('# Applicable rule: ts'));
    ok('no rules, nothing to add', memory.ruleNotices([], '/proj', 'a.ts', memory.turnState({})) === '' && memory.ruleNotices(null, '/proj', 'a.ts', memory.turnState({})) === '');
    const long = [mk(['*.ts'], 'long', { body: 'L'.repeat(9000) })];
    const cut = memory.ruleNotices(long, '/proj', 'a.ts', memory.turnState({}));
    ok('a long rule is cut at 6000 in a notice', cut === `\n\n# Applicable rule: long\n${'L'.repeat(6000)}\n${memory.TRUNCATED}`);

    // findRule
    const set = [mk([], 'style'), mk([], 'frontend/react'), mk([], 'backend/Style-Guide')];
    ok('findRule: exact name', memory.findRule(set, 'style').name === 'style');
    ok('findRule: case-insensitive', memory.findRule(set, 'STYLE').name === 'style' && memory.findRule(set, 'backend/style-guide').name === 'backend/Style-Guide');
    ok('findRule: tolerates a .mdc suffix', memory.findRule(set, 'style.mdc').name === 'style');
    ok('findRule: a unique basename is enough', memory.findRule(set, 'react').name === 'frontend/react');
    ok('findRule: an ambiguous basename is not guessed', memory.findRule([mk([], 'a/x'), mk([], 'b/x')], 'x') === null);
    ok('findRule: unknown and empty names find nothing', memory.findRule(set, 'nope') === null && memory.findRule(set, '') === null && memory.findRule(set, null) === null && memory.findRule(null, 'style') === null);
}

// =============================================================================
// [F] the tools: read_rule and the notices on read_file / write_file / edit_file
// =============================================================================
console.log('\n[F] agent tools');
const ui = { step: () => ({ done() { }, fail() { }, update() { } }), streamChunk() { }, streamEnd() { }, status() { }, statusStop() { }, isStreaming: () => false };
function makeCtx(dir, extra = {}) {
    return {
        userDirectory: dir, language: 'English', personality: '',
        readFile: async (f) => fs.readFileSync(path.join(dir, f), 'utf8'),
        writeFile: async (f, content) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), content); return true; },
        editFile: async () => ({ ok: true, applied: 1 }),
        executeBash: async () => ({ output: 'ok' }), ask: async () => 'y',
        ...extra,
    };
}
{
    const dir = project({ ...LAYOUT, 'x.ts': 'export const x = 1;\n', 'y.ts': 'export const y = 2;\n', 'z.md': '# z\n' });
    const engine = new Code2Prompt({ template: path.join(ROOT, 'actions', 'default.md'), OPENAI_KEY: 'test' });
    const defs = await agents.loadAgents();
    const rt = (ctx) => ({ engine, ctx, ui, agents: defs, depth: 0, cwd: dir });

    // read_rule
    const readRule = agents.buildTools(rt(makeCtx(dir)), ['read_rule']).read_rule;
    ok('read_rule exists', !!readRule);
    let res = await readRule.execute({ name: 'c' });
    ok('read_rule returns name, description, globs and the full body', res.name === 'c' && res.description === 'Database migration checklist' && same(res.globs, []) && res.body === 'RULE_C_MARK write reversible migrations.');
    res = await readRule.execute({ name: 'b' });
    ok('read_rule works for a glob rule (no description needed)', res.name === 'b' && same(res.globs, ['*.ts']) && res.body.includes('RULE_B_MARK'));
    ok('read_rule tolerates the .mdc suffix and case', (await readRule.execute({ name: 'C.mdc' })).name === 'c');
    res = await readRule.execute({ name: 'nope' });
    ok('an unknown rule is an error that lists the names', res.error && /not found/.test(res.error) && /Available: \.cursorrules, a, b, c$/.test(res.error));
    const bare = project({ 'a.ts': 'plain\n' });
    const bareRt = { engine, ctx: makeCtx(bare), ui, agents: defs, depth: 0, cwd: bare };
    ok('with no rules at all the error says so', /Available: \(none\)$/.test((await agents.buildTools(bareRt, ['read_rule']).read_rule.execute({ name: 'x' })).error));
    ok('a project without rules leaves tool results untouched', (await agents.buildTools(bareRt, ['read_file']).read_file.execute({ path: 'a.ts' })) === 'plain\n');
    const longDir = project({ '.cursor/rules/long.mdc': rule('description: Long', 'L'.repeat(30000)) });
    const longRes = await agents.buildTools({ engine, ctx: makeCtx(longDir), ui, agents: defs, depth: 0, cwd: longDir }, ['read_rule']).read_rule.execute({ name: 'long' });
    ok('a very long rule is capped like any tool output', longRes.body.length < 13000 && /truncated/.test(longRes.body));
    const lazy = rt(makeCtx(dir));
    const lazyTools = agents.buildTools(lazy, ['read_rule']);
    ok('a runtime built without rules does not read them until a tool needs them', lazy.rules === undefined);
    await lazyTools.read_rule.execute({ name: 'a' });
    ok('...then keeps them on the runtime', Array.isArray(lazy.rules) && lazy.rules.length === 4);

    // availability
    ok('main and explorer can read rules', defs.main.tools.includes('read_rule') && defs.explorer.tools.includes('read_rule'));
    ok('an agent without a tools block gets read_rule among its read-only defaults', !!agents.buildTools(rt(makeCtx(dir)), null).read_rule);
    ok('coder and reviewer are unchanged', !defs.coder.tools.includes('read_rule') && !defs.reviewer.tools.includes('read_rule'));
    ok('a tool whitelist without read_rule does not have it', !agents.buildTools(rt(makeCtx(dir)), ['read_file']).read_rule);

    // notices on file tools
    const ctx = makeCtx(dir);
    const tools = agents.buildTools(rt(ctx), ['read_file', 'write_file', 'edit_file']);
    const read1 = await tools.read_file.execute({ path: 'x.ts' });
    ok('read_file of a matching file appends the glob rule', read1.startsWith('export const x = 1;') && read1.endsWith('\n\n# Applicable rule: b\nRULE_B_MARK typescript style.'));
    const read2 = await tools.read_file.execute({ path: 'y.ts' });
    ok('...once per turn', read2 === 'export const y = 2;\n');
    ok('read_file of a file no rule covers is untouched', (await tools.read_file.execute({ path: 'z.md' })) === '# z\n');
    ok('an unreadable file is still an error object', /cannot read/.test((await tools.read_file.execute({ path: 'missing.ts' })).error));

    const ctx2 = makeCtx(dir);
    const tools2 = agents.buildTools(rt(ctx2), ['read_file', 'write_file', 'edit_file']);
    const wrote = await tools2.write_file.execute({ path: 'new.ts', content: 'a\nb\nc' });
    ok('write_file of a matching file appends the rule too', wrote.startsWith('wrote new.ts (3 lines)') && wrote.includes('# Applicable rule: b'));
    ok('...and the rule is then spent for this turn', (await tools2.edit_file.execute({ path: 'x.ts', instructions: 'noop' })) === 'edited x.ts (1 change(s))');

    const ctx3 = makeCtx(dir);
    const tools3 = agents.buildTools(rt(ctx3), ['write_file', 'edit_file']);
    const edited = await tools3.edit_file.execute({ path: 'src/deep.ts', instructions: 'noop' });
    ok('edit_file of a matching file appends the rule', edited.startsWith('edited src/deep.ts (1 change(s))') && edited.includes('# Applicable rule: b'));
    const failing = agents.buildTools(rt(makeCtx(dir, { writeFile: async () => false, editFile: async () => ({ ok: false, error: 'nope' }) })), ['write_file', 'edit_file']);
    ok('failed writes and edits stay plain errors', (await failing.write_file.execute({ path: 'a.ts', content: 'x' })).error && (await failing.edit_file.execute({ path: 'a.ts', instructions: 'x' })).error === 'nope');

    // the same ctx across a delegation shares what was already shown
    const shared = makeCtx(dir);
    const parent = agents.buildTools(rt(shared), ['read_file']);
    const child = agents.buildTools({ engine, ctx: shared, ui, agents: defs, depth: 1, cwd: dir }, ['read_file']);
    ok('a sub-agent sharing the turn does not repeat a rule', (await parent.read_file.execute({ path: 'x.ts' })).includes('Applicable rule: b') && (await child.read_file.execute({ path: 'y.ts' })) === 'export const y = 2;\n');
}

// =============================================================================
// [G] runAgent: the memory in the system prompt, the editor's active file
// =============================================================================
console.log('\n[G] runAgent');
{
    const dir = project({ ...LAYOUT, 'x.ts': 'export const x = 1;\n', 'y.ts': 'export const y = 2;\n' });
    const engine = new Code2Prompt({ template: path.join(ROOT, 'actions', 'default.md'), OPENAI_KEY: 'test' });
    const defs = await agents.loadAgents();
    let seen = null;
    engine.runAgentLoop = async ({ system, tools }) => { seen = { system, tools }; return { text: 'ANSWER' }; };
    const run = async (ctx, agentName = 'main', depth = 0) => {
        await agents.runAgent({ engine, agentName, agents: defs, task: 'do X', ctx, ui, depth, streamAnswer: false });
        return seen;
    };

    // no editor context: the glob rule is not in the prompt, but it still reaches the agent through the tools
    let ctx = makeCtx(dir);
    let s = await run(ctx);
    ok('the prompt carries AGENTS.md, the orvix block, .cursorrules and the always-on rule', ['AGENTS_MARK', 'orvix map --budget 2000', 'LEGACY_MARK', 'RULE_A_MARK', 'MEMORY_MARK'].every((t) => s.system.includes(t)));
    ok('under "# Project memory"', s.system.includes('# Project memory\n## AGENTS.md'));
    ok('the glob rule is not in the prompt, the described one is listed', !s.system.includes('RULE_B_MARK') && s.system.includes('- c — Database migration checklist'));
    ok('the agent can read the listed rule', !!s.tools.read_rule && (await s.tools.read_rule.execute({ name: 'c' })).body.includes('RULE_C_MARK'));
    const first = await s.tools.read_file.execute({ path: 'x.ts' });
    ok('touching a matching file brings the glob rule in', first.includes('# Applicable rule: b') && first.includes('RULE_B_MARK'));
    ok('...once per turn', !(await s.tools.read_file.execute({ path: 'y.ts' })).includes('Applicable rule'));

    // a sub-agent of the same turn shares ctx: nothing is repeated
    const sub = await run(ctx, 'explorer', 1);
    ok('a sub-agent of the same turn gets the memory too', sub.system.includes('AGENTS_MARK') && sub.system.includes('RULE_A_MARK'));
    ok('...and does not see the glob rule again', !(await sub.tools.read_file.execute({ path: 'y.ts' })).includes('Applicable rule'));

    // an editor context with an active file loads the rule up front, and the tools stop repeating it
    ctx = makeCtx(dir, { editor: { activeFile: 'x.ts', selection: null, openFiles: ['x.ts'] } });
    s = await run(ctx);
    ok('the active file loads its glob rule into the prompt', s.system.includes('## Rule: b (applies to x.ts)\nRULE_B_MARK typescript style.'));
    ok('the rule in the prompt is not appended to tool results again', !(await s.tools.read_file.execute({ path: 'y.ts' })).includes('Applicable rule'));
    ok('an active file no rule covers loads nothing extra', !(await run(makeCtx(dir, { editor: { activeFile: 'z.md', selection: null, openFiles: [] } }))).system.includes('RULE_B_MARK'));
    ok('an absolute active file works', (await run(makeCtx(dir, { editor: { activeFile: path.join(dir, 'y.ts') } }))).system.includes('(applies to y.ts)'));
    ok('an editor context without an active file is harmless', !(await run(makeCtx(dir, { editor: { activeFile: null, selection: null, openFiles: [] } }))).system.includes('RULE_B_MARK'));

    // a new turn (a new ctx) shows the rule again, and AGENTS.md is read again
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'Second turn: SECOND_MARK.\n');
    s = await run(makeCtx(dir));
    ok('each turn re-reads AGENTS.md', s.system.includes('SECOND_MARK') && !s.system.includes('AGENTS_MARK'));
    ok('each turn shows glob rules again', (await s.tools.read_file.execute({ path: 'x.ts' })).includes('Applicable rule: b'));

    // a project with no memory at all gets no section
    const bareDir = project({ 'a.txt': 'hi' });
    s = await run(makeCtx(bareDir));
    ok('no project memory, no "# Project memory" section', !s.system.includes('# Project memory'));
}

for (const dir of TMP) fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
