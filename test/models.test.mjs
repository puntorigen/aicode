// Offline checks for the model layer: provider registry and per-call options
// (lib/models.js), the OpenRouter catalog and key checks (lib/openrouter.js),
// the model picker listing and spec grammar, cost accounting through OpenRouter
// usage accounting, and credential handling (lib/keys.js). A local http server
// plays OpenRouter (AICODE_OPENROUTER_API); nothing touches the network or the
// real HOME.
import { MockLanguageModelV3 } from 'ai/test';
import { createRequire } from 'module';
import http from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'actions', 'default.md'); // any action template: the engine only needs one to exist

// isolate HOME before anything resolves ~/.aicode (config, keys, caches)
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-models-home-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
for (const name of ['OPENROUTER_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_KEY', 'OPENAI_KEY', 'GROQ_KEY', 'REPLICATE_API_TOKEN', 'AICODE_OPENROUTER_API']) delete process.env[name];

const models = require('../lib/models');
const openrouter = require('../lib/openrouter');
const keysLib = require('../lib/keys');
const config = require('../lib/config');
const Code2Prompt = require('../lib/engine');
const EncryptedJsonDB = require('../helpers/db');
const { generateText, streamText } = require('ai');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '}${name}`); if (!cond) failures++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

// the live catalog entries (trimmed) the picker facts were verified against on 2026-10-17
const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/openrouter-models.json', import.meta.url), 'utf8'));
const normalized = raw.data.map(openrouter.normalizeModel).filter(Boolean);
const byId = Object.fromEntries(normalized.map((m) => [m.id, m]));
const ago = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString();

// write the catalog cache: the fixture plus `extra` entries, minus the ids in `drop`
function writeCatalog({ extra = [], drop = [], fetchedAt = new Date().toISOString() } = {}) {
    fs.mkdirSync(path.dirname(openrouter.cacheFile()), { recursive: true });
    const list = normalized.filter((m) => !drop.includes(m.id)).concat(extra);
    fs.writeFileSync(openrouter.cacheFile(), JSON.stringify({ fetchedAt, models: list }) + '\n');
}
const removeCatalog = () => { try { fs.unlinkSync(openrouter.cacheFile()); } catch (e) { /* none */ } };

// a local http server; `handler(req, res, body)` answers
async function startStub(handler) {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => handler(req, res, body));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}
const sendJson = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

// --- [A] Anthropic extended thinking: budget vs adaptive ---------------------
console.log('\n[A] Anthropic thinking options');
{
    // the models verified against the live API on 2026-10-17
    for (const id of ['claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5', 'claude-sonnet-5']) {
        ok(`${id} rejects budget-based thinking`, models.rejectsThinkingBudget(id) === true);
    }
    for (const id of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5',
        'claude-haiku-4-5-20251001', 'claude-opus-4-20250514', 'claude-opus-4-1-20250805', 'claude-3-haiku-20240307']) {
        ok(`${id} keeps budget-based thinking`, models.rejectsThinkingBudget(id) === false);
    }
    ok('ids that are not Claude versions keep the budget form', models.rejectsThinkingBudget('gpt-5.5') === false
        && models.rejectsThinkingBudget('') === false && models.rejectsThinkingBudget(undefined) === false);
    ok('future majors are treated as adaptive-only', models.rejectsThinkingBudget('claude-opus-6') === true
        && models.rejectsThinkingBudget('claude-sonnet-5-20261001') === true);

    // the default smart tier (claude-opus-4-8 @ xhigh) used to send thinking.type=enabled
    const smart = models.callOptions('ANTHROPIC', 'smart', { ANTHROPIC_KEY: 'k' });
    ok('default smart tier uses adaptive thinking with its effort', same(smart, {
        providerOptions: { anthropic: { thinking: { type: 'adaptive' }, effort: 'xhigh' } },
        maxOutputTokens: 48000,
    }));
    const fast = models.callOptions('ANTHROPIC', 'fast', { ANTHROPIC_KEY: 'k' });
    ok('the fast tier (haiku, effort none) sends no thinking', same(fast, {}));

    const forced = (model, effort) => models.callOptions('ANTHROPIC', 'smart', { ANTHROPIC_KEY: 'k', ANTHROPIC_MODEL: model, ANTHROPIC_EFFORT: effort });
    ok('a budget-only model keeps thinking.type=enabled with the effort budget', same(forced('claude-haiku-4-5', 'high'), {
        providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 16000 } } },
        maxOutputTokens: 32000,
    }));
    ok('opus-4-6 (accepts both) stays on the budget form', forced('claude-opus-4-6', 'medium').providerOptions.anthropic.thinking.type === 'enabled');
    ok('sonnet-5 at max -> adaptive effort max', same(forced('claude-sonnet-5', 'max').providerOptions.anthropic,
        { thinking: { type: 'adaptive' }, effort: 'max' }));
    ok('fable-5 at low -> adaptive effort low', forced('claude-fable-5', 'low').providerOptions.anthropic.effort === 'low');
    ok('effort none disables thinking on every model', same(forced('claude-opus-4-8', 'none'), {}) && same(forced('claude-haiku-4-5', 'none'), {}));
    ok('structured calls never send thinking', same(models.callOptions('ANTHROPIC', 'smart', { ANTHROPIC_KEY: 'k' }, { structured: true }), {}));
    ok('other providers send nothing', same(models.callOptions('OPENAI', 'smart', { OPENAI_KEY: 'k' }), {})
        && same(models.callOptions('GROQ', 'smart', { GROQ_KEY: 'k' }), {}));

    // MAX on a budget-only model must stay inside the API limits
    ok('a budget at max is clamped below max_tokens', same(forced('claude-haiku-4-5', 'max'), {
        providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 48000 } } },
        maxOutputTokens: 64000,
    }));
    ok('a tiny budget is raised to the API minimum of 1024', same(forced('claude-haiku-4-5', 'minimal'), {
        providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 1024 } } },
        maxOutputTokens: 17000,
    }));
    ok('adaptive thinking maps minimal to low', forced('claude-sonnet-5', 'minimal').providerOptions.anthropic.effort === 'low');
}

