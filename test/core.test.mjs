// Offline checks for the small shared modules: UsageLedger, lib/history.js, lib/config.js.
// Everything that touches ~/.aicode runs against a temporary HOME.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// isolate HOME before anything resolves it
const REAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-core-home-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const Code2Prompt = require('../lib/engine');
const { trimSessionHistory } = require('../lib/history');
const config = require('../lib/config');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '}${name}`); if (!cond) failures++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// =============================================================================
// [A] UsageLedger
// =============================================================================
console.log('\n[A] UsageLedger');
{
    const { UsageLedger } = Code2Prompt;
    ok('UsageLedger is exposed on Code2Prompt', typeof UsageLedger === 'function');
    const ledger = new UsageLedger();
    const empty = ledger.summary();
    ok('empty summary has zero calls and tokens', empty.calls === 0 && empty.inputTokens === 0 && empty.outputTokens === 0 && empty.cost === 0);
    ledger.record('OPENAI', 'smart', 'model-a', { inputTokens: 100, outputTokens: 20 });
    ledger.record('OPENAI', 'fast', 'model-b', { promptTokens: 30, completionTokens: 5 }); // legacy field names
    ledger.record('ANTHROPIC', 'smart', 'model-a', {}); // missing usage counts as 0 tokens
    const s = ledger.summary();
    ok('summary counts every call', s.calls === 3);
    ok('summary sums input tokens (incl. legacy names)', s.inputTokens === 130);
    ok('summary sums output tokens (incl. legacy names)', s.outputTokens === 25);
    ok('summary groups calls by model', eq(s.models, { 'model-a': 2, 'model-b': 1 }));
    ok('summary lists models', s.model === 'model-a, model-b');
    ok('summary cost is a finite number', Number.isFinite(s.cost) && s.cost >= 0);
    ledger.reset();
    ok('reset clears the ledger', ledger.summary().calls === 0);
}

// =============================================================================
// [B] per-engine ledgers vs. the static ledger
// =============================================================================
console.log('\n[B] engine ledger isolation');
{
    const { UsageLedger } = Code2Prompt;
    const mk = () => new Code2Prompt({ template: path.join(ROOT, 'actions', 'default.md'), OPENAI_KEY: 'test' });
    Code2Prompt.resetUsage();
    const a = mk(), b = mk(), plain = mk();
    const la = new UsageLedger(), lb = new UsageLedger();
    a.setUsageLedger(la);
    b.setUsageLedger(lb);
    a._recordUsage('OPENAI', 'smart', { inputTokens: 1, outputTokens: 1 });
    a._recordUsage('OPENAI', 'smart', { inputTokens: 1, outputTokens: 1 });
    b._recordUsage('OPENAI', 'fast', { inputTokens: 1, outputTokens: 1 });
    ok('engine A records into its own ledger', la.summary().calls === 2);
    ok('engine B records into its own ledger', lb.summary().calls === 1);
    ok('ledgered engines leave the static ledger untouched', Code2Prompt.getUsage().calls === 0);
    plain._recordUsage('OPENAI', 'smart', { inputTokens: 7, outputTokens: 3 });
    ok('an engine without a ledger writes to the static ledger', Code2Prompt.getUsage().calls === 1 && Code2Prompt.getUsage().inputTokens === 7);
    ok('static writes do not leak into engine ledgers', la.summary().calls === 2 && lb.summary().calls === 1);
    a.setUsageLedger(null);
    a._recordUsage('OPENAI', 'smart', { inputTokens: 1, outputTokens: 1 });
    ok('setUsageLedger(null) goes back to the static ledger', Code2Prompt.getUsage().calls === 2 && la.summary().calls === 2);
    const viaOption = new Code2Prompt({ template: path.join(ROOT, 'actions', 'default.md'), OPENAI_KEY: 'test', usageLedger: lb });
    viaOption._recordUsage('OPENAI', 'fast', {});
    ok('usageLedger can be passed as a constructor option', lb.summary().calls === 2);
    Code2Prompt.resetUsage();
    ok('resetUsage() empties the static ledger', Code2Prompt.getUsage().calls === 0);
}

// =============================================================================
// [C] history
// =============================================================================
console.log('\n[C] trimSessionHistory');
{
    const msg = (i, size = 10) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i).padEnd(size, 'x') });
    const long = Array.from({ length: 30 }, (_, i) => msg(i));
    const t = trimSessionHistory(long);
    ok('keeps the last 10 pairs by default', t.length === 20 && t[0].content.startsWith('10') && t[19].content.startsWith('29'));
    ok('maxTurns is respected', trimSessionHistory(long, 2).length === 4);
    const big = Array.from({ length: 8 }, (_, i) => msg(i, 10000));
    const trimmed = trimSessionHistory(big);
    const total = trimmed.reduce((n, m) => n + m.content.length, 0);
    ok('drops the oldest pairs above the char budget', total <= 32000 && trimmed.length < 8 && trimmed.length % 2 === 0);
    ok('keeps the newest messages when trimming by size', trimmed[trimmed.length - 1].content.startsWith('7'));
    ok('never trims below one pair', trimSessionHistory([msg(0, 50000), msg(1, 50000)]).length === 2);
    ok('null and undefined become an empty history', eq(trimSessionHistory(null), []) && eq(trimSessionHistory(undefined), []));
    ok('messages without content count as empty', trimSessionHistory([{ role: 'user' }, { role: 'assistant' }]).length === 2);
}

