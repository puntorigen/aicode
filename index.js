#!/usr/bin/env node

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const actionsIndex = require('./actions');
const personalitiesIndex = require('./personalities');
const getSystemLocale = require('./helpers/lang')();
const parsers = require('./parsers');
const output_redirected = !process.stdout.isTTY;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const sharp = require("sharp");

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
  .help('h')
  .alias('h', 'help')
  .parse();

// Initialize the required variables
const ISO6391 = require('iso-639-1')
const code2prompt = require('./lib/engine');
const modelsReg = require('./lib/models');
const path = require('path');
const fs = require('fs').promises;
const currentWorkingDirectory = process.cwd();
const actionsDirectory = path.join(__dirname, 'actions');
require('dotenv').config();
const os = require('os');
const { z } = require('zod');
const { createUI } = require('./lib/ui');
const EncryptedJsonDB = require('./helpers/db');
const CacheWithTTL = require('./helpers/CacheWithTTL');
const Translator = require('./helpers/translator');
const tmp = require('tmp');
let tmpFiles = {}; // track tmp files, to remove them on finish or ctrl-c

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
let activeUI = ui; // swapped by the TUI while a session is open
let debug = (message, data) => { if (argv.debug) activeUI.debug(message, data); };

// trap exit signals
process.on('SIGINT', () => {
    try { activeUI && activeUI.dispose && activeUI.dispose(); } catch (e) {}
    // erase tmp files
    for (const [key, value] of Object.entries(tmpFiles)) {
        try { value.removeCallback(); } catch (e) {}
    }
    process.exit(0);
});

// helper methods; TODO move them to helper class
/**
 * Finds the best matching ratio from a list of supported ratios for the given dimensions.
 *
 * @param {Array<string>} supportedRatios - Array of supported ratios as strings (e.g., ["4:3", "16:9", "3:2"]).
 * @param {number} width - Width in pixels.
 * @param {number} height - Height in pixels.
 * @returns {Object} - An object with the closest 'ratio' as a string and a boolean 'perfect'.
 */
const findBestRatio = (supportedRatios, width, height) => {
    if (!width || !height || !Array.isArray(supportedRatios) || supportedRatios.length === 0) {
        debug("Invalid input. Provide width, height, and a non-empty array of supported ratios.");
        return null;
    }

    const actualRatio = width / height;

    let bestMatch = null;
    let smallestDifference = Infinity;

    for (const ratioString of supportedRatios) {
        const [numerator, denominator] = ratioString.split(":").map(Number);
        const ratio = numerator / denominator;

        const difference = Math.abs(actualRatio - ratio);

        if (difference < smallestDifference) {
            smallestDifference = difference;
            bestMatch = ratioString;
        }
    }

    return {
        ratio: bestMatch,
        perfect: smallestDifference < 1e-5 // Treat as perfect if the difference is negligible
    };
};

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

// short provider/model chip for the header/status bar (display only)
const describeProvider = (db_keys_data) => {
    if (argv.local && db_keys_data.LOCAL_MODEL) return { provider: 'local', model: db_keys_data.LOCAL_MODEL };
    for (const p of ['OPENAI', 'ANTHROPIC', 'GROQ']) {
        if (modelsReg.hasCredentials(p, db_keys_data)) return { provider: p.toLowerCase(), model: modelsReg.modelId(p, 'smart', db_keys_data) };
    }
    if (db_keys_data.LOCAL_MODEL) return { provider: 'local', model: db_keys_data.LOCAL_MODEL };
    return { provider: '', model: '' };
};

