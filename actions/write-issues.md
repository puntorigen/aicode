```description
Generates an ISSUES file for a project, considering security issues, bugs, and fixes that need to be addressed.
```

```js:pre
// what kind of files should I read from this project source to generate the ISSUES files?
const files_ = await queryLLM('What are the main files we need to analyze from the sourcetree to generate a detailed list of issue on this project?\n'+source_tree, 
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

Project Path: {{ absolute_code_path }}

Act as an expert software critique and QA analyst, you are an expert level software engineer as well, versed in best practices for NodeJS, React and python codebases, that excels in finding specific issues within code, and excels at writing clear and easy to understand 'how to fix' approaches that are concise and helpful. Focus on specific security issues affecting specific files and code block snippets, always indicating on which file, why and how to solve the issue. If there're hardcoded API keys, point where and why are they a security risk. If there's a potential DoS attack that can be performed because of a codeblock within the codebase, ensure to point it as well, indicating why and how to solve it. Also focus on scalability, since the code could be used to serve several concurrent users and as a startup we always should strive to have the best performant code. Generate a high-quality markdown ISSUES file for this project so our developers have a clear roadmap of checklist items to remediate and HOW to fix them with specific files, lines and code modifications.

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

The ISSUES file should include the following sections:

1. Project Title (based on what the folder name is or the code is about)
2. Brief description (1-2 sentences)
3. Code Quality Score (a quality score, 1-10 and a 1 sentence reason)
3. Security Issues (checklist)
4. Bad Practices (checklist)
5. Steps to Achieve Production Level Quality (checklist)
6. Code Improvements (checklist)
8. Recomendations (1-2 sentences; focus on what should be done to improve the codebase and not praising the code)

Write the content in Markdown format. Use your deep analysis of the code to generate accurate and helpful content, but also explain things clearly so our developers know exactly how to fix the issues.

Feel free to infer reasonable details if needed, but try to stick to what can be determined from the codebase itself always avoiding replying there's something missing.

# RULES
- Never say which things should be 'regulary updated' or 'checked'. Always focus on what's actually wrong or needs improvement within the codebase, indicating specific files with issues.
- If there's a specific security issue, point the file and the line number where the issue is located, and provide a clear explanation of the issue and how to fix it.
- Whenever you suggest implementing something, be specific about what should be implemented and how it should be implemented, and where within the codebase.
- If you suggest refactoring a file, be specific about what should be refactored and how it should be refactored, and where within the codebase.
- If you mention conventions, specify what conventions are being broken and how they should be fixed, and where within the codebase.
- When giving a score, be specific about what the score is based on and why it was given.

```json:schema
{
    "issues": "your markdown content for the ISSUES file"
}
``` 

```js
// nodejs code to run after getting results (runs within an isolated async function block)
// context vars: schema (results), absolute_code_path, files, source_tree, etc (all the template vars)
// save 'issues' schema.issues contents to disk (abs)
// ai=true when running this code block from AI, false when manually running it
if (ai) {
    await writeFile(`${absolute_code_path}/ISSUES.md`, schema.issues);
    log('ISSUES.md saved!');
}
// if you return an object here, it will be available for the next code block
```

```bash
# commands to run after the previous nodejs code block
```