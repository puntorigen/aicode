```description
Generates a README file for a project.
```

```js:pre
// what kind of files should I read from this project source to generate the README?
const files_ = await queryLLM('What are the main files we need from the sourcetree to generate a README of this project?\n'+source_tree, 
    z.array(z.string()).describe('filenames to read from the given source tree')
);
console.log('queryLLM files_',files_.data);
// read the indicated files and return object overwriting default files (use readFiles helper that takes an array of files and returns an array of objects with a field named 'code')
// add absolute_code_path prefix to the files if it's not contained
// filter 'files' to only include the files that are in the 'files_' array
let filtered = [];
files = files.map((item)=>{
    files_.data.some((file)=>{
        if (item.path.includes(file)){
            // also truncate the files to 1000 characters
            item.code = item.code.substring(0, 1000);
            filtered.push(item);
            return true;
        }
    });
});
console.log('filtered', filtered);
console.log('files_', files_);
return {
    files: filtered
}
```

```js:pre
console.log('SECOND JS BLOCK');
console.log('files2', files);
```

Project Path: {{ absolute_code_path }}

I'd like you to generate a high-quality README file for this project, suitable for hosting on GitHub. Analyze the codebase to understand the purpose, functionality, and structure of the project. 

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
4. Installation instructions
5. Usage examples
6. Configuration options (if applicable) 
7. Contribution guidelines
8. Testing instructions
9. License
10. Acknowledgements/Credits

Write the content in Markdown format. Use your analysis of the code to generate accurate and helpful content, but also explain things clearly for users who may not be familiar with the implementation details.

Feel free to infer reasonable details if needed, but try to stick to what can be determined from the codebase itself. Let me know if you have any other questions as you're writing!

```json:schema
{
    "readme": "content of the README file"
}
```

```js
// nodejs code to run after getting results (runs within an isolated async function block)
// context vars: schema (results), absolute_code_path, files, source_tree, etc (all the template vars)
const fs = require('fs').promises;
// save 'readme' schema.readme contents to disk (abs)
await fs.writeFile(`${absolute_code_path}/README.md`, schema.readme, 'utf8');
// if you return an object here, it will be available for the next code block
```

```bash
# commands to run after the previous nodejs code block
```
