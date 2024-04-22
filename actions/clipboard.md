```description
Execute this if you need to access the clipboard data and integrate it into the current context.
packages: osascript
```

```js:pre
// what kind of files should I read from this project source to generate the README?
//const x = require(''); // custom aicode require, checks remote npm usage and installs if necessary
//aicode.osascript("get the clipboard data")
//vars should be within context object; context.source_tree
//methods within aicode object; aicode.queryLLM, aicode.queryContext
progress.text(`#determining most important files ...#`);
const pasted = await modules.clipboard.paste();
const files_ = await queryLLM(`What are the main files we need from the following sourcetree to see how we can integrate the following clipboard data on the project?

source_tree:
${source_tree}

clipboard data to integrate:
${pasted}
`, 
    z.array(z.string()).describe('filenames to read from the given source tree')
);
let filtered = [];
files = files.map((item)=>{
    files_.data.some((file)=>{
        if (item.path.includes(file)){
            // if the file is too large, truncate it to 60% of its total word length
            const words = item.code.split(/\s+/);
            if (words.length < 100) {
                filtered.push(item);
                return true;
            }
            const words_per = Math.floor(words.length * 0.6);
            const p90 = words.slice(0, words_per).join(' ');
            item.code = p90;
            filtered.push(item);
            return true;
        }
    });
});
return {
    files: filtered,
}
```

Project Path: {{ absolute_code_path }}

Act as an expert engineer and writer and analyze the following project files and source_tree:

Source Tree:
```
{{ source_tree }}
```

{{#each files}}
{{#if code}}
`{{path}}`:

{{{code}}}

{{/if}}
{{/each}}

```js
const pasted = await modules.clipboard.paste();
const prompt_ = `# think how the following data, idea or code snippet can be useful within the current context, describe the steps to integrate it and generate a response to the user, as well as full code examples if useful: `;
const query = await queryContext(prompt_ + pasted,
    z.object({
        steps: z.array(z.string()).describe('steps to integrate the clipboard data'),
        files_to_update: z.array(
            z.object({
                path: z.string().describe('the path of the file to update'),
                content: z.string().describe('the content to update the file with'),
            })
        ).describe('files to update with the clipboard data'),
        reasoning: z.string().describe('reasoning for the integration of the clipboard data'),
    })
)
progress.stop();
log('answer from aicode',query.data);

```
