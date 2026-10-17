#!/usr/bin/env node

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const getSystemLocale = require('./helpers/lang')();
const output_redirected = !process.stdout.isTTY;

const __ = require('y18n')({
    directory: __dirname + '/locales',
    locale: getSystemLocale,
}).__;

let argv = yargs(hideBin(process.argv))
  .scriptName('aicode')
  .locale(getSystemLocale)
  .usage(__('Usage: $0 <command> [options]'))
  .command('$0 [input]', __('Process the input'), (yargs) => {
    yargs.positional('input', {
      describe: __('Input string to process'),
      type: 'string',
    })
  })
  .command('serve', __('Start the Agent Server only (for the IDE extension or other frontends)'), (yargs) => {
    yargs
      .option('port', {
        type: 'number',
        description: __('Port to listen on (default: server.port in ~/.aicode/config.json; 0 picks a free port)'),
      })
      .option('token', {
        type: 'string',
        description: __('Handshake token clients must send (default: a random one for this run)'),
      })
  })
  .command('models [query]', __('List available models (OpenRouter catalog plus configured providers)'), (yargs) => {
    yargs
      .positional('query', {
        describe: 'only models whose id or name contains every word (e.g. "sonnet 5.5")',
        type: 'string',
      })
      .option('refresh', {
        type: 'boolean',
        default: false,
        description: __('Refresh the OpenRouter model catalog'),
      })
  })
  .command('keys [action] [provider] [value]', __('Manage provider API keys: list, set, remove, test'), (yargs) => {
    yargs
      .positional('action', {
        describe: 'list (default), set, remove or test',
        type: 'string',
      })
      .positional('provider', {
        describe: 'openrouter, anthropic, openai, groq or local',
        type: 'string',
      })
      .positional('value', {
        describe: 'the key (omit it to be asked: a key typed here stays in your shell history)',
        type: 'string',
      })
  })
  .option('model', {
    type: 'string',
    description: __('Model for this run: [provider:]model[@effort], e.g. openrouter:anthropic/claude-sonnet-5.5@max or "sonnet 5.5 max"'),
  })
  .option('debug', {
    alias: 'd',
    type: 'boolean',
    description: __('Run with debug output'),
  })
  .option('language', {
    alias: 'l',
    type: 'string',
    description: __('Language for the output'),
  })
  .option('confirm', {
    alias: 'c',
    type: 'boolean',
    default: false,
    description: __('Confirm each AI action before executing it'),
  })
  .option('local', {
    type: 'boolean',
    default: false,
    description: __('Force using the local model provider (Ollama/LM Studio) for this run'),
  })
  .option('agent', {
    alias: 'a',
    type: 'boolean',
    default: false,
    description: __('Force agent mode: a multi-step tool-using loop instead of a single action'),
  })
  .option('quiet', {
    alias: 'q',
    type: 'boolean',
    default: false,
    description: __('Only print the final answer (no header, steps or footer)'),
  })
  .option('tui', {
    type: 'boolean',
    default: false,
    description: __('Open the interactive TUI session'),
  })
  .option('install-skill', {
    type: 'string',
    description: __('Install an Agent Skill from skills.sh (e.g. owner/repo), then exit'),
  })
  .option('global', {
    alias: 'g',
    type: 'boolean',
    default: false,
    description: __('With --install-skill: install the skill globally (~/) instead of into the project'),
  })
  .help('h')
  .alias('h', 'help')
  .parse();

// Initialize the required variables
const modelsReg = require('./lib/models');
const openrouter = require('./lib/openrouter');
const keysLib = require('./lib/keys');
const skills = require('./lib/skills');
const currentWorkingDirectory = process.cwd();
require('dotenv').config();
const { createUI } = require('./lib/ui');
const EncryptedJsonDB = require('./helpers/db');
const { createRuntime, cleanupTmpFiles } = require('./lib/runtime');

if (output_redirected) {
    // disable debugger if output is redirected
    argv.debug = false;
}

