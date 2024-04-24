#!/usr/bin/env node

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const actionsIndex = require('./actions');

let argv = yargs(hideBin(process.argv))
  .scriptName('aicode')
  .usage('Usage: $0 <command> [options]')
  .command('$0 <input>', 'Process the input', (yargs) => {
    yargs.positional('input', {
      describe: 'Input string to process',
      type: 'string',
    })
  })
  .option('debug', {
    alias: 'd',
    type: 'boolean',
    description: 'Run with debug output',
  })
  .option('language', {
    alias: 'l',
    type: 'string',
    default: 'English',
    description: 'Language for the output',
  })
  .help('h')
  .alias('h', 'help')
  .parse();

// Initialize the required variables
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
const Translator = require('./helpers/translator');

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
    progress.text('*analyzing ...*')
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
    general.registerFileViewer('png',(file)=>'--query me if you need data about this file--');
    const initial_analysis = await general.queryLLM('# Analyze the following text and return if its an action or a question, it\'s language and an english version of it:\n'+argv.input,
        z.object({
            type_of: z.enum(['action','question']).describe('Type of the input'),
            english: z.string().describe('English version of text'),
            //is_action: z.boolean().describe('True if the input is an action, False if the input is a question'),
            //is_question: z.boolean().describe('True if the input is a question, True if the input is a question'),
            language: z.enum(['English','Spanish','Portuguese','French','Japanese']).describe('language of the given input'),
        })
    );
    if (initial_analysis.data.language) {
        argv.language = initial_analysis.data.language;
    }
    const ui_lang = new Translator('ui',argv.language,async(question,schema)=>{
        return await general.queryLLM(question,schema); 
    });
    progress.text(`*analyzing ...* #${initial_analysis.data.english}#`)
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
        progress.text(`#reasoning ...# !${action.data.reason}!`)
        
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
                const template_ = template.endsWith('.md') ? template : `${template}.md`;
                const specific = new code2prompt({
                    path: currentWorkingDirectory,
                    template: path.join(actionsDirectory,template_),
                    extensions: [],
                    ignore: ["**/node_modules/**","**/*.png","**/*.jpg","**/*.gif","**/package-lock.json","**/.env","**/.gitignore","**/LICENSE"],
                    OPENAI_KEY: db_keys_data.OPENAI_KEY,
                    GROQ_KEY: db_keys_data.GROQ_KEY
                });
                return await specific.request(question,null,{
                    //custom_context,
                    meta: false
                });
            },
            writeFile:async(file,content)=>{
                return await fs.writeFile(file,content, 'utf8');
            },
            readFile:async(file)=>{
                return await fs.readFile(path.join(currentWorkingDirectory,file), 'utf8');
            },
            renderMD:(text)=>{
                return marked.parse(text);
            },
            log:(message,data,color='cyan')=>{
                // extract just the filename from action.data.file (abs)
                const template_ = action.data.file.split('/').pop().replace('.md','');
                x_console.out({ prefix:'action:'+template_, color, message, data });
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
                const translation = new Translator('ui',argv.language,general.queryLLM);
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
                const translation = new Translator('ui',argv.language,general.queryLLM);
                const translated = await translation.t(question);
                const template_ = action.data.file.split('/').pop().replace('.md','');
                x_console.out({ prefix:'action:'+template_, color:'cyan', message:translated });
            },
            user_prompt: argv.input,
            english_user_prompt: initial_analysis.data.english,
            argv,userOS,progress,
            language:initial_analysis.data.language,
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
        progress.text(`?generating answer ...? #using ${action.data.file}#`);
        const context_ = await actioncode.runTemplate(initial_analysis.data.english, {}, additional_context)
        progress.stop();
        //
    }
    if (argv.debug) {
        console.log('Debug mode is on');
    }

})()