// --- [B] OpenRouter model normalization ----------------------------------------
console.log('\n[B] OpenRouter catalog entries');
{
    ok('the fixture is the raw API shape (22 entries, 21 usable)', raw.data.length === 22 && normalized.length === 21);
    ok('a :batch variant is dropped', !byId['anthropic/claude-sonnet-5.5:batch'] && raw.data.some((r) => r.id === 'anthropic/claude-sonnet-5.5:batch'));
    const sonnet = byId['anthropic/claude-sonnet-5.5'];
    ok('the short name drops the vendor prefix of the name', sonnet.name.startsWith('Anthropic: ') && sonnet.shortName === 'Claude Sonnet 5.5');
    ok('limits and flags are read from the API fields', sonnet.contextLength === 1000000 && sonnet.maxCompletionTokens === 128000 && sonnet.supportsTools === true && sonnet.supportsStructuredOutputs === true && sonnet.created === 1790618686);
    ok('prices become numbers in USD per token', same(sonnet.pricing, { prompt: 0.000002, completion: 0.00001 }));
    ok('the reasoning object keeps its efforts', same(sonnet.reasoning, { supportedEfforts: ['max', 'xhigh', 'high', 'medium', 'low'], defaultEffort: 'high', mandatory: true, supportsMaxTokens: false }));
    ok('~ ids are aliases and :free ids are free', byId['~anthropic/claude-sonnet-latest'].isAlias === true && byId['anthropic/claude-sonnet-5.5'].isAlias === false
        && byId['xingchen-agi/xing4.0-29b-a4b:free'].isFree === true && byId['xingchen-agi/xing4.0-29b-a4b:free'].pricing.prompt === 0);
    ok('a router priced "-1" has no price', byId['openrouter/auto-beta'].pricing === null && byId['openrouter/auto-beta'].maxCompletionTokens === null);
    ok('a model without a reasoning object has reasoning null', byId['unbiased/pareto-26.10'].reasoning === null);
    ok('a reasoning object without efforts has no supportedEfforts key', !('supportedEfforts' in byId['z-ai/glm-5'].reasoning) && byId['qwen/qwen3.8-flash'].reasoning.supportsMaxTokens === true);

    const made = (extra) => ({ id: 'acme/model-1', name: 'Acme: Model One', context_length: 8000, architecture: { output_modalities: ['text'] }, supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000002' }, top_provider: { max_completion_tokens: 4096 }, created: 1700000000, ...extra });
    ok('a name without ": " is its own short name', openrouter.normalizeModel(made({ name: 'PlainName' })).shortName === 'PlainName');
    ok('only the first ": " splits the name', openrouter.normalizeModel(made({ name: 'Acme: Model: Pro' })).shortName === 'Model: Pro');
    ok('supported_efforts null means every effort is accepted', openrouter.normalizeModel(made({ reasoning: { supported_efforts: null, default_effort: null, mandatory: false, supports_max_tokens: false } })).reasoning.supportedEfforts === null);
    ok('models that cannot output text are dropped', openrouter.normalizeModel(made({ architecture: { output_modalities: ['image'] } })) === null && openrouter.normalizeModel(made({ architecture: {} })) === null);
    ok('entries without a usable id are dropped', openrouter.normalizeModel(null) === null && openrouter.normalizeModel('x') === null && openrouter.normalizeModel(made({ id: '' })) === null && openrouter.normalizeModel(made({ id: 5 })) === null);
    ok('missing optional fields get neutral values', (() => {
        const m = openrouter.normalizeModel({ id: 'bare/model', architecture: { output_modalities: ['text'] } });
        return m.name === 'bare/model' && m.shortName === 'bare/model' && m.contextLength === 0 && m.pricing === null && m.supportsTools === false && m.reasoning === null && m.created === 0 && m.maxCompletionTokens === null;
    })());
    ok('an unparseable price is no price', openrouter.normalizeModel(made({ pricing: { prompt: 'free', completion: '0.1' } })).pricing === null);
}

// --- [C] catalog download, cache and key verification ------------------------------
console.log('\n[C] catalog fetch / cache / verifyKey');
{
    const seen = [];
    const mode = { models: 'ok' };
    const stub = await startStub((req, res) => {
        const auth = req.headers.authorization || '';
        seen.push({ url: req.url, auth });
        if (req.url === '/models') {
            if (mode.models === 'fail') return sendJson(res, 500, { error: 'boom' });
            if (mode.models === 'empty') return sendJson(res, 200, { data: [] });
            if (mode.models === 'garbage') { res.writeHead(200); return res.end('<html>not json'); }
            return sendJson(res, 200, raw);
        }
        if (req.url === '/key') {
            if (auth === 'Bearer good') return sendJson(res, 200, { data: { label: 'my-key', usage: 1.5, limit: 10, limit_remaining: 8.5, is_free_tier: false } });
            if (auth === 'Bearer nolimit') return sendJson(res, 200, { data: { label: 'open', usage: 0, limit: null, limit_remaining: null, is_free_tier: true } });
            if (auth === 'Bearer forbidden') return sendJson(res, 403, {});
            if (auth === 'Bearer flaky') return sendJson(res, 503, {});
            if (auth === 'Bearer weird') { res.writeHead(200); return res.end('not json at all'); }
            return sendJson(res, 401, { error: { message: 'No auth credentials found' } });
        }
        return sendJson(res, 404, {});
    });
    process.env.AICODE_OPENROUTER_API = stub.url;
    const count = (url) => seen.filter((r) => r.url === url).length;

    ok('the API base comes from AICODE_OPENROUTER_API and loses trailing slashes', openrouter.apiBase() === stub.url);
    process.env.AICODE_OPENROUTER_API = stub.url + '///';
    ok('trailing slashes are trimmed', openrouter.apiBase() === stub.url);
    process.env.AICODE_OPENROUTER_API = stub.url;

    removeCatalog();
    ok('without a cache there is no catalog', openrouter.loadCatalog() === null);
    const first = await openrouter.fetchCatalog({ apiKey: 'good' });
    ok('fetchCatalog downloads and normalizes the catalog', first.models.length === 21 && typeof first.fetchedAt === 'string' && first.models.every((m) => typeof m.shortName === 'string'));
    ok('the key is sent as a Bearer token', seen[0].url === '/models' && seen[0].auth === 'Bearer good');
    ok('the catalog is cached on disk', fs.existsSync(openrouter.cacheFile()) && openrouter.loadCatalog().models.length === 21 && openrouter.loadCatalog().fetchedAt === first.fetchedAt);
    const before = count('/models');
    await openrouter.fetchCatalog();
    ok('a fresh cache is served without touching the network', count('/models') === before);
    await openrouter.fetchCatalog({ force: true });
    ok('force fetches again, and the public endpoint needs no key', count('/models') === before + 1 && seen[seen.length - 1].auth === '');
    writeCatalog({ fetchedAt: ago(30) });
    await openrouter.fetchCatalog();
    ok('a stale cache is refreshed', count('/models') === before + 2);

    ok('isStale: missing, undated or garbled catalogs are stale', openrouter.isStale(null) && openrouter.isStale({ fetchedAt: '' }) && openrouter.isStale({ fetchedAt: 'yesterday' }) && openrouter.isStale({}));
    ok('isStale honors the ttl', openrouter.isStale({ fetchedAt: ago(25) }, 24) === true && openrouter.isStale({ fetchedAt: ago(23) }, 24) === false && openrouter.isStale({ fetchedAt: ago(2) }, 1) === true);

    // failures: the cache keeps answering
    writeCatalog({ fetchedAt: ago(30) });
    mode.models = 'fail';
    const problems = [];
    const fallback = await openrouter.fetchCatalog({ force: true, onError: (err) => problems.push(err.message) });
    ok('a failed download falls back to the cache and reports the error', fallback.models.length === 21 && problems.length === 1 && problems[0].includes('500'));
    ok('a throwing onError hook cannot break the lookup', (await openrouter.fetchCatalog({ force: true, onError: () => { throw new Error('hook'); } })).models.length === 21);
    mode.models = 'empty';
    const emptied = await openrouter.fetchCatalog({ force: true, onError: (err) => problems.push(err.message) });
    ok('an empty answer never replaces a good cache', emptied.models.length === 21 && openrouter.loadCatalog().models.length === 21 && problems[problems.length - 1].includes('no usable models'));
    mode.models = 'garbage';
    ok('an unparseable answer falls back to the cache too', (await openrouter.fetchCatalog({ force: true })).models.length === 21);
    removeCatalog();
    mode.models = 'fail';
    const noCache = await openrouter.fetchCatalog({ force: true }).then(() => null, (e) => e);
    ok('without a cache a failed download throws', noCache instanceof Error && noCache.message.includes('500'));
    mode.models = 'ok';

    // verifyKey
    const good = await openrouter.verifyKey('good');
    ok('verifyKey 200 -> label, usage and the credits left', same(good, { ok: true, label: 'my-key', usage: 1.5, limit: 10, limitRemaining: 8.5, isFreeTier: false }));
    ok('verifyKey sends the Bearer token to /key', seen[seen.length - 1].url === '/key' && seen[seen.length - 1].auth === 'Bearer good');
    ok('verifyKey: no limit comes back as null', same(await openrouter.verifyKey('nolimit'), { ok: true, label: 'open', usage: 0, limit: null, limitRemaining: null, isFreeTier: true }));
    ok('verifyKey 401 -> invalid key', same(await openrouter.verifyKey('bad'), { ok: false, error: 'invalid key' }));
    ok('verifyKey 403 -> invalid key', same(await openrouter.verifyKey('forbidden'), { ok: false, error: 'invalid key' }));
    ok('verifyKey 503 -> HTTP 503', same(await openrouter.verifyKey('flaky'), { ok: false, error: 'HTTP 503' }));
    ok('verifyKey tolerates a 200 without JSON', (await openrouter.verifyKey('weird')).ok === true);
    process.env.AICODE_OPENROUTER_API = 'http://127.0.0.1:1';
    const unreachable = await openrouter.verifyKey('good');
    ok('verifyKey never throws: a network failure is a result', unreachable.ok === false && typeof unreachable.error === 'string' && unreachable.error.length > 0);
    process.env.AICODE_OPENROUTER_API = stub.url;

    await stub.close();
    delete process.env.AICODE_OPENROUTER_API;
}

// --- [D] the model picker listing --------------------------------------------------
console.log('\n[D] listModels');
{
    writeCatalog();
    const cfg = (extra = {}) => ({ models: { selected: null, recent: [], featuredVendors: ['anthropic', 'openai', 'moonshotai'], catalogTtlHours: 24, ...extra } });
    const list = (keysData = {}, extra = {}, query) => models.listModels({ keysData, config: cfg(extra), query });
    const ids = (listing) => listing.models.map((m) => m.id);

    const plain = list();
    const plainById = Object.fromEntries(plain.models.filter((m) => m.provider === 'OPENROUTER').map((m) => [m.id, m]));
    ok('featured models lead when nothing is recent: vendor order, newest first', ids(plain).slice(0, 8).join() === [
        'anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5',
        'openai/gpt-6.1-sol', 'openai/gpt-5.6-sol', 'openai/gpt-oss-120b',
        'moonshotai/kimi-k3', 'moonshotai/kimi-k2.7-code'].join());
    ok('only the 3 newest models of a featured vendor are featured', plainById['anthropic/claude-sonnet-5'].groups.length === 0 && plainById['anthropic/claude-opus-5.5'].groups.join() === 'featured'
        && plainById['openai/gpt-oss-120b'].groups.join() === 'featured');
    const withRecent = list({}, { recent: ['moonshotai/kimi-k3', 'anthropic/claude-sonnet-5'] });
    ok('recent models come first, in recent order', ids(withRecent).slice(0, 2).join() === 'moonshotai/kimi-k3,anthropic/claude-sonnet-5');
    ok('a model can be both recent and featured', withRecent.models[0].groups.join() === 'recent,featured' && withRecent.models[1].groups.join() === 'recent');
    ok('a recent model is not repeated among the featured ones', ids(withRecent).filter((id) => id === 'moonshotai/kimi-k3').length === 1);
    ok('recents are keyed by model id: every provider listing that id shows it as recent', (() => {
        const shared = list({}, { recent: ['openai/gpt-oss-120b'] }).models.filter((m) => m.id === 'openai/gpt-oss-120b');
        return shared.length === 2 && shared.map((m) => m.provider).sort().join() === 'GROQ,OPENROUTER' && shared.every((m) => m.groups.includes('recent'));
    })());
    ok('aliases and free models are never featured', plainById['~anthropic/claude-sonnet-latest'].groups.length === 0 && plainById['xingchen-agi/xing4.0-29b-a4b:free'].groups.length === 0);
    ok('vendors outside featuredVendors are not featured', plainById['z-ai/glm-5'].groups.length === 0 && plainById['deepseek/deepseek-v4.1-flash'].groups.length === 0);
    const rest = plain.models.filter((m) => m.groups.length === 0);
    ok('everything else is ordered newest first', rest.every((m, i) => i === 0 || rest[i - 1].created >= m.created));
    ok('without credentials nothing is available and built-ins are not featured', plain.models.every((m) => m.available === false) && plain.models.filter((m) => m.provider !== 'OPENROUTER').every((m) => m.groups.length === 0));

    const withKeys = list({ OPENROUTER_KEY: 'k', ANTHROPIC_KEY: 'k', OPENAI_KEY: 'k', LOCAL_BASE_URL: 'http://x/v1', LOCAL_MODEL: 'llama3', LOCAL_FAST_MODEL: 'llama3-small' });
    const featuredAll = withKeys.models.filter((m) => m.groups.includes('featured'));
    const firstBuiltin = featuredAll.findIndex((m) => m.provider !== 'OPENROUTER');
    ok('OpenRouter featured entries come before the built-in providers', firstBuiltin > 0 && featuredAll.slice(0, firstBuiltin).every((m) => m.provider === 'OPENROUTER') && featuredAll.slice(firstBuiltin).every((m) => m.provider !== 'OPENROUTER'));
    ok('built-in providers follow the default order', [...new Set(featuredAll.slice(firstBuiltin).map((m) => m.provider))].join() === 'ANTHROPIC,OPENAI,LOCAL');
    ok('the OpenRouter entries are available with its key', withKeys.models.filter((m) => m.provider === 'OPENROUTER').every((m) => m.available === true));
    ok('a provider without a key lists its models as unavailable', withKeys.models.filter((m) => m.provider === 'GROQ').length === 2 && withKeys.models.filter((m) => m.provider === 'GROQ').every((m) => m.available === false && m.groups.length === 0));
    ok('local models come from the config', withKeys.models.filter((m) => m.provider === 'LOCAL').map((m) => m.id).join() === 'llama3,llama3-small');
    const opus = withKeys.models.find((m) => m.provider === 'ANTHROPIC' && m.id === 'claude-opus-4-8');
    ok('Anthropic models describe their reasoning efforts', opus.reasoning.supportedEfforts.includes('max') && opus.reasoning.defaultEffort === 'xhigh' && opus.pricing.prompt === 5 && opus.shortName === 'claude-opus-4-8' && opus.created === 0);
    ok('other built-in providers have no reasoning info', withKeys.models.find((m) => m.provider === 'OPENAI').reasoning === null);
    const custom = list({ ANTHROPIC_KEY: 'k', ANTHROPIC_MODEL: 'claude-custom-9' });
    ok('a user model override is listed', custom.models.some((m) => m.provider === 'ANTHROPIC' && m.id === 'claude-custom-9' && m.available === true));

    ok('prices are shown per 1M tokens rounded to 2 decimals', same(plainById['moonshotai/kimi-k3'].pricing, { prompt: 0.3, completion: 11.94 }) && same(plainById['anthropic/claude-haiku-5.5'].pricing, { prompt: 0.1, completion: 0.5 })
        && plainById['openrouter/auto-beta'].pricing === null);
    ok('the picker carries what the UI needs', (() => {
        const m = plainById['moonshotai/kimi-k3'];
        return m.provider === 'OPENROUTER' && m.shortName === 'Kimi K3' && m.contextLength === 1048576 && m.supportsTools === true && m.supportsStructuredOutputs === true && m.created === 1784215858 && m.reasoning.supportedEfforts.includes('max');
    })());

    ok('selected echoes the remembered selection', same(list({}, { selected: { provider: 'OPENROUTER', model: 'moonshotai/kimi-k3', effort: 'max' } }).selected, { provider: 'OPENROUTER', model: 'moonshotai/kimi-k3', effort: 'max' }) && plain.selected === null);
    ok('the catalog summary counts OpenRouter models only', plain.catalog.count === 21 && plain.catalog.stale === false && typeof plain.catalog.fetchedAt === 'string');
    writeCatalog({ fetchedAt: ago(48) });
    ok('an old catalog is reported stale', list().catalog.stale === true && models.listModels({ keysData: {}, config: cfg({ catalogTtlHours: 100 }) }).catalog.stale === false);
    writeCatalog();

    ok('query: every word must match the id or the name', ids(list({}, {}, 'sonnet 5.5')).join() === 'anthropic/claude-sonnet-5.5');
    ok('query is case-insensitive and matches names', ids(list({}, {}, 'GLM')).sort().join() === 'z-ai/glm-5,z-ai/glm-5.3-prime' && ids(list({}, {}, 'Kimi K3')).join() === 'moonshotai/kimi-k3');
    ok('an empty query lists everything', list({}, {}, '   ').models.length === list().models.length);
    ok('a query keeps the picker order', ids(list({}, { recent: ['anthropic/claude-sonnet-5'] }, 'sonnet')).slice(0, 2).join() === 'anthropic/claude-sonnet-5,anthropic/claude-sonnet-5.5');
    ok('a query can match built-in models', list({ ANTHROPIC_KEY: 'k' }, {}, 'opus-4-8').models.some((m) => m.provider === 'ANTHROPIC'));

    // no cache at all
    const realHome = process.env.HOME;
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-models-empty-'));
    process.env.HOME = emptyHome;
    const bare = models.listModels({ keysData: { ANTHROPIC_KEY: 'k' }, config: cfg() });
    ok('without a catalog cache only the built-in models are listed', bare.catalog === null && bare.models.length > 0 && bare.models.every((m) => m.provider !== 'OPENROUTER'));
    process.env.HOME = realHome;
    fs.rmSync(emptyHome, { recursive: true, force: true });
}

// --- [E] the model spec grammar -------------------------------------------------------
console.log('\n[E] parseModelSpec');
{
    writeCatalog();
    const keysData = { OPENROUTER_KEY: 'k', ANTHROPIC_KEY: 'k', OPENAI_KEY: 'k', LOCAL_BASE_URL: 'http://x/v1', LOCAL_MODEL: 'llama3' };
    const cfg = (extra = {}) => ({ models: { selected: null, recent: [], featuredVendors: ['anthropic', 'openai', 'moonshotai'], catalogTtlHours: 24, ...extra } });
    const parse = (spec, extra) => models.parseModelSpec(spec, { keysData, config: cfg(extra) });
    const sel = (provider, model, effort = null) => ({ provider, model, effort });

    ok('provider:model@effort', same(parse('openrouter:anthropic/claude-sonnet-5.5@max'), sel('OPENROUTER', 'anthropic/claude-sonnet-5.5', 'max')));
    ok('the provider prefix and the effort are case-insensitive', same(parse('OpenRouter:anthropic/claude-sonnet-5.5@MAX'), sel('OPENROUTER', 'anthropic/claude-sonnet-5.5', 'max')));
    ok('every effort of the ladder is accepted', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].every((e) => parse(`anthropic:claude-opus-4-8@${e}`).effort === e));
    ok('prefixed ids are taken as given for every provider', same(parse('anthropic:claude-opus-4-8@high'), sel('ANTHROPIC', 'claude-opus-4-8', 'high')) && same(parse('openai:gpt-5.5'), sel('OPENAI', 'gpt-5.5'))
        && same(parse('groq:llama-3.1-8b-instant'), sel('GROQ', 'llama-3.1-8b-instant')) && same(parse('local:whatever'), sel('LOCAL', 'whatever')));
    ok('a vendor-prefixed id is an OpenRouter model', same(parse('moonshotai/kimi-k3'), sel('OPENROUTER', 'moonshotai/kimi-k3')));
    ok('a ~ alias is an OpenRouter model', same(parse('~anthropic/claude-sonnet-latest@low'), sel('OPENROUTER', '~anthropic/claude-sonnet-latest', 'low')));
    ok('a bare id of a built-in provider resolves in preference order', same(parse('claude-sonnet-5'), sel('ANTHROPIC', 'claude-sonnet-5')) && same(parse('gpt-5.5'), sel('OPENAI', 'gpt-5.5'))
        && same(parse('llama-3.1-8b-instant'), sel('GROQ', 'llama-3.1-8b-instant')) && same(parse('llama3'), sel('LOCAL', 'llama3')));
    ok('a bare id matches the tail of a catalog id', same(parse('kimi-k3'), sel('OPENROUTER', 'moonshotai/kimi-k3')) && same(parse('glm-5'), sel('OPENROUTER', 'z-ai/glm-5')));
    ok('a single word that is no id is a phrase: the first match of the picker', parse('kimi').model === 'moonshotai/kimi-k3' && parse('kimi k3').model === 'moonshotai/kimi-k3');

    ok('Cursor-style: "sonnet 5.5 max"', same(parse('sonnet 5.5 max'), sel('OPENROUTER', 'anthropic/claude-sonnet-5.5', 'max')));
    ok('Cursor-style: -max and .max suffixes, any case', same(parse('claude-sonnet-5.5-max'), sel('OPENROUTER', 'anthropic/claude-sonnet-5.5', 'max')) && same(parse('claude-sonnet-5.5.max'), sel('OPENROUTER', 'anthropic/claude-sonnet-5.5', 'max')) && same(parse('Sonnet 5.5 MAX'), sel('OPENROUTER', 'anthropic/claude-sonnet-5.5', 'max')));
    ok('Cursor-style: words in any order and spacing', same(parse('gpt-5.6 sol'), sel('OPENROUTER', 'openai/gpt-5.6-sol')) && same(parse('  kimi   k3 '), sel('OPENROUTER', 'moonshotai/kimi-k3')));
    ok('an explicit @effort wins over a trailing max', parse('kimi k3 max@low').effort === 'low' && parse('kimi k3@high').effort === 'high');
    ok('a phrase takes the first match of the picker order (featured first)', parse('sonnet').model === 'anthropic/claude-sonnet-5.5');
    ok('a recent model wins a phrase', parse('sonnet', { recent: ['anthropic/claude-sonnet-5'] }).model === 'anthropic/claude-sonnet-5');
    ok('a phrase skips models without tool support', (() => {
        writeCatalog({ extra: [{ ...byId['moonshotai/kimi-k3'], id: 'moonshotai/kimi-k3-notools', supportsTools: false, created: 1999999999 }] });
        const picked = parse('kimi k3').model;
        writeCatalog();
        return picked === 'moonshotai/kimi-k3';
    })());

    const bad = (spec) => throws(() => parse(spec));
    ok('nothing matched -> the documented error', bad('nope-model') instanceof Error && bad('nope-model').message === 'unknown model: nope-model (use provider:model, see "aicode models")');
    ok('empty and blank specs fail', bad('') instanceof Error && bad('   ') instanceof Error && bad(undefined) instanceof Error && bad(null) instanceof Error);
    ok('a prefix without a model fails', bad('openrouter:') instanceof Error && bad('openai:   ') instanceof Error);
    ok('an unknown effort fails and lists the choices', bad('anthropic/claude-sonnet-5.5@bogus').message.includes('unknown effort "bogus"') && bad('anthropic/claude-sonnet-5.5@bogus').message.includes('xhigh'));
    ok('only "max" is not a model', bad('max') instanceof Error && bad('@max') instanceof Error && bad('x@') instanceof Error);
    const realHome = process.env.HOME;
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-models-empty-'));
    process.env.HOME = emptyHome;
    ok('without a catalog cache a phrase cannot reach OpenRouter models, built-in ids still resolve', bad('sonnet 5.5 max') instanceof Error && same(parse('claude-sonnet-5'), sel('ANTHROPIC', 'claude-sonnet-5')));
    process.env.HOME = realHome;
    fs.rmSync(emptyHome, { recursive: true, force: true });

    // checkSelection / selectModel
    const check = (value, keys = keysData) => models.checkSelection(value, keys);
    ok('checkSelection normalizes provider case and defaults the effort', same(check({ provider: 'openrouter', model: ' anthropic/claude-sonnet-5.5 ' }), { ok: true, selection: sel('OPENROUTER', 'anthropic/claude-sonnet-5.5') }));
    ok('checkSelection rejects shapes, providers, models and efforts', ['x', null, [], 5].every((v) => check(v).code === 'unknown_model') && check({ provider: 'nope', model: 'x' }).code === 'unknown_model'
        && check({ provider: 'OPENAI', model: '' }).code === 'unknown_model' && check({ provider: 'OPENAI', model: 7 }).code === 'unknown_model' && check({ provider: 'OPENAI', model: 'x', effort: 'turbo' }).code === 'unknown_model');
    ok('checkSelection needs credentials only when given the keys', check({ provider: 'GROQ', model: 'x' }).code === 'no_credentials' && models.checkSelection({ provider: 'GROQ', model: 'x' }).ok === true);
    const flags = { model: null };
    config.saveConfig({ models: { selected: null, recent: [] } });
    ok('selectModel stores the selection on the flags and remembers it', same(models.selectModel(flags, sel('OPENROUTER', 'moonshotai/kimi-k3', 'max'), keysData), sel('OPENROUTER', 'moonshotai/kimi-k3', 'max')) && same(flags.model, sel('OPENROUTER', 'moonshotai/kimi-k3', 'max')) && same(config.loadConfig().models.selected, sel('OPENROUTER', 'moonshotai/kimi-k3', 'max')));
    ok('the remembered recent list is newest first, without duplicates, at most 8', (() => {
        for (let i = 0; i < 10; i++) models.selectModel(flags, sel('OPENAI', `m-${i}`), keysData);
        models.selectModel(flags, sel('OPENAI', 'm-5'), keysData);
        const recent = config.loadConfig().models.recent;
        return recent.length === 8 && recent[0] === 'm-5' && recent.filter((id) => id === 'm-5').length === 1 && recent[1] === 'm-9';
    })());
    models.selectModel({ model: null }, sel('OPENAI', 'quiet'), keysData, { persist: false });
    ok('persist: false leaves the remembered selection alone', config.loadConfig().models.selected.model === 'm-5');
    const err = throws(() => models.selectModel(flags, sel('GROQ', 'x'), keysData));
    ok('selectModel throws an Error carrying the code, changing nothing', err && err.code === 'no_credentials' && flags.model.model === 'm-5');
    ok('selectModel(null) clears the flags and the remembered selection', models.selectModel(flags, null, keysData) === null && flags.model === null && config.loadConfig().models.selected === null);
    ok('the chip says MAX only for max', models.chipFor(sel('OPENROUTER', 'moonshotai/kimi-k3', 'max')).model === 'Kimi K3 MAX' && models.chipFor(sel('OPENROUTER', 'moonshotai/kimi-k3', 'high')).model === 'Kimi K3'
        && same(models.chipFor(sel('ANTHROPIC', 'claude-opus-4-8', null)), { provider: 'anthropic', model: 'claude-opus-4-8' }) && models.chipFor(sel('OPENROUTER', 'vendor/unlisted', 'max')).model === 'vendor/unlisted MAX');
    config.saveConfig({ models: { selected: null, recent: [] } });
}

// --- [F] OpenRouter reasoning options -------------------------------------------------
console.log('\n[F] callOptions for OpenRouter');
{
    writeCatalog({
        extra: [
            { ...byId['moonshotai/kimi-k3'], id: 'acme/any-effort', maxCompletionTokens: null, reasoning: { supportedEfforts: null, defaultEffort: null, mandatory: false, supportsMaxTokens: false } },
            { ...byId['moonshotai/kimi-k3'], id: 'acme/small-output', maxCompletionTokens: 8192 },
        ],
    });
    const opts = (model, effort, extra = {}, call = {}) => models.callOptions('OPENROUTER', 'smart', { OPENROUTER_KEY: 'k', OPENROUTER_MODEL: model, OPENROUTER_EFFORT: effort, ...extra }, call);
    const reasoning = (model, effort) => { const o = opts(model, effort); return o.providerOptions ? o.providerOptions.openrouter.reasoning : null; };
    const REASONING = (r, max) => ({ providerOptions: { openrouter: { reasoning: r } }, maxOutputTokens: max });

    ok('no effort -> no options (the model default applies)', same(models.callOptions('OPENROUTER', 'smart', { OPENROUTER_KEY: 'k' }), {}) && same(opts('anthropic/claude-sonnet-5.5', null), {}));
    ok('structured calls never send reasoning', same(opts('anthropic/claude-sonnet-5.5', 'max', {}, { structured: true }), {}));
    ok('a listed effort is sent as is, with the output capped at 64000', same(opts('anthropic/claude-sonnet-5.5', 'max'), REASONING({ effort: 'max' }, 64000)) && reasoning('anthropic/claude-sonnet-5.5', 'xhigh').effort === 'xhigh');
    ok('the output cap is the model limit below 64000, 64000 above it, 32000 when unknown', opts('acme/small-output', 'high').maxOutputTokens === 8192 && opts('openai/gpt-oss-120b', 'high').maxOutputTokens === 64000
        && opts('moonshotai/kimi-k3', 'high').maxOutputTokens === 64000 && opts('acme/any-effort', 'high').maxOutputTokens === 32000);
    ok('reasoning with neither an effort list nor a token budget sends nothing', same(opts('moonshotai/kimi-k2.7-code', 'max'), {}) && same(opts('z-ai/glm-5', 'max'), {}));

    ok('an unlisted effort drops to the nearest lower listed one', reasoning('openai/gpt-oss-120b', 'max') === null ? false : reasoning('openai/gpt-oss-120b', 'max').effort === 'high' && reasoning('openai/gpt-oss-120b', 'xhigh').effort === 'high');
    ok('...which can skip several steps', reasoning('z-ai/glm-5.3-prime', 'xhigh').effort === 'high' && reasoning('z-ai/glm-5.3-prime', 'medium').effort === 'low');
    ok('below everything listed, the lowest listed effort is used', reasoning('z-ai/glm-5.3-prime', 'minimal').effort === 'low' && reasoning('openai/gpt-oss-120b', 'minimal').effort === 'low');
    ok('none is sent only when the model lists it', same(reasoning('moonshotai/kimi-k3', 'none'), { effort: 'none' }) && reasoning('openai/gpt-oss-120b', 'none') === null && same(opts('openai/gpt-oss-120b', 'none'), {}));
    ok('an effort that lands on a listed none sends none', same(reasoning('mistralai/mistral-large-4-0', 'medium'), { effort: 'none' }) && same(reasoning('mistralai/mistral-large-4-0', 'high'), { effort: 'high' }));
    ok('null supportedEfforts: the gateway accepts every value', same(reasoning('acme/any-effort', 'xhigh'), { effort: 'xhigh' }) && same(reasoning('acme/any-effort', 'none'), { effort: 'none' }));
    ok('reasoning without an effort control uses a token budget when supported', same(reasoning('qwen/qwen3.8-flash', 'high'), { max_tokens: 16000 }) && same(reasoning('qwen/qwen3.8-flash', 'max'), { max_tokens: 64000 }) && same(reasoning('qwen/qwen3.8-flash', 'minimal'), { max_tokens: 1000 }));
    ok('...and nothing for none, or when no budget is supported', reasoning('qwen/qwen3.8-flash', 'none') === null && reasoning('z-ai/glm-5', 'high') === null && same(opts('xingchen-agi/xing4.0-29b-a4b:free', 'max'), {}));
    ok('a model without reasoning info is sent the effort as given', same(reasoning('unbiased/pareto-26.10', 'high'), { effort: 'high' }) && reasoning('unbiased/pareto-26.10', 'none') === null);
    ok('an unlisted model is sent the effort too (output capped at 32000)', same(opts('vendor/brand-new-model', 'high'), REASONING({ effort: 'high' }, 32000)) && same(opts('vendor/brand-new-model', 'none'), {}));
    const fastOptions = (extra = {}) => models.callOptions('OPENROUTER', 'fast', { OPENROUTER_KEY: 'k', OPENROUTER_EFFORT: 'max', ...extra });
    ok('the fast tier never reasons, whatever the config says: it asks for effort none when the model lists it', fastOptions().providerOptions.openrouter.reasoning.effort === 'none');
    ok('...and sends nothing when the fast model cannot switch reasoning off', same(fastOptions({ OPENROUTER_FAST_MODEL: 'openai/gpt-oss-120b' }), {}));

    // the effort overrides of the other providers are accepted and resolved, but only Anthropic acts on them
    ok('OPENAI_EFFORT and GROQ_EFFORT resolve but send nothing', models.resolveModelSpec('OPENAI', 'smart', { OPENAI_EFFORT: 'max' }).effort === 'max' && models.resolveModelSpec('GROQ', 'smart', { GROQ_EFFORT: 'low' }).effort === 'low'
        && same(models.callOptions('OPENAI', 'smart', { OPENAI_KEY: 'k', OPENAI_EFFORT: 'max' }), {}) && same(models.callOptions('GROQ', 'smart', { GROQ_KEY: 'k', GROQ_EFFORT: 'max' }), {}));
    ok('LOCAL_EFFORT still defaults to none', models.resolveModelSpec('LOCAL', 'smart', { LOCAL_MODEL: 'm' }).effort === 'none' && models.resolveModelSpec('LOCAL', 'smart', { LOCAL_MODEL: 'm', LOCAL_EFFORT: 'high' }).effort === 'high');
    writeCatalog();
}

// --- [G] registry: tiers, context, price, credentials, order ----------------------------
console.log('\n[G] OpenRouter in the registry');
{
    writeCatalog();
    ok('the default provider order is OpenRouter, Anthropic, OpenAI, Groq, local', same(models.DEFAULT_PROVIDER_ORDER, ['OPENROUTER', 'ANTHROPIC', 'OPENAI', 'GROQ', 'LOCAL']) && same(Object.keys(models.PROVIDERS), models.DEFAULT_PROVIDER_ORDER));
    ok('the effort ladder is ascending and minimal has a budget', same(models.EFFORT_ORDER, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) && models.EFFORT_BUDGETS.minimal === 1000
        && models.EFFORT_ORDER.every((e, i, all) => i === 0 || models.EFFORT_BUDGETS[all[i - 1]] < models.EFFORT_BUDGETS[e]));
    ok('the engine starts from the same order', same(new Code2Prompt({ template: TEMPLATE }).modelPreferences, models.DEFAULT_PROVIDER_ORDER));

    ok('smart tier: the sonnet "latest" alias, no effort', same(models.resolveModelSpec('OPENROUTER', 'smart', {}), { model: '~anthropic/claude-sonnet-latest', effort: null }));
    ok('fast tier: the haiku "latest" alias, effort none', same(models.resolveModelSpec('OPENROUTER', 'fast', {}), { model: '~anthropic/claude-haiku-latest', effort: 'none' }));
    ok('OPENROUTER_MODEL and OPENROUTER_EFFORT override the smart tier', same(models.resolveModelSpec('OPENROUTER', 'smart', { OPENROUTER_MODEL: 'moonshotai/kimi-k3', OPENROUTER_EFFORT: 'max' }), { model: 'moonshotai/kimi-k3', effort: 'max' }));
    ok('OPENROUTER_FAST_MODEL overrides the fast tier but never its effort', same(models.resolveModelSpec('OPENROUTER', 'fast', { OPENROUTER_FAST_MODEL: 'anthropic/claude-haiku-5.5', OPENROUTER_EFFORT: 'max' }), { model: 'anthropic/claude-haiku-5.5', effort: 'none' }));
    writeCatalog({ drop: ['~anthropic/claude-haiku-latest'] });
    ok('a fast model missing from the cached catalog falls back to the smart model', models.resolveModelSpec('OPENROUTER', 'fast', { OPENROUTER_MODEL: 'moonshotai/kimi-k3' }).model === 'moonshotai/kimi-k3'
        && models.resolveModelSpec('OPENROUTER', 'fast', {}).model === '~anthropic/claude-sonnet-latest');
    removeCatalog();
    ok('without a catalog the fast alias is kept', models.resolveModelSpec('OPENROUTER', 'fast', {}).model === '~anthropic/claude-haiku-latest');
    ok('modelId mirrors the resolved model', models.modelId('OPENROUTER', 'smart', { OPENROUTER_MODEL: 'x/y' }) === 'x/y' && models.modelId('ANTHROPIC', 'smart', {}) === 'claude-opus-4-8');
    writeCatalog();

    ok('context size follows the catalog entry of the resolved model', models.contextSizeFor('OPENROUTER', { OPENROUTER_MODEL: 'moonshotai/kimi-k3' }) === 1048576 && models.contextSizeFor('OPENROUTER', { OPENROUTER_MODEL: 'openai/gpt-oss-120b' }) === 131072);
    ok('...else 128000', models.contextSizeFor('OPENROUTER', { OPENROUTER_MODEL: 'vendor/unlisted' }) === 128000);
    removeCatalog();
    ok('...and without a catalog', models.contextSizeFor('OPENROUTER', { OPENROUTER_MODEL: 'moonshotai/kimi-k3' }) === 128000);
    writeCatalog();

    ok('estimateCost: the built-in table wins', Math.abs(models.estimateCost('openai/gpt-oss-120b', 1e6, 1e6) - 0.9) < 1e-9 && Math.abs(models.estimateCost('claude-opus-4-8', 1e6, 1e6) - 30) < 1e-9);
    ok('estimateCost: OpenRouter models fall back to their catalog price', Math.abs(models.estimateCost('anthropic/claude-sonnet-5.5', 1e6, 1e6) - 12) < 1e-9 && Math.abs(models.estimateCost('moonshotai/kimi-k3', 1000, 500) - (1000 * 3.04e-7 + 500 * 0.000011936)) < 1e-12);
    ok('estimateCost: unknown models and priceless routers cost nothing', models.estimateCost('vendor/unlisted', 1e6, 1e6) === 0 && models.estimateCost('openrouter/auto-beta', 1e6, 1e6) === 0 && models.estimateCost('claude-opus-4-8') === 0);

    ok('hasCredentials(OPENROUTER) needs a non-blank key', models.hasCredentials('OPENROUTER', { OPENROUTER_KEY: 'k' }) && !models.hasCredentials('OPENROUTER', {}) && !models.hasCredentials('OPENROUTER', { OPENROUTER_KEY: '   ' })
        && !models.hasCredentials('OPENROUTER', { OPENROUTER_KEY: null }) && !models.hasCredentials('OPENROUTER', { OPENROUTER_KEY: 42 }));
    ok('hasCredentials ignores blank keys for every provider and unknown providers', !models.hasCredentials('OPENAI', { OPENAI_KEY: ' ' }) && !models.hasCredentials('NOPE', { NOPE_KEY: 'k' })
        && models.hasCredentials('LOCAL', { LOCAL_BASE_URL: 'http://x', LOCAL_MODEL: 'm' }) && !models.hasCredentials('LOCAL', { LOCAL_BASE_URL: 'http://x' }));
    ok('resolveProvider walks the preferences and honors the context window', models.resolveProvider(['OPENROUTER', 'OPENAI'], { OPENROUTER_KEY: 'k', OPENAI_KEY: 'k' }, 1000) === 'OPENROUTER'
        && models.resolveProvider(['OPENROUTER', 'OPENAI'], { OPENROUTER_KEY: 'k', OPENROUTER_MODEL: 'openai/gpt-oss-120b', OPENAI_KEY: 'k' }, 200000) === 'OPENAI'
        && models.resolveProvider(['OPENROUTER', 'OPENAI'], { OPENAI_KEY: 'k' }, 1000) === 'OPENAI' && models.resolveProvider(['OPENROUTER'], {}, 1) === null);

    // the engine routes by these preferences
    const template = TEMPLATE;
    const engine = (keys) => new Code2Prompt({ template, ...keys });
    const onlyRouter = engine({ OPENROUTER_KEY: 'k' });
    onlyRouter.setModelPreferences(['OPENAI', 'ANTHROPIC', 'GROQ']);
    ok('a template that lists other providers still reaches OpenRouter, behind them', same(onlyRouter.modelPreferences, ['OPENAI', 'ANTHROPIC', 'GROQ', 'OPENROUTER']));
    onlyRouter.setModelPreferences(['OPENAI', 'ANTHROPIC', 'GROQ'], { strict: true });
    ok('strict keeps exactly the given list', same(onlyRouter.modelPreferences, ['OPENAI', 'ANTHROPIC', 'GROQ']));
    const several = engine({ OPENROUTER_KEY: 'k', GROQ_KEY: 'k', LOCAL_BASE_URL: 'http://x/v1', LOCAL_MODEL: 'm' });
    several.setModelPreferences(['GROQ']);
    ok('credentialed providers that were not listed follow in the default order', same(several.modelPreferences, ['GROQ', 'OPENROUTER', 'LOCAL']));
    several.setModelPreferences(['NOPE', 'GROQ', 'GROQ2']);
    ok('unknown providers are filtered out', same(several.modelPreferences, ['GROQ', 'OPENROUTER', 'LOCAL']));
    ok('setLLMAPI accepts an OpenRouter key', engine({}).setLLMAPI('OPENROUTER', 'sk-or-new') === true);
    const configured = engine({ OPENROUTER_KEY: 'k', OPENROUTER_MODEL: 'x/y', OPENROUTER_FAST_MODEL: 'x/z', OPENROUTER_EFFORT: 'max', OPENAI_EFFORT: 'low', GROQ_EFFORT: 'low' });
    ok('the engine config carries the OpenRouter settings and the effort overrides', configured.config.OPENROUTER_MODEL === 'x/y' && configured.config.OPENROUTER_FAST_MODEL === 'x/z' && configured.config.OPENROUTER_EFFORT === 'max' && configured.config.OPENAI_EFFORT === 'low' && configured.config.GROQ_EFFORT === 'low');
}

// --- [H] OpenRouter calls and the cost they report ---------------------------------------------
console.log('\n[H] chat completions through OpenRouter');
{
    writeCatalog();
    const requests = [];
    const COST = 0.0123;
    const usageBlock = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: COST };
    const completion = (content) => ({ id: 'gen-1', object: 'chat.completion', created: 1, model: 'anthropic/claude-sonnet-5.5', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: usageBlock });
    const stub = await startStub((req, res, body) => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { /* not json */ }
        requests.push({ url: req.url, headers: req.headers, body: parsed });
        if (req.url !== '/chat/completions') return sendJson(res, 404, {});
        if (parsed && parsed.model === 'broken/model') return sendJson(res, 401, { error: { message: 'bad key sk-or-chat-key', code: 401 } });
        if (!parsed.stream) return sendJson(res, 200, completion('Hello from OpenRouter'));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (extra) => `data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', created: 1, model: parsed.model, ...extra })}\n\n`;
        res.write(chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello ' }, finish_reason: null }] }));
        res.write(chunk({ choices: [{ index: 0, delta: { content: 'streamed' }, finish_reason: null }] }));
        res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
        res.write(chunk({ choices: [], usage: usageBlock }));
        res.write('data: [DONE]\n\n');
        res.end();
    });
    process.env.AICODE_OPENROUTER_API = stub.url;

    const cfg = { OPENROUTER_KEY: 'sk-or-chat-key', OPENROUTER_MODEL: 'anthropic/claude-sonnet-5.5', OPENROUTER_EFFORT: 'max' };
    const model = models.createModel('OPENROUTER', 'smart', cfg);
    const result = await generateText({ model, prompt: 'Say hi', ...models.callOptions('OPENROUTER', 'smart', cfg) });
    ok('generateText answers through the OpenRouter provider', result.text === 'Hello from OpenRouter' && result.usage.inputTokens === 100 && result.usage.outputTokens === 20);
    const sent = requests[0];
    ok('the request goes to the configured base URL with the key and the app headers', sent.url === '/chat/completions' && sent.headers.authorization === 'Bearer sk-or-chat-key'
        && sent.headers['http-referer'] === 'https://github.com/puntorigen/aicode' && sent.headers['x-title'] === 'aicode');
    ok('the selected model is the one requested', sent.body.model === 'anthropic/claude-sonnet-5.5');
    ok('the MAX effort reaches the request as a reasoning effort', sent.body.reasoning && sent.body.reasoning.effort === 'max' && sent.body.max_tokens === 64000);
    ok('usage accounting is requested', sent.body.usage && sent.body.usage.include === true);
    ok('the real cost comes back in the provider metadata', result.providerMetadata && result.providerMetadata.openrouter && result.providerMetadata.openrouter.usage && result.providerMetadata.openrouter.usage.cost === COST);

    const streamed = streamText({ model, prompt: 'Say hi', ...models.callOptions('OPENROUTER', 'smart', cfg) });
    let text = '';
    for await (const part of streamed.textStream) text += part;
    const streamUsage = await streamed.usage;
    const streamMetadata = await streamed.providerMetadata;
    ok('streamText streams the answer', text === 'Hello streamed' && streamUsage.inputTokens === 100);
    ok('the streamed call reports the real cost too', streamMetadata && streamMetadata.openrouter && streamMetadata.openrouter.usage && streamMetadata.openrouter.usage.cost === COST);

    // the ledger prefers the reported cost over the price estimate
    const ledger = new Code2Prompt.UsageLedger();
    ledger.record('OPENROUTER', 'smart', 'anthropic/claude-sonnet-5.5', result.usage, result.providerMetadata);
    const summary = ledger.summary();
    ok('the ledger sums the reported cost, not the catalog estimate', Math.abs(summary.cost - COST) < 1e-12 && Math.abs(summary.cost - models.estimateCost('anthropic/claude-sonnet-5.5', 100, 20)) > 1e-6);
    ledger.record('OPENROUTER', 'smart', 'anthropic/claude-sonnet-5.5', { inputTokens: 1e6, outputTokens: 0 }, null);
    ledger.record('OPENROUTER', 'smart', 'anthropic/claude-sonnet-5.5', { inputTokens: 1e6, outputTokens: 0 }, { openrouter: { usage: { cost: 'free' } } });
    ok('entries without a reported cost fall back to the estimate', Math.abs(ledger.summary().cost - (COST + 2 + 2)) < 1e-9 && ledger.entries[1].cost === undefined && ledger.entries[2].cost === undefined);
    ledger.record('OPENAI', 'fast', 'gpt-5.4-mini', { inputTokens: 1e6, outputTokens: 1e6 }, { openai: {} });
    ok('metadata of other providers is ignored', Math.abs(ledger.summary().cost - (COST + 4 + 0.25 + 2)) < 1e-9 && ledger.summary().calls === 4);
    ok('a reported cost of zero is kept (free models)', (() => { const l = new Code2Prompt.UsageLedger(); l.record('OPENROUTER', 'smart', 'x/y:free', { inputTokens: 1e6 }, { openrouter: { usage: { cost: 0 } } }); return l.summary().cost === 0 && l.entries[0].cost === 0; })());

    // the engine records the cost itself, on both call paths
    const Engine = require('../lib/engine');
    const engine = new Engine({ template: TEMPLATE, OPENROUTER_KEY: 'sk-or-chat-key', OPENROUTER_MODEL: 'anthropic/claude-sonnet-5.5' });
    const engineLedger = new Engine.UsageLedger();
    engine.setUsageLedger(engineLedger);
    engine.setModelPreferences(['OPENROUTER'], { strict: true });
    await engine.queryLLM('Say hi', null, { tier: 'smart' }).catch(() => { });
    ok('the engine passes the provider metadata to the ledger', engineLedger.entries.length >= 1 && engineLedger.entries.every((e) => e.provider === 'OPENROUTER' && Math.abs(e.cost - COST) < 1e-12));

    // errors never echo the key back
    const failing = models.createModel('OPENROUTER', 'smart', { ...cfg, OPENROUTER_MODEL: 'broken/model' });
    const failure = await generateText({ model: failing, prompt: 'hi', maxRetries: 0 }).then(() => null, (e) => e);
    ok('a rejected call surfaces the provider error', failure instanceof Error && failure.message.length > 0);

    await stub.close();
    delete process.env.AICODE_OPENROUTER_API;
}