// the single terminal UI (transcript renderer for one-shot runs)
const ui = createUI({
    quiet: argv.quiet,
    debug: argv.debug,
    plain: output_redirected ? true : undefined,
});

// per-session flags (the TUI mutates them live: /local, /agent)
const flags = {
    confirm: !!argv.confirm,
    local: !!argv.local,
    mode: argv.agent ? 'agent' : 'auto',
    language: argv.language || null,
    quiet: !!argv.quiet,
    debug: !!argv.debug,
    modelPreferences: null,
    // the ModelSelection of this run: --model, else the one remembered in config.json
    model: null,
};
const debug = (message, data) => { if (flags.debug) ui.debug(message, data); };

// trap exit signals; long-running commands (aicode serve) register async cleanup
// in `shutdownHooks`, which runs before the process exits
const shutdownHooks = [];
const shutdown = async () => {
    try { ui && ui.dispose && ui.dispose(); } catch (e) {}
    for (const hook of shutdownHooks) {
        // a hook that hangs must not keep the process alive
        try { await Promise.race([hook(), new Promise((resolve) => setTimeout(resolve, 3000))]); } catch (e) {}
    }
    // erase tmp files
    cleanupTmpFiles();
    process.exit(0);
};
process.on('SIGINT', shutdown);

// probe for a local OpenAI-compatible server (Ollama, LM Studio)
const detectLocalProvider = async () => {
    const candidates = [
        { name: 'Ollama', baseURL: 'http://localhost:11434/v1', tags: 'http://localhost:11434/api/tags' },
        { name: 'LM Studio', baseURL: 'http://localhost:1234/v1', tags: 'http://localhost:1234/v1/models' },
    ];
    for (const candidate of candidates) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 1500);
            const res = await fetch(candidate.tags, { signal: controller.signal });
            clearTimeout(timer);
            if (!res.ok) continue;
            const data = await res.json();
            // Ollama: { models: [{name}] } / LM Studio (openai format): { data: [{id}] }
            const models = (data.models || data.data || []).map((m) => m.name || m.id).filter(Boolean);
            if (models.length > 0) {
                return { name: candidate.name, baseURL: candidate.baseURL, models };
            }
        } catch (e) { /* server not running; try next */ }
    }
    return null;
};

// credentials for commands that never prompt (serve, models, keys): keys.json
// plus the environment, in memory only (environment values are not written back)
const loadKeysWithoutPrompt = () => keysLib.loadKeys({ onWarn: (message) => ui.note(message, '', 'yellow') });

// aicode serve: only the Agent Server, in the foreground until Ctrl-C
const runServe = async () => {
    const { startAgentServer } = require('./lib/server');
    const config = require('./lib/config').loadConfig();
    if (argv.port !== undefined && (!Number.isInteger(argv.port) || argv.port < 0 || argv.port > 65535)) {
        ui.error(new Error(`Invalid --port "${argv.port}": use an integer between 0 and 65535.`));
        process.exit(1);
    }
    const port = argv.port !== undefined ? argv.port : config.server.port;
    const keysData = loadKeysWithoutPrompt();
    let server;
    try {
        server = await startAgentServer({
            port,
            token: argv.token || undefined,
            debug: (message, data) => { if (flags.debug) ui.debug(message, data); },
            // the key store every session shares: keys.* messages change it live
            keysData,
            // one runtime per session, all sharing the same key store
            runtimeFactory: (sessionCwd, sessionFlags, extras = {}) => createRuntime({
                cwd: sessionCwd,
                keysData,
                flags: sessionFlags,
                debug: extras.debug,
                ide: extras.ide || null,
            }),
        });
    } catch (err) {
        ui.error(err && err.code === 'EADDRINUSE' ? new Error(`${err.message}. Use --port <n> (0 picks a free port).`) : err);
        process.exit(1);
    }
    shutdownHooks.push(() => server.close());
    process.on('SIGTERM', shutdown);
    process.stdout.write(`aicode agent server ready\n  url    ${server.url}\n  token  ${server.token}\nPress Ctrl-C to stop.\n`);
};

