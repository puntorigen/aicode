// read all .md files in the current directory
// parse the md code-blocks looking for 'description' lang field blocks
// create a prompt for the CLI to choose the best personality template based on the user request
//
const codeblocks = require('code-blocks');
const path = require('path');
const fs = require('fs').promises;
const { glob } = require("glob");

class indexFolder {
    constructor(inputText) {
        this.code_blocks = [];
        this.input = inputText;
        this.currentFolder = __dirname;
    }

    async initialize() {
        // traverse current folder and read all .md (with hbs) files
        const files = await glob('**/*.md', { cwd: this.currentFolder, nodir:true, absolute:true });
        for (const file of files) {
            // read 'file' contents
            const content = await fs.readFile(file, 'utf-8');
            // parse the md code-blocks looking for 'description' lang field blocks
            const code_blocks = await codeblocks.fromString(content);
            for (const block of code_blocks) {
                if (block.lang === 'description') {
                    this.code_blocks.push({file, content: block.value});
                }
            }
        }
    }

    async getPrompt() {
        await this.initialize();
        let prompt = `Given the following input text:\n\n${this.input}\n\nPlease select the most suitable personality template file from the availables and their description relateness to the request:\n\n`;
        for (const block of this.code_blocks) {
            prompt += `file:${block.file}\ndescription:\n${block.content}\n\n`;
        }
        //console.log('action prompt debug:', prompt)
        return prompt;
    }

    async getPersonality(template) {
        // read the selected template file
        let content = await fs.readFile(template, 'utf-8');
        // remove code-blocks from the content (just leave the markdown or hbs content)
        const code_blocks = await codeblocks.fromString(content);
        for (const block of code_blocks) {
            const full_block = "```" + block.lang + "\n" + block.value + "\n```"
            content = content.replace(full_block, '');
        }
        return content.trim();
    }
}

module.exports = indexFolder;