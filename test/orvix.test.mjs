// Checks for the orvix layer (lib/orvix.js) and what is built on it: the index lifecycle,
// the query API, result compression, the agent tools (code_map, find_symbol, show_symbol,
// who_calls, calls, read_file ranges), the system brief and the navigation policy, and the
// `aicode orvix` command. The real orvix-cli runs against small temp projects (it is a
// pure-JS dependency); the file is skipped with a notice when orvix-cli cannot run.
// Nothing touches the network, the real HOME or this repository's own index.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// isolate HOME (config.json, keys) and switch the orvix layer on: test/run.mjs turns it off for the other files
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-orvix-home-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
delete process.env.AICODE_NO_ORVIX;
delete process.env.GIT_DIR;

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '}${name}`); if (!cond) failures++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const orvixLib = require('../lib/orvix');
const agents = require('../lib/agents');
const Code2Prompt = require('../lib/engine');
const { createRuntime } = require('../lib/runtime');
const { createOrvix, locate, decide, settings, parseAmbiguous, filterMap, commandMayChangeFiles } = orvixLib;

// orvix-cli must run here, or there is nothing to test
const location = locate({});
const probe = location ? spawnSync(process.execPath, [location.main, '--version'], { encoding: 'utf8', timeout: 20000 }) : null;
if (!location || !probe || probe.status !== 0) {
    console.log('SKIP orvix-cli cannot run here (' + (location ? `exit ${probe && probe.status}` : 'not installed') + ')');
    process.exit(0);
}