// ---- aicode models / aicode keys ----------------------------------------------------
// a table on stdout: every column but the last is padded to its widest cell
const printTable = (rows) => {
    const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => String(row[col]).length)));
    for (const row of rows) {
        const line = row.map((cell, col) => (col === row.length - 1 ? String(cell) : String(cell).padEnd(widths[col]))).join('  ');
        process.stdout.write(line.trimEnd() + '\n');
    }
};

// 200000 -> "200k", 1000000 -> "1M"
const formatContext = (tokens) => {
    if (!tokens) return '-';
    return tokens >= 1000000 ? `${Number((tokens / 1000000).toFixed(1))}M` : `${Math.round(tokens / 1000)}k`;
};

// aicode models [query] [--refresh]: the picker's list, as a table
const runModels = async () => {
    const keysData = loadKeysWithoutPrompt();
    const config = require('./lib/config').loadConfig();
    if (keysData.OPENROUTER_KEY || argv.refresh) {
        // the catalog endpoint is public: --refresh works without a key too
        try {
            await openrouter.fetchCatalog({
                apiKey: keysData.OPENROUTER_KEY,
                force: !!argv.refresh,
                onError: (err) => ui.note(`Could not refresh the OpenRouter catalog (${err.message}); using the cached list.`, '', 'yellow'),
            });
        } catch (err) {
            ui.note(`Could not load the OpenRouter catalog: ${err.message}`, '', 'yellow');
        }
    }
    const listing = modelsReg.listModels({ keysData, config, query: argv.query });
    if (listing.models.length === 0) {
        process.stderr.write(argv.query ? `No model matches "${argv.query}".\n` : 'No models to list.\n');
        process.exitCode = 1;
        return;
    }
    const rows = [['n', 'provider', 'id', 'context', '$in/$out per 1M', 'tools', 'efforts', 'groups']];
    listing.models.forEach((m, i) => {
        const efforts = m.reasoning
            ? (Array.isArray(m.reasoning.supportedEfforts) ? m.reasoning.supportedEfforts.join(',') || '-' : (m.reasoning.supportedEfforts === null ? 'any' : '-'))
            : '-';
        rows.push([
            String(i + 1),
            m.provider.toLowerCase(),
            m.id,
            formatContext(m.contextLength),
            m.pricing ? `$${m.pricing.prompt}/$${m.pricing.completion}` : '-',
            m.supportsTools ? 'yes' : 'no',
            efforts,
            m.groups.join(',') || '-',
        ]);
    });
    printTable(rows);
    if (!listing.catalog) process.stderr.write('\nThe OpenRouter catalog is not loaded yet: run "aicode keys set openrouter" or "aicode models --refresh".\n');
    else if (listing.models.some((m) => m.provider === 'OPENROUTER' && !m.available)) process.stderr.write('\nOpenRouter models need a key: run "aicode keys set openrouter".\n');
    process.stderr.write('Use one with: aicode --model <provider:id[@effort]>   (e.g. --model "sonnet 5.5 max")\n');
};

