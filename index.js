#!/usr/bin/env node

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

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
        template: path.join(actionsDirectory,'default.hbs'),
        extensions: ["js"],
        ignore: ["**/node_modules/**"],
        OPENAI_KEY: process.env.OPENAI_KEY
    });
    const action_or_question = await general.queryLLM('# Is the following text an action or a question?\n'+argv.input,
        z.object({
            is_action: z.boolean().describe('True if the input is an action, False if the input is a question'),
            is_question: z.boolean().describe('True if the input is a question, True if the input is a question'),
            language: z.string().describe('The language of the input in 2 letters (e.g. en, fr, es, etc.)'),
        })
    );
    console.log('is action or question?',action_or_question.data);
    // 1) if the input is an action, select the best action template from the availables and run it
    // 2) if the input is a question, run the question to the model with the 'default-template' and return the response

    console.log(`Processing input: ${argv.input}`,currentWorkingDirectory,userOS);
    console.log(`Actions directory: ${actionsDirectory}`);
    if (argv.debug) {
        console.log('Debug mode is on');
    }

})()

