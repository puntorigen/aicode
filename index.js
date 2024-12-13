#!/usr/bin/env node

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const actionsIndex = require('./actions');
const personalitiesIndex = require('./personalities');
const getSystemLocale = require('./helpers/lang')();
const parsers = require('./parsers');
const output_redirected = !process.stdout.isTTY;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
//console.log('getSystemLocale',getSystemLocale);

const __ = require('y18n')({
    directory: __dirname + '/locales',
    locale: getSystemLocale,
}).__;

let argv = yargs(hideBin(process.argv))
  .scriptName('aicode')
  .locale(getSystemLocale)
  .usage(__('Usage: $0 <command> [options]'))
  .command('$0 <input>', __('Process the input'), (yargs) => {
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
    //default: 'English',
    description: __('Language for the output'),
  })
  .option('confirm', {
    alias: 'c',
    type: 'boolean',
    default: false,
    description: __('Confirm each AI action before executing it'),
  })
  .help('h')
  .alias('h', 'help')
  .parse();

// trap exit signals
process.on('SIGINT', () => {
    console.log('CTRL+C detected. Exiting gracefully...');
    // erase tmp files
    for (const [key, value] of Object.entries(tmpFiles)) {
        value.removeCallback();
    }
    // Perform any cleanup, if necessary
    process.exit(0); // Exit normally
});

if (output_redirected) {
    // disable debugger if output is redirected
    argv.debug = false;
}

// Initialize the required variables
const ISO6391 = require('iso-639-1')
//const code2prompt = require('code2prompt');
const code2prompt = require('../code2prompt');
const safeEval = require('safe-eval');
const path = require('path');
const fs = require('fs').promises;
const currentWorkingDirectory = process.cwd();
const actionsDirectory = path.join(__dirname, 'actions');
require('dotenv').config();
const os = require('os');
const { z } = require('zod');
const x_console = new (require('@concepto/console'))();
x_console.setColorTokens({
    '*':'magenta',
    '#':'cyan',
    '@':'green',
    '!':'blue',
    '?':'yellow',
});
x_console.setPrefix({ prefix:'aicode', color:'cyan' });
const marked = require('marked');
const { log } = require('console');
const { readFile } = require('fs');
const TerminalRenderer = require('marked-terminal').default;
const prompts = require('prompts');
const EncryptedJsonDB = require('./helpers/db');
const CacheWithTTL = require('./helpers/CacheWithTTL');
const Translator = require('./helpers/translator');
const { locale } = require('yargs');
const debug = (argv.debug) ? (x,data)=>x_console.out({ prefix:'debug', message:x, data }) : ()=>{};
const tmp = require('tmp');
let tmpFiles = {}; // track tmp files, to remove them on finish or ctrl-c

marked.setOptions({
    // Define custom renderer
    renderer: new TerminalRenderer()
});