// aicode keys [list|set <provider> [value]|remove <provider>|test <provider>]
const runKeys = async () => {
    const keysData = loadKeysWithoutPrompt();
    const action = String(argv.action || 'list').toLowerCase();
    const say = (line = '') => process.stdout.write(line + '\n');
    const fail = (err) => { ui.error(err instanceof Error ? err : new Error(String(err))); process.exit(1); };
    if (action === 'list') {
        printTable([
            ['provider', 'configured', 'masked', 'source', 'model'],
            ...keysLib.listProviders(keysData).map((row) => [row.provider.toLowerCase(), row.configured ? 'yes' : 'no', row.masked || '-', row.source || '-', row.model || '-']),
        ]);
        return;
    }
    if (!['set', 'remove', 'test'].includes(action)) fail(`Unknown keys action "${argv.action}". Use list, set, remove or test.`);
    if (!argv.provider) fail(`aicode keys ${action} needs a provider: openrouter, anthropic, openai, groq or local.`);
    let provider;
    try { provider = keysLib.parseProvider(argv.provider); } catch (err) { fail(err); }

    if (action === 'set') {
        let value = argv.value;
        if (provider === 'LOCAL') {
            const baseURL = value || await ui.ask('Local server base URL (e.g. http://localhost:11434/v1):');
            const model = await ui.ask('Model name served there:');
            value = { baseURL, model };
        } else if (value === undefined || value === '') {
            const label = provider === 'OPENROUTER' ? 'Paste your OpenRouter API key (openrouter.ai/settings/keys):' : `Paste your ${provider} API key:`;
            value = await ui.ask(label, { secret: true });
        }
        try { keysLib.setKey(provider, value, keysData); } catch (err) { fail(err); }
        say(`${provider.toLowerCase()} key saved`);
        const res = await keysLib.testKey(provider, keysData);
        say(res.ok ? `ok · ${res.detail}` : `failed · ${res.detail}`);
        return;
    }
    if (action === 'remove') {
        const row = keysLib.listProviders(keysData).find((r) => r.provider === provider);
        if (!row.configured) { say(`${provider.toLowerCase()} is not configured`); return; }
        if (!await ui.confirm(`Remove the ${provider.toLowerCase()} key?`, { initial: false })) { say('kept'); return; }
        keysLib.removeKey(provider, keysData);
        say(`${provider.toLowerCase()} key removed`);
        const envNames = (keysLib.ENV_NAMES[keysLib.PROVIDER_KEYS[provider]] || []).filter((name) => (process.env[name] || '').trim() !== '');
        if (envNames.length) say(`note: ${envNames.join(' / ')} is still set in your environment and keeps ${provider.toLowerCase()} configured`);
        return;
    }
    // test
    const res = await keysLib.testKey(provider, keysData);
    say(res.ok ? `ok · ${res.detail}` : `failed · ${res.detail}`);
    if (!res.ok) process.exitCode = 1;
};

