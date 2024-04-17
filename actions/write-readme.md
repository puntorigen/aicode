```description
Generates a README file for a project.
```

```js:pre
// what kind of files should I read from this project source to generate the README?
const files_ = await queryLLM('What are the main files we need from the sourcetree to generate a README of this project?\n'+source_tree, 
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
            // also truncate the files to 100% of their total length
            const chars_per = Math.floor(item.code.length * 1);
            item.code = item.code.substring(0, chars_per);
            filtered.push(item);
            return true;
        }
    });
});
//console.log('filtered', filtered);
//console.log('files_', files_);
return {
    files: filtered
}
```

```js:pre
//log('SECOND JS BLOCK');
//log('files2', files);
```

Project Path: {{ absolute_code_path }}

Act as an expert in code analysis and documentation and generate a high-quality markdown README file for this project. 
Analyze the following codebase in detail to first understand its purpose and functionality, if it's a CLI, library, class or program, then check if there're usage examples within the code or other files, and use that information to generate your response. 

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

The README should include the following sections:

1. Project Title
2. Brief description (1-2 sentences)
3. Features
4. Usage examples
5. License

Write the content in Markdown format. Use your analysis of the code to generate accurate and helpful content, but also explain things clearly for users who may not be familiar with the implementation details.

Feel free to infer reasonable details if needed, but try to stick to what can be determined from the codebase itself always avoiding replying there's something missing.

```json:schema
{
    "readme": "your markdown content for the README file"
}
```

```js
// nodejs code to run after getting results (runs within an isolated async function block)
// context vars: schema (results), absolute_code_path, files, source_tree, etc (all the template vars)
// save 'readme' schema.readme contents to disk (abs)
await writeFile(`${absolute_code_path}/README.md`, schema.readme);
log('README.md saved!');
// if you return an object here, it will be available for the next code block
```

```bash
# commands to run after the previous nodejs code block
```
