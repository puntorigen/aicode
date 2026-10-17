// Offline checks for lib/models.js: provider registry, effort handling and
// per-call provider options. Nothing here touches the network or the real HOME.
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import fs from 'fs';

const require = createRequire(import.meta.url);

// isolate HOME before anything resolves ~/.aicode (config, keys, caches)
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-models-home-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const models = require('../lib/models');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '}${name}`); if (!cond) failures++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
}

fs.rmSync(TMP_HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