// Process the input
!(async () => {
    // these commands never run the interactive key prompts
    if (argv._[0] === 'serve') {
        await runServe();
        return;
    }
    if (argv._[0] === 'models') {
        await runModels();
        ui.dispose();
        return;
    }
    if (argv._[0] === 'keys') {
        await runKeys();
        ui.dispose();
        return;
    }
    // --install-skill: install an Agent Skill from skills.sh and exit (no keys needed)
    if (argv['install-skill']) {
        const src = String(argv['install-skill']).trim();
        ui.note(`Installing skill *${src}*${argv.global ? ' (global)' : ' (project)'} via skills.sh …`);
        const res = await skills.installSkill(src, { global: !!argv.global, inherit: true });
        if (res.ok) ui.note('Skill installed. aicode will pick it up automatically on the next run.', '', 'green');
        else ui.error(`Skill install failed (exit ${res.code}). Is npx available? Try: npx skills add ${src}`);
        try { ui.dispose(); } catch (e) { }
        process.exit(res.ok ? 0 : 1);
    }
    // load config data
    const db_keys = new EncryptedJsonDB('keys.json');
    let db_keys_data = db_keys.load();
    // an OpenRouter key that came from the environment lives in memory only; it is
    // kept out of every write to keys.json below
    let openrouterFromEnv = '';
    const saveKeys = () => {
        const copy = { ...db_keys_data };
        if (openrouterFromEnv && copy.OPENROUTER_KEY === openrouterFromEnv) delete copy.OPENROUTER_KEY;
        db_keys.save(copy);
    };
    if (true) {
        // only ask any supported API, if there are no API providers set yet
        // OPENROUTER: one key for the whole model catalog. It heads the default provider
        // order, so it is asked first, and only in an interactive terminal.
        if (!(db_keys_data.OPENROUTER_KEY || '').trim()) {
            const fromEnv = (process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY || '').trim();
            if (fromEnv) {
                openrouterFromEnv = fromEnv;
                db_keys_data.OPENROUTER_KEY = fromEnv;
            } else if (process.stdin.isTTY && process.stdout.isTTY) {
                db_keys_data.OPENROUTER_KEY = await ui.ask('Enter your OPENROUTER API key (or empty if none):', { secret: true });
            }
        }
        // OPENAI
        if (!process.env.OPENAI_KEY && !db_keys_data.OPENAI_KEY) {
            db_keys_data.OPENAI_KEY = await ui.ask('Enter your OPENAI API key (or empty if none):');
        } else if (process.env.OPENAI_KEY && !db_keys_data.OPENAI_KEY) {
            db_keys_data.OPENAI_KEY = process.env.OPENAI_KEY;
        }
        // GROQ
        if (!process.env.GROQ_KEY && !db_keys_data.GROQ_KEY) {
            db_keys_data.GROQ_KEY = await ui.ask('Enter your GROQ API key (or empty if none):');
        } else if (process.env.GROQ_KEY && !db_keys_data.GROQ_KEY) {
            db_keys_data.GROQ_KEY = process.env.GROQ_KEY;
        }
        // ANTHROPIC
        if (!process.env.ANTHROPIC_KEY && !db_keys_data.ANTHROPIC_KEY) {
            db_keys_data.ANTHROPIC_KEY = await ui.ask('Enter your ANTHROPIC API key (or empty if none):');
        } else if (process.env.ANTHROPIC_KEY && !db_keys_data.ANTHROPIC_KEY) {
            db_keys_data.ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
        }
        // REPLICATE
        if (!process.env.REPLICATE_API_TOKEN && !db_keys_data.REPLICATE_API_TOKEN) {
            db_keys_data.REPLICATE_API_TOKEN = await ui.ask('Enter your REPLICATE API TOKEN (or empty if none):');
        } else if (process.env.REPLICATE_API_TOKEN && !db_keys_data.REPLICATE_API_TOKEN) {
            db_keys_data.REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
        }
        // we need at least 1 provider: cloud key or a local model server
        const has_cloud_key = [db_keys_data.OPENROUTER_KEY, db_keys_data.OPENAI_KEY, db_keys_data.GROQ_KEY, db_keys_data.ANTHROPIC_KEY].some((k) => (k || '').trim() != '');
        const has_local = (db_keys_data.LOCAL_BASE_URL || '').trim() != '' && (db_keys_data.LOCAL_MODEL || '').trim() != '';
        if (!has_cloud_key && !has_local) {
            // no cloud keys: probe for a local OpenAI-compatible server (Ollama/LM Studio)
            const local = await detectLocalProvider();
            if (local) {
                ui.note(`No API keys set, but *${local.name}* was detected running locally.`);
                const chosen = await ui.select('Select a local model to use with aicode:', local.models.map((m) => ({ title: m, value: m })));
                if (chosen) {
                    db_keys_data.LOCAL_BASE_URL = local.baseURL;
                    db_keys_data.LOCAL_MODEL = chosen;
                } else {
                    ui.error('You need at least one API key or a local model to continue. Quitting.');
                    process.exit(1);
                }
            } else {
                ui.error('You need to set at least one API key (or run a local model with Ollama/LM Studio) to continue. Quitting.');
                process.exit(1);
            }
        }
        //
        saveKeys();
    }
    // --local flag: force the LOCAL provider for this run
    if (flags.local) {
        if ((db_keys_data.LOCAL_BASE_URL || '').trim() == '' || (db_keys_data.LOCAL_MODEL || '').trim() == '') {
            const local = await detectLocalProvider();
            if (!local) {
                ui.error('No local model server detected (tried Ollama and LM Studio). Quitting.');
                process.exit(1);
            }
            const chosen = await ui.select('Select a local model to use with aicode:', local.models.map((m) => ({ title: m, value: m })));
            if (!chosen) process.exit(1);
            db_keys_data.LOCAL_BASE_URL = local.baseURL;
            db_keys_data.LOCAL_MODEL = chosen;
            saveKeys();
        }
    }
    // --model: the model of this run only (the TUI and the IDE are the ones that remember a pick)
    if (argv.model) {
        // a Cursor-style phrase ("sonnet 5.5 max") is matched against the catalog: fetch it once
        // when there is a key and no fresh cache (a failure falls back to the cached list)
        if ((db_keys_data.OPENROUTER_KEY || '').trim() !== '') {
            try { await openrouter.fetchCatalog({ apiKey: db_keys_data.OPENROUTER_KEY }); } catch (e) { /* matched against what is cached */ }
        }
        try {
            const checked = modelsReg.checkSelection(modelsReg.parseModelSpec(argv.model, { keysData: db_keys_data }), db_keys_data);
            if (!checked.ok) throw new Error(checked.message);
            flags.model = checked.selection;
        } catch (err) {
            ui.error(err);
            process.exit(1);
        }
    }

    // the runtime owns the pipeline (runPrompt) for this session
    const runtime = createRuntime({ cwd: currentWorkingDirectory, keysData: db_keys_data, flags, debug });

    // ---------------------------------------------------------------------------
    // dispatch: one-shot vs. interactive TUI session
    // ---------------------------------------------------------------------------
    const chip = runtime.describeProvider();
    if (argv.input) {
        // one-shot invocation
        ui.header({ name: 'aicode', version: require('./package.json').version, cwd: currentWorkingDirectory, provider: chip.provider, model: chip.model });
        await runtime.runPrompt(argv.input, ui);
        ui.dispose();
    } else if (!output_redirected && process.stdin.isTTY) {
        // no input + interactive terminal: open the TUI session
        ui.dispose();
        // /model and /keys: everything works on the same live objects the runtime reads
        // (flags.model, the shared key store), so a change applies to the next turn
        const modelsApi = {
            list: (query) => modelsReg.listModels({ keysData: db_keys_data, query }),
            parse: (spec) => modelsReg.parseModelSpec(spec, { keysData: db_keys_data }),
            select: (selection) => modelsReg.selectModel(flags, selection, db_keys_data),
            current: () => flags.model,
            chip: () => runtime.describeProvider(),
            hasOpenRouterKey: () => modelsReg.hasCredentials('OPENROUTER', db_keys_data),
            refresh: () => openrouter.fetchCatalog({ apiKey: db_keys_data.OPENROUTER_KEY, force: true }),
        };
        const keysApi = {
            list: () => keysLib.listProviders(db_keys_data),
            set: (provider, value) => keysLib.setKey(provider, value, db_keys_data),
            test: (provider) => keysLib.testKey(provider, db_keys_data),
        };
        try {
            const { startTui } = await import('./lib/tui/index.mjs');
            await startTui({
                runPrompt: runtime.runPrompt,
                version: require('./package.json').version,
                cwd: currentWorkingDirectory,
                provider: chip.provider,
                model: chip.model,
                actions: runtime.listActions(),
                models: modelsApi,
                keys: keysApi,
                listSkills: () => skills.discoverSkills(currentWorkingDirectory),
                installSkill: (source, onOutput) => skills.installSkill(source, { onOutput }),
                hasLocal: !!(db_keys_data.LOCAL_BASE_URL && db_keys_data.LOCAL_MODEL),
                setLocal: (on) => { flags.local = !!on; },
                agentEnabled: flags.mode === 'agent',
                setAgent: (on) => { flags.mode = on ? 'agent' : 'auto'; },
                colorEnabled: !process.env.NO_COLOR,
                debug: !!flags.debug,
            });
        } catch (err) {
            ui.error(err);
            process.exit(1);
        }
    } else {
        // no input, non-interactive: nothing to do
        process.stdout.write('aicode: provide an input, e.g. aicode "add a README for this project"\n');
        process.exit(0);
    }
})().catch((err) => {
    try {
        ui && ui.dispose && ui.dispose();
        ui.error(err);
    } catch (e) {
        console.error(err);
    }
    process.exit(1);
});