// =============================================================================
// [D] config
// =============================================================================
console.log('\n[D] lib/config.js');
{
    const file = config.configPath();
    ok('config lives under the (temporary) HOME', file === path.join(TMP_HOME, '.aicode', 'config.json'));
    const notes = [];
    config.setConfigDebug((m) => notes.push(m));

    let c = config.reloadConfig();
    ok('defaults without a config file', c.orvix.enabled === true && c.orvix.mapBudget === 1500);
    ok('default ide settings', c.ide.version === '4.141.0' && c.ide.confirm === true && c.ide.open === true && c.ide.port === 0);
    ok('default server port', c.server.port === 7865);
    ok('default model settings', c.models.selected === null && eq(c.models.recent, []) && c.models.catalogTtlHours === 24 && c.models.fallbackOnError === false);
    ok('default featured vendors include anthropic and openai', c.models.featuredVendors.includes('anthropic') && c.models.featuredVendors.includes('openai'));
    ok('default skills and conversations', eq(c.skills, { ignore: [], allow: [] }) && c.conversations.cursorImport === true && c.conversations.sqlite === true);

    c = config.saveConfig({ orvix: { mapBudget: 900 } });
    ok('saveConfig merges into defaults', c.orvix.mapBudget === 900 && c.orvix.enabled === true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok('only user-set keys are written to disk', eq(onDisk, { orvix: { mapBudget: 900 } }));
    ok('file is 2-space JSON', fs.readFileSync(file, 'utf8').startsWith('{\n  "orvix"'));
    ok('loadConfig is cached and refreshed by saveConfig', config.loadConfig().orvix.mapBudget === 900);

    config.saveConfig({ orvix: { enabled: false } });
    c = config.loadConfig();
    ok('objects merge recursively across saves', c.orvix.enabled === false && c.orvix.mapBudget === 900);

    config.saveConfig({ skills: { ignore: ['a', 'b'] } });
    config.saveConfig({ skills: { ignore: ['c'] } });
    ok('arrays replace instead of concatenating', eq(config.loadConfig().skills.ignore, ['c']));

    config.saveConfig({ models: { selected: { provider: 'OPENROUTER', model: 'x/y', effort: 'max' } } });
    ok('nested objects can be set', config.loadConfig().models.selected.effort === 'max');
    config.saveConfig({ models: { selected: null } });
    ok('null replaces a value (clears the selection)', config.loadConfig().models.selected === null);
    config.saveConfig({ models: { catalogTtlHours: undefined } });
    ok('undefined values are ignored', config.loadConfig().models.catalogTtlHours === 24);

    // external edits are picked up by reloadConfig, not by the cache
    fs.writeFileSync(file, JSON.stringify({ server: { port: 9000 } }));
    ok('loadConfig stays cached until reloadConfig', config.loadConfig().server.port === 7865);
    ok('reloadConfig re-reads the file', config.reloadConfig().server.port === 9000);

    // malformed file: never throws, falls back to defaults, notes the problem
    fs.writeFileSync(file, '{ not json');
    notes.length = 0;
    let threw = false;
    try { c = config.reloadConfig(); } catch (e) { threw = true; }
    ok('a malformed file does not throw', !threw);
    ok('a malformed file falls back to defaults', c.server.port === 7865 && c.orvix.mapBudget === 1500);
    ok('a malformed file leaves a debug note', notes.some((n) => /malformed/.test(n)));
    config.saveConfig({ server: { port: 1234 } });
    ok('saving over a malformed file works', config.loadConfig().server.port === 1234);
    ok('the unreadable original is kept as .bak', fs.existsSync(file + '.bak') && fs.readFileSync(file + '.bak', 'utf8') === '{ not json');

    // the resolved path follows HOME (tests and users that relocate it)
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-core-home2-'));
    process.env.HOME = other;
    process.env.USERPROFILE = other;
    ok('the cache follows a changed HOME', config.loadConfig().server.port === 7865);
    process.env.HOME = TMP_HOME;
    process.env.USERPROFILE = TMP_HOME;
    ok('...and follows it back', config.loadConfig().server.port === 1234);
    fs.rmSync(other, { recursive: true, force: true });
    config.setConfigDebug(null);
}

// cleanup
process.env.HOME = REAL_HOME;
fs.rmSync(TMP_HOME, { recursive: true, force: true });

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
