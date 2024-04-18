#!/usr/bin/env node

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const actionsIndex = require('./actions');

const argv = yargs(hideBin(process.argv))
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
    '*':'yellow',
    '#':'cyan',
    '@':'green'
});
x_console.setPrefix({ prefix:'aicode', color:'cyan' });
const marked = require('marked');
const { log } = require('console');
const { readFile } = require('fs');
const TerminalRenderer = require('marked-terminal').default;

marked.setOptions({
    // Define custom renderer
    renderer: new TerminalRenderer()
});

// Process the input
!(async () => {
    // -1) determine OS of the user
    const userOS = os.platform();
    // 0) determine if the input is an action or a question, and the user input language
    const general = new code2prompt({
        path: currentWorkingDirectory,
        template: path.join(actionsDirectory,'default.md'),
        extensions: [],
        ignore: ["**/node_modules/**","**/*.png","**/*.jpg","**/*.gif","**/package-lock.json","**/.env","**/.gitignore","**/LICENSE"],
        OPENAI_KEY: process.env.OPENAI_KEY
    });
    const action_or_question = await general.queryLLM('# Is the following text an action or a question?\n'+argv.input,
        z.object({
            type_of: z.enum(['action','question']).describe('Type of the input'),
            //is_action: z.boolean().describe('True if the input is an action, False if the input is a question'),
            //is_question: z.boolean().describe('True if the input is a question, True if the input is a question'),
            language: z.enum(['English','Spanish','Portuguese','French','Japanese']).describe('language of the given input'),
        })
    );
    console.log('is action or question?',action_or_question.data);
    // 1) if the input is an action, select the best action template from the availables and run it
    if (action_or_question.data.type_of === 'action') {
        const user_action = new actionsIndex(argv.input);
        const prompt = await user_action.getPrompt();
        // which action template should we use ?
        const action = await general.queryLLM(prompt,
            z.object({
                file: z.string().describe('the choosen template file'),
                reason: z.string().describe('the reason why the template is the best for the user input'),
            })
        );
        console.log('action',action.data);
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
                    OPENAI_KEY: process.env.OPENAI_KEY
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
            log:(message,data,color='cyan')=>{
                // extract just the filename from action.data.file (abs)
                const template_ = action.data.file.split('/').pop().replace('.md','');
                x_console.out({ prefix:'action:'+template_, color, message, data });
            },
            user_prompt: argv.input,
            language:action_or_question.data.language,
        };
        additional_context = {...additional_context,...{
            executeScript:async(code)=>{
                const code_executed = await code_helper.executeNode(additional_context,code);
                return code_executed;
            }
        }};

        // render the template using code2prompt
        const actioncode = new code2prompt({
            path: currentWorkingDirectory,
            template: action.data.file,
            extensions: [],
            ignore: ["**/node_modules/**","**/*.png","**/*.jpg","**/*.gif","**/package-lock.json","**/.env","**/.gitignore","**/LICENSE"],
            OPENAI_KEY: process.env.OPENAI_KEY
        });
        // get the code blocks
        const code_helper = new (require('./helpers/codeBlocks'));
        const context_prompt = await actioncode.generateContextPrompt(null,true);
        //console.log('context_prompt',context_prompt);
        additional_context = {...additional_context,...{
                absolute_code_path: context_prompt.context.absolutePath,
                source_tree: context_prompt.context.sourceTree,
                files: context_prompt.context.filesArray,
            }
        };
        const code_blocks = await actioncode.getCodeBlocks();
        // check if we have ':pre' code blocks (must run before the template)
        //console.log('code_blocks for choosen template',code_blocks);
        for (const block of code_blocks) {
            // if block.lang ends with ':pre'
            if (block.lang.endsWith(':pre')) {
                // if block.lang contains 'js'
                if (block.lang.includes('js')) {
                    const code_executed = await code_helper.executeNode(additional_context,block.code);
                    // if code_executed is an object
                    if (typeof code_executed === 'object') {
                        //console.log('adding context from pre:js code block',code_executed);
                        additional_context = {...additional_context,...code_executed};
                    }
                }
            }
        }
        // query the template (if it's not empty or just scripts)
        if (context_prompt.rendered.trim() !== '') {        
            const template_res = await actioncode.request(argv.input, null, {
                custom_variables: {
                    ...additional_context
                }
            });
            //console.log('template_res',template_res);
            // add results from template_res.data obj schema to additional_context object
            additional_context = {...additional_context, ...{
                schema:template_res.data
            }};
        }
        // check if we have none ':pre' code blocks (must run after the template)
        for (const block of code_blocks) {
            // if block.lang doesn't end with ':pre'
            if (!block.lang.endsWith(':pre')) {
                // if block.lang contains 'js'
                if (block.lang.includes('js')) {
                    const code_executed = await code_helper.executeNode(additional_context,block.code);
                    // if code_executed is an object
                    if (typeof code_executed === 'object') {
                        //console.log('adding context from post js code block',code_executed);
                        additional_context = {...additional_context,...code_executed};
                    }
                }
            }
        }
        //
    } else if (action_or_question.data.type_of === 'question' || action_or_question.data.type_of === 'instruction') {
        // 2) if the input is a question, run the question to the model with the 'default-template' and return the response
        const question = new code2prompt({
            path: currentWorkingDirectory,
            template: path.join(actionsDirectory,'default.md'),
            extensions: [],
            ignore: ["**/node_modules/**","**/*.png","**/*.jpg","**/*.gif","**/package-lock.json","**/.env","**/.gitignore","**/LICENSE"],
            OPENAI_KEY: process.env.OPENAI_KEY
        });
        let prompt_ = `# Act as a friendly and expert generalist analyst with 20 years of experience in several programming languages. Analyze the provided codebase sourcetree and files, determine the functionality and then using that info alongside the sourcetree and code sources, answer the following user question in detail, using markdown syntax, nice formatting (emoji's,tables,titles) in a friendly tone using short sentences (max 60 chars per line, avoiding word wrapping). Always reply the specific question asked using the provided context and codebase references and nothing else:\n${argv.input}`;
        if (action_or_question.data.type_of === 'instruction') {
            prompt_ = `# Act as an expert software engineer, analize the following question and provide a detailed answer using the provided context and codebase references (use markdown):\n${argv.input}`;
        }
        const response = await question.request(prompt_);
        x_console.out({ message:marked.parse(response.data) });
        //console.log('response:\n',response.data);
    } else {
        console.log('The input is not an action or a question.. exiting..');
        console.log(`Processing input: ${argv.input}`,currentWorkingDirectory,userOS);
        console.log(`Actions directory: ${actionsDirectory}`);
    }
    if (argv.debug) {
        console.log('Debug mode is on');
    }

})()

