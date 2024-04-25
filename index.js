#!/usr/bin/env node

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const actionsIndex = require('./actions');
const getSystemLocale = require('./helpers/lang')();
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
  .help('h')
  .alias('h', 'help')
  .parse();

// trap exit signals
process.on('SIGINT', () => {
    console.log('CTRL+C detected. Exiting gracefully...');
    // Perform any cleanup, if necessary
    process.exit(0); // Exit normally
});

// Initialize the required variables
const ISO6391 = require('iso-639-1')
const code2prompt = require('code2prompt');
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
    if (key_providers.length==0) {
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
        // we need at least 1 key
        if (db_keys_data.GROQ_KEY.trim() == '' && db_keys_data.OPENAI_KEY.trim() == '') {
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
    //x_console.title({ title:'aicode', color:'magenta', titleColor:'white'})
    // -1) determine OS of the user
    const userOS = os.platform();
    // 0) determine if the input is an action or a question, and the user input language
    const general = new code2prompt({
        path: currentWorkingDirectory,
        template: path.join(actionsDirectory,'default.md'),
        extensions: [],
        ignore: ["**/node_modules/**","**/*.png","**/*.jpg","**/*.gif","**/package-lock.json","**/.env","**/.gitignore","**/LICENSE"],
        OPENAI_KEY: db_keys_data.OPENAI_KEY,
        GROQ_KEY: db_keys_data.GROQ_KEY
    });
    // register custom file parsers
    general.registerFileViewer('png',(file)=>'--query me if you need data about this file--');
    // run the initial analysis
    const initial_analysis = await general.queryLLM('# Analyze the following text and return if its an action or a question, it\'s language and an english version of it:\n'+argv.input,
        z.object({
            type_of: z.enum(['action','question']).describe('Type of the input'),
            english: z.string().describe('English version of text, without translating filenames'),
            language: z.enum(['English','Spanish','Portuguese','French','Japanese']).describe('language of the given input'),
            //language_code: z.enum(['en','es','pt','fr','ja']).describe('ISO-639 language code of the given input'),
        })
    );
    if (!argv.language && initial_analysis.data.language) {
        argv.language = initial_analysis.data.language;
    }
    // get ISO-639 language code from 'language'; to support user defined target language
    initial_analysis.data.language_code = ISO6391.getCode(argv.language);
    //
    const ui_text = new Translator('ui',initial_analysis.data.language_code);
    const ui_texts = await (async()=>{
        return {
            'analyzing':await ui_text.t('analyzing'),
            'reasoning':await ui_text.t('thinking'),
            'generating_answer':await ui_text.t('crafting answer'),
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
        const action = await general.queryLLM(prompt,
            z.object({
                file: z.string().describe('just the absolute choosen template file'),
                reason: z.string().describe('the reason why the template is the best for the user input'),
            })
        );
        progress.stop();
        console.log('action',action.data);
        progress.text(`#${ui_texts['reasoning']} ...# !${action.data.reason}!`)
        // if action.data.file contains 'file:', remove it
        if (action.data.file.startsWith('file:')) {
            action.data.file = action.data.file.replace('file:','');
        }
        //console.log('action',action.data);
        // declare methods for js code blocks
        let additional_context = { 
            queryLLM:async(question,schema)=>{
                return await general.queryLLM(question,schema); 
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
                    const specific = new code2prompt({
                        path: currentWorkingDirectory,
                        template: path.join(actionsDirectory,template_),
                        extensions: [],
                        ignore: ["**/node_modules/**","**/*.png","**/*.jpg","**/*.md","**/*.gif","**/package-lock.json","**/.env","**/.gitignore","**/LICENSE"],
                        OPENAI_KEY: db_keys_data.OPENAI_KEY,
                        GROQ_KEY: db_keys_data.GROQ_KEY
                    });
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
            writeFile:async(file,content)=>{
                return await fs.writeFile(file,content, 'utf8');
            },
            readFile:async(file)=>{
                return await fs.readFile(path.join(currentWorkingDirectory,file), 'utf8');
            },
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
                const template_ = action.data.file.split('/').pop().replace('.md','');
                progress.stop();
                x_console.out({ prefix:ui_texts['action']+':'+template_, color, message, data });
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
                    }
                }
            },
            ask: async(question)=>{
                // ask the user a question in the input language
                const translation = new Translator('ui',initial_analysis.data.language_code);
                const translated = await translation.t(question);
                const response = await prompts({
                    type: 'text',
                    name: 'value',
                    message: translated
                });
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
            argv,userOS,progress,
            language:initial_analysis.data.language,
            language_code:initial_analysis.data.language_code,
        };
        // some special methods that need access to the context
        additional_context.runTemplate = async(template,question=null,custom_context={})=>{
            // add .md to 'template' if it doesn't have extension
            const template_ = template.endsWith('.md') ? template : `${template}.md`;
            const specific = new code2prompt({
                path: currentWorkingDirectory,
                template: path.join(actionsDirectory,template_),
                extensions: [],
                ignore: ["**/node_modules/**","**/*.png","**/*.jpg","**/*.gif","**/package-lock.json","**/.env","**/.gitignore","**/LICENSE"],
                OPENAI_KEY: db_keys_data.OPENAI_KEY,
                GROQ_KEY: db_keys_data.GROQ_KEY
            });
            return await specific.runTemplate(question,null,{...additional_context,...custom_context,...{ai:false}});
        };
        // render the template using code2prompt
        const actioncode = new code2prompt({
            path: currentWorkingDirectory,
            template: action.data.file,
            extensions: [],
            ignore: ["**/node_modules/**","**/*.png","**/*.jpg","**/*.gif","**/package-lock.json","**/.env","**/.gitignore","**/LICENSE"],
            OPENAI_KEY: db_keys_data.OPENAI_KEY,
            GROQ_KEY: db_keys_data.GROQ_KEY
        });
        progress.text(`?${ui_texts['generating_answer']} ...? #${ui_texts['using']} ${action.data.file}#`);
        const context_ = await actioncode.runTemplate(initial_analysis.data.english, {}, {...additional_context,...{ai:true}});
        progress.stop();
        //
    }
    if (argv.debug) {
        console.log('Debug mode is on');
    }

})()

