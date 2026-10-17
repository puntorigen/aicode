// aicode runtime: the per-session pipeline, extracted from index.js.
//
// A Runtime owns everything one session needs to run a turn: the mutable `flags`
// (confirm / local / mode / language / ...), the credentials (`keysData`, kept by
// reference so a key saved elsewhere is visible to later turns), the engine
// factory (`codePrompt`) and `runPrompt`, the full one-turn pipeline
// (fast-tier pre-flight classification -> action template or agent loop).
//
// Everything talks to a UI object (the transcript renderer for one-shot runs, the
// Ink TUI adapter, or the Agent Server's WebSocket adapter), so this module is
// renderer-agnostic. index.js is now a thin CLI around it.

const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const { z } = require('zod');
const ISO6391 = require('iso-639-1');
const tmp = require('tmp');
const code2prompt = require('./engine');
const modelsReg = require('./models');
const keysLib = require('./keys');
const skills = require('./skills');
const agentsReg = require('./agents');
const parsers = require('../parsers');
const actionsIndex = require('../actions');
const personalitiesIndex = require('../personalities');
const EncryptedJsonDB = require('../helpers/db');
const CacheWithTTL = require('../helpers/CacheWithTTL');
const Translator = require('../helpers/translator');

const ROOT = path.join(__dirname, '..');
const actionsDirectory = path.join(ROOT, 'actions');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// tmp files created by actions (tracked process-wide so index.js can erase them on ctrl-c)
const tmpFiles = {};
function cleanupTmpFiles() {
    for (const value of Object.values(tmpFiles)) {
        try { value.removeCallback(); } catch (e) { /* already removed */ }
    }
}

const FLAG_DEFAULTS = {
    confirm: false,
    local: false,
    mode: 'auto', // auto | agent (ask/plan arrive with the modes work)
    language: null,
    quiet: false,
    debug: false,
    modelPreferences: null,
    model: null,
};

/**
 * Make `engine` run on the model the user picked: its provider only (or, with
 * config.models.fallbackOnError, that provider first and the rest of
 * DEFAULT_PROVIDER_ORDER behind it), with the chosen model id and effort.
 * Throws when the provider has no credentials.
 */
function applyModelSelection(engine, selection, keysData) {
    if (!modelsReg.hasCredentials(selection.provider, keysData)) throw new Error(`no credentials for ${selection.provider}`);
    const fallback = require('./config').loadConfig().models.fallbackOnError === true;
    engine.setModelPreferences(
        fallback ? [selection.provider, ...modelsReg.DEFAULT_PROVIDER_ORDER.filter((p) => p !== selection.provider)] : [selection.provider],
        { strict: true },
    );
    // LOCAL keeps its LOCAL_FAST_MODEL as configured
    engine.config[`${selection.provider}_MODEL`] = selection.model;
    engine.config[`${selection.provider}_EFFORT`] = selection.effort;
}

/**
 * What a template's `await setModelPreferences([...])` does for this turn: the
 * providers it names go first (the engine still reaches every other provider
 * that has credentials). It never overrides --local or a model the user picked.
 * A missing key is asked for only when nothing at all can serve the request and
 * the client can take a secret: a user with just an OpenRouter key must not be
 * nagged for an OpenAI one.
 */
async function applyTemplatePreferences(engine, order, { keysData, ui, local = false, selection = null }) {
    if (local) return true; // --local forces the LOCAL provider; ignore template preferences
    if (selection) return true; // the model the user picked wins over a template's preference order
    engine.setModelPreferences(order);
    const canAsk = typeof ui.ask === 'function' && ui.canAskSecrets !== false;
    const served = engine.modelPreferences.some((p) => modelsReg.hasCredentials(p, keysData));
    if (!canAsk || served) return true;
    for (const provider of ['OPENAI', 'GROQ', 'ANTHROPIC']) {
        const field = `${provider}_KEY`;
        if (keysData[field] || !engine.modelPreferences.includes(provider)) continue;
        const answer = await ui.ask(`Enter your *${provider} API key* (or empty if none):`);
        if ((answer || '').trim() !== '') {
            keysLib.setKey(provider, answer, keysData);
            engine.setLLMAPI(provider, keysData[field]);
        }
        break; // one question per template run, like before
    }
    return true;
}

