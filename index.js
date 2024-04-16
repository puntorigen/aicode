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

// Process the input
!(async () => {
    // -1) determine OS of the user
    const userOS = os.platform();
    // 0) determine if the input is an action or a question, and the user input language
    const general = new code2prompt({
        path: currentWorkingDirectory,
        template: path.join(actionsDirectory,'default.md'),
        extensions: ["js"],
        ignore: ["**/node_modules/**"],
        OPENAI_KEY: process.env.OPENAI_KEY
    });
    const action_or_question = await general.queryLLM('# Is the following text an action or a question?\n'+argv.input,
        z.object({
            is_action: z.boolean().describe('True if the input is an action, False if the input is a question'),
            is_question: z.boolean().describe('True if the input is a question, True if the input is a question'),
            language: z.string().describe('2 letters language of the input (ex. en, fr, sp, etc.)'),
        })
    );
    console.log('is action or question?',action_or_question.data);
    // 1) if the input is an action, select the best action template from the availables and run it
    if (action_or_question.data.is_action) {
        const user_action = new actionsIndex(argv.input);
        const prompt = await user_action.getPrompt();
        // declare methods for js code blocks
        let additional_context = { 
            queryLLM:async(question,schema)=>{
                return await general.queryLLM(question,schema); 
            }
        };
        const action = await general.queryLLM(prompt,
            z.object({
                file: z.string().describe('the choosen template file'),
                reason: z.string().describe('the reason why the template is the best for the user input'),
            })
        );
        console.log('action',action.data);
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
                        console.log('adding context from pre:js code block',code_executed);
                        additional_context = {...additional_context,...code_executed};
                    }
                }
            }
        }
        // query the template
        const template_res = await actioncode.request(argv.input, null, {
            custom_variables: {
                ...additional_context
            }
        });
        console.log('template_res',template_res);
        // check if we have none ':pre' code blocks (must run after the template)
        // add results from template_res.data obj schema to additional_context object
        additional_context = {...additional_context, ...{
            schema:template_res.data
        }};
    }
    // 2) if the input is a question, run the question to the model with the 'default-template' and return the response

    console.log(`Processing input: ${argv.input}`,currentWorkingDirectory,userOS);
    console.log(`Actions directory: ${actionsDirectory}`);
    if (argv.debug) {
        console.log('Debug mode is on');
    }

})()

