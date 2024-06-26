```description
Creates a tutorial for a project.
```

```js:pre
// what kind of files should I read from this project source to generate the README?
progress.text(`#determining most important files ...#`);
const files_ = await queryLLM('What are the main files we need from the following sourcetree to write a tutorial about the functionality and features of these files?\n'+source_tree, 
    z.array(z.string()).describe('filenames to read from the given source tree')
);
//console.log('queryLLM files_',files_.data);
// read the indicated files and return object overwriting default files (use readFiles helper that takes an array of files and returns an array of objects with a field named 'code')
// add absolute_code_path prefix to the files if it's not contained
// filter 'files' to only include the files that are in the 'files_' array
let filtered = [];
files = files.map((item)=>{
    files_.data.some((file)=>{
        if (item.path.includes(file)){
            // if the file is too large, truncate it to 90% of its total word length
            const words = item.code.split(/\s+/);
            if (words.length < 100) {
                filtered.push(item);
                return true;
            }
            const words_per = Math.floor(words.length * 0.9);
            const p90 = words.slice(0, words_per).join(' ');
            item.code = p90;
            //const chars_per = Math.floor(item.code.length * 0.9);
            //item.code = item.code.substring(0, chars_per);
            filtered.push(item);
            return true;
        }
    });
});
// query what this project is about first
//const project_summary = await queryContext('Write a summary for what this project is about so an LLM can understand it to use it as context for writing a tutorial');
//const project_summary = await queryTemplate('create-summary', '', {absolute_code_path, source_tree, files: filtered })
//console.log('project_summary2', project_summary);
//console.log('filtered', filtered);
//console.log('files_', files_);
return {
    files: filtered,
    //summary: project_summary.data
}
```

```js:pre
//log('SECOND JS BLOCK');
//log('files2', files);
progress.text(`#writing tutorial ...#`);
```

Project Path: {{ absolute_code_path }}

# Act as an expert software engineer and writer of documents and tutorials, you have a professional and friendly style. 
# We need to create a friendly tutorial about the project in the given source tree in {{ language }}.

Source Tree:
```
{{ source_tree }}
```

# Analyze the following files contents and dependencies to understand what the folder is about and create an engaging tutorial that is easy to understand and follow:

{{#each files}}
{{#if code}}
`{{path}}`:

{{{code}}}

{{/if}}
{{/each}}

# The tutorial should first describe what the tutorial is about, layout the steps we're going to implement and then follow them one at a time, showing all code snippets needed and then the final solution and deployment and bundling steps.
# Feel free to infer reasonable details if needed, but try to stick to what can be determined from the codebase itself always avoiding replying there's something missing.

{{#if language}}
# Always answer in {{ language }}.
{{/if}}

```json:schema
{
    "tutorial": "tutorial content in markdown syntax"
}
```

```js
// nodejs code to run after getting results (runs within an isolated async function block)
// context vars: schema (results), absolute_code_path, files, source_tree, etc (all the template vars)
// is there a file specified in the user request?
const file = await queryLLM(
    `# If there is a file specified in the following user request, return it. If not, return the field empty:\n
    ${english_user_prompt}
    `, 
    z.object({
        file: z.string().describe('the exact file name or empty if there is none'),
    })
);
if (file.data.file.trim()!='') {
    progress.text(`#saving tutorial ... to ${file.data.file}#`);
    // save 'readme' schema.tutorial contents to disk (abs)
    await writeFile(`${absolute_code_path}/${file.data.file}`, schema.tutorial + '\n\n### Generated by aicode');
    //await writeFile(`${absolute_code_path}/TUTORIAL-${language}.md`, schema.tutorial + '\n\n### Generated by aicode');
    progress.stop();
    console.log(`${file.data.file} saved!`);
} else {
    // answer to the console
    progress.stop();
    console.log(renderMD(schema.tutorial));
}
```

```bash
# commands to run after the previous nodejs code block
```