// Process the input
!(async () => {
    // load config data
    const db_keys = new EncryptedJsonDB('keys.json');
    let db_keys_data = db_keys.load();
    let key_providers = Object.keys(db_keys_data);
    if (true) {
        // only ask any supported API, if there are no API providers set yet
        // OPENAI
        if (!process.env.OPENAI_KEY && !db_keys_data.OPENAI_KEY) {
            // prompt for OPENAI_KEY
            db_keys_data.OPENAI_KEY = (
                await prompts({
                    type: 'text',
                    name: 'value',
                    message: x_console.colorize('Enter your OPENAI API key (or empty if none):')
                })
            ).value;

        } else if (process.env.OPENAI_KEY && !db_keys_data.OPENAI_KEY) {
            // save OPENAI env into db_keys
            db_keys_data.OPENAI_KEY = process.env.OPENAI_KEY;
        }
        // GROQ
        if (!process.env.GROQ_KEY && !db_keys_data.GROQ_KEY) {
            // prompt for GROQ_KEY
            db_keys_data.GROQ_KEY = (
                await prompts({
                    type: 'text',
                    name: 'value',
                    message: x_console.colorize('Enter your GROQ API key (or empty if none):')
                })
            ).value;

        } else if (process.env.GROQ_KEY && !db_keys_data.GROQ_KEY) {
            // save GROQ_KEY env into db_keys
            db_keys_data.GROQ_KEY = process.env.GROQ_KEY;
        }
        // ANTHROPIC
        if (!process.env.ANTHROPIC_KEY && !db_keys_data.ANTHROPIC_KEY) {
            // prompt for ANTHROPIC_KEY
            db_keys_data.ANTHROPIC_KEY = (
                await prompts({
                    type: 'text',
                    name: 'value',
                    message: x_console.colorize('Enter your ANTHROPIC API key (or empty if none):')
                })
            ).value;

        } else if (process.env.ANTHROPIC_KEY && !db_keys_data.ANTHROPIC_KEY) {
            // save ANTHROPIC_KEY env into db_keys
            db_keys_data.ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
        }
        // OPENAI
        if (!process.env.REPLICATE_API_TOKEN && !db_keys_data.REPLICATE_API_TOKEN) {
            // prompt for REPLICATE_API_TOKEN
            db_keys_data.REPLICATE_API_TOKEN = (
                await prompts({
                    type: 'text',
                    name: 'value',
                    message: x_console.colorize('Enter your REPLICATE API TOKEN (or empty if none):')
                })
            ).value;

        } else if (process.env.REPLICATE_API_TOKEN && !db_keys_data.REPLICATE_API_TOKEN) {
            // save REPLICATE_API_TOKEN env into db_keys
            db_keys_data.REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
        }
        // we need at least 1 key
        if (db_keys_data.GROQ_KEY.trim() == '' && db_keys_data.OPENAI_KEY.trim() == '' && db_keys_data.ANTHROPIC_KEY.trim() == '') {
            x_console.out({ prefix:'aicode', color:'brightRed', message:'You need to set at least one API key to continue. Quitting.' });
            process.exit(1);
        }
        //
        db_keys.save(db_keys_data);
    }
    // INIT
    // show aicode logo
    const progress = x_console.spinner({
        prefix:'aicode', color:'green'
    });
    //
    progress.text(`*${__('parsing')} ...*`)
    progress.start();
    // Define default configuration for the code2prompt instances
    const codePrompt = (template,config={}) => {
        return new code2prompt({
            path: currentWorkingDirectory,
            template, //: path.join(actionsDirectory,'default.md'),
            extensions: [],
            ignore: ["**/node_modules/**","**/*.gguf","**/*.pyc","**/*.js.*","**/*.css.*","**/*.chunk.*","**/*.png","**/*.jpg","**/*.gif","**/package-lock.json","**/.env","**/.gitignore","**/LICENSE"],
            OPENAI_KEY: db_keys_data.OPENAI_KEY,
            GROQ_KEY: db_keys_data.GROQ_KEY,
            ANTHROPIC_KEY: db_keys_data.ANTHROPIC_KEY,
            maxBytesPerFile: (db_keys_data.ANTHROPIC_KEY!='')?32768:16384,
            custom_viewers: {
                // register custom file parsers
                '.docx': async(file)=>{
                    const docx_parser = new parsers.docx(file);
                    const content = await docx_parser.read();
                    debug('reading .docx: '+file,content);
                    return content;
                },
                '.xlsx': async(file)=>{
                    const xlsx_parser = new parsers.xlsx(file);
                    const content = await xlsx_parser.read();
                    debug('reading .xlsx: '+file,content);
                    return content;
                },
                '.pdf': async(file)=>{
                    const pdf_parser = new parsers.pdf(file);
                    const content = await pdf_parser.read();
                    debug('reading .pdf: '+file,content);
                    return content;
                },
                '.rtf': async(file)=>{
                    const rtf_parser = new parsers.rtf(file);
                    const content = await rtf_parser.read();
                    debug('reading .rtf: '+file,content);
                    return content;
                }
            },
            debugger: argv.debug,
            ...config
        });
    }
    // init replicate if key is set
    let replicate = null, replicate_models = {};
    if (db_keys_data.REPLICATE_API_TOKEN) {
        const replicate_ = require('replicate');
        replicate = new replicate_({ auth: db_keys_data.REPLICATE_API_TOKEN });
        replicate_models = {
            'create-image': async(data)=>{
                // cost: 333 images per 1 usd; https://replicate.com/black-forest-labs/flux-schnell
                const props = {
                    prompt: '',
                    aspect_ratio: '1:1', // values: 1:1, 16:9, 21:9, 2:3, 3:2, 4:5, 5:4, 9:16, 9:21
                    output_format: 'jpg',
                    output_quality: 100,
                    num_outputs: 1,
                    ...data
                };
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
            'create-avatar': async(data)=>{
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
            'photomaker': async(data)=>{
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
            'image-to-text': async(data)=>{
                // cost, 344 runs per 1 usd; https://replicate.com/smoretalk/clip-interrogator-turbo
                // data min: { image, prompt }
                const props = {
                    mode: "fast", // turbo, fast, best
                    image: "", // url to process
                    style_only: false,
                    ...data
                };
                if (!data) return { specs:props, output_format:'txt' };
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
            'image-to-video': async(data)=>{
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
                if (!data) return { specs:props, output_format:'mp4' };
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
            'text-to-speech': async(data)=>{
                // cost, 142 runs per 1 usd; https://replicate.com/lucataco/xtts-v2
                // data min: { text, language, speaker }
                const props = {
                    // define defaults first, and overwrite with data
                    text: 'Hola, ¿cómo estás?',
                    language: 'es',
                    speaker: 'https://replicate.delivery/pbxt/Jt79w0xsT64R1JsiJ0LQRL8UcWspg5J4RFrU6YwEKpOT1ukS/male.wav',
                    ...data
                }
                if (!data) return { specs:props, output_format:'wav', specs_values:{
                    text: 'text',
                    language: ['es','en','fr','de','it','pt','pl','tr','ru','nl','cs','ar','zh','hu','ko','hi'],
                    speaker: ['url_wav','url_mp3','url_m4a','url_ogg','url_flv']
                } };
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
    //x_console.title({ title:'aicode', color:'magenta', titleColor:'white'})
    // -1) determine OS of the user
    const userOS = os.platform();
    // 0) determine if the input is an action or a question, and the user input language
    const general = codePrompt(path.join(actionsDirectory,'default.md'));
    // run the initial analysis
    const initial_analysis = await general.queryLLM('# Analyze the following text and return if its an action or a question, it\'s language and an english version of it:\n'+argv.input,
        z.object({
            type_of: z.enum(['action','question']).describe('Type of the input'),
            english: z.string().describe('English version of text, without translating filenames'),
            language: z.enum(['English','Spanish','Portuguese','French','Japanese']).describe('language of the given input'),
            //language_code: z.enum(['en','es','pt','fr','ja']).describe('ISO-639 language code of the given input'),
        })
    );
    const input_lang_code = ISO6391.getCode(initial_analysis.data.language);
    if (!argv.language && initial_analysis.data.language) {
        argv.language = initial_analysis.data.language;
    }
    // if argv.language length is 2, it's an ISO-639 language code
    if (argv.language && argv.language.length == 2) {
        // get language name from ISO-639 language code
        argv.language = ISO6391.getName(argv.language);
    }
    // get ISO-639 language code from 'language'; to support user defined target language
    initial_analysis.data.language_code = ISO6391.getCode(argv.language);
    //
    const ui_text = new Translator('ui',input_lang_code);
    const ui_texts = await (async()=>{
        return {
            'analyzing':await ui_text.t('analyzing'),
            'reasoning':await ui_text.t('thinking'),
            'generating_answer':await ui_text.t('answering'),
            'using':await ui_text.t('using'),
            'action':await ui_text.t('action'),
        };
    })();
    //console.log('ui_texts',ui_texts);
    progress.text(`*${ui_texts['analyzing']} ...* #${initial_analysis.data.english}#`)
    //progress.stop();
    //console.log('initial input analysis?',initial_analysis.data);
    // 1) if the input is an action, select the best action template from the availables and run it
    //if (action_or_question.data.type_of === 'action') {
    if (true) { // always run this block
        const user_action = new actionsIndex(argv.input);
        const prompt = await user_action.getPrompt();
        // which action template should we use ?
        progress.text(`#${ui_texts['reasoning']} ...#`)
        const action = await general.queryLLM(prompt,
            z.object({
                file: z.string().describe('just the absolute choosen template file'),
                reason: z.string().describe('the reason why the template is the best for the user input'),
            })
        );
        const template_ = action.data.file.split('/').pop().replace('.md','');
        // choose a personality profile
        const personality = new personalitiesIndex(argv.input);
        const personality_prompt = await personality.getPrompt();
        progress.text(`#${ui_texts['reasoning']} ...# !${action.data.reason}!`)
        const persona = await general.queryLLM(personality_prompt,
            z.object({
                file: z.string().describe('just the absolute choosen template file'),
                reason: z.string().describe('the reason why the template is the best for the user input'),
            })
        );
        if (persona.data.file.startsWith('file:')) {
            persona.data.file = persona.data.file.replace('file:','');
        }
        const persona_ = await personality.getPersonality(persona.data.file);
        //progress.stop();
        //debug('action',action.data);
        //debug('personality',persona_);
        const translate = new Translator(template_,initial_analysis.data.language_code);
        const personality__ = await translate.t('personality');
        progress.text(`#${ui_texts['reasoning']} ...# ${personality__}: !${persona.data.reason}!`)
        //await sleep(2500);

        // if action.data.file contains 'file:', remove it
        if (action.data.file.startsWith('file:')) {
            action.data.file = action.data.file.replace('file:','');
        }
        //console.log('action',action.data);
        // declare methods for js code blocks
        let additional_context = { 
            personality:persona_,
            confirm_actions:argv.confirm, // prompt user before executing actions
            replicate_models, 
            queryLLM:async(question,schema)=>{
                try {
                    return await general.queryLLM(question,schema); 
                } catch(err) {
                    if (argv.debug) {
                        x_console.out({ prefix:'aicode', color:'brightRed', message:'Error running queryLLM: '+err.message, data:{question} });
                    }
                    return false;
                }
            },
            queryContext:async(question,schema)=>{
                return await general.request(question,schema); 
            },
            queryTemplate:async(template,question=null,custom_context={})=>{
                // add .md to 'template' if it doesn't have extension
                // test cachekey: template+question+currentWorkingDirectory
                const cache = new CacheWithTTL('template_cache.json');
                const cacheKey = template+question+currentWorkingDirectory;
                const cachedTemplate = cache.get(cacheKey);
                if (cachedTemplate) {
                    return cachedTemplate;
                }
                try {
                    const template_ = template.endsWith('.md') ? template : `${template}.md`;
                    const specific = codePrompt(path.join(actionsDirectory,template_));
                    const resp_ = await specific.request(question,null,{
                        //custom_context,
                        meta: false
                    });
                    cache.set(cacheKey, resp_, 1 * 60 * 60 * 1000); // 1 hour
                    return resp_;
                } catch(err) {
                    x_console.out({ prefix:'aicode', color:'brightRed', message:'Error running template: '+err.message });
                }
            },
            setModelPreferences:async(order_models)=>{
                general.setModelPreferences(order_models);
                // ask model API keys if they don't exit and we need them
                if (!db_keys_data.OPENAI_KEY && general.model_preferences.includes('OPENAI')) {
                    // prompt for OPENAI_KEY
                    db_keys_data.OPENAI_KEY = (
                        await prompts({
                            type: 'text',
                            name: 'value',
                            message: x_console.colorize('Enter your *OPENAI API key* (or empty if none):')
                        })
                    ).value;
                    if (db_keys_data.OPENAI_KEY.trim()!='') {
                        db_keys.save(db_keys_data);
                        general.setLLMAPI('OPENAI',db_keys_data.OPENAI_KEY);
                    }
                } else if (!db_keys_data.GROQ_KEY && general.model_preferences.includes('GROQ')) {
                    // prompt for GROQ_KEY
                    db_keys_data.GROQ_KEY = (
                        await prompts({
                            type: 'text',
                            name: 'value',
                            message: x_console.colorize('Enter your *GROQ API key* (or empty if none):')
                        })
                    ).value;
                    if (db_keys_data.GROQ_KEY.trim()!='') {
                        db_keys.save(db_keys_data);
                        general.setLLMAPI('GROQ',db_keys_data.GROQ_KEY);
                    }
                } else if (!db_keys_data.ANTHROPIC_KEY && general.model_preferences.includes('ANTHROPIC')) {
                    // prompt for ANTHROPIC_KEY
                    db_keys_data.ANTHROPIC_KEY = (
                        await prompts({
                            type: 'text',
                            name: 'value',
                            message: x_console.colorize('Enter your *ANTHROPIC API key* (or empty if none):')
                        })
                    ).value;
                    if (db_keys_data.ANTHROPIC_KEY.trim()!='') {
                        db_keys.save(db_keys_data);
                        general.setLLMAPI('ANTHROPIC',db_keys_data.ANTHROPIC_KEY);
                    }
                }
                //
                return true;
            },
            writeFile:async(file,content)=>{
                await fs.writeFile(file,content, 'utf8');
                await sleep(500);
            },
            readFile:async(file)=>{
                return await fs.readFile(path.join(currentWorkingDirectory,file), 'utf8');
            },
            stringifyTreeFromPaths:(paths)=>{
                const tree = general.stringifyTreeFromPaths(paths);
                return tree;
            },
            userDirectory:currentWorkingDirectory,
            actionsDirectory,
            tmp: async(ext='tmp')=>{
                const tmpobj = tmp.fileSync({
                    postfix: '.'+ext
                });
                tmpFiles[tmpobj.name] = tmpobj;
                await sleep(100);
                return {
                    file: tmpobj.name,
                    fd: tmpobj.fd,
                    remove: tmpobj.removeCallback
                }
            },
            sleep,
            getNpmReadme:async(packageName)=>{
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
                        //console.log('README Content:\n', readme);
                        cache.set(packageName, readme, 24 * 60 * 60 * 1000); // 24 hours
                        return readme;
                    } else {
                        throw new Error('README not available for this package.');
                    }
                } catch (error) {
                    console.error('Failed to fetch README:', error.message);
                    return null;
                }
            },
            renderMD:(text)=>{
                return marked.parse(text);
            },
            log:(message,data,color='cyan')=>{
                // extract just the filename from action.data.file (abs)
                progress.stop();
                const template_ = action.data.file.split('/').pop().replace('.md','');
                x_console.out({ prefix:ui_texts['action']+':'+template_, color, message:x_console.colorize(message), data });
                progress.start();
            },
            debug:(message,data,color='green')=>{
                // extract just the filename from action.data.file (abs)
                if (argv.debug) {
                    progress.stop();
                    const template_ = action.data.file.split('/').pop().replace('.md','');
                    x_console.out({ prefix:ui_texts['action']+':'+template_, color, message:x_console.colorize(message), data });
                }
            },
            joinPaths: (...paths)=>{
                const path_ = require('path');
                return path_.join(...paths);
            },
            db: {
                engine: EncryptedJsonDB,
                save: (file,data)=>{
                    const db = new EncryptedJsonDB(file);
                    let db_data = db.load();
                    db_data = {...db_data,...data};
                    db.save(data);
                },
                load: (file)=>{
                    const db = new EncryptedJsonDB(file);
                    return db.load();
                },
            },
            modules: {
                screenshot: require('screenshot-desktop'),
                diagram: require('cli-diagram'),
                image: {
                    scale: async(image, width, height) => {
                        try {
                            // Validate the file exists
                            if (!fs.existsSync(image)) {
                                return null;
                            }
                        
                            // Overwrite the original image file with the scaled image
                            await sharp(image)
                              .resize(width, height)
                              .toFile(image);
                        
                            debug(`Image scaled to ${width}x${height} and saved at ${image}`);
                          } catch (error) {
                            debug(`Error scaling image: ${error.message}`);
                          }
                    },
                    convert: async(image, format) => {
                        try {
                            if (!fs.existsSync(image)) {
                                throw new Error(`Image file not found: ${image}`);
                            }

                            // Extract the file directory, name, and create the new file name
                            const dir = path.dirname(image);
                            const ext = path.extname(image);
                            const baseName = path.basename(image, ext);
                            const newFileName = `${baseName}.${format}`;
                            const newFilePath = path.join(dir, newFileName);

                            // Convert and save the image to the new format
                            await sharp(image).toFormat(format).toFile(newFilePath);
                            return newFilePath;
                        } catch (error) {
                            debug(`Error converting image to ${format}: ${error.message}`);
                            return null;
                        }
                    }
                },
                clipboard: {
                    paste: async()=>{
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
                    copy: async(text)=>{
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
            t: async(text)=>{
                // try to translate text to the user specified language (using google)
                try {
                    const translated = await translate.t(text);
                    return translated;
                } catch(err) {
                    return text;
                }
            },
            ask: async(question)=>{
                // ask the user a question in the input language
                progress.stop();
                const translation = new Translator('ui',initial_analysis.data.language_code);
                const translated = await translation.t(question);
                const response = await prompts({
                    type: 'text',
                    name: 'value',
                    message: translated
                });
                progress.start();
                return response.value;
            },
            select: async(question,choices)=>{
                // ask the user to choose from a list of choices in the input language using prompts
                progress.stop();
                const translation = new Translator('ui',initial_analysis.data.language_code);
                const translated = await translation.t(question);
                // translate the given choices
                for (let i=0; i<choices.length; i++) {
                    choices[i].title = await translation.t(choices[i].title);
                }
                const response = await prompts({
                    type: 'select',
                    name: 'value',
                    message: translated,
                    choices
                });
                progress.start();
                return response.value;
            },
            answer: async(text)=>{
                // answer the user in the input language
                const translation = new Translator('ui',initial_analysis.data.language_code);
                const translated = await translation.t(text);
                const template_ = action.data.file.split('/').pop().replace('.md','');
                x_console.out({ prefix:ui_texts['action']+':'+template_, color:'cyan', message:translated });
            },
            user_prompt: argv.input,
            english_user_prompt: initial_analysis.data.english,
            argv,system_os:userOS,progress,
            language:argv.language,
            language_code:initial_analysis.data.language_code,
        };
        // some special methods that need access to the previous context methods
        additional_context.runTemplate = async(template,question=null,custom_context={})=>{
            // add .md to 'template' if it doesn't have extension
            const template_ = template.endsWith('.md') ? template : `${template}.md`;
            const specific = codePrompt(path.join(actionsDirectory,template_));
            return await specific.runTemplate(question,null,{...additional_context,...custom_context,...{ai:false}});
        };
        additional_context.executeBash = async(code) => {
            try {
                const exec = await general.executeBash({...additional_context},code);
                return exec;
            } catch(err) {
                return false;
            }
        };
        additional_context.executeNode = async(code) => {
            try {
                const exec = await general.executeNode({...additional_context},code);
                return exec;
            } catch(err) {
                return { error:err };
            }
        };
        additional_context.executePython = async(code) => {
            try {
                const exec = await general.executePython({...additional_context},code);
                return exec;
            } catch(err) {
                return { error:err };
            }
        };
        additional_context.spawnBash = async(custom_context={},code) => {
            const exec = await general.spawnBash({...additional_context,...custom_context},code);
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
        // render the template using code2prompt
        const actioncode = codePrompt(action.data.file);
        progress.text(`?${ui_texts['generating_answer']} ...? #${ui_texts['using']} ${action.data.file}#`);
        try {
            let context_ = await actioncode.runTemplate(initial_analysis.data.english, {}, {...additional_context,...{ai:true}});
            debug('context_.abort_',context_.abort_);
            progress.stop();
        } catch(ErrA) {
            progress.stop();
            x_console.out({ prefix:'aicode', color:'brightRed', message:'Error running template: '+ErrA.message, data:ErrA });
        }
        //
    }
    if (argv.debug) {
        console.log('Debug mode is on');
    }

})()