const TMP = [TMP_HOME];
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// a temp project; `git: false` leaves it outside any repository
function project(files = {}, { git: init = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-orvix-'));
    TMP.push(dir);
    if (init) git(dir, 'init', '-q', '.');
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    return dir;
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
const occurrences = (text, line) => text.split('\n').filter((l) => l.trim() === line).length;

// a small ES-module project with a call chain run -> double -> add, and a name used twice (helper)
const SMALL = {
    'src/math.js': 'export function add(a, b) {\n  return a + b;\n}\nexport function double(n) {\n  return add(n, n);\n}\n',
    'src/app.js': "import { double } from './math.js';\nexport function run() {\n  return double(21);\n}\nfunction helper() { return 1 }\n",
    'src/box.js': 'function helper() { return 2 }\nclass Box {\n  open() { return helper() }\n}\n',
};
const NAV_TOOLS = ['code_map', 'find_symbol', 'show_symbol', 'who_calls', 'calls'];
const SMALL_SYMBOLS = 7; // add, double, run, helper, helper, Box, Box.open
const fn = (name, i) => `function ${name}${i}(a, b) {\n  // body of ${name}${i}\n  const x = a + b + ${i};\n  const y = x * 2;\n  const z = y - 1;\n  console.log(x, y, z);\n  if (x > 10) { return y }\n  if (y > 10) { return z }\n  return x;\n}\n`;
// 30 functions of 10 lines: over the 200 lines orvix's compression needs, and its symbol map is far smaller than the text
const BIG = Array.from({ length: 30 }, (_, i) => fn('fn', i)).join('');

// a ready, indexed copy of SMALL (plus BIG) with its orvix instance
async function indexed(extra = {}, options = {}) {
    const dir = project({ ...SMALL, 'src/big.js': BIG, ...extra });
    const orvix = createOrvix(dir, options);
    await orvix.ensureIndex();
    await orvix.ready(30000);
    return { dir, orvix };
}

// =============================================================================
// [A] helpers: configuration, shell-command guess, ambiguity, map filter
// =============================================================================
console.log('\n[A] helpers');
{
    ok('the default configuration', same(settings({}), { enabled: true, mapBudget: 1500, bin: null }));
    ok('settings read orvix.enabled, mapBudget and bin', same(settings({ orvix: { enabled: false, mapBudget: 800, bin: ' /x/orvix ' } }), { enabled: false, mapBudget: 800, bin: '/x/orvix' }));
    ok('a nonsense map budget falls back', settings({ orvix: { mapBudget: 'lots' } }).mapBudget === 1500 && settings({ orvix: { mapBudget: -5 } }).mapBudget === 1500);
    ok('a huge map budget is capped at 20000 tokens', settings({ orvix: { mapBudget: 10 ** 9 } }).mapBudget === 20000 && settings({ orvix: { mapBudget: 20000 } }).mapBudget === 20000);
    ok('orvix-cli resolves to its entry points', location.kind === 'pkg' && fs.existsSync(location.main) && fs.existsSync(location.query) && fs.existsSync(location.hook));
    ok('config.orvix.bin replaces main and query but keeps the hook', locate({ bin: '/x/orvix' }).kind === 'bin' && locate({ bin: '/x/orvix' }).bin === '/x/orvix' && locate({ bin: '/x/orvix' }).hook === location.hook);

    for (const cmd of ['ls -la', 'git status', 'git log --oneline | head', 'grep -rn foo src/', 'cat a.js | wc -l', 'cd sub && ls', 'echo hi 2>&1', 'FOO=1 ls', 'find . -name "*.js"', 'git diff HEAD~1', 'pwd; date', 'ls > /dev/null', 'ls\npwd', 'git config --get user.name', 'git rev-parse HEAD', 'git ls-files | wc -l']) {
        ok(`read-only: ${cmd.replace(/\n/g, '\\n')}`, commandMayChangeFiles(cmd) === false);
    }
    for (const cmd of ['npm test', 'rm -rf dist', 'git checkout main', 'git stash', 'echo x > out.txt', 'cat a >> b', 'sed -i s/a/b/ f.js', 'find . -name x -delete', 'find . -exec rm {} ;', 'ls && touch f', 'ls & rm x', 'echo $(date)', 'mv a b', 'node build.js', 'git pull', 'ls\nrm -rf x']) {
        ok(`may change files: ${cmd.replace(/\n/g, '\\n')}`, commandMayChangeFiles(cmd) === true);
    }
    ok('an empty command changes nothing', commandMayChangeFiles('') === false && commandMayChangeFiles(null) === false);

    const header = '"helper" matches 2 symbols:';
    const amb = parseAmbiguous(`${header}\n6w2c  src/app.js:5 function helper()\nn5rx  src/box.js:1 function helper() ←1\n`);
    ok('an ambiguous reference becomes candidates', amb && amb.ambiguous === true && amb.message === header && amb.candidates.length === 2);
    ok('...with id, file, line and signature', same(amb.candidates[1], { id: 'n5rx', file: 'src/box.js', startLine: 1, signature: 'function helper()' }));
    ok('"no symbol matches" is not ambiguity', parseAmbiguous('no symbol matches "x". Try `orvix find x`.') === null && parseAmbiguous('') === null && parseAmbiguous(undefined) === null);

    const MAP = 'a/x.js\n  aaaa  function x()  :1\n  … 3 more\na/b/y.js\n  bbbb  function y()  :1\nlib/z.js\n  cccc  function z()  :1\n… 3 files (9 symbols) not shown';
    ok('a map is filtered to a directory', filterMap(MAP, 'a', 1000) === 'a/x.js\n  aaaa  function x()  :1\n  … 3 more\na/b/y.js\n  bbbb  function y()  :1');
    ok('...or to one file, with ./ and a trailing slash tolerated', filterMap(MAP, './lib/z.js', 1000) === 'lib/z.js\n  cccc  function z()  :1' && filterMap(MAP, 'a/b/', 1000) === 'a/b/y.js\n  bbbb  function y()  :1');
    ok('a directory prefix is not a name prefix', filterMap(MAP, 'li', 1000).startsWith('no indexed symbols under li'));
    ok('no filter keeps the whole text', filterMap(MAP, '', 1000) === MAP && filterMap(MAP, '.', 1000) === MAP);
    const wide = Array.from({ length: 40 }, (_, i) => `d/f${i}.js\n  id${i}  function f${i}()  :1`).join('\n');
    const fitted = filterMap(wide, 'd', 100);
    ok('the filtered map is fitted to the budget and says what was left out', fitted.length < wide.length / 2 && /… \d+ more files under d not shown/.test(fitted));
    // a tiny budget still shows a useful amount (200 characters at least)...
    const blocks12 = Array.from({ length: 12 }, (_, i) => `d/f${i}.js\n  id${i}  function f${i}()  :1`).join('\n');
    const floor = filterMap(blocks12, 'd', 1);
    ok('a tiny budget still shows about 200 characters of the map', (floor.match(/^d\/f\d+\.js$/gm) || []).length === 6 && /… 6 more files under d not shown/.test(floor));
    // ...and the first file is shown even when it alone is over the budget
    const oneHuge = 'd/huge.js\n' + Array.from({ length: 30 }, (_, i) => `  hh${i}  function huge${i}()  :${i}`).join('\n') + '\nd/next.js\n  nn  function next()  :1';
    const huge = filterMap(oneHuge, 'd', 1);
    ok('...never just the footer', huge.startsWith('d/huge.js\n') && huge.includes('huge29') && !huge.includes('d/next.js') && /… 1 more files under d not shown/.test(huge));
}

// =============================================================================
// [B] enablement
// =============================================================================
console.log('\n[B] when the layer is active');
{
    const on = (dir, cfg = {}, env = {}) => decide(dir, { enabled: true, ...cfg }, location, env);

    ok('a git repository is on', on(project({ 'a.js': 'x' })).enabled === true);
    ok('...even without source files', on(project({ 'README.md': '# hi' })).enabled === true);
    const sub = project({ 'pkg/a.js': 'x' });
    ok('a subdirectory of a repository counts as inside it', on(path.join(sub, 'pkg')).enabled === true);
    const worktreeLike = project({ '.git': 'gitdir: /elsewhere\n', 'a.js': 'x' }, { git: false });
    ok('a .git file (worktree, submodule) counts too', on(worktreeLike).enabled === true);

    const few = project({ 'a.js': 'x', 'b.py': 'y', 'notes.md': 'z' }, { git: false });
    const fewDecision = on(few);
    ok('no repository and fewer than 5 source files: off, and it says why', fewDecision.enabled === false && /fewer than 5 source files/.test(fewDecision.reason));
    const many = project({ 'a.js': '1', 'b.ts': '2', 'c.py': '3', 'd.go': '4', 'e.rs': '5' }, { git: false });
    ok('no repository but 5 source files: on', on(many).enabled === true);
    const nested = project({ 'src/a.js': '1', 'src/b.js': '2', 'src/lib/c.js': '3', 'src/lib/d.js': '4', 'src/lib/deep/e.js': '5' }, { git: false });
    ok('source files in subdirectories count', on(nested).enabled === true);
    const four = project(Object.fromEntries(['a', 'b', 'c', 'd'].map((n) => [`${n}.js`, '1'])), { git: false });
    ok('four source files are not enough', on(four).enabled === false);
    for (const dirName of ['node_modules/x', '.hidden', 'dist', 'build', 'vendor', 'target', 'venv', '__pycache__', 'bower_components']) {
        const inside = project(Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((n) => [`${dirName}/${n}.js`, '1'])), { git: false });
        ok(`source files under ${dirName} do not count`, on(inside).enabled === false);
    }
    const used = project({ '.orvix/symbols.json': '{"version":1,"symbols":{}}' }, { git: false });
    ok('a project that already has an orvix index is on', on(used).enabled === true);

    const any = project({ 'a.js': 'x' });
    ok('AICODE_NO_ORVIX turns it off', decide(any, { enabled: true }, location, { AICODE_NO_ORVIX: '1' }).reason === 'AICODE_NO_ORVIX is set');
    ok('...also spelled true/yes/on, in any case and with spaces', ['true', 'YES', 'on', ' On ', ' 1 '].every((value) => decide(any, { enabled: true }, location, { AICODE_NO_ORVIX: value }).enabled === false));
    ok('...but 0, empty, no and off leave it on', ['0', '', 'no', 'off', 'false'].every((value) => on(any, {}, { AICODE_NO_ORVIX: value }).enabled === true));
    ok('orvix.enabled false in the configuration turns it off', on(any, { enabled: false }).enabled === false);
    ok('without orvix-cli it is off', decide(any, { enabled: true }, null, {}).reason === 'orvix-cli is not installed');
    ok('a home directory is never indexed', decide(TMP_HOME, { enabled: true }, location, {}).enabled === false);
    // ...not even when it is a repository with sources (people do that with dotfiles), while a project inside it is fine
    const homeLike = project({ 'a.js': 'x', 'proj/b.js': 'y' });
    const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = homeLike;
    process.env.USERPROFILE = homeLike;
    const homeDecision = decide(homeLike, { enabled: true }, location, {});
    const inHome = decide(path.join(homeLike, 'proj'), { enabled: true }, location, {});
    process.env.HOME = savedHome.HOME;
    process.env.USERPROFILE = savedHome.USERPROFILE;
    ok('...even a home that is a repository with sources', homeDecision.enabled === false && /home directory/.test(homeDecision.reason));
    ok('...but a project inside the home directory is', inHome.enabled === true);
    ok('...nor a filesystem root', decide(path.parse(process.cwd()).root, { enabled: true }, location, {}).enabled === false);

    const disabled = createOrvix(few);
    ok('an instance reports enabled and reason', disabled.enabled === false && typeof disabled.reason === 'string');
    ok('a disabled instance reports an empty status', same(disabled.status(), { enabled: false, symbols: 0, indexing: false, dirty: false }));
    const offButIndexed = project({ '.orvix/symbols.json': JSON.stringify({ version: 1, symbols: { a: {} } }) }, { git: false });
    ok('...even when an index is on disk', createOrvix(offButIndexed, { config: { orvix: { enabled: false } } }).status().symbols === 0 && createOrvix(offButIndexed).status().symbols === 1);
    const built = await disabled.ensureIndex();
    ok('...ensureIndex does nothing', built.enabled === false && built.building === false && !exists(few, '.orvix'));
    ok('...queries answer { error } and never throw', (await disabled.find('a')).error.includes('not active') && (await disabled.show('a')).error.includes('not active') && (await disabled.map(100)).error.includes('not active'));
    ok('...indexNow reports why, and compress leaves text alone', (await disabled.indexNow()).ok === false && (await disabled.compress('Read', { file_path: path.join(few, 'a.js') }, 'text')) === 'text');
    disabled.markDirty(['a.js']);
    disabled.markDirty();
    ok('...and markDirty is a no-op', !exists(few, '.orvix') && disabled.status().dirty === false);

    process.env.AICODE_NO_ORVIX = '1';
    ok('the environment is read when the instance is created', createOrvix(project({ 'a.js': 'x' })).enabled === false);
    delete process.env.AICODE_NO_ORVIX;
    ok('...and again each time', createOrvix(project({ 'a.js': 'x' })).enabled === true);
}

// =============================================================================
// [C] index lifecycle
// =============================================================================
console.log('\n[C] index lifecycle');
{
    const dir = project(SMALL);
    const logs = { a: [], b: [] };
    const a = createOrvix(dir, { debug: (m) => logs.a.push(m) });
    const b = createOrvix(dir, { debug: (m) => logs.b.push(m) });
    ok('the status starts empty', same(a.status(), { enabled: true, symbols: 0, indexing: false, dirty: false }));

    const events = [];
    const stop = a.onStatus((s) => events.push(s));
    const steps = [];
    const ui = { step: (label) => { steps.push(['start', label]); return { done: (x) => steps.push(['done', x]), fail: (x) => steps.push(['fail', x]) }; } };
    const started = await a.ensureIndex({ ui });
    ok('ensureIndex starts the build and says so', started.enabled === true && started.building === true && started.symbols === 0 && started.step && typeof started.step.detach === 'function');
    ok('...shown as a step', same(steps, [['start', 'indexing symbols (orvix)']]));
    ok('...indexing is reported', a.status().indexing === true && b.status().indexing === true);
    const second = await b.ensureIndex();
    ok('a second runtime of the same directory joins the build instead of starting one', second.building === true && logs.a.some((m) => /indexing/.test(m)) && logs.b.length === 0);

    ok('a query while the first build runs says to use text search', (await a.find('add')).error === orvixLib.BUILDING && (await b.show('add')).error === orvixLib.BUILDING && (await a.map(100)).error === orvixLib.BUILDING);
    ok('...and so do the others', (await a.whoCalls('add')).error === orvixLib.BUILDING && (await a.calls('add')).error === orvixLib.BUILDING);
    ok('ready() with no time to wait is false', (await b.ready(0)) === false);
    ok('ready() waits for the build', (await a.ready(30000)) === true);
    ok('the symbols are on disk and counted', exists(dir, '.orvix/symbols.json') && a.status().symbols === SMALL_SYMBOLS);
    ok('the step ended with the symbol count', steps.length === 2 && steps[1][0] === 'done' && steps[1][1] === `${SMALL_SYMBOLS} symbols`);
    ok('listeners saw it start and finish', events.length === 2 && events[0].indexing === true && events[1].indexing === false && events[1].symbols === SMALL_SYMBOLS);
    ok('both runtimes see the same status', same(a.status(), b.status()));
    const seen = events.length;
    stop();
    a.markDirty();
    await a.settle(30000);
    ok('a stopped listener hears nothing more', events.length === seen);

    ok('.orvix/ is excluded through the repository, once', occurrences(read(dir, '.git/info/exclude'), '.orvix/') === 1);
    ok('the project .gitignore is not touched (not even created)', !exists(dir, '.gitignore'));
    ok('git status does not list the index', !git(dir, 'status', '--porcelain', '-uall').includes('.orvix'));
    await createOrvix(dir).ensureIndex();
    ok('a later instance does not add the line again', occurrences(read(dir, '.git/info/exclude'), '.orvix/') === 1);

    // already ignored by the project: nothing is added to info/exclude
    const ignored = project({ ...SMALL, '.gitignore': '.orvix/\n' });
    const before = read(ignored, '.git/info/exclude');
    const o2 = createOrvix(ignored);
    await o2.ensureIndex();
    await o2.ready(30000);
    ok('a project that ignores .orvix/ already keeps its exclude file as it was', o2.status().symbols === SMALL_SYMBOLS && read(ignored, '.git/info/exclude') === before && read(ignored, '.gitignore') === '.orvix/\n');

    // no repository: no exclusion is attempted, and no file of the project is written
    const bare = project(Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((n) => [`${n}.js`, `function ${n}() {}\n`])), { git: false });
    const o3 = createOrvix(bare);
    await o3.ensureIndex();
    await o3.ready(30000);
    ok('outside a repository the index is built and nothing else is written', o3.status().symbols === 5 && exists(bare, '.orvix/symbols.json') && !exists(bare, '.gitignore') && !exists(bare, '.git'));

    // a pre-existing exclude file without a final newline is respected
    const noNl = project(SMALL);
    fs.writeFileSync(path.join(noNl, '.git/info/exclude'), 'build/');
    const o4 = createOrvix(noNl);
    await o4.ensureIndex();
    await o4.ready(30000);
    ok('an exclude file that did not end with a newline keeps its content', read(noNl, '.git/info/exclude') === 'build/\n.orvix/\n');

    // the index is not rebuilt when there is one
    const again = createOrvix(dir, { debug: (m) => logs.b.push(m) });
    const reused = await again.ensureIndex();
    ok('ensureIndex with an index in place builds nothing', reused.building === false && reused.symbols === SMALL_SYMBOLS && reused.step === null && !logs.b.some((m) => /indexing/.test(m)));
    ok('...and its status is the index as it is', same(again.status(), a.status()));

    // a broken orvix: the failure is reported, never thrown, and not retried at once
    const broken = project(SMALL);
    const fake = path.join(broken, 'fake-orvix.cjs');
    fs.writeFileSync(fake, '#!/usr/bin/env node\nprocess.stderr.write("boom: cannot index\\n");\nprocess.exit(3);\n');
    fs.chmodSync(fake, 0o755);
    const failedSteps = [];
    const o5 = createOrvix(broken, { config: { orvix: { bin: fake } } });
    ok('with config.orvix.bin the executable is used', o5.enabled === true);
    await o5.ensureIndex({ ui: { step: () => ({ done: () => failedSteps.push('done'), fail: (t) => failedSteps.push(t) }) } });
    await o5.settle(15000);
    ok('a failing index run is reported on the step', failedSteps.length === 1 && /^orvix: boom: cannot index/.test(failedSteps[0]));
    ok('...the status stays empty and not indexing', o5.status().symbols === 0 && o5.status().indexing === false);
    const afterFail = await o5.find('add');
    ok('...queries say the index is not available, with the reason', /not available.*boom/.test(afterFail.error) && !/still building/.test(afterFail.error));
    const retry = await o5.ensureIndex();
    ok('...and it is not retried straight away', retry.building === false && o5.status().indexing === false);

    // an index that orvix itself built, in a repository that does not ignore it yet: adopted, and kept out of git status
    const prebuilt = project(SMALL);
    execFileSync(process.execPath, [location.main, 'index', prebuilt], { stdio: 'ignore' });
    ok('an index built by hand is not excluded from git yet', exists(prebuilt, '.orvix/symbols.json') && !read(prebuilt, '.git/info/exclude').includes('.orvix/'));
    const adopted = await createOrvix(prebuilt).ensureIndex();
    ok('ensureIndex adopts an existing index and excludes it from git', adopted.building === false && adopted.symbols === SMALL_SYMBOLS && occurrences(read(prebuilt, '.git/info/exclude'), '.orvix/') === 1 && !git(prebuilt, 'status', '--porcelain', '-uall').includes('.orvix'));

    // an index that cannot be refreshed: compression does not trust it, and queries do not hammer the refresh
    const flaky = project({ ...SMALL, 'src/big.js': BIG });
    const seed = createOrvix(flaky);
    await seed.ensureIndex();
    await seed.ready(30000);
    const callLog = path.join(flaky, 'calls.log');
    const refuser = path.join(flaky, 'refuse-orvix.cjs');
    fs.writeFileSync(refuser, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(callLog)}, process.argv.slice(2).join(' ') + '\\n');\nprocess.stderr.write('refused\\n');\nprocess.exit(2);\n`);
    fs.chmodSync(refuser, 0o755);
    const o7 = createOrvix(flaky, { sessionId: 'flaky-session', config: { orvix: { bin: refuser } } });
    const indexCalls = () => (exists(flaky, 'calls.log') ? read(flaky, 'calls.log') : '').split('\n').filter((line) => line.startsWith('index ')).length;
    o7.markDirty(); // something changed that only an index run can pick up
    const bigText = read(flaky, 'src/big.js');
    ok('compression does not trust an index that cannot be brought up to date', (await o7.compress('Read', { file_path: path.join(flaky, 'src/big.js') }, bigText)) === bigText);
    ok('...after one attempt to refresh it', indexCalls() === 1);
    ok('a query that orvix refuses answers with what orvix said', (await o7.find('add')).error === 'refused');
    await o7.find('double');
    ok('queries do not start the refresh again while it backs off', indexCalls() === 1);
    ok('a map orvix refuses answers with what orvix said', (await o7.map(100)).error === 'refused');
    ok('...and so does gain', (await o7.gain()).error === 'refused');

    // a change that arrives while a run works, whose debounce fires before the run ends, still gets its own pass
    const lost = project(SMALL);
    const counter = path.join(lost, 'index-count');
    const slowBin = path.join(lost, 'slow-orvix.cjs');
    fs.writeFileSync(slowBin, [
        '#!/usr/bin/env node',
        "const fs = require('fs');",
        "const { spawnSync } = require('child_process');",
        `const counter = ${JSON.stringify(counter)};`,
        "if (process.argv[2] === 'index') {",
        "  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;",
        "  fs.writeFileSync(counter, String(n + 1));",
        '  if (n === 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000); // only the first run is slow',
        '}',
        `const res = spawnSync(process.execPath, [${JSON.stringify(location.main)}, ...process.argv.slice(2)], { stdio: 'inherit' });`,
        'process.exit(res.status === null ? 1 : res.status);',
        '',
    ].join('\n'));
    fs.chmodSync(slowBin, 0o755);
    const slow = createOrvix(lost, { config: { orvix: { bin: slowBin } } });
    const slowRun = slow.indexNow(); // takes two seconds...
    slow.markDirty(); // ...and a change arrives: its debounce (1.5 s) fires while that run still works
    await sleep(1700);
    ok('the debounce fired during the run without starting a second one', slow.status().indexing === true && Number(read(lost, 'index-count')) === 1);
    await slowRun;
    ok('the change that arrived meanwhile is still pending when the run ends', slow.status().dirty === true);
    await slow.settle(30000);
    ok('...and gets its own pass', slow.status().dirty === false && slow.status().indexing === false && Number(read(lost, 'index-count')) === 2);

    // answers orvix should never give, but another build might: an { error } or a safe default, never a crash
    const odd = project(SMALL);
    const oddSeed = createOrvix(odd);
    await oddSeed.ensureIndex();
    await oddSeed.ready(30000);
    const oddBin = path.join(odd, 'odd-orvix.cjs');
    fs.writeFileSync(oddBin, [
        '#!/usr/bin/env node',
        'const sub = process.argv[2];',
        "if (sub === 'show' && process.argv[3] === 'num') process.stdout.write('5');",
        "else if (sub === 'show') process.stdout.write(JSON.stringify({ id: 'x1', name: 'n', kind: 'function', file: 'a.js', startLine: 1, endLine: 1, signature: 'function n()', exported: true }));",
        "else if (sub === 'who-calls') process.stdout.write('not json at all');",
        "else if (sub === 'gain') process.stdout.write('{}');",
        "else process.stdout.write('{\"find\":\"not a list\"}');",
        '',
    ].join('\n'));
    fs.chmodSync(oddBin, 0o755);
    const weird = createOrvix(odd, { config: { orvix: { bin: oddBin } } });
    ok('a symbol without a source has an empty one', (await weird.show('x1')).source === '');
    ok('an answer that is not a symbol is an error, not a crash', (await weird.show('num')).error === 'orvix returned an unexpected answer');
    ok('an answer that is not a list is an error too', (await weird.find('a')).error === 'orvix returned an unexpected answer');
    ok('...also when it is not JSON at all', (await weird.whoCalls('x')).error === 'orvix returned an unexpected answer');
    ok('...and for gain', (await weird.gain()).error === 'orvix returned an unexpected answer');

    // orvix init: the one path that writes AGENTS.md and .gitignore, at the user's request
    const initDir = project(SMALL);
    const initOrvix = createOrvix(initDir);
    const initEvents = [];
    initOrvix.onStatus((s) => initEvents.push(s));
    const refusedInit = await initOrvix.init({ agents: ['codex', 'nope'] });
    ok('init refuses an unknown agent before orvix runs, and says which are known', refusedInit.ok === false && /unknown agent: nope \(use claude, codex, cursor, gemini\)/.test(refusedInit.output) && !exists(initDir, 'AGENTS.md') && !exists(initDir, '.orvix'));
    const inited = await initOrvix.init({ agents: [' Codex '] });
    ok('init writes the instruction file and the index', inited.ok === true && read(initDir, 'AGENTS.md').includes('<!-- orvix:start -->') && read(initDir, '.gitignore').includes('.orvix/') && initOrvix.status().symbols === SMALL_SYMBOLS);
    ok('...the listeners hear the new symbol count, and nothing is left pending', initEvents.length >= 1 && initEvents[initEvents.length - 1].symbols === SMALL_SYMBOLS && initOrvix.status().dirty === false);
}

// =============================================================================
// [D] queries
// =============================================================================
console.log('\n[D] queries');
{
    const { orvix } = await indexed();
    const found = await orvix.find('add');
    ok('find returns the documented shape', Array.isArray(found) && found.length >= 1 && same(Object.keys(found[0]).sort(), ['endLine', 'exported', 'file', 'id', 'kind', 'name', 'signature', 'startLine']));
    const add = found.find((s) => s.name === 'add');
    ok('...with the symbol facts', add && add.kind === 'function' && add.file === 'src/math.js' && add.startLine === 1 && add.endLine === 3 && add.signature === 'function add(a, b)' && add.exported === true);
    ok('...and no byte offsets', !('startByte' in add) && !('endByte' in add));
    const open = (await orvix.find('open')).find((s) => s.name === 'open');
    ok('a method carries its container', open && open.kind === 'method' && open.container === 'Box');
    ok('a query with no match is an empty list', same(await orvix.find('zzzzqqq'), []));
    ok('an empty query is an error, not a crash', (await orvix.find('  ')).error === 'empty query');
    ok('a query cannot start with a dash (the CLI would read an option)', (await orvix.find('--json')).error.includes('start with'));

    const shown = await orvix.show(add.id);
    ok('show returns the symbol and its exact source', shown.id === add.id && shown.name === 'add' && shown.source === 'function add(a, b) {\n  return a + b;\n}' && shown.startLine === 1);
    ok('show takes a short id prefix', (await orvix.show(add.id.slice(0, 5))).source === shown.source);
    ok('show takes a name', (await orvix.show('double')).source.startsWith('function double(n)'));
    ok('show takes a qualified method name', (await orvix.show('Box.open')).source.includes('helper()'));
    const ambiguous = await orvix.show('helper');
    ok('an ambiguous name answers with the candidates', ambiguous.ambiguous === true && ambiguous.candidates.length === 2 && ambiguous.candidates.every((c) => c.id && c.file && c.startLine && c.signature) && /matches 2 symbols/.test(ambiguous.message));
    ok('...and one id from them resolves it', /return [12]/.test((await orvix.show(ambiguous.candidates[0].id)).source));
    ok('an unknown symbol is an error', /no symbol matches/.test((await orvix.show('zzzzqqq')).error));
    ok('an empty reference is an error', (await orvix.show('')).error === 'empty symbol id or name' && (await orvix.whoCalls(null)).error === 'empty symbol id or name');
    ok('a reference cannot start with a dash', (await orvix.show('-p')).error.includes('start with') && (await orvix.calls('--json')).error.includes('start with'));

    const callers = await orvix.whoCalls('add');
    ok('who-calls lists the callers', same(callers.map((s) => s.name), ['double']));
    ok('who-calls follows imports across files', same((await orvix.whoCalls('double')).map((s) => s.name), ['run']));
    ok('calls lists the dependencies', same((await orvix.calls('double')).map((s) => s.name), ['add']));
    ok('a symbol nobody calls has an empty list', same(await orvix.whoCalls('run'), []));
    ok('an ambiguous reference works for who-calls and calls too', (await orvix.whoCalls('helper')).ambiguous === true && (await orvix.calls('helper')).ambiguous === true);

    const map = await orvix.map(400);
    ok('map is the readable text', typeof map === 'string' && map.includes('src/math.js') && map.includes('function add(a, b)') && !map.trim().startsWith('['));
    ok('...without trailing whitespace', map === map.trimEnd());
    ok('map without a budget uses the configured one', typeof (await orvix.map()) === 'string' && orvix.mapBudget === 1500);
    const tiny = await orvix.map(50);
    ok('a small budget gives a smaller map', typeof tiny === 'string' && tiny.length < (await orvix.map(5000)).length);
    const scoped = await orvix.map(400, { path: 'src/math.js' });
    ok('map can be narrowed to a file', scoped.includes('function add(a, b)') && !scoped.includes('src/app.js') && !scoped.includes('src/box.js'));
    const dirScoped = await orvix.map(2000, { path: 'src' });
    ok('...or to a directory', dirScoped.includes('src/app.js') && dirScoped.includes('src/big.js'));
    ok('...and a path with nothing in it says so', (await orvix.map(400, { path: 'nowhere' })).startsWith('no indexed symbols under nowhere'));
    ok('a huge budget is capped, not refused', typeof (await orvix.map(10 ** 9)) === 'string');
    ok('a map that does not wait for a refresh also answers', typeof (await orvix.map(200, { wait: false })) === 'string');
    ok('gain starts at zero', same(await orvix.gain(), { compressions: 0, before: 0, after: 0, saved: 0, ratio: 0 }));

    // a path is looked up in a map several times larger than the budget asked for: a file the ranking puts last still shows
    const crowd = {};
    for (let i = 0; i < 25; i++) crowd[`pkg/m${i}.js`] = `export function fn${i}() {\n  return ${i};\n}\n`;
    crowd['main.js'] = `${Array.from({ length: 25 }, (_, i) => `import { fn${i} } from './pkg/m${i}.js';`).join('\n')}\nexport function main() {\n  return [${Array.from({ length: 25 }, (_, i) => `fn${i}()`).join(', ')}];\n}\n`;
    crowd['zzz/leaf.js'] = 'export function leaf() {\n  return 0;\n}\n';
    const crowdDir = project(crowd);
    const crowdOrvix = createOrvix(crowdDir);
    await crowdOrvix.ensureIndex();
    await crowdOrvix.ready(30000);
    ok('(the plain map at a small budget does not reach the last file)', !(await crowdOrvix.map(100)).includes('zzz/leaf.js'));
    const leafMap = await crowdOrvix.map(100, { path: 'zzz' });
    ok('...but asking for its path finds it', leafMap.includes('zzz/leaf.js') && leafMap.includes('function leaf()'));
}

// =============================================================================
// [E] freshness: known writes, unknown changes
// =============================================================================
console.log('\n[E] freshness');
{
    const { dir, orvix } = await indexed();
    const dirtyLog = () => (exists(dir, '.orvix/dirty') ? read(dir, '.orvix/dirty') : '');

    // a status listener that throws must not break the index, nor the listeners after it
    const failing = orvix.onStatus(() => { throw new Error('a listener that fails'); });
    const careful = [];
    const stopCareful = orvix.onStatus((status) => careful.push(status));
    orvix.markDirty(['src/app.js']);
    ok('a listener that throws does not stop the others, nor markDirty', careful.length === 1 && careful[0].dirty === true);
    failing();
    stopCareful();
    await orvix.find('run'); // applies the log
    ok('...and the project is clean again', orvix.status().dirty === false);

    fs.writeFileSync(path.join(dir, 'src/extra.js'), 'export function gamma() {\n  return 3;\n}\n');
    orvix.markDirty(['src/extra.js']);
    ok('a write to a known file goes to the dirty log', dirtyLog() === 'src/extra.js\n');
    ok('...and the status says changes are pending', orvix.status().dirty === true && orvix.status().indexing === false);
    ok('the next query sees the new file', (await orvix.find('gamma')).some((s) => s.name === 'gamma'));
    ok('...and applying it empties the log', dirtyLog() === '' && orvix.status().dirty === false);

    fs.writeFileSync(path.join(dir, 'src/extra.js'), 'export function gamma() {\n  return 3;\n}\nexport function delta() {\n  return 4;\n}\n');
    orvix.markDirty([path.join(dir, 'src/extra.js')]);
    ok('an absolute path is logged relative to the project', dirtyLog() === 'src/extra.js\n');
    ok('an edit shows up as well', (await orvix.find('delta')).some((s) => s.name === 'delta'));

    fs.rmSync(path.join(dir, 'src/extra.js'));
    const heard = [];
    const unlisten = orvix.onStatus((status) => heard.push(status));
    orvix.markDirty(['src/extra.js']);
    orvix.markDirty(['src/extra.js']);
    ok('listeners hear a change once, not once per call', heard.length === 1 && heard[0].dirty === true);
    ok('a deleted file is dropped from the index', same(await orvix.find('gamma'), []));
    unlisten();

    orvix.markDirty(['README.md', 'notes.txt', '../outside.js', '/etc/hosts', 'src']);
    ok('files orvix does not index, and paths outside the project, are ignored', dirtyLog() === '' && orvix.status().dirty === false);
    orvix.markDirty([]);
    ok('an empty list is the same as "anything may have changed"', orvix.status().dirty === true);
    await orvix.settle(30000);
    ok('...which an index run settles', orvix.status().dirty === false && orvix.status().indexing === false);

    // a change nobody can name: an index run, and the query waits for it
    fs.writeFileSync(path.join(dir, 'src/shell.js'), 'export function epsilon() {\n  return 5;\n}\n');
    orvix.markDirty();
    ok('markDirty() with no files marks the project dirty', orvix.status().dirty === true);
    ok('a query after it waits for the refresh and sees the change', (await orvix.find('epsilon')).some((s) => s.name === 'epsilon'));
    await orvix.settle(30000);
    ok('the project is clean afterwards', orvix.status().dirty === false);

    // the map waits for the refresh as well, and the symbol count follows the index
    const symbolsBefore = orvix.status().symbols;
    fs.writeFileSync(path.join(dir, 'src/zeta.js'), 'export function zeta() {\n  return 6;\n}\nexport function zeta2() {\n  return 7;\n}\n');
    orvix.markDirty();
    ok('a map after an unnamed change waits for the refresh and shows it', (await orvix.map(5000)).includes('function zeta()'));
    await orvix.settle(30000);
    ok('the symbol count follows the index', orvix.status().symbols === symbolsBefore + 2);

    // the dirty log is trimmed by an index run: what the run saw goes
    fs.appendFileSync(path.join(dir, '.orvix/dirty'), 'src/app.js\n');
    ok('an entry is pending', orvix.status().dirty === true);
    const run = await orvix.indexNow();
    ok('indexNow runs now and reports the summary', run.ok === true && run.summary && run.summary.files === fs.readdirSync(path.join(dir, 'src')).filter((f) => f.endsWith('.js')).length && typeof run.summary.symbols === 'number' && run.symbols === run.summary.symbols);
    ok('...the entries it took into account are gone', dirtyLog() === '' && orvix.status().dirty === false);

    // what is written to the log while a run works was not seen by it: that stays
    fs.writeFileSync(path.join(dir, '.orvix/dirty'), 'src/app.js\n');
    const partial = orvix.indexNow();
    orvix.markDirty(['src/math.js']);
    await partial;
    ok('an entry written during a run stays in the log', dirtyLog() === 'src/math.js\n');
    await orvix.find('add'); // applies it
    ok('...until a query applies it', dirtyLog() === '' && orvix.status().dirty === false);

    // the debounce: a burst of markDirty() calls is one run, which flush() starts without waiting
    const logs = [];
    const burst = createOrvix(dir, { debug: (m) => logs.push(m) });
    burst.markDirty(); burst.markDirty(); burst.markDirty();
    ok('nothing runs while the debounce waits', burst.status().indexing === false && logs.length === 0);
    burst.flush();
    ok('flush() starts the pending refresh at once', burst.status().indexing === true);
    await burst.settle(30000);
    ok('...one run for the whole burst', logs.filter((m) => /indexing/.test(m)).length === 1);
    burst.flush();
    ok('flush() with nothing pending does nothing', burst.status().indexing === false);

    // a change that arrives while a run is working gets its own pass
    const racing = createOrvix(dir);
    const first = racing.indexNow();
    ok('indexNow while a run is in flight joins it', racing.indexNow() === first);
    racing.markDirty();
    await first;
    ok('a change during the run keeps the project dirty and schedules another pass', racing.status().dirty === true);
    await racing.settle(30000);
    ok('...which settle waits for', racing.status().dirty === false && racing.status().indexing === false);

    // markDirty before there is any index builds one lazily
    const lazy = project(SMALL);
    const o = createOrvix(lazy);
    o.markDirty(['src/math.js']);
    ok('with no index yet a known write does not create the cache by itself', !exists(lazy, '.orvix'));
    await o.settle(30000);
    ok('...the debounced pass builds the first index', o.status().symbols === SMALL_SYMBOLS && exists(lazy, '.orvix/symbols.json'));
}

// =============================================================================
// [F] result compression
// =============================================================================
console.log('\n[F] compression');
{
    const { dir, orvix } = await indexed({ 'notes/long.md': Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n') }, { sessionId: 'session-one' });
    const abs = (rel) => path.join(dir, rel);
    const HINT = 'This result came from the orvix index';

    const small = read(dir, 'src/math.js');
    ok('a small file is left alone', (await orvix.compress('Read', { file_path: abs('src/math.js') }, small)) === small);
    const big = read(dir, 'src/big.js');
    const compressed = await orvix.compress('Read', { file_path: abs('src/big.js') }, big);
    ok('a large indexed file comes back as its symbol map', compressed !== big && compressed.length < big.length / 2 && /^src\/big\.js — 301 lines, 30 symbols \(body elided by orvix\)/.test(compressed));
    ok('...listing the symbols with ids and line ranges', /fn0\(a, b\)\s+:1-10/.test(compressed) && /fn29\(a, b\)\s+:291-300/.test(compressed));
    ok('...and it says how to get the text back', compressed.includes('read this file again or pass offset/limit'));
    ok('...the first compression of a session carries the hint about the index', compressed.includes(HINT) && compressed.indexOf(HINT) > compressed.indexOf('pass offset/limit'));
    ok('the same file read again is the real text', (await orvix.compress('Read', { file_path: abs('src/big.js') }, big)) === big);

    fs.writeFileSync(path.join(dir, 'src/unknown.js'), big);
    ok('a big file the index does not know is left alone', (await orvix.compress('Read', { file_path: abs('src/unknown.js') }, big)) === big);
    const md = read(dir, 'notes/long.md');
    ok('a big file that is not code is left alone', (await orvix.compress('Read', { file_path: abs('notes/long.md') }, md)) === md);
    ok('a file outside the project is left alone', (await orvix.compress('Read', { file_path: path.join(os.tmpdir(), 'elsewhere.js') }, big)) === big);

    const two = createOrvix(dir, { sessionId: 'session-two' });
    const again = await two.compress('Read', { file_path: abs('src/big.js') }, big);
    ok('another session is compressed again (and gets its own hint)', again !== big && again.includes(HINT));
    ok('...the hint comes once per session', !(await two.compress('Read', { file_path: abs('src/big.js') }, big)).includes(HINT));

    // search hits: a grep through the shell, rewritten as the symbols that contain them
    const hits = Array.from({ length: 30 }, (_, i) => `src/big.js:${i + 1}:  line ${i + 1} of the search result text`).join('\n');
    const found = await orvix.compress('Bash', { command: 'grep -rn body src' }, hits);
    ok('search hits become the symbols that contain them', /^3 symbols contain the matches \(30 hits, resolved by orvix\)/.test(found) && found.length < hits.length / 2);
    ok('...with their ids and locations', /\bfunction fn0\(a, b\)/.test(found) && /src\/big\.js:11\s+function fn1\(a, b\)/.test(found) && /fn2\(a, b\)/.test(found));
    ok('a Grep result is treated the same way', (await orvix.compress('Grep', { pattern: 'body' }, hits)).startsWith('3 symbols contain the matches'));
    const literals = Array.from({ length: 30 }, (_, i) => `docs/guide.md:${i + 1}:  TODO number ${i + 1} remains here`).join('\n');
    ok('hits that are not inside symbols (TODOs, literals) are left alone', (await orvix.compress('Bash', { command: 'grep -rn TODO docs' }, literals)) === literals);
    ok('too few hits are left alone', (await orvix.compress('Bash', { command: 'grep x' }, 'src/big.js:1:a\nsrc/big.js:2:b')) === 'src/big.js:1:a\nsrc/big.js:2:b');
    ok('output that is not a search is left alone', (await orvix.compress('Bash', { command: 'npm test' }, hits)) === hits);
    ok('an unknown tool name is left alone', (await orvix.compress('Edit', { file_path: abs('src/big.js') }, big)) === big);
    ok('empty and non-string results are left alone', (await orvix.compress('Read', { file_path: abs('src/big.js') }, '')) === '' && (await orvix.compress('Read', {}, undefined)) === undefined);
    const huge = 'x\n'.repeat(1024 * 1024 + 1); // 2 MiB + 2 characters, a million lines of a file the index knows
    ok('a result over the size cap is not even sent to the hook', (await orvix.compress('Read', { file_path: abs('src/big.js') }, huge)) === huge);

    // a write the index has not caught up with is applied before the hook trusts the index
    const edited = BIG + Array.from({ length: 12 }, (_, i) => fn('late', i)).join('');
    fs.writeFileSync(path.join(dir, 'src/big.js'), edited);
    const fresh = createOrvix(dir, { sessionId: 'session-three' });
    fresh.markDirty(['src/big.js']);
    const afterWrite = await fresh.compress('Read', { file_path: abs('src/big.js') }, edited);
    ok('a file written moments ago is compressed from its current symbols', /421 lines, 42 symbols/.test(afterWrite) && /late11\(a, b\)/.test(afterWrite));
    // a change nobody named, in flight: compression waits for the index run
    const withRun = createOrvix(dir, { sessionId: 'session-four' });
    fs.writeFileSync(path.join(dir, 'src/big.js'), edited + fn('later', 0));
    withRun.markDirty();
    const waited = await withRun.compress('Read', { file_path: abs('src/big.js') }, edited + fn('later', 0));
    ok('with a refresh pending, compression waits for it and still compresses', /431 lines, 43 symbols/.test(waited) && /later0\(a, b\)/.test(waited));

    const gain = await orvix.gain();
    ok('gain counts the compressions made', gain.compressions >= 5 && gain.saved > 0 && gain.before > gain.after && gain.ratio > 0 && gain.ratio < 1);

    // no index (yet): nothing is rewritten
    const cold = createOrvix(project(SMALL));
    ok('before the index exists a result is left alone', (await cold.compress('Read', { file_path: path.join(cold.root, 'src/math.js') }, big)) === big);

    // the first build is in flight: nothing is rewritten, and the read does not wait for the build
    const building = project({ ...SMALL, 'src/big.js': BIG });
    const buildingOrvix = createOrvix(building, { sessionId: 'building-session' });
    await buildingOrvix.ensureIndex();
    const during = await buildingOrvix.compress('Read', { file_path: path.join(building, 'src/big.js') }, big);
    ok('while the first index is being built a result is left alone, without waiting', buildingOrvix.status().indexing === true && during === big);
    await buildingOrvix.settle(30000);
    ok('...once it is built the same read is compressed', (await buildingOrvix.compress('Read', { file_path: path.join(building, 'src/big.js') }, big)) !== big);
}

// =============================================================================
// [G] the agent tools
// =============================================================================
console.log('\n[G] agent tools');
{
    const manyItems = Array.from({ length: 60 }, (_, i) => `function item${i}() { return ${i}; }`).join('\n') + '\n';
    const bulk = Array.from({ length: 400 }, (_, i) => `function bulkfunction${i}(alpha, beta) { return alpha + beta + ${i}; }`).join('\n') + '\n';
    const { dir, orvix } = await indexed({ 'src/many.js': manyItems, 'src/bulk.js': bulk }, { sessionId: 'tools-session' });
    const files = {
        readFile: async (f) => fs.readFileSync(path.join(dir, f), 'utf8'),
        writeFile: async (f, c) => { fs.writeFileSync(path.join(dir, f), c); return true; },
        editFile: async (f) => { fs.appendFileSync(path.join(dir, f), '\nexport function edited() {}\n'); return { ok: true, applied: 1 }; },
        executeBash: async () => ({ output: 'ran' }),
        ask: async () => '',
        userDirectory: dir,
    };
    const engine = { traverseDirectory: async () => ({ sourceTree: '', filesArray: [] }) };
    const build = (ctx = {}, allowed = null) => agents.buildTools({ engine, ctx: { ...files, ...ctx }, cwd: dir }, allowed);
    const NAV = NAV_TOOLS;
    const run = async (tools, name, input) => await tools[name].execute(input, { toolCallId: 't', messages: [] });
    const dirtyOf = () => (exists(dir, '.orvix/dirty') ? read(dir, '.orvix/dirty') : '');

    const tools = build({ orvix }, [...NAV, 'read_file', 'write_file', 'edit_file', 'run_bash']);
    ok('the five navigation tools exist while the index is active', NAV.every((n) => tools[n]));
    const noIndex = build({ orvix: createOrvix(project({ 'a.js': 'x' }, { git: false })) }, [...NAV, 'read_file']);
    ok('...and not without it', NAV.every((n) => !build({}, [...NAV, 'read_file'])[n]) && NAV.every((n) => !noIndex[n]) && noIndex.read_file);
    ok('the default read-only set includes them', NAV.every((n) => build({ orvix })[n]) && build({ orvix }).read_file && !build({ orvix }).write_file);

    const map = await run(tools, 'code_map', { budget: 300, path: null });
    ok('code_map returns the text map', typeof map === 'string' && map.includes('src/math.js'));
    const fileMap = await run(tools, 'code_map', { budget: null, path: 'src/math.js' });
    ok('code_map takes a path', fileMap.includes('function add(a, b)') && !fileMap.includes('src/app.js'));
    ok('...and null for both', typeof (await run(tools, 'code_map', { budget: null, path: null })) === 'string');
    ok('code_map honors its budget', (await run(tools, 'code_map', { budget: 60, path: null })).length < (await run(tools, 'code_map', { budget: null, path: null })).length / 2);
    const widest = await run(tools, 'code_map', { budget: 20000, path: null });
    ok('a huge budget still answers within the output cap, and says it was cut', widest.length <= 12100 && /\[truncated \d+ chars\]$/.test(widest));

    const syms = await run(tools, 'find_symbol', { query: 'double' });
    ok('find_symbol returns the symbol list', Array.isArray(syms) && syms[0].name === 'double' && syms[0].file === 'src/math.js');
    const capped = await run(tools, 'find_symbol', { query: 'item' });
    ok('a long list is capped, with the total and a hint', capped.total === 60 && capped.shown === 50 && capped.symbols.length === 50 && /refine/.test(capped.note));
    fs.writeFileSync(path.join(dir, 'src/fifty.js'), Array.from({ length: 50 }, (_, i) => `function unitfn${i}() { return ${i}; }`).join('\n') + '\n');
    orvix.markDirty(['src/fifty.js']);
    const fifty = await run(tools, 'find_symbol', { query: 'unitfn' });
    ok('...but exactly 50 matches are listed whole', Array.isArray(fifty) && fifty.length === 50);
    ok('a query with no match is an empty list', same(await run(tools, 'find_symbol', { query: 'zzzzqqq' }), []));
    ok('an orvix failure is an { error } value', (await run(tools, 'find_symbol', { query: '--x' })).error.includes('start with'));

    const shown = await run(tools, 'show_symbol', { id: 'add' });
    ok('show_symbol returns the source', shown.name === 'add' && shown.source.includes('return a + b') && shown.startLine === 1);
    const amb = await run(tools, 'show_symbol', { id: 'helper' });
    ok('an ambiguous show_symbol returns the candidates', amb.ambiguous === true && amb.candidates.length === 2);
    ok('an unknown symbol is an error', /no symbol matches/.test((await run(tools, 'show_symbol', { id: 'zzzzqqq' })).error));
    ok('who_calls and calls return the candidates of an ambiguous name too', (await run(tools, 'who_calls', { id: 'helper' })).ambiguous === true && (await run(tools, 'calls', { id: 'helper' })).ambiguous === true);
    const callers = await run(tools, 'who_calls', { id: 'add' });
    ok('who_calls lists callers', Array.isArray(callers) && callers[0].name === 'double');
    const none = await run(tools, 'who_calls', { id: 'run' });
    ok('who_calls with no callers carries the receiver-call note', same(none.symbols, []) && /through a receiver \(obj\.method\(\)\) are not attributed/.test(none.note));
    ok('calls lists the dependencies', (await run(tools, 'calls', { id: 'double' }))[0].name === 'add');
    ok('calls with none is an empty list', same(await run(tools, 'calls', { id: 'add' }), []));
    // more than 50 callers or callees: capped with the total, like any symbol list
    const leafDefs = Array.from({ length: 55 }, (_, i) => `function leaf${i}() { return ${i}; }`).join('\n');
    const callerDefs = Array.from({ length: 55 }, (_, i) => `function caller${i}() { return target(); }`).join('\n');
    fs.writeFileSync(path.join(dir, 'src/hub.js'), `${leafDefs}\nfunction hub() {\n  return [${Array.from({ length: 55 }, (_, i) => `leaf${i}()`).join(', ')}];\n}\nfunction target() { return 1; }\n${callerDefs}\n`);
    orvix.markDirty(['src/hub.js']);
    const manyCallees = await run(tools, 'calls', { id: 'hub' });
    ok('calls is capped like the other lists', manyCallees.total === 55 && manyCallees.shown === 50 && manyCallees.symbols.length === 50);
    const manyCallers = await run(tools, 'who_calls', { id: 'target' });
    ok('...and so is who_calls', manyCallers.total === 55 && manyCallers.shown === 50 && manyCallers.symbols.length === 50);

    // a symbol with a huge body: the source is cut to what fits, and the result stays a valid object
    const lines = Array.from({ length: 800 }, (_, i) => `  const v${i} = ${i};`).join('\n');
    fs.writeFileSync(path.join(dir, 'src/giant.js'), `export function giant() {\n${lines}\n}\n`);
    orvix.markDirty(['src/giant.js']);
    const giant = await run(tools, 'show_symbol', { id: 'giant' });
    ok('a symbol with a huge body is truncated, not refused', giant.name === 'giant' && /\[truncated \d+ chars\]$/.test(giant.source) && JSON.stringify(giant).length <= 12000);
    // quotes and backslashes take two characters in JSON: the cut accounts for that
    const quoted = Array.from({ length: 400 }, (_, i) => `  const q${i} = "say \\"hi\\" and \\"bye\\" ${i}";`).join('\n');
    fs.writeFileSync(path.join(dir, 'src/giantq.js'), `export function giantq() {\n${quoted}\n}\n`);
    orvix.markDirty(['src/giantq.js']);
    const giantq = await run(tools, 'show_symbol', { id: 'giantq' });
    ok('...also when its text is mostly escapes', giantq.name === 'giantq' && /\[truncated \d+ chars\]$/.test(giantq.source) && JSON.stringify(giantq).length <= 12000 && giantq.source.length > 4000);
    // one line with nothing to escape: the cut lands exactly on the limit, and the notice that follows must still fit
    fs.writeFileSync(path.join(dir, 'src/giantline.js'), `export function giantline() { return '${'a'.repeat(20000)}'; }\n`);
    orvix.markDirty(['src/giantline.js']);
    const giantline = await run(tools, 'show_symbol', { id: 'giantline' });
    const giantlineSize = JSON.stringify(giantline).length;
    ok('...and when nothing in it needs escaping the notice still fits', giantline.name === 'giantline' && /\[truncated \d+ chars\]$/.test(giantline.source) && giantlineSize <= 12000 && giantlineSize > 11800);
    ok('a source that fits is returned whole', (await run(tools, 'show_symbol', { id: 'add' })).source === 'function add(a, b) {\n  return a + b;\n}');

    // read_file: ranges, full, and the symbol map for a plain read of a big file
    const first = await run(tools, 'read_file', { path: 'src/math.js', offset: null, limit: null, full: null });
    ok('a plain read of a small file is the text', first === read(dir, 'src/math.js'));
    ok('offset and limit return that range, numbered, with the total', (await run(tools, 'read_file', { path: 'src/math.js', offset: 4, limit: 2, full: null })) === 'src/math.js · lines 4-5 of 6\n     4|export function double(n) {\n     5|  return add(n, n);\n… 1 more lines (continue with offset 6)');
    ok('the last range has no continuation footer', (await run(tools, 'read_file', { path: 'src/math.js', offset: 5, limit: 100, full: null })) === 'src/math.js · lines 5-6 of 6\n     5|  return add(n, n);\n     6|}');
    ok('limit alone starts at the top', (await run(tools, 'read_file', { path: 'src/math.js', offset: null, limit: 1, full: null })).startsWith('src/math.js · lines 1-1 of 6\n     1|export function add'));
    ok('offset alone reads a window from there', (await run(tools, 'read_file', { path: 'src/math.js', offset: 3, limit: null, full: null })).startsWith('src/math.js · lines 3-6 of 6'));
    ok('an offset on the very last line is fine', (await run(tools, 'read_file', { path: 'src/math.js', offset: 6, limit: 5, full: null })) === 'src/math.js · lines 6-6 of 6\n     6|}');
    ok('an offset below 1 is the top of the file', (await run(tools, 'read_file', { path: 'src/math.js', offset: 0, limit: 1, full: null })).includes('lines 1-1 of 6'));
    ok('an offset past the end is an error that says how long the file is', (await run(tools, 'read_file', { path: 'src/math.js', offset: 99, limit: 5, full: null })).error === 'offset 99 is past the end of src/math.js (6 lines)');
    fs.writeFileSync(path.join(dir, 'empty.txt'), '');
    ok('an empty file is reported as one', (await run(tools, 'read_file', { path: 'empty.txt', offset: 1, limit: 5, full: null })) === 'empty.txt: (empty file)');
    ok('a file that does not exist is an error', (await run(tools, 'read_file', { path: 'nope.js', offset: null, limit: null, full: null })).error.startsWith('cannot read nope.js'));
    fs.writeFileSync(path.join(dir, 'wide.txt'), 'a'.repeat(5000) + '\nshort\n');
    ok('one very long line is cut in a ranged read', (await run(tools, 'read_file', { path: 'wide.txt', offset: 1, limit: 2, full: null })).includes('a'.repeat(2000) + '…\n     2|short'));
    fs.writeFileSync(path.join(dir, 'lots.txt'), Array.from({ length: 4000 }, (_, i) => `row number ${i + 1} with some padding text`).join('\n'));
    const windowed = await run(tools, 'read_file', { path: 'lots.txt', offset: 1, limit: 3000, full: null });
    ok('a ranged read stays inside the output cap and says where to continue', windowed.length <= 12300 && /continue with offset \d+\)$/.test(windowed));
    fs.writeFileSync(path.join(dir, 'rows.txt'), Array.from({ length: 700 }, (_, i) => `r${i + 1}`).join('\n') + '\n');
    const window500 = await run(tools, 'read_file', { path: 'rows.txt', offset: 1, limit: null, full: null });
    ok('with no limit a ranged read is a window of 500 lines', window500.startsWith('rows.txt · lines 1-500 of 700\n') && window500.endsWith('… 200 more lines (continue with offset 501)'));
    const next = Number(/continue with offset (\d+)/.exec(windowed)[1]);
    ok('...the continuation picks up where it stopped', (await run(tools, 'read_file', { path: 'lots.txt', offset: next, limit: 1, full: null })).includes(`${String(next).padStart(6)}|row number ${next} `));

    const planRead = await run(tools, 'read_file', { path: 'src/big.js', offset: null, limit: null, full: null });
    ok('a plain read of a big indexed file is its symbol map', /^src\/big\.js — 301 lines, 30 symbols/.test(planRead));
    ok('...a second plain read is the text', (await run(tools, 'read_file', { path: 'src/big.js', offset: null, limit: null, full: null })).startsWith('function fn0(a, b) {'));
    const fullRead = build({ orvix: createOrvix(dir, { sessionId: 'full-session' }) }, ['read_file']);
    ok('full: true is the text, never the map', (await run(fullRead, 'read_file', { path: 'src/big.js', offset: null, limit: null, full: true })).startsWith('function fn0(a, b) {'));
    const rangedRead = build({ orvix: createOrvix(dir, { sessionId: 'ranged-session' }) }, ['read_file']);
    ok('a ranged read of a big file is never the map', (await run(rangedRead, 'read_file', { path: 'src/big.js', offset: 1, limit: 2, full: null })).startsWith('src/big.js · lines 1-2 of 300'));
    ok('without the index read_file returns the text, and the new fields are optional for the model', (await run(build({}, ['read_file']), 'read_file', { path: 'src/big.js' })).startsWith('function fn0'));

    // writes mark the file dirty; shell commands mark the project dirty unless they only read
    await orvix.settle(30000);
    fs.rmSync(path.join(dir, '.orvix/dirty'), { force: true });
    await run(tools, 'write_file', { path: 'src/created.js', content: 'export function created() {}\n' });
    ok('write_file marks the file dirty', dirtyOf() === 'src/created.js\n');
    ok('...so the very next symbol query sees it', (await run(tools, 'find_symbol', { query: 'created' })).some((s) => s.name === 'created'));
    await run(tools, 'edit_file', { path: 'src/created.js', instructions: 'add a function' });
    ok('edit_file marks the file dirty', dirtyOf() === 'src/created.js\n');
    ok('...and the edit is found', (await run(tools, 'find_symbol', { query: 'edited' })).some((s) => s.name === 'edited'));
    const refused = build({ orvix, writeFile: async () => false }, ['write_file']);
    ok('a write that was cancelled reports it and marks nothing', (await run(refused, 'write_file', { path: 'src/never.js', content: 'x' })).error.includes('cancelled') && dirtyOf() === '');

    const marks = [];
    const spy = { ...orvix, markDirty: (...args) => { marks.push(args); return orvix.markDirty(...args); } };
    const shell = build({ orvix: spy, executeBash: async () => ({ output: 'ok' }) }, ['run_bash']);
    await run(shell, 'run_bash', { command: 'git status' });
    await run(shell, 'run_bash', { command: 'ls src | head' });
    ok('a read-only command does not mark the project dirty', marks.length === 0);
    await run(shell, 'run_bash', { command: 'npm test' });
    ok('any other command does', marks.length === 1 && marks[0].length === 0);
    const cancelled = build({ orvix: spy, executeBash: async () => false }, ['run_bash']);
    ok('a command that did not run reports it and marks nothing', (await run(cancelled, 'run_bash', { command: 'make' })).error.includes('cancelled') && marks.length === 1);
    await orvix.settle(30000);

    // grep output through run_bash is rewritten as symbols
    const grepOut = Array.from({ length: 30 }, (_, i) => `src/big.js:${i + 1}:  line ${i + 1} of the search result text`).join('\n');
    const grepper = build({ orvix: createOrvix(dir, { sessionId: 'grep-session' }), executeBash: async () => ({ output: grepOut }) }, ['run_bash']);
    ok('run_bash of a grep returns the symbols that contain the hits', (await run(grepper, 'run_bash', { command: 'grep -rn body src' })).startsWith('3 symbols contain the matches'));
    ok('...and the output of any other command is returned as it is', (await run(grepper, 'run_bash', { command: 'cat out.txt' })) === grepOut);
    const stderrOnly = build({ orvix, executeBash: async () => ({ output: '', error: 'bad things' }) }, ['run_bash']);
    ok('stderr is still reported', (await run(stderrOnly, 'run_bash', { command: 'ls missing' })) === '[stderr] bad things');
    await orvix.settle(30000);
}

// =============================================================================
// [H] the system brief and the navigation policy
// =============================================================================
console.log('\n[H] brief and policy');
{
    const nav = agents.loadNavigation();
    ok('the navigation file has both variants', nav.orvix.startsWith('# Code navigation') && nav.basic.startsWith('# Code navigation') && nav.orvix !== nav.basic);
    ok('the orvix variant covers the tools, the receiver-call caveat and the precedence rule', ['find_symbol', 'show_symbol', 'code_map', 'who_calls', 'calls', 'search', 'offset', 'full: true'].every((w) => nav.orvix.includes(w)) && /receiver/.test(nav.orvix) && /takes precedence/.test(nav.orvix) && /never run `orvix index`/.test(nav.orvix));
    ok('...and the table that maps shell commands to tools', ['`orvix map` | `code_map`', '`orvix show <id>` | `show_symbol`', '`orvix find <name>` | `find_symbol`', '`orvix who-calls <id>` | `who_calls`', '`orvix calls <id>` | `calls`'].every((row) => nav.orvix.includes(row)));
    ok('the basic variant is shorter and names no code index tool', nav.basic.length < nav.orvix.length / 2 && !/find_symbol|show_symbol|code_map/.test(nav.basic));
    const defs = await agents.loadAgents();
    ok('agents/_navigation.md is not an agent', !('_navigation' in defs) && Object.keys(defs).sort().join() === 'coder,explorer,main,reviewer');
    ok('every agent lists the navigation tools', Object.values(defs).every((a) => NAV_TOOLS.every((t) => a.tools.includes(t))));
    ok('the read-only agents still cannot write', !defs.explorer.tools.includes('write_file') && !defs.reviewer.tools.includes('write_file') && !defs.explorer.tools.includes('run_bash'));

    const { dir, orvix } = await indexed({ 'AGENTS.md': 'Project rules: AGENTS_MARK.\n\n<!-- orvix:start -->\nrun `orvix map --budget 2000`\n<!-- orvix:end -->\n' });
    // the engine the runtime builds: .git and .orvix are not part of the project snapshot
    const rt = createRuntime({ cwd: dir, keysData: { OPENAI_KEY: 'test' }, flags: {} });
    const engine = rt.codePrompt(path.join(ROOT, 'actions', 'default.md'));
    const captured = [];
    engine.runAgentLoop = async ({ system, tools }) => { captured.push({ system, tools: Object.keys(tools) }); return { text: 'ANSWER' }; };
    const ui = { step: () => ({ done() { }, fail() { }, update() { } }), streamChunk() { }, streamEnd() { }, status() { }, statusStop() { }, isStreaming: () => false };
    const ctxFor = (extra = {}) => ({
        userDirectory: dir, language: 'English', personality: '',
        readFile: async (f) => fs.readFileSync(path.join(dir, f), 'utf8'),
        writeFile: async () => true, editFile: async () => ({ ok: true, applied: 1 }), executeBash: async () => ({ output: '' }), ask: async () => '',
        ...extra,
    });
    const turn = (agentName, ctx, depth = 0) => agents.runAgent({ engine, agentName, agents: defs, task: 'go', ctx, ui, depth, streamAnswer: false });

    const spyCalls = [];
    const spied = { ...orvix, markDirty: (...a) => { spyCalls.push(['markDirty', ...a]); return orvix.markDirty(...a); }, indexNow: () => { spyCalls.push(['indexNow']); return orvix.indexNow(); } };
    await turn('main', ctxFor({ orvix: spied }));
    const system = captured[0].system;
    ok('the system prompt carries the ranked code map instead of the file tree', system.includes('# Code map (orvix)') && system.includes('function add(a, b)') && !system.includes('Project source tree'));
    ok('...a directories overview with file counts, without .git or .orvix', system.includes('# Directories\n- ./ (1 files at the top level)\n- src/ (4 files)\n') && !system.includes('.git/') && !system.includes('.orvix/'));
    ok('...and the pointer to the other tools', system.includes('Use list_files for the complete file tree, find_symbol/show_symbol for code, search for literals.'));
    ok('the navigation policy of the orvix variant is appended', system.includes(nav.orvix));
    ok('...after the project memory, so it takes precedence over the orvix block in AGENTS.md', system.indexOf('# Project memory') > 0 && system.includes('run `orvix map --budget 2000`') && system.indexOf(nav.orvix) > system.indexOf('run `orvix map --budget 2000`'));
    ok('the orchestrator gets the navigation tools', NAV_TOOLS.every((t) => captured[0].tools.includes(t)));
    ok('every orchestrator turn starts a refresh of the index', same(spyCalls, [['markDirty'], ['indexNow']]));
    await turn('explorer', ctxFor({ orvix: spied }), 1);
    ok('a sub-agent does not refresh it again', spyCalls.length === 2);
    ok('...but gets the same policy and tools, read-only', captured[1].system.includes(nav.orvix) && captured[1].tools.includes('find_symbol') && !captured[1].tools.includes('write_file'));

    const tiny = project({ 'a.js': 'x' }, { git: false });
    await turn('main', ctxFor({ userDirectory: tiny, readFile: async (f) => fs.readFileSync(path.join(tiny, f), 'utf8'), orvix: createOrvix(tiny) }));
    ok('without the index the tree stays and the basic policy is used', captured[2].system.includes('Project source tree') && !captured[2].system.includes('# Code map') && captured[2].system.includes(nav.basic) && !captured[2].system.includes(nav.orvix));
    ok('...and the navigation tools are not offered', NAV_TOOLS.every((t) => !captured[2].tools.includes(t)));

    // an index that is still being built: the tree, the orvix policy (its tools say to wait)
    const building = project(SMALL);
    const buildingOrvix = createOrvix(building);
    await buildingOrvix.ensureIndex();
    await turn('main', ctxFor({ userDirectory: building, readFile: async () => '', orvix: buildingOrvix }));
    ok('during the first build the brief falls back to the tree and the tools are offered', captured[3].system.includes('Project source tree') && captured[3].tools.includes('find_symbol'));
    await buildingOrvix.settle(30000);

    await turn('main', ctxFor());
    ok('a context without orvix gets the basic policy', captured[4].system.includes(nav.basic) && !captured[4].tools.includes('find_symbol'));
    await turn('main', ctxFor({ orvix: { ...orvix, map: async () => { throw new Error('boom'); } } }));
    ok('a map that throws falls back to the tree', captured[5].system.includes('Project source tree'));
    await turn('main', ctxFor({ orvix: { ...orvix, map: async () => 'no symbols indexed' } }));
    ok('an empty index falls back to the tree too', captured[6].system.includes('Project source tree') && !captured[6].system.includes('# Code map'));

    // more than 60 directories: the overview is cut, and says how many were left out
    const crowdedTree = project(Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`d${String(i).padStart(2, '0')}/f.js`, `export function f${i}() {}\n`])));
    const crowdedOrvix = createOrvix(crowdedTree);
    await crowdedOrvix.ensureIndex();
    await crowdedOrvix.ready(30000);
    await turn('main', ctxFor({ userDirectory: crowdedTree, readFile: async () => '', orvix: crowdedOrvix }));
    const overview = captured[captured.length - 1].system.split('# Directories\n')[1].split('\n\n')[0].split('\n');
    ok('the directory overview stops at 60 lines and counts the rest', overview.length === 61 && overview[0] === '- d00/ (1 files)' && overview[59] === '- d59/ (1 files)' && overview[60] === '… 10 more directories');

    // how the tools appear in the UI: one line per call, and a short phrase for what came back
    const sym = (name) => ({ id: name, name, kind: 'function', file: 'src/a.js', startLine: 1, endLine: 2, signature: `function ${name}()`, exported: true });
    const rendering = [
        ['read_file', { path: 'src/a.js', offset: 10, limit: 20 }, 'x', 'read src/a.js (lines 10+20)', 'x'],
        ['read_file', { path: 'a.js', offset: null, limit: 5 }, 'x\ny', 'read a.js (lines 1+5)', '2 lines'],
        ['read_file', { path: 'a.js', offset: 7, limit: null }, 'x', 'read a.js (lines 7…)', 'x'],
        ['read_file', { path: 'a.js', offset: null, limit: null }, 'x', 'read a.js', 'x'],
        ['code_map', { budget: null, path: 'src' }, 'a\nb\nc', 'code map src', '3 lines'],
        ['code_map', { budget: 500, path: null }, 'a\nb', 'code map', '2 lines'],
        ['find_symbol', { query: 'q'.repeat(60) }, [sym('a')], `find symbol "${'q'.repeat(40)}"`, '1 symbol'],
        ['find_symbol', { query: 'zz' }, [], 'find symbol "zz"', '0 symbols'],
        ['find_symbol', { query: 'item' }, { total: 60, shown: 50, symbols: [sym('a')] }, 'find symbol "item"', '60 symbols'],
        ['show_symbol', { id: 'add' }, { ...sym('add'), source: 'function add() {}' }, 'show symbol add', 'src/a.js:1-2'],
        ['show_symbol', { id: 'helper' }, { ambiguous: true, message: 'm', candidates: [{ id: 'a' }, { id: 'b' }] }, 'show symbol helper', '2 candidates'],
        ['who_calls', { id: 'add' }, [sym('a'), sym('b')], 'who calls add', '2 symbols'],
        ['who_calls', { id: 'run' }, { symbols: [], note: 'n' }, 'who calls run', 'none found'],
        ['calls', { id: 'add' }, { error: 'boom' }, 'calls of add', 'error'],
    ];
    const stepLog = [];
    const recordingUi = { ...ui, step: (label) => { const entry = { label, result: null }; stepLog.push(entry); return { done: (r) => { entry.result = r; }, fail: (r) => { entry.result = `failed: ${r}`; } }; } };
    const capturingLoop = engine.runAgentLoop;
    let emit = null;
    engine.runAgentLoop = async ({ onEvent }) => { emit(onEvent); return { text: 'done' }; };
    emit = (onEvent) => rendering.forEach(([toolName, input, output], i) => {
        onEvent({ type: 'tool-call', toolCallId: `c${i}`, toolName, input });
        onEvent({ type: 'tool-result', toolCallId: `c${i}`, toolName, input, output });
    });
    await agents.runAgent({ engine, agentName: 'main', agents: defs, task: 'go', ctx: ctxFor({ orvix }), ui: recordingUi, depth: 0, streamAnswer: false });
    const bad = rendering.map((row, i) => ({ row, got: stepLog[i] })).filter(({ row, got }) => !got || got.label !== row[3] || got.result !== row[4]);
    if (bad.length) console.log(JSON.stringify(bad.map(({ row, got }) => ({ expect: [row[3], row[4]], got })), null, 1));
    ok('each call shows as one line with a short summary of the result', bad.length === 0 && stepLog.length === rendering.length);
    stepLog.length = 0;
    emit = (onEvent) => {
        onEvent({ type: 'tool-call', toolCallId: 'd0', toolName: 'find_symbol', input: { query: 'a' } });
        onEvent({ type: 'tool-result', toolCallId: 'd0', toolName: 'find_symbol', input: { query: 'a' }, output: [] });
    };
    await agents.runAgent({ engine, agentName: 'explorer', agents: defs, task: 'go', ctx: ctxFor({ orvix }), ui: recordingUi, depth: 1, streamAnswer: false });
    ok("a sub-agent's calls are indented under its parent", stepLog.length === 1 && stepLog[0].label === '  ↳ find symbol "a"');
    engine.runAgentLoop = capturingLoop;

    // the runtime's snapshot leaves out the repository and the index (they once flooded every prompt)
    fs.mkdirSync(path.join(dir, '.git/objects/aa'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git/objects/aa/bbbb'), 'object');
    Code2Prompt.invalidateTraverseCache();
    const snapshot = await engine.traverseDirectory(dir);
    const paths = snapshot.filesArray.map((f) => f.path).sort();
    ok('the project snapshot has the sources and neither .git nor .orvix', same(paths, ['AGENTS.md', 'src/app.js', 'src/big.js', 'src/box.js', 'src/math.js']));
}

// =============================================================================
// [I] aicode orvix (the command line)
// =============================================================================
console.log('\n[I] aicode orvix');
{
    const cli = (dir, args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'index.js'), ...args], {
        cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: TMP_HOME, USERPROFILE: TMP_HOME, NO_COLOR: '1', ...env },
    });
    const all = (res) => `${res.stdout}${res.stderr}`;

    const dir = project(SMALL);
    let res = cli(dir, ['orvix', 'status']);
    ok('status of a project with no index yet', res.status === 0 && /orvix is active in/.test(res.stdout) && /symbols\s+0/.test(res.stdout) && /indexing\s+no/.test(res.stdout));
    ok('...status with no action is the same', cli(dir, ['orvix']).stdout === res.stdout);
    res = cli(dir, ['orvix', 'index']);
    ok('orvix index builds it (orvix itself, with the terminal attached)', res.status === 0 && exists(dir, '.orvix/symbols.json'));
    ok('...and keeps .orvix/ out of git status', read(dir, '.git/info/exclude').includes('.orvix/') && !exists(dir, '.gitignore'));
    res = cli(dir, ['orvix', 'status']);
    ok('status after indexing', new RegExp(`symbols\\s+${SMALL_SYMBOLS}\\b`).test(res.stdout) && /changes\s+none pending/.test(res.stdout));
    res = cli(dir, ['orvix', 'find', 'double']);
    ok('orvix find passes through', res.status === 0 && res.stdout.includes('double'));
    res = cli(dir, ['orvix', 'show', 'add']);
    ok('orvix show prints the source', res.status === 0 && res.stdout.includes('return a + b'));
    res = cli(dir, ['orvix', 'show', 'add', '--json']);
    ok('options go through to orvix', res.status === 0 && JSON.parse(res.stdout).name === 'add');
    res = cli(dir, ['orvix', 'map', '-b', '300']);
    ok('orvix map takes its own options', res.status === 0 && res.stdout.includes('src/math.js'));
    res = cli(dir, ['orvix', 'who-calls', 'add']);
    ok('orvix who-calls passes through', res.status === 0 && res.stdout.includes('double'));
    res = cli(dir, ['orvix', 'show', 'helper']);
    ok('an ambiguous reference makes orvix exit non-zero, and aicode passes that on', res.status !== 0 && /matches 2 symbols/.test(res.stderr));
    res = cli(dir, ['orvix', 'gain']);
    ok('orvix gain passes through', res.status === 0 && /compress|saved|token/i.test(res.stdout));
    res = cli(dir, ['orvix', 'frobnicate']);
    ok('an unknown command is refused with the list of the known ones', res.status === 1 && /Unknown orvix command "frobnicate"/.test(all(res)) && /who-calls/.test(all(res)));
    res = cli(dir, ['orvix', 'init', '--agents', 'nope']);
    ok('init with an unknown agent is refused before orvix runs', res.status === 1 && /Unknown agent: nope/.test(all(res)) && !exists(dir, 'AGENTS.md') && !exists(dir, '.gitignore'));

    const tiny = project({ 'a.js': 'x' }, { git: false });
    res = cli(tiny, ['orvix', 'status']);
    ok('status of a project where the layer is off says why', res.status === 0 && /orvix is off for this project: not a git repository and fewer than 5 source files/.test(res.stdout));
    res = cli(dir, ['orvix', 'status'], { AICODE_NO_ORVIX: '1' });
    ok('...also with the environment switch', /orvix is off for this project: AICODE_NO_ORVIX is set/.test(res.stdout));

    // the only path that writes AGENTS.md and .gitignore, and only because the user asked for it
    const initDir = project(SMALL);
    res = cli(initDir, ['orvix', 'init', '--agents', 'codex']);
    ok('init --agents writes the agent instruction file and builds the index', res.status === 0 && exists(initDir, 'AGENTS.md') && read(initDir, 'AGENTS.md').includes('<!-- orvix:start -->') && exists(initDir, '.orvix/symbols.json'));
    ok('...and orvix ignores its own cache in .gitignore', /\.orvix/.test(exists(initDir, '.gitignore') ? read(initDir, '.gitignore') : ''));
}

// ---- cleanup ------------------------------------------------------------------------------------
await sleep(200);
for (const dir of TMP) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ } }

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