function createRuntime({ cwd = process.cwd(), keysData = {}, flags = {}, debug: debugFn = null, ide = null } = {}) {
    // `flags` stays the caller's object (the TUI/server mutate it live); only
    // missing keys are filled in
    const runtimeFlags = (flags && typeof flags === 'object') ? flags : {};
    for (const [key, value] of Object.entries(FLAG_DEFAULTS)) {
        if (runtimeFlags[key] === undefined) runtimeFlags[key] = value;
    }
    // a caller that did not pick a model gets the one remembered from the last
    // selection (the way Cursor remembers it), while that provider still has credentials
    if (runtimeFlags.model === null) {
        const checked = modelsReg.checkSelection(require('./config').loadConfig().models.selected, keysData);
        if (checked.ok) runtimeFlags.model = checked.selection;
    }
    const debug = typeof debugFn === 'function' ? debugFn : () => { };
    let agentDefsCache = null;
    let lastUsage = null;

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

    // the model the user picked for this runtime's turns (flags.model); --local ignores it
    const activeSelection = (opts = {}) => (runtimeFlags.local ? null : (opts.model || runtimeFlags.model || null));

    // short provider/model chip for the header/status bar (display only)
    const describeProvider = () => {
        if (runtimeFlags.local && keysData.LOCAL_MODEL) return { provider: 'local', model: keysData.LOCAL_MODEL };
        const selection = activeSelection();
        if (selection) return modelsReg.chipFor(selection);
        // the first cloud provider with credentials, in the default order; LOCAL only when nothing else is configured
        for (const p of modelsReg.DEFAULT_PROVIDER_ORDER.filter((name) => name !== 'LOCAL')) {
            if (modelsReg.hasCredentials(p, keysData)) return { provider: p.toLowerCase(), model: modelsReg.modelId(p, 'smart', keysData) };
        }
        if (keysData.LOCAL_MODEL) return { provider: 'local', model: keysData.LOCAL_MODEL };
        return { provider: '', model: '' };
    };

    // names (basenames) of the available action templates, for the /actions command
    const listActions = () => {
        try {
            return require('fs').readdirSync(actionsDirectory)
                .filter((f) => f.endsWith('.md'))
                .map((f) => f.replace(/\.md$/, ''))
                .sort();
        } catch (e) {
            return [];
        }
    };

    // Define default configuration for the code2prompt instances
    const codePrompt = (template, config = {}) => {
        const instance = new code2prompt({
            path: cwd,
            template,
            extensions: [],
            ignore: ["**/node_modules/**", "**/*.gguf", "**/*.pyc", "**/*.js.*", "**/*.css.*", "**/*.chunk.*", "**/*.png", "**/*.jpg", "**/*.gif", "**/package-lock.json", "**/.env", "**/.gitignore", "**/LICENSE"],
            OPENROUTER_KEY: runtimeFlags.local ? '' : keysData.OPENROUTER_KEY,
            OPENAI_KEY: runtimeFlags.local ? '' : keysData.OPENAI_KEY,
            GROQ_KEY: runtimeFlags.local ? '' : keysData.GROQ_KEY,
            ANTHROPIC_KEY: runtimeFlags.local ? '' : keysData.ANTHROPIC_KEY,
            LOCAL_BASE_URL: keysData.LOCAL_BASE_URL,
            LOCAL_MODEL: keysData.LOCAL_MODEL,
            LOCAL_FAST_MODEL: keysData.LOCAL_FAST_MODEL,
            LOCAL_API_KEY: keysData.LOCAL_API_KEY,
            LOCAL_CONTEXT: keysData.LOCAL_CONTEXT,
            LOCAL_EFFORT: keysData.LOCAL_EFFORT || process.env.LOCAL_EFFORT,
            // optional smart-model / reasoning-effort overrides
            OPENROUTER_MODEL: keysData.OPENROUTER_MODEL || process.env.OPENROUTER_MODEL,
            OPENROUTER_FAST_MODEL: keysData.OPENROUTER_FAST_MODEL || process.env.OPENROUTER_FAST_MODEL,
            OPENROUTER_EFFORT: keysData.OPENROUTER_EFFORT || process.env.OPENROUTER_EFFORT,
            OPENAI_MODEL: keysData.OPENAI_MODEL || process.env.OPENAI_MODEL,
            OPENAI_EFFORT: keysData.OPENAI_EFFORT || process.env.OPENAI_EFFORT,
            ANTHROPIC_MODEL: keysData.ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL,
            ANTHROPIC_EFFORT: keysData.ANTHROPIC_EFFORT || process.env.ANTHROPIC_EFFORT,
            GROQ_MODEL: keysData.GROQ_MODEL || process.env.GROQ_MODEL,
            GROQ_EFFORT: keysData.GROQ_EFFORT || process.env.GROQ_EFFORT,
            maxBytesPerFile: runtimeFlags.local ? 16384 : 65536,
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
            debugger: runtimeFlags.debug,
            ...config
        });
        if (runtimeFlags.local) {
            instance.setModelPreferences(['LOCAL']);
        }
        return instance;
    };

    // init replicate if key is set
    let replicate = null, replicate_models = {};
    if (keysData.REPLICATE_API_TOKEN) {
        const replicate_ = require('replicate');
        replicate = new replicate_({ auth: keysData.REPLICATE_API_TOKEN });
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
    // file helpers bound to a base directory, so the exact same helpers can be
    // rebuilt for another root (a git worktree) later. `deps` carries what
    // editFile/executeBash need from the turn: the engine and a getter for the
    // action context (not built yet when the helpers are created).
    // ---------------------------------------------------------------------------
    const makeFileHelpers = (baseDir, runUI, confirmAction, deps = {}) => {
        const getEngine = () => (typeof deps.engine === 'function' ? deps.engine() : deps.engine);
        const getContext = () => (typeof deps.getContext === 'function' ? deps.getContext() : (deps.context || {}));
        const writeFile = async (file, content) => {
            const abs_file = path.isAbsolute(file) ? file : path.join(baseDir, file);
            const display = path.relative(baseDir, abs_file) || file;
            // compute and show the diff BEFORE asking, so a confirmation can be judged on it
            let existed = false, previous = '';
            try { previous = await fs.readFile(abs_file, 'utf8'); existed = true; } catch (e) { }
            if (existed && previous !== content) runUI.diff(display, previous, content);
            if (!await confirmAction(`write file #${display}#`)) return false;
            await fs.writeFile(abs_file, content, 'utf8');
            code2prompt.invalidateTraverseCache(); // project files changed
            runUI.fileWritten(display, { created: !existed, lines: String(content).split('\n').length });
            return true;
        };
        const readFile = async (file) => {
            return await fs.readFile(path.join(baseDir, file), 'utf8');
        };
        const editFile = async (file, instructions) => {
            // diff-based editing: ask the smart model for search/replace blocks and apply them,
            // instead of regenerating the whole file
            const abs_file = path.isAbsolute(file) ? file : path.join(baseDir, file);
            const original = await fs.readFile(abs_file, 'utf8');
            const edits = await getEngine().queryLLM(
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
            const display = path.relative(baseDir, abs_file) || file;
            runUI.diff(display, original, updated);
            if (!await confirmAction(`edit file #${display}# (${edits.data.length - failed.length} change(s))`)) return { ok: false, error: 'cancelled by user' };
            await fs.writeFile(abs_file, updated, 'utf8');
            code2prompt.invalidateTraverseCache(); // project files changed
            runUI.fileWritten(display, { created: false, lines: updated.split('\n').length });
            return { ok: true, applied: edits.data.length - failed.length, failed };
        };
        const executeBash = async (code) => {
            try {
                if (!await confirmAction(`run bash: #${String(code).split('\n')[0].substring(0, 80)}#`)) return false;
                const exec = await getEngine().executeBash({ ...getContext(), userDirectory: baseDir }, code);
                code2prompt.invalidateTraverseCache(); // bash may have changed project files
                return exec;
            } catch (err) {
                return false;
            }
        };
        return { readFile, writeFile, editFile, executeBash };
    };

    // ---------------------------------------------------------------------------
    // runPrompt: one full pipeline turn for a single user input.
    // renderer-agnostic: everything talks to `runUI` (the transcript UI for
    // one-shot runs, or the Ink TUI's UI adapter for interactive sessions).
    // ---------------------------------------------------------------------------
    const runPrompt = async (input, runUI, opts = {}) => {
        const runStart = Date.now();
        // per-turn usage ledger: installed on every engine this turn creates, so
        // concurrent sessions never mix their token/cost totals
        const ledger = new code2prompt.UsageLedger();
        // the model picked for this turn (opts.model, else flags.model); null = default routing
        const selection = activeSelection(opts);
        const engineFor = (template, config) => {
            const engine = codePrompt(template, config);
            engine.setUsageLedger(ledger);
            if (selection) applyModelSelection(engine, selection, keysData);
            return engine;
        };
        const userOS = os.platform();
        // 0) single fast-tier pre-flight call: classify input + pick action template + pick personality
        let general;
        try {
            general = engineFor(path.join(actionsDirectory, 'default.md'));
        } catch (err) {
            // the picked model cannot run (e.g. its key was removed after it was chosen)
            runUI.error(err);
            const usage0 = ledger.summary();
            lastUsage = usage0;
            runUI.footer({ ...usage0, elapsedMs: Date.now() - runStart });
            return usage0;
        }
        if (opts.signal) general.setAbortSignal(opts.signal);
        const modelPreferences = opts.modelPreferences || runtimeFlags.modelPreferences;
        if (modelPreferences && !runtimeFlags.local && !selection) general.setModelPreferences(modelPreferences);
        const user_action = new actionsIndex(input);
        const personality = new personalitiesIndex(input);
        await Promise.all([user_action.initialize(), personality.initialize()]);
        const action_choices = user_action.code_blocks.map((b) => `file:${b.file}\ndescription:\n${b.content}`).join('\n\n');
        const personality_choices = personality.code_blocks.map((b) => `file:${b.file}\ndescription:\n${b.content}`).join('\n\n');
        // discover installed Agent Skills (skills.sh / SKILL.md); offered to the
        // router alongside the built-in action templates
        const skills_list = skills.discoverSkills(cwd);
        const hasSkills = skills_list.length > 0;
        const skill_choices = skills_list.map((s) => `skill:${s.name}\ndescription:\n${s.description}`).join('\n\n');
        const analyzeStep = runUI.step('analyzing request');
        let initial_analysis;
        try {
            let analysisPrompt =
`# Analyze the following user input text:
${input}

# 1. Classify it as an action or a question, detect its language, and provide an english version of it (without translating filenames).

# 2. Select the most suitable action template file for handling the input, from the following available templates and their descriptions:
${action_choices}

# 3. Select the most suitable personality template file for writing the response, from the following available personalities and their descriptions:
${personality_choices}

# 4. Decide whether this request needs AGENT MODE. Set needs_agent to true ONLY when fulfilling it clearly requires MULTIPLE dependent steps — e.g. reading and modifying several files, running commands and reacting to their output, or iterating until something builds/tests/works. Set needs_agent to false for a single question, a single-file change, or a one-shot generation that a single action template handles well.`;
            const analysisShape = {
                type_of: z.enum(['action', 'question']).describe('Type of the input'),
                english: z.string().describe('English version of text, without translating filenames'),
                language: z.enum(['English', 'Spanish', 'Portuguese', 'French', 'Japanese']).describe('language of the given input'),
                action_file: z.string().describe('just the absolute chosen action template file'),
                action_reason: z.string().describe('brief reason why the action template is the best for the user input'),
                personality_file: z.string().describe('just the absolute chosen personality template file'),
                personality_reason: z.string().describe('brief reason why the personality template is the best for the user input'),
                needs_agent: z.boolean().describe('true only if the request requires multiple dependent steps (multi-file edits, running/verifying commands, iterating); false for simple one-shot requests'),
            };
            if (hasSkills) {
                analysisPrompt +=
`

# 5. Only if one of the following installed skills clearly matches the request better than any action template above, set skill_name to that skill's exact name; otherwise set skill_name to an empty string:
${skill_choices}`;
                analysisShape.skill_name = z.string().describe('exact name of the installed skill to use, or an empty string when an action template fits better');
            }
            initial_analysis = await general.queryLLM(analysisPrompt, z.object(analysisShape), { tier: 'fast' });
        } catch (err) {
            analyzeStep.fail('analyzing request');
            runUI.statusStop();
            if (opts.signal && opts.signal.aborted) runUI.note('run cancelled', '', 'yellow');
            else runUI.error(err);
            const usage0 = ledger.summary();
            lastUsage = usage0;
            runUI.footer({ ...usage0, elapsedMs: Date.now() - runStart });
            return usage0;
        }
        const input_lang_code = ISO6391.getCode(initial_analysis.data.language);
        let targetLanguage = runtimeFlags.language || initial_analysis.data.language;
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
                file: resolveTemplateFile(initial_analysis.data.personality_file, personality.code_blocks, path.join(ROOT, 'personalities', 'default.md')),
                reason: initial_analysis.data.personality_reason,
            }
        };
        // if the router picked an installed skill, route to the use-skill action
        // and load its full instructions for the template scope
        let selectedSkill = null;
        if (hasSkills && initial_analysis.data.skill_name && String(initial_analysis.data.skill_name).trim()) {
            const wanted = String(initial_analysis.data.skill_name).trim().toLowerCase();
            const match = skills_list.find((s) => s.name.toLowerCase() === wanted)
                || skills_list.find((s) => s.name.toLowerCase().includes(wanted) || wanted.includes(s.name.toLowerCase()));
            if (match) {
                try {
                    const loaded = skills.loadSkill(match);
                    selectedSkill = { ...match, body: loaded.body, files: loaded.files };
                    action.data.file = path.join(actionsDirectory, 'use-skill.md');
                    action.data.reason = `matched installed skill "${match.name}"`;
                } catch (e) {
                    debug('failed to load selected skill', { name: match.name, err: e.message });
                }
            }
        }
        const template_ = action.data.file.split('/').pop().replace('.md', '');
        const persona_name = persona.data.file.split('/').pop().replace('.md', '');
        const persona_ = await personality.getPersonality(persona.data.file);
        const translate = new Translator(template_, initial_analysis.data.language_code);
        analyzeStep.done(`${selectedSkill ? 'skill:' + selectedSkill.name : template_} · ${persona_name}`);
        // use the chosen personality as the system prompt for all LLM calls of this run
        general.setSystemPrompt(persona_);
        const progress = runUI.progressShim();
        // central gate for --confirm: ask the user before executing state-changing actions
        const confirmAction = async (description) => {
            if (!runtimeFlags.confirm) return true;
            return await runUI.confirm(`*aicode wants to:* ${description}. Continue?`);
        };
        // file helpers bound to the project root (editFile/executeBash reach the
        // engine and the context lazily)
        let additional_context = null;
        const fileHelpers = makeFileHelpers(cwd, runUI, confirmAction, { engine: () => general, getContext: () => additional_context });
        // declare methods for js code blocks
        additional_context = {
            personality: persona_,
            confirm_actions: runtimeFlags.confirm, // prompt user before executing actions
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
                // test cachekey: template+question+cwd
                const cache = new CacheWithTTL('template_cache.json');
                const cacheKey = template + question + cwd;
                const cachedTemplate = cache.get(cacheKey);
                if (cachedTemplate) {
                    return cachedTemplate;
                }
                try {
                    const template_ = template.endsWith('.md') ? template : `${template}.md`;
                    const specific = engineFor(path.join(actionsDirectory, template_));
                    const resp_ = await specific.request(question, null, {
                        meta: false
                    });
                    cache.set(cacheKey, resp_, 1 * 60 * 60 * 1000); // 1 hour
                    return resp_;
                } catch (err) {
                    runUI.error('Error running template: ' + err.message);
                }
            },
            setModelPreferences: (order_models) => applyTemplatePreferences(general, order_models, {
                keysData, ui: runUI, local: runtimeFlags.local, selection: activeSelection(opts),
            }),
            writeFile: fileHelpers.writeFile,
            readFile: fileHelpers.readFile,
            editFile: fileHelpers.editFile,
            stringifyTreeFromPaths: (paths) => {
                const tree = general.stringifyTreeFromPaths(paths);
                return tree;
            },
            userDirectory: cwd,
            actionsDirectory,
            // the skill the router selected for this run (null unless use-skill.md)
            getSelectedSkill: () => selectedSkill,
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
                            await require('sharp')(tmpobj.name)
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
                            await require('sharp')(tmpobj.name).toFormat(format).toFile(newFilePath);

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
            argv: runtimeFlags, // legacy alias: no template reads it today, kept for compatibility
            system_os: userOS, progress,
            language: targetLanguage,
            language_code: initial_analysis.data.language_code,
        };
        // some special methods that need access to the previous context methods
        additional_context.runTemplate = async (template, question = null, custom_context = {}) => {
            // add .md to 'template' if it doesn't have extension
            const template_ = template.endsWith('.md') ? template : `${template}.md`;
            const specific = engineFor(path.join(actionsDirectory, template_));
            return await specific.runTemplate(question, null, { ...additional_context, ...custom_context, ...{ ai: false } });
        };
        additional_context.executeBash = fileHelpers.executeBash;
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

            // Resolve the output path relative to the working directory
            const resolved_path = path.isAbsolute(output)
                ? output
                : path.resolve(cwd, output);

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
        // agent mode: run a multi-step tool-using loop (agents/main.md orchestrator)
        // instead of a single action template. Forced by the 'agent' mode (--agent,
        // /agent), auto-selected by the classifier for multi-step requests, or
        // chosen because a skill matched (skills are usually multi-step procedures,
        // so they default to the agent loop — the one-shot use-skill.md path stays
        // as a fallback under --local, where tool calling may be unavailable).
        const mode = opts.modeOverride || runtimeFlags.mode || 'auto';
        const skillWantsAgent = !!selectedSkill && !runtimeFlags.local;
        const wantAgent = mode === 'agent' || skillWantsAgent || (initial_analysis.data.needs_agent === true && !selectedSkill);
        if (wantAgent) {
            try {
                if (!agentDefsCache) agentDefsCache = await agentsReg.loadAgents();
                await agentsReg.runAgent({
                    engine: general,
                    agentName: 'main',
                    agents: agentDefsCache,
                    task: initial_analysis.data.english,
                    ctx: additional_context,
                    ui: runUI,
                    history: opts.history || [],
                    depth: 0,
                    streamAnswer: true,
                    skill: selectedSkill || null,
                });
            } catch (ErrAgent) {
                try { runUI.streamEnd(); } catch (e) { }
                runUI.statusStop();
                if (opts.signal && opts.signal.aborted) runUI.note('run cancelled', '', 'yellow');
                else runUI.error(ErrAgent);
            }
            const usageA = ledger.summary();
            lastUsage = usageA;
            runUI.footer({ ...usageA, elapsedMs: Date.now() - runStart });
            return usageA;
        }

        // render the template using the engine
        const actioncode = engineFor(action.data.file);
        if (opts.signal) actioncode.setAbortSignal(opts.signal);
        if (modelPreferences && !runtimeFlags.local && !selection) actioncode.setModelPreferences(modelPreferences);
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
        const usage = ledger.summary();
        lastUsage = usage;
        runUI.footer({ ...usage, elapsedMs: Date.now() - runStart });
        return usage;
    };

    return {
        cwd,
        flags: runtimeFlags,
        keysData,
        ide,
        runPrompt,
        describeProvider,
        listActions,
        codePrompt,
        makeFileHelpers,
        // usage summary of the last completed turn (null before the first turn)
        usage: () => lastUsage,
    };
}

module.exports = { createRuntime, cleanupTmpFiles, applyModelSelection, applyTemplatePreferences, FLAG_DEFAULTS };
