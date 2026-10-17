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
};
const debug = (message, data) => { if (flags.debug) ui.debug(message, data); };

// trap exit signals
process.on('SIGINT', () => {
    try { ui && ui.dispose && ui.dispose(); } catch (e) {}
    // erase tmp files
    cleanupTmpFiles();
    process.exit(0);
});

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

// Process the input
!(async () => {
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
    if (true) {
        // only ask any supported API, if there are no API providers set yet
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
        const has_cloud_key = [db_keys_data.OPENAI_KEY, db_keys_data.GROQ_KEY, db_keys_data.ANTHROPIC_KEY].some((k) => (k || '').trim() != '');
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
        db_keys.save(db_keys_data);
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
            db_keys.save(db_keys_data);
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
        // which providers currently have credentials, for the /model command
        const availableProviders = ['OPENAI', 'ANTHROPIC', 'GROQ']
            .filter((p) => modelsReg.hasCredentials(p, db_keys_data));
        try {
            const { startTui } = await import('./lib/tui/index.mjs');
            await startTui({
                runPrompt: runtime.runPrompt,
                version: require('./package.json').version,
                cwd: currentWorkingDirectory,
                provider: chip.provider,
                model: chip.model,
                actions: runtime.listActions(),
                availableProviders,
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