// --- [I] credentials -----------------------------------------------------------------------------
console.log('\n[I] lib/keys.js');
{
    const keysFile = () => path.join(TMP_HOME, '.aicode', 'keys.json');
    const resetKeys = () => { try { fs.unlinkSync(keysFile()); } catch (e) { /* none */ } };
    const stored = () => new EncryptedJsonDB('keys.json').load();
    const clearEnv = () => { for (const name of ['OPENROUTER_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_KEY', 'OPENAI_KEY', 'GROQ_KEY', 'REPLICATE_API_TOKEN']) delete process.env[name]; };
    resetKeys(); clearEnv();

    ok('masked keeps 6 leading and 4 trailing characters', keysLib.maskKey('sk-or-v1-abcdefghijklmnop') === 'sk-or-…mnop' && keysLib.maskKey('123456789012') === '123456…9012');
    ok('short or missing values are fully hidden', keysLib.maskKey('12345678901') === '••••' && keysLib.maskKey('abc') === '••••' && keysLib.maskKey('') === '••••' && keysLib.maskKey(null) === '••••' && keysLib.maskKey(12345678901234) === '••••');
    ok('provider names parse in any case', keysLib.parseProvider('OpenRouter') === 'OPENROUTER' && keysLib.parseProvider(' groq ') === 'GROQ' && keysLib.parseProvider('local') === 'LOCAL' && keysLib.parseProvider('ANTHROPIC') === 'ANTHROPIC');
    const unknown = throws(() => keysLib.parseProvider('nope'));
    ok('unknown providers are refused with the list of valid ones', unknown && unknown.message.includes('unknown provider: nope') && unknown.message.includes('openrouter') && throws(() => keysLib.parseProvider(undefined)) instanceof Error && throws(() => keysLib.parseProvider('')) instanceof Error);
    ok('the key fields follow the default provider order', same(Object.keys(keysLib.PROVIDER_KEYS), ['OPENROUTER', 'ANTHROPIC', 'OPENAI', 'GROQ']));

    // loadKeys: stored file + environment
    process.env.OPENROUTER_API_KEY = 'env-alias-key-000000';
    ok('OPENROUTER_API_KEY is accepted as a fallback name', keysLib.loadKeys().OPENROUTER_KEY === 'env-alias-key-000000');
    process.env.OPENROUTER_KEY = 'env-main-key-111111';
    ok('OPENROUTER_KEY wins over the fallback name', keysLib.loadKeys().OPENROUTER_KEY === 'env-main-key-111111');
    process.env.GROQ_KEY = '   ';
    process.env.REPLICATE_API_TOKEN = 'r8_token_value_1234';
    const fromEnv = keysLib.loadKeys();
    ok('blank environment values are ignored; the Replicate token is read', fromEnv.GROQ_KEY === undefined && fromEnv.REPLICATE_API_TOKEN === 'r8_token_value_1234');
    ok('loading never writes the environment back', !fs.existsSync(keysFile()));
    new EncryptedJsonDB('keys.json').save({ OPENROUTER_KEY: 'stored-key-2222222', ANTHROPIC_KEY: 'sk-ant-stored-3333' });
    ok('the stored key wins over the environment once saved', keysLib.loadKeys().OPENROUTER_KEY === 'stored-key-2222222' && keysLib.loadKeys().ANTHROPIC_KEY === 'sk-ant-stored-3333');
    fs.writeFileSync(keysFile(), 'this is not an encrypted file');
    const warnings = [];
    const damaged = keysLib.loadKeys({ onWarn: (m) => warnings.push(m) });
    ok('an unreadable keys.json warns and continues with the environment', warnings.length === 1 && warnings[0].includes('keys.json') && damaged.OPENROUTER_KEY === 'env-main-key-111111');
    resetKeys(); clearEnv();

    // setKey / removeKey / listProviders
    new EncryptedJsonDB('keys.json').save({ ANTHROPIC_KEY: 'sk-ant-stored-3333' });
    process.env.GROQ_KEY = 'gsk_from_the_environment';
    const keysData = keysLib.loadKeys();
    ok('keysData merges the stored file and the environment', keysData.ANTHROPIC_KEY === 'sk-ant-stored-3333' && keysData.GROQ_KEY === 'gsk_from_the_environment');
    const returned = keysLib.setKey('openrouter', '  sk-or-v1-abcdefghijkl  ', keysData);
    ok('setKey trims, mutates keysData in place and returns it', returned === keysData && keysData.OPENROUTER_KEY === 'sk-or-v1-abcdefghijkl');
    ok('setKey writes only what changed (environment keys stay out of the file)', same(Object.keys(stored()).sort(), ['ANTHROPIC_KEY', 'OPENROUTER_KEY']) && stored().OPENROUTER_KEY === 'sk-or-v1-abcdefghijkl');
    ok('the file does not contain the key in clear', !fs.readFileSync(keysFile(), 'utf8').includes('sk-or-v1-abcdefghijkl') && !fs.readFileSync(keysFile(), 'utf8').includes('sk-ant-stored-3333'));
    if (process.platform !== 'win32') ok('keys.json is readable by its owner only', (fs.statSync(keysFile()).mode & 0o077) === 0);
    ok('an empty key is refused', throws(() => keysLib.setKey('openai', '   ', keysData)).message === 'empty key' && throws(() => keysLib.setKey('openai', undefined, keysData)).message === 'empty key' && keysData.OPENAI_KEY === undefined);
    ok('an unknown provider is refused', throws(() => keysLib.setKey('nope', 'abc', keysData)) instanceof Error && throws(() => keysLib.removeKey('nope', keysData)) instanceof Error);
    ok('a LOCAL server needs a base URL and a model', throws(() => keysLib.setKey('local', { baseURL: 'http://localhost:11434/v1' }, keysData)).message === 'empty key' && throws(() => keysLib.setKey('local', 'http://x', keysData)).message === 'empty key');
    keysLib.setKey('local', { baseURL: 'http://user:secret@localhost:11434/v1', model: 'llama3', fastModel: 'llama3-small' }, keysData);
    ok('a LOCAL server stores its URL, model and fast model', keysData.LOCAL_BASE_URL.startsWith('http://user:secret@') && keysData.LOCAL_MODEL === 'llama3' && keysData.LOCAL_FAST_MODEL === 'llama3-small' && stored().LOCAL_MODEL === 'llama3');

    const rows = keysLib.listProviders(keysData);
    const row = (provider) => rows.find((r) => r.provider === provider);
    ok('listProviders has one row per provider in the default order', rows.map((r) => r.provider).join() === 'OPENROUTER,ANTHROPIC,OPENAI,GROQ,LOCAL');
    ok('a stored key: masked, from keys.json, with its smart model', row('OPENROUTER').configured && row('OPENROUTER').masked === 'sk-or-…ijkl' && row('OPENROUTER').source === 'keys.json' && row('OPENROUTER').model === '~anthropic/claude-sonnet-latest');
    ok('an environment key says so', row('GROQ').configured && row('GROQ').source === 'env' && row('GROQ').masked === 'gsk_fr…ment' && row('GROQ').model === 'openai/gpt-oss-120b');
    ok('a missing key has no mask, source or model', same(row('OPENAI'), { provider: 'OPENAI', configured: false, masked: null, source: null, model: null }));
    ok('a LOCAL row shows the server without its credentials', row('LOCAL').configured && row('LOCAL').masked === 'http://localhost:11434/v1' && row('LOCAL').model === 'llama3' && !JSON.stringify(rows).includes('secret@') && !JSON.stringify(rows).includes('sk-or-v1-abcdefghijkl'));

    keysLib.removeKey('local', keysData);
    ok('removeKey(local) forgets the server everywhere', keysData.LOCAL_BASE_URL === undefined && keysData.LOCAL_MODEL === undefined && keysData.LOCAL_FAST_MODEL === undefined && stored().LOCAL_MODEL === undefined && !keysLib.listProviders(keysData).find((r) => r.provider === 'LOCAL').configured);
    keysLib.removeKey('openrouter', keysData);
    ok('removeKey drops one key and keeps the others', keysData.OPENROUTER_KEY === undefined && stored().OPENROUTER_KEY === undefined && stored().ANTHROPIC_KEY === 'sk-ant-stored-3333' && keysData.GROQ_KEY === 'gsk_from_the_environment');
    ok('removing a key that is not stored is harmless', (() => { keysLib.removeKey('openai', keysData); return true; })());
    resetKeys(); clearEnv();

    // testKey
    const anything = { OPENROUTER_KEY: 'sk-or-test-key-123456' };
    ok('testKey of an unknown provider says so', (await keysLib.testKey('nope', anything)).ok === false && (await keysLib.testKey('nope', anything)).detail.includes('unknown provider'));
    ok('testKey of a provider without a key -> not configured', same(await keysLib.testKey('openai', anything), { ok: false, detail: 'not configured' }));

    const seen = [];
    const stub = await startStub((req, res) => {
        seen.push(req.headers.authorization);
        if (req.url !== '/key') return sendJson(res, 404, {});
        if (req.headers.authorization === 'Bearer sk-or-test-key-123456') return sendJson(res, 200, { data: { label: 'ci-key', limit: 5, limit_remaining: 3.14159, usage: 1.86 } });
        if (req.headers.authorization === 'Bearer sk-or-open-key-123456') return sendJson(res, 200, { data: { label: 'open', limit: null, limit_remaining: null } });
        if (req.headers.authorization === 'Bearer sk-or-odd-key-1234567') return sendJson(res, 200, { data: { label: null, limit: 5, limit_remaining: null } });
        return sendJson(res, 401, {});
    });
    process.env.AICODE_OPENROUTER_API = stub.url;
    ok('testKey(OPENROUTER) reports the label and the credits left', same(await keysLib.testKey('openrouter', anything), { ok: true, detail: 'ci-key · 3.14 credits left' }));
    ok('...unlimited when the key has no limit', same(await keysLib.testKey('openrouter', { OPENROUTER_KEY: 'sk-or-open-key-123456' }), { ok: true, detail: 'open · unlimited' }));
    ok('...and tolerates missing fields', (await keysLib.testKey('openrouter', { OPENROUTER_KEY: 'sk-or-odd-key-1234567' })).detail === 'key · ? credits left');
    ok('...invalid key when rejected', same(await keysLib.testKey('openrouter', { OPENROUTER_KEY: 'sk-or-bad-key-1234567' }), { ok: false, detail: 'invalid key' }));
    ok('the key reached the server as a Bearer token', seen[0] === 'Bearer sk-or-test-key-123456');
    await stub.close();
    process.env.AICODE_OPENROUTER_API = 'http://127.0.0.1:1';
    const offline = await keysLib.testKey('openrouter', anything);
    ok('...a network failure is a result, not an exception', offline.ok === false && offline.detail.length > 0 && !offline.detail.includes('sk-or-test-key-123456'));
    delete process.env.AICODE_OPENROUTER_API;

    // the other providers answer one tiny completion on their fast tier
    const originalCreate = models.createModel;
    let asked = null;
    const reply = (text) => new MockLanguageModelV3({
        doGenerate: async (options) => {
            asked = options;
            return { content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
        },
    });
    models.createModel = () => reply('OK');
    const answered = await keysLib.testKey('anthropic', { ANTHROPIC_KEY: 'sk-ant-test-key-123456' });
    ok('testKey of a cloud provider answers with its fast model', same(answered, { ok: true, detail: 'claude-haiku-4-5 answered' }) && asked.maxOutputTokens === 5 && JSON.stringify(asked.prompt).includes('Reply with the single word OK.'));
    const created = [];
    models.createModel = (provider, tier) => { created.push([provider, tier]); return reply('OK'); };
    await keysLib.testKey('groq', { GROQ_KEY: 'gsk_test_key_1234567' });
    ok('...on the fast tier of that provider', same(created, [['GROQ', 'fast']]));
    models.createModel = () => new MockLanguageModelV3({ doGenerate: async () => { throw new Error('401 invalid x-api-key: sk-ant-test-key-123456'); } });
    const rejected = await keysLib.testKey('anthropic', { ANTHROPIC_KEY: 'sk-ant-test-key-123456' });
    ok('a failing call is reported without echoing the key', rejected.ok === false && rejected.detail.includes('401') && !rejected.detail.includes('sk-ant-test-key-123456') && rejected.detail.includes('***'));
    models.createModel = originalCreate;
    resetKeys(); clearEnv();
}

fs.rmSync(TMP_HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
