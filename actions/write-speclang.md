```description
Generates a Speclang DSL file for a project codebase.
```

```js:pre
await setModelPreferences(["OPENAI","ANTHROPIC","GROQ"]);
let speclang_syntax = `
# consider the following syntax from a DSL called 'speclang'; you can check more info on this link: https://githubnext.com/projects/speclang/
# SpecLang it's a structured Mardown-like document (DSL) of what you want of your program penned out in only the necessary level of detail.
# An example 'speclang' file looks as follows:
\`\`\`speclang
- Continuously poll the server on progress on the route \`/progress?taskId=$id\`.
  - The server responds with a JSON object with the following fields:
    - progress: number
    - output: string
    - errors: string
    - However, if the object is empty, then $progress = 0 and $output and $errors are empty strings.
  - Display the progress as a blue progress bar.
  - If $errors is not empty, then
    - Display $errors in a big red box labelled "Task errors:".
  - Display $output in a big gray box labelled "Task output:".
- When the progress reaches 100%, redirect to the url \`/success?taskId=$id\`.
\`\`\`
# A 'speclang' file describes both the backend and frontend interactions, with a high-level ui and data flow interaction description. These speclang files are later used as a blueprint to generate complete source code for projects (that's another process).
# I need your help for generating a LangSpec file about an existing project folder I have. Your task is to take the following folder codebase and create a single SpecLang file that will be used as a guide for another process to re-create the codebase (not necessarily using the same syntax code, but providing the same functionality). Be highly detailed, use nested features to infer grouped functionaly, but omit specifics about licenses, exact file names or specific source code for any particular language. The ui is just the UI, not necesarily react, wordpress, vuejs, etc. The backend is just the backend, not necesarily python, nodejs, nextjs, etc. The database is just the database, not necesarily postgres, sqlite, mysql, unless the functionality description requires a specific database. If it contains a docker, be explicit to identify what's needed for an engineer to create it, but not necesarily list the required imports or technologies, because on the speclang we don't specify specific languages implementations, just instructions about how it should work (what each method should do when executed, how data should be saved: e.g. schemas), how the data should flow (what ui to what thing that must be done on the backend, etc), and how the UI should look like (layout, colors).
If there are data schemas, provide their high-level specs as needed for a junior engineer to recreate them on any db. If there are referenced images, try to describe them as much as posible, so we can later generate similar ones without knowning the original files.
`;
// what kind of files should I read from this project source to generate the SpecLang file?
const files_ = await queryLLM(speclang_syntax+'What are the main files we need from the sourcetree to generate a SpecLang of this folder?\n'+source_tree, 
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
    files: filtered,
    speclang_syntax
}
```

```js:pre
//log('SECOND JS BLOCK');
//log('files2', files);
```
{{ speclang_syntax }}
# The following is the codebase we need to understand and use as source for generating the SpecLang:

Project Path: {{ absolute_code_path }}

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

Write the content in Markdown format. Use your analysis of the code to generate accurate and helpful content, but also explain things clearly for users who may not be familiar with the implementation details.

Feel free to infer reasonable details if needed, but try to stick to what can be determined from the codebase itself always avoiding replying there's something missing.

```json:schema
{
    "speclang": "your markdown content for the SpecLang file"
}
```

```js
// nodejs code to run after getting results (runs within an isolated async function block)
// context vars: schema (results), absolute_code_path, files, source_tree, etc (all the template vars)
// save 'readme' schema.readme contents to disk (abs)
// ai=true when running this code block from AI, false when manually running it
if (ai) {
    await writeFile(`${absolute_code_path}/speclang.md`, schema.speclang);
    log('speclang.md saved!');
}
// if you return an object here, it will be available for the next code block
```

```bash
# commands to run after the previous nodejs code block
```