// Process the input
!(async () => {
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
    if (argv.local) {
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

    // Define default configuration for the code2prompt instances
    const codePrompt = (template, config = {}) => {
        const instance = new code2prompt({
            path: currentWorkingDirectory,
            template,
            extensions: [],
            ignore: ["**/node_modules/**", "**/*.gguf", "**/*.pyc", "**/*.js.*", "**/*.css.*", "**/*.chunk.*", "**/*.png", "**/*.jpg", "**/*.gif", "**/package-lock.json", "**/.env", "**/.gitignore", "**/LICENSE"],
            OPENAI_KEY: argv.local ? '' : db_keys_data.OPENAI_KEY,
            GROQ_KEY: argv.local ? '' : db_keys_data.GROQ_KEY,
            ANTHROPIC_KEY: argv.local ? '' : db_keys_data.ANTHROPIC_KEY,
            LOCAL_BASE_URL: db_keys_data.LOCAL_BASE_URL,
            LOCAL_MODEL: db_keys_data.LOCAL_MODEL,
            LOCAL_FAST_MODEL: db_keys_data.LOCAL_FAST_MODEL,
            LOCAL_API_KEY: db_keys_data.LOCAL_API_KEY,
            LOCAL_CONTEXT: db_keys_data.LOCAL_CONTEXT,
            LOCAL_EFFORT: db_keys_data.LOCAL_EFFORT || process.env.LOCAL_EFFORT,
            // optional smart-model / reasoning-effort overrides
            OPENAI_MODEL: db_keys_data.OPENAI_MODEL || process.env.OPENAI_MODEL,
            ANTHROPIC_MODEL: db_keys_data.ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL,
            ANTHROPIC_EFFORT: db_keys_data.ANTHROPIC_EFFORT || process.env.ANTHROPIC_EFFORT,
            GROQ_MODEL: db_keys_data.GROQ_MODEL || process.env.GROQ_MODEL,
            maxBytesPerFile: argv.local ? 16384 : 65536,
            custom_viewers: {
                // register custom file parsers
                '.docx': async (file) => {
                    const docx_parser = new parsers.docx(file);
                    const content = await docx_parser.read();
                    debug('reading .docx: ' + file, content);
                    return content;
                },
                '.xlsx': async (file) => {
                    const xlsx_parser = new parsers.xlsx(file);
                    const content = await xlsx_parser.read();
                    debug('reading .xlsx: ' + file, content);
                    return content;
                },
                '.pdf': async (file) => {
                    const pdf_parser = new parsers.pdf(file);
                    const content = await pdf_parser.read();
                    debug('reading .pdf: ' + file, content);
                    return content;
                },
                '.rtf': async (file) => {
                    const rtf_parser = new parsers.rtf(file);
                    const content = await rtf_parser.read();
                    debug('reading .rtf: ' + file, content);
                    return content;
                }
            },
            debugger: argv.debug,
            ...config
        });
        if (argv.local) {
            instance.setModelPreferences(['LOCAL']);
        }
        return instance;
    }
    // init replicate if key is set
    let replicate = null, replicate_models = {};
    if (db_keys_data.REPLICATE_API_TOKEN) {
        const replicate_ = require('replicate');
        replicate = new replicate_({ auth: db_keys_data.REPLICATE_API_TOKEN });
        replicate_models = {
            'create-image': async ({ prompt, width, height, ...data }) => {
                // cost: 333 images per 1 usd; https://replicate.com/black-forest-labs/flux-schnell
                const best_ratio = findBestRatio(["1:1", "16:9", "21:9", "2:3", "3:2", "4:5", "5:4", "9:16", "9:21"], width, height);
                const props = {
                    prompt,
                    aspect_ratio: best_ratio ? best_ratio.ratio : '1:1', // values: 1:1, 16:9, 21:9, 2:3, 3:2, 4:5, 5:4, 9:16, 9:21
                    output_format: 'jpg',
                    output_quality: 100,
                    num_outputs: 1,
                    ...data
                };
                debug('create-image', props);
                const response = await replicate.run(
                    "black-forest-labs/flux-schnell",
                    {
                        input: props
                    }
                );
                return {
                    output: response.output, //jpg
                    error: response.error,
                    raw: response
                };
            },
            'create-avatar': async (data) => {
                const props = {
                    // define defaults first, and overwrite with data
                    age: 22,
                    race: 'american',
                    gender: 'male',
                    hair: 'black',
                    eyes: 'blue',
                    background: 'green',
                    shirt: 'blue',
                    ...data
                }
                const prompt = `A complete and realistic neutral face of a ${props.age} years old ${props.race} ${props.gender} facing the camera, that shows the full ${props.hair}-short hair, clean face without hair, with a ${props.shirt} formal shirt, ${props.eyes} eyes and a ${props.background} flat background. Hyper realistic.`;
                const response = await replicate.run(
                    "black-forest-labs/flux-schnell",
                    {
                        input: {
                            num_outputs: 1,
                            aspect_ratio: "1:1",
                            output_format: "jpg",
                            output_quality: 100,
                            prompt: prompt
                        }
                    }
                );
                return {
                    output: response.output, //jpg
                    error: response.error,
                    raw: response
                };
            },
            'photomaker': async (data) => {
                // Create photos, paintings and avatars for anyone in any style within seconds.
                // cost: 52 images per 1 usd; https://replicate.com/tencentarc/photomaker
                const props = {
                    prompt: '', // describe the new pose or situation you want to create
                    input_image: '', // url of image to use as source
                    num_outputs: 1,
                    num_steps: 50,
                    style_name: 'Photographic (Default)',
                    guidance_scale: 5,
                    style_strength_ratio: 20,
                    negative_prompt: 'nsfw, lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry',
                    ...data
                };
                if (data.image) props.input_image = data.image;
                const response = await replicate.run(
                    "tencentarc/photomaker:ddfc2b08d209f9fa8c1eca692712918bd449f695dabb4a958da31802a9570fe4",
                    {
                        input: props
                    }
                );
                return {
                    output: response.output, //png
                    error: response.error,
                    raw: response
                };
            },
            'image-to-text': async (data) => {
                // cost, 344 runs per 1 usd; https://replicate.com/smoretalk/clip-interrogator-turbo
                // data min: { image, prompt }
                const props = {
                    mode: "fast", // turbo, fast, best
                    image: "", // url to process
                    style_only: false,
                    ...data
                };
                if (!data) return { specs: props, output_format: 'txt' };
                const response = await replicate.run(
                    "smoretalk/clip-interrogator-turbo:f66767bbd5c60b841e05dfb72a176d11bf36eca0554c6ea5d6d705cf617bafe8",
                    {
                        input: props
                    }
                );
                return {
                    output: response.output, //text
                    error: response.error,
                    raw: response
                };
            },
            'image-to-video': async (data) => {
                // cost, 5 videos per 1 usd; https://replicate.com/ali-vilab/i2vgen-xl
                // data min: { image, prompt }
                const props = {
                    image: '',
                    prompt: '',
                    max_frames: 16,
                    guidance_scale: 9,
                    num_inference_steps: 50,
                    ...data
                };
                if (!data) return { specs: props, output_format: 'mp4' };
                const response = await replicate.run(
                    "ali-vilab/i2vgen-xl:5821a338d00033abaaba89080a17eb8783d9a17ed710a6b4246a18e0900ccad4",
                    {
                        input: props
                    }
                );
                return {
                    output: response.output, //mp4
                    error: response.error,
                    raw: response
                };
            },
            'text-to-speech': async (data) => {
                // cost, 142 runs per 1 usd; https://replicate.com/lucataco/xtts-v2
                // data min: { text, language, speaker }
                const props = {
                    // define defaults first, and overwrite with data
                    text: 'Hola, ¿cómo estás?',
                    language: 'es',
                    speaker: 'https://replicate.delivery/pbxt/Jt79w0xsT64R1JsiJ0LQRL8UcWspg5J4RFrU6YwEKpOT1ukS/male.wav',
                    ...data
                }
                if (!data) return {
                    specs: props, output_format: 'wav', specs_values: {
                        text: 'text',
                        language: ['es', 'en', 'fr', 'de', 'it', 'pt', 'pl', 'tr', 'ru', 'nl', 'cs', 'ar', 'zh', 'hu', 'ko', 'hi'],
                        speaker: ['url_wav', 'url_mp3', 'url_m4a', 'url_ogg', 'url_flv']
                    }
                };
                const response = await replicate.run(
                    "lucataco/xtts-v2:684bc3855b37866c0c65add2ff39c78f3dea3f4ff103a436465326e0f438d55e",
                    {
                        input: props
                    }
                );
                return {
                    output: response.output, //wav
                    error: response.error,
                    raw: response
                };
            }
        };
    }

    // ---------------------------------------------------------------------------
    // runPrompt: one full pipeline turn for a single user input.
    // renderer-agnostic: everything talks to `runUI` (the transcript UI for
    // one-shot runs, or the Ink TUI's UI adapter for interactive sessions).
    // ---------------------------------------------------------------------------
    const runPrompt = async (input, runUI, opts = {}) => {
        const runStart = Date.now();
        code2prompt.resetUsage();
        const userOS = os.platform();
        // 0) single fast-tier pre-flight call: classify input + pick action template + pick personality
        const general = codePrompt(path.join(actionsDirectory, 'default.md'));
        if (opts.signal) general.setAbortSignal(opts.signal);
        if (opts.modelPreferences && !argv.local) general.setModelPreferences(opts.modelPreferences);
        const user_action = new actionsIndex(input);
        const personality = new personalitiesIndex(input);
        await Promise.all([user_action.initialize(), personality.initialize()]);
        const action_choices = user_action.code_blocks.map((b) => `file:${b.file}\ndescription:\n${b.content}`).join('\n\n');
        const personality_choices = personality.code_blocks.map((b) => `file:${b.file}\ndescription:\n${b.content}`).join('\n\n');
        const analyzeStep = runUI.step('analyzing request');
        let initial_analysis;
        try {
            initial_analysis = await general.queryLLM(
`# Analyze the following user input text:
${input}

# 1. Classify it as an action or a question, detect its language, and provide an english version of it (without translating filenames).

# 2. Select the most suitable action template file for handling the input, from the following available templates and their descriptions:
${action_choices}

# 3. Select the most suitable personality template file for writing the response, from the following available personalities and their descriptions:
${personality_choices}`,
                z.object({
                    type_of: z.enum(['action', 'question']).describe('Type of the input'),
                    english: z.string().describe('English version of text, without translating filenames'),
                    language: z.enum(['English', 'Spanish', 'Portuguese', 'French', 'Japanese']).describe('language of the given input'),
                    action_file: z.string().describe('just the absolute chosen action template file'),
                    action_reason: z.string().describe('brief reason why the action template is the best for the user input'),
                    personality_file: z.string().describe('just the absolute chosen personality template file'),
                    personality_reason: z.string().describe('brief reason why the personality template is the best for the user input'),
                }),
                { tier: 'fast' }
            );
        } catch (err) {
            analyzeStep.fail('analyzing request');
            runUI.statusStop();
            if (opts.signal && opts.signal.aborted) runUI.note('run cancelled', '', 'yellow');
            else runUI.error(err);
            const usage0 = code2prompt.getUsage();
            runUI.footer({ ...usage0, elapsedMs: Date.now() - runStart });
            return usage0;
        }
        const input_lang_code = ISO6391.getCode(initial_analysis.data.language);
        let targetLanguage = argv.language || initial_analysis.data.language;
        // if targetLanguage length is 2, it's an ISO-639 language code
        if (targetLanguage && targetLanguage.length == 2) {
            targetLanguage = ISO6391.getName(targetLanguage);
        }
        initial_analysis.data.language_code = ISO6391.getCode(targetLanguage);

        // resolve the returned file names against the actually available templates
        const resolveTemplateFile = (chosen, available, fallback) => {
            let chosen_ = (chosen || '').replace(/^file:/, '').trim();
            const basename = chosen_.split('/').pop();
            const match = available.find((b) => b.file === chosen_) ||
                available.find((b) => b.file.split('/').pop() === basename);
            if (match) return match.file;
            debug('template not resolved, using fallback', { chosen, fallback });
            return fallback;
        };
        const action = {
            data: {
                file: resolveTemplateFile(initial_analysis.data.action_file, user_action.code_blocks, path.join(actionsDirectory, 'answer-user-question.md')),
                reason: initial_analysis.data.action_reason,
            }
        };
        const persona = {
            data: {
                file: resolveTemplateFile(initial_analysis.data.personality_file, personality.code_blocks, path.join(__dirname, 'personalities', 'default.md')),
                reason: initial_analysis.data.personality_reason,
            }
        };
        const template_ = action.data.file.split('/').pop().replace('.md', '');
        const persona_name = persona.data.file.split('/').pop().replace('.md', '');
        const persona_ = await personality.getPersonality(persona.data.file);
        const translate = new Translator(template_, initial_analysis.data.language_code);
        analyzeStep.done(`${template_} · ${persona_name}`);
        // use the chosen personality as the system prompt for all LLM calls of this run
        general.setSystemPrompt(persona_);
        const progress = runUI.progressShim();
        // central gate for --confirm: ask the user before executing state-changing actions
        const confirmAction = async (description) => {
            if (!argv.confirm) return true;
            return await runUI.confirm(`*aicode wants to:* ${description}. Continue?`);
        };
        // declare methods for js code blocks
        let additional_context = {
            personality: persona_,
            confirm_actions: argv.confirm, // prompt user before executing actions
            confirmAction,
            replicate_models,
            findBestRatio,
            queryLLM: async (question, schema) => {
                try {
                    return await general.queryLLM(question, schema);
                } catch (err) {
                    debug('Error running queryLLM: ' + err.message, { question });
                    return false;
                }
            },
            queryContext: async (question, schema) => {
                return await general.request(question, schema);
            },
            queryTemplate: async (template, question = null, custom_context = {}) => {
                // add .md to 'template' if it doesn't have extension
                // test cachekey: template+question+currentWorkingDirectory
                const cache = new CacheWithTTL('template_cache.json');
                const cacheKey = template + question + currentWorkingDirectory;
                const cachedTemplate = cache.get(cacheKey);
                if (cachedTemplate) {
                    return cachedTemplate;
                }
                try {
                    const template_ = template.endsWith('.md') ? template : `${template}.md`;
                    const specific = codePrompt(path.join(actionsDirectory, template_));
                    const resp_ = await specific.request(question, null, {
                        meta: false
                    });
                    cache.set(cacheKey, resp_, 1 * 60 * 60 * 1000); // 1 hour
                    return resp_;
                } catch (err) {
                    runUI.error('Error running template: ' + err.message);
                }
            },
            setModelPreferences: async (order_models) => {
                if (argv.local) return true; // --local forces the LOCAL provider; ignore template preferences
                general.setModelPreferences(order_models);
                // ask model API keys if they don't exit and we need them
                if (!db_keys_data.OPENAI_KEY && general.model_preferences.includes('OPENAI')) {
                    db_keys_data.OPENAI_KEY = await runUI.ask('Enter your *OPENAI API key* (or empty if none):');
                    if ((db_keys_data.OPENAI_KEY || '').trim() != '') {
                        db_keys.save(db_keys_data);
                        general.setLLMAPI('OPENAI', db_keys_data.OPENAI_KEY);
                    }
                } else if (!db_keys_data.GROQ_KEY && general.model_preferences.includes('GROQ')) {
                    db_keys_data.GROQ_KEY = await runUI.ask('Enter your *GROQ API key* (or empty if none):');
                    if ((db_keys_data.GROQ_KEY || '').trim() != '') {
                        db_keys.save(db_keys_data);
                        general.setLLMAPI('GROQ', db_keys_data.GROQ_KEY);
                    }
                } else if (!db_keys_data.ANTHROPIC_KEY && general.model_preferences.includes('ANTHROPIC')) {
                    db_keys_data.ANTHROPIC_KEY = await runUI.ask('Enter your *ANTHROPIC API key* (or empty if none):');
                    if ((db_keys_data.ANTHROPIC_KEY || '').trim() != '') {
                        db_keys.save(db_keys_data);
                        general.setLLMAPI('ANTHROPIC', db_keys_data.ANTHROPIC_KEY);
                    }
                }
                //
                return true;
            },
            writeFile: async (file, content) => {
                const abs_file = path.isAbsolute(file) ? file : path.join(currentWorkingDirectory, file);
                const display = path.relative(currentWorkingDirectory, abs_file) || file;
                if (!await confirmAction(`write file #${display}#`)) return false;
                let existed = false, previous = '';
                try { previous = await fs.readFile(abs_file, 'utf8'); existed = true; } catch (e) { }
                if (existed && previous !== content) runUI.diff(display, previous, content);
                await fs.writeFile(abs_file, content, 'utf8');
                code2prompt.invalidateTraverseCache(); // project files changed
                runUI.fileWritten(display, { created: !existed, lines: String(content).split('\n').length });
                return true;
            },
            readFile: async (file) => {
                return await fs.readFile(path.join(currentWorkingDirectory, file), 'utf8');
            },
            editFile: async (file, instructions) => {
                // diff-based editing: ask the smart model for search/replace blocks and apply them,
                // instead of regenerating the whole file
                const abs_file = path.isAbsolute(file) ? file : path.join(currentWorkingDirectory, file);
                const original = await fs.readFile(abs_file, 'utf8');
                const edits = await general.queryLLM(
`# You are editing the file '${file}'. Apply the following instructions by returning a list of exact search/replace edits.
# Rules:
# - each 'search' text MUST be copied VERBATIM from the current file contents (including whitespace and indentation) and must be unique within the file
# - keep each edit as small as possible while remaining unique
# - the 'replace' text is the full replacement for the matched 'search' text

# instructions:
${instructions}

# current file contents:
${original}`,
                    z.array(z.object({
                        search: z.string().describe('exact verbatim text to find in the file (must be unique)'),
                        replace: z.string().describe('replacement text'),
                    })).describe('list of search/replace edits to apply')
                );
                if (!edits || !Array.isArray(edits.data)) return { ok: false, error: 'no edits returned' };
                let updated = original;
                const failed = [];
                for (const edit of edits.data) {
                    if (edit.search && updated.includes(edit.search)) {
                        updated = updated.replace(edit.search, edit.replace);
                    } else {
                        failed.push(edit);
                    }
                }
                if (updated === original) return { ok: false, error: 'no edits could be applied', failed };
                const display = path.relative(currentWorkingDirectory, abs_file) || file;
                runUI.diff(display, original, updated);
                if (!await confirmAction(`edit file #${display}# (${edits.data.length - failed.length} change(s))`)) return { ok: false, error: 'cancelled by user' };
                await fs.writeFile(abs_file, updated, 'utf8');
                code2prompt.invalidateTraverseCache(); // project files changed
                runUI.fileWritten(display, { created: false, lines: updated.split('\n').length });
                return { ok: true, applied: edits.data.length - failed.length, failed };
            },
            stringifyTreeFromPaths: (paths) => {
                const tree = general.stringifyTreeFromPaths(paths);
                return tree;
            },
            userDirectory: currentWorkingDirectory,
            actionsDirectory,
            tmp: async (ext = 'tmp') => {
                const tmpobj = tmp.fileSync({
                    postfix: '.' + ext
                });
                tmpFiles[tmpobj.name] = tmpobj;
                return {
                    file: tmpobj.name,
                    fd: tmpobj.fd,
                    remove: tmpobj.removeCallback
                }
            },
            sleep,
            getNpmReadme: async (packageName) => {
                // test cache
                const cache = new CacheWithTTL('npm_readme_cache.json');
                const cachedReadme = cache.get(packageName);
                if (cachedReadme) {
                    return cachedReadme;
                }
                const fetch = (await import('node-fetch')).default;
                const url = `https://registry.npmjs.org/${packageName}`;
                try {
                    const response = await fetch(url);
                    if (!response.ok) {
                        throw new Error('Network response was not ok.');
                    }
                    const data = await response.json();
                    const readme = data.readme;
                    if (readme) {
                        cache.set(packageName, readme, 24 * 60 * 60 * 1000); // 24 hours
                        return readme;
                    } else {
                        throw new Error('README not available for this package.');
                    }
                } catch (error) {
                    debug('Failed to fetch README: ' + error.message);
                    return null;
                }
            },
            renderMD: (text) => {
                return runUI.renderMarkdown(text);
            },
            log: (message, data, color = 'cyan') => {
                runUI.note(message, data, color);
            },
            debug: (message, data, color = 'green') => {
                runUI.debug(message, data);
            },
            joinPaths: (...paths) => {
                const path_ = require('path');
                return path_.join(...paths);
            },
            // route sandbox console.log through the UI so it never collides with
            // the transient status line / TUI transcript (keeps ordering correct)
            console: {
                log: (message, data) => {
                    const util = require('util');
                    let line = (message == null) ? '' : (typeof message === 'string' ? message : util.inspect(message));
                    if (data !== undefined) line += ' ' + (typeof data === 'string' ? data : util.inspect(data));
                    runUI.raw(line);
                },
                error: (message) => { runUI.error(message); },
                warn: (message) => { runUI.note(message, '', 'yellow'); },
                info: (message) => { runUI.note(message, '', 'cyan'); },
            },
            db: {
                engine: EncryptedJsonDB,
                save: (file, data) => {
                    const db = new EncryptedJsonDB(file);
                    let db_data = db.load();
                    db_data = { ...db_data, ...data };
                    db.save(db_data);
                },
                load: (file) => {
                    const db = new EncryptedJsonDB(file);
                    return db.load();
                },
            },
            modules: {
                screenshot: require('screenshot-desktop'),
                diagram: require('cli-diagram'),
                image: {
                    scale: async (image, width, height) => {
                        const fs = require('fs'); // sync
                        try {
                            // Validate the file exists
                            if (!fs.existsSync(image)) {
                                return null;
                            }
                            // copy the image to a tmp file
                            const tmpobj = tmp.fileSync({
                                postfix: '.jpg'
                            });
                            fs.copyFileSync(image, tmpobj.name);

                            // Overwrite the original image file with the scaled image
                            await sharp(tmpobj.name)
                                .resize(width, height)
                                .toFile(image);

                            // Remove the temporary file
                            tmpobj.removeCallback();

                            debug(`Image scaled to ${width}x${height} and saved at ${image}`);
                        } catch (error) {
                            debug(`Error scaling image: ${error.message}`);
                        }
                    },
                    convert: async (image, format) => {
                        const fs = require('fs'); // sync
                        try {
                            if (!fs.existsSync(image)) {
                                throw new Error(`Image file not found: ${image}`);
                            }

                            // copy the image to a tmp file
                            const tmpobj = tmp.fileSync({
                                postfix: '.jpg'
                            });
                            fs.copyFileSync(image, tmpobj.name);
                            // Extract the file directory, name, and create the new file name
                            const dir = path.dirname(image);
                            const ext = path.extname(image);
                            const baseName = path.basename(image, ext);
                            const newFileName = `${baseName}.${format}`;
                            const newFilePath = path.join(dir, newFileName);

                            // Convert and save the image to the new format
                            await sharp(tmpobj.name).toFormat(format).toFile(newFilePath);

                            // Remove the temporary file
                            tmpobj.removeCallback();

                            return newFilePath;
                        } catch (error) {
                            debug(`Error converting image to ${format}: ${error.message}`);
                            return null;
                        }
                    }
                },
                clipboard: {
                    paste: async () => {
                        const clipboard = require("copy-paste");
                        const paste_ = new Promise((resolve, reject) => {
                            clipboard.paste((error, data) => {
                                if (error) {
                                    reject(error);
                                } else {
                                    resolve(data);
                                }
                            });
                        });
                        return await paste_;
                    },
                    copy: async (text) => {
                        const clipboard = require("copy-paste");
                        const copy_ = new Promise((resolve, reject) => {
                            clipboard.copy(text, (error) => {
                                if (error) {
                                    reject(error);
                                } else {
                                    resolve(true);
                                }
                            });
                        });
                        return await copy_;
                    }
                }
            },
            t: async (text) => {
                // try to translate text to the user specified language (using google)
                try {
                    const translated = await translate.t(text);
                    return translated;
                } catch (err) {
                    return text;
                }
            },
            ask: async (question) => {
                // ask the user a question in the input language
                const translation = new Translator('ui', initial_analysis.data.language_code);
                const translated = await translation.t(question);
                return await runUI.ask(translated);
            },
            select: async (question, choices) => {
                // ask the user to choose from a list of choices in the input language
                const translation = new Translator('ui', initial_analysis.data.language_code);
                const translated = await translation.t(question);
                // translate the given choices
                for (let i = 0; i < choices.length; i++) {
                    choices[i].title = await translation.t(choices[i].title);
                }
                return await runUI.select(translated, choices);
            },
            answer: async (text) => {
                // answer the user in the input language
                const translation = new Translator('ui', initial_analysis.data.language_code);
                const translated = await translation.t(text);
                runUI.answer(translated);
            },
            user_prompt: input,
            english_user_prompt: initial_analysis.data.english,
            argv, system_os: userOS, progress,
            language: targetLanguage,
            language_code: initial_analysis.data.language_code,
        };
        // some special methods that need access to the previous context methods
        additional_context.runTemplate = async (template, question = null, custom_context = {}) => {
            // add .md to 'template' if it doesn't have extension
            const template_ = template.endsWith('.md') ? template : `${template}.md`;
            const specific = codePrompt(path.join(actionsDirectory, template_));
            return await specific.runTemplate(question, null, { ...additional_context, ...custom_context, ...{ ai: false } });
        };
        additional_context.executeBash = async (code) => {
            try {
                if (!await confirmAction(`run bash: #${String(code).split('\n')[0].substring(0, 80)}#`)) return false;
                const exec = await general.executeBash({ ...additional_context }, code);
                code2prompt.invalidateTraverseCache(); // bash may have changed project files
                return exec;
            } catch (err) {
                return false;
            }
        };
        additional_context.executeNode = async (code) => {
            try {
                const exec = await general.executeNode({ ...additional_context }, code);
                return exec;
            } catch (err) {
                return { error: err };
            }
        };
        additional_context.executePython = async (code) => {
            try {
                const exec = await general.executePython({ ...additional_context }, code);
                return exec;
            } catch (err) {
                return { error: err };
            }
        };
        additional_context.spawnBash = async (custom_context = {}, code) => {
            if (!await confirmAction(`run bash: #${String(code).split('\n')[0].substring(0, 80)}#`)) return false;
            const exec = await general.spawnBash({ ...additional_context, ...custom_context }, code);
            code2prompt.invalidateTraverseCache(); // bash may have changed project files
            return exec;
        };
        // additional special context methods
        additional_context.downloadTmp = async (url, file_extension = 'tmp') => {
            const fetch = (await import('node-fetch')).default;
            const fs = require('fs');

            // Use the tmp method to generate a temporary file
            const tmp_file = await additional_context.tmp(file_extension);

            try {
                const response = await fetch(url);

                if (!response.ok) {
                    debug(`Failed to fetch the file. Status: ${response.status}`);
                }

                // Pipe the response data to the temporary file
                const file_stream = fs.createWriteStream(tmp_file.file);
                await new Promise((resolve, reject) => {
                    response.body.pipe(file_stream);
                    response.body.on("error", reject);
                    file_stream.on("finish", resolve);
                });

                debug(`File downloaded successfully to temporary file: ${tmp_file.file}`);
                return tmp_file; // Return the tmp_file object
            } catch (error) {
                debug(`Error downloading file from ${url}:`, error.message);
                tmp_file.remove(); // Clean up the temp file on error
                throw error;
            }
        };

        additional_context.downloadFile = async (url, output) => {
            const fetch = (await import('node-fetch')).default;
            const fs = require('fs');
            const path = require('path');

            // Resolve the output path relative to the currentWorkingDirectory
            const resolved_path = path.isAbsolute(output)
                ? output
                : path.resolve(currentWorkingDirectory, output);

            // Ensure the directory exists
            const directory = path.dirname(resolved_path);
            fs.mkdirSync(directory, { recursive: true });

            try {
                const response = await fetch(url);

                if (!response.ok) {
                    debug(`Failed to fetch the file. Status: ${response.status}`);
                    return null;
                }

                // Pipe the response data to the specified file
                const file_stream = fs.createWriteStream(resolved_path);
                await new Promise((resolve, reject) => {
                    response.body.pipe(file_stream);
                    response.body.on("error", reject);
                    file_stream.on("finish", resolve);
                });

                debug(`File downloaded successfully to: ${resolved_path}`);
                return resolved_path; // Return the absolute path of the saved file
            } catch (error) {
                debug(`Error downloading file from ${url}:`, error.message);
                return null;
            }
        };
        // render the template using the engine
        const actioncode = codePrompt(action.data.file);
        if (opts.signal) actioncode.setAbortSignal(opts.signal);
        if (opts.modelPreferences && !argv.local) actioncode.setModelPreferences(opts.modelPreferences);
        actioncode.setSystemPrompt(persona_); // personality as system prompt (not injected into user prompt)
        // stream free-text (schema-less) responses live to the terminal
        actioncode.setStreamHandler((chunk) => { runUI.streamChunk(chunk); });
        runUI.status(`generating answer …`);
        try {
            await actioncode.runTemplate(initial_analysis.data.english, {}, { ...additional_context, ...{ ai: true } });
            runUI.streamEnd();
            runUI.statusStop();
        } catch (ErrA) {
            runUI.streamEnd();
            runUI.statusStop();
            if (opts.signal && opts.signal.aborted) runUI.note('run cancelled', '', 'yellow');
            else runUI.error(ErrA);
        }
        // usage + cost footer
        const usage = code2prompt.getUsage();
        runUI.footer({ ...usage, elapsedMs: Date.now() - runStart });
        return usage;
    };

    // ---------------------------------------------------------------------------
    // dispatch: one-shot vs. interactive TUI session
    // ---------------------------------------------------------------------------
    const chip = describeProvider(db_keys_data);
    if (argv.input) {
        // one-shot invocation
        ui.header({ name: 'aicode', version: require('./package.json').version, cwd: currentWorkingDirectory, provider: chip.provider, model: chip.model });
        await runPrompt(argv.input, ui);
        ui.dispose();
    } else if (!output_redirected && process.stdin.isTTY) {
        // no input + interactive terminal: open the TUI session
        ui.dispose();
        // list available action templates (basenames) for the /actions command
        let actionNames = [];
        try {
            actionNames = require('fs').readdirSync(actionsDirectory)
                .filter((f) => f.endsWith('.md'))
                .map((f) => f.replace(/\.md$/, ''))
                .sort();
        } catch (e) { }
        // which providers currently have credentials, for the /model command
        const availableProviders = ['OPENAI', 'ANTHROPIC', 'GROQ']
            .filter((p) => modelsReg.hasCredentials(p, db_keys_data));
        try {
            const { startTui } = await import('./lib/tui/index.mjs');
            await startTui({
                runPrompt,
                version: require('./package.json').version,
                cwd: currentWorkingDirectory,
                provider: chip.provider,
                model: chip.model,
                actions: actionNames,
                availableProviders,
                hasLocal: !!(db_keys_data.LOCAL_BASE_URL && db_keys_data.LOCAL_MODEL),
                setLocal: (on) => { argv.local = !!on; },
                colorEnabled: !process.env.NO_COLOR,
                debug: !!argv.debug,
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
        activeUI && activeUI.dispose && activeUI.dispose();
        ui.error(err);
    } catch (e) {
        console.error(err);
    }
    process.exit(1);
});
