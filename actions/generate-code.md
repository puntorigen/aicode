```description
Generates a file with source code. Some common requests include:
- generating source code for a user task, generating source code for a user prompt, generate the solution given a certain referenced file such as pdf, docx, rtf, txt, etc.
- improving a given file source code, fixing a given source code, transforming a given source file source code into another language, etc.
```

```js:pre
// translation of strings
await setModelPreferences(["OPENAI","ANTHROPIC","GROQ"]);
const translated_progress = async(text,suffix='') => {
    const text_ = await t(text);
    progress.text(`#${text_} ...# `+suffix);
}
// what kind of files should I read from this project given the user request?
await translated_progress(`determining most important files`);
const files_ = await queryLLM(`
What are the main files we need to read from the sourcetree to generate the source code for the user prompt?\n
# source_tree:
${source_tree}

# user prompt:
${english_user_prompt}
`, 
    z.array(z.string()).describe('filenames to read from the given source tree')
);
debug('queryLLM files_',files_.data);

// read the indicated files and return object overwriting default files (use readFiles helper that takes an array of files and returns an array of objects with a field named 'code')
// add absolute_code_path prefix to the files if it's not contained
// filter 'files' to only include the files that are in the 'files_' array
let filtered = [];
files = files.map((item)=>{
    files_.data.some((file)=>{
        if (item.path.includes(file)){
            // also truncate the files to 100% of their total length
            //const chars_per = Math.floor(item.code.length * 1);
            //item.code = item.code.substring(0, chars_per);
            filtered.push(item);
            return true;
        }
    });
});
const original_source_tree = source_tree;
source_tree = stringifyTreeFromPaths(files_.data);

// understand the user task given the sources, and return a thinking plan for the source code generation
await translated_progress(`understanding the user task`);
const files_code = filtered.map((item)=>{
    if (item.code) {
        return `\`${item.path}\`:\n\n${item.code}\n\n`;
    }
}).join('');

await translated_progress(`generating a plan`);
const plan = await queryLLM(
    `
    # We have the following source tree and files contents to generate the source code for the user task:
    # source tree:
    ${original_source_tree}

    # files contents:
    ${files_code}

    # Given this information as context, the user is requesting us to perform the following task:
    ${english_user_prompt}

    # Return a detailed understanding of the user task and a plan to generate the needed source code for the user task. Feel free to infer reasonable details if needed, trying to stick to what can be determined from the user request considering the current folder source tree and files contents, always in regards to the user requested task, always avoiding replying there's something missing.

    # Also use the following writing rules whenever writing your texts:
    ${personality}
    `, 
    z.object({
        // plan array of strings for generating the source code
        your_understanding_of_the_task: z.string().describe('your understanding of the task'),
        plan: z.array(z.string()).describe('the plan to generate the source code')
    })
);
// report initial working plan as MD
const initial_report = `
# Initial Working Plan
The user requested the following task:
${english_user_prompt}

## Understanding of the Task
${plan.data.your_understanding_of_the_task}

## Plan to Generate the Source Code
${plan.data.plan.map((item,idx)=>`${idx+1}. ${item}`).join('\n')}
`;

// ask the user if he's happy with the plan
log('\n'+renderMD(initial_report));
let extra_user_feedback = '';
const is_user_ok = await select(`Are you happy with the plan?`,[{
    title: 'Yes',
    value: true
},{
    title: 'No',
    value: false
}]);
if (!is_user_ok) {
    extra_user_feedback = await answer(`Please provide feedback on what you would like to change in the plan.`);
    return;
}
//log('working plan',plan.data);

// query where to write the file
await translated_progress(`determining where to write the file`);
const file = await queryLLM(
    `# If there is a file specified in the following user request stating where to write to, return it. If not, return the field empty:\n
    ${english_user_prompt}
    `, 
    z.object({
        file: z.string().describe('the exact file name or empty if there is none'),
    })
);
let target_file = '';
if (file.data.file.trim()!='') {
    target_file = file.data.file.trim();
    debug('file specified', target_file);
} else {
    // if there is no file specified, ask the file to the user or assign the most probable one
    //debug('no file specific... TODO ask the user for the filename');
    //target_file = await ask('Where do you want me to save the file?'); // only ask if not in non-interactive mode
    // ask the llm what is the most probable file to write to given the original source_tree
    const file_ = await queryLLM(
        `
        # The user is requesting us to generate source code for the following task:
        ${english_user_prompt}

        # If there is no file specified in the user request, return the most probable file to write to given the current folder source tree, without overwriting the referenced source:\n
        ${original_source_tree}
        `, 
        z.object({
            file: z.string().describe('the most probable relative file to write to')
        })
    );
    target_file = file_.data.file.trim();
    debug('file specified', target_file);
}

await translated_progress(`generating source code`);
return {
    files: filtered,
    filename: target_file,
    source_tree,
    translated_progress,
    plan: plan.data.plan,
    understanding_of_the_task: plan.data.your_understanding_of_the_task,
    initial_report,
    extra_user_feedback
}
```

Project Path: {{ absolute_code_path }}

# Act as an expert fullstack software engineer who excels at writing high quality source code with easy to understand and relevant comments. The following are the relevant files and their contents provided by the user for you to generate the code for completing the user task. Always return the full source code needed to be executed, never use comments as placeholders for future code. Assign comments to the code in {{ language }} language, but ensure the variables and functions are named in English.

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

# As a guide use the following task understanding to guide you in generating the source code:
{{understanding_of_the_task}}

{{#if extra_user_feedback}}
# Regarding the task understanding, the user also gave as the following extra feedback:
{{extra_user_feedback}}
{{/if}}

{{#if personality}}
# Use the following rules for writing the {{language}} code comments:
{{personality}}
{{/if}}

```json:schema
{
    "source_code": "generated source code contents"
}
```

```js
// double check that the generated source code is correct, and assign a quality_score
await translated_progress(`checking generated source code`);
const final_check = await queryLLM(
    `# The user requested the following task
    ${english_user_prompt}
    
    # Please double check the following code we made is correct and fix it if it's not. Also improve anything that may be improve to make it work better. Never use comment placeholders instead of code, and ensure the code is a working solution:\n
    ${schema.source_code}

    # Return the improved code, a quality score from 0 to 10, any npm packages needed to install and any other relevant information for the user.
    `, 
    z.object({
        is_correct: z.boolean().describe('true if the source code is correct, false otherwise'),
        improved_code: z.string().describe('the improved source code if needed'),
        improvements: z.string().describe('any other relevant information for the user'),
        quality_score: z.number().min(0).max(10).describe('a score from 0 to 10 indicating the quality of the generated source code'),
        npm_packages: z.array(z.string()).describe('an array of npm packages needed to install for the code to work, if any'),
        how_to_run: z.string().describe('how to run the code on the terminal, if needed')
    })
);

// save the generated code
await translated_progress(`saving source code`, filename);
await writeFile(filename, final_check.data.improved_code);
// generate a report for the user in markdown format
let report = `
# Source Code Generation Report
The user requested the following task:
${english_user_prompt}

## Understanding of the Task
${understanding_of_the_task}

## Plan Used to Generate the Source Code
${plan.map((item,idx)=>`${idx+1}. ${item}`).join('\n')}

## Quality Score of the Generated Code: ${final_check.data.quality_score}/10
## Source Code Generated as: [${filename}](${filename})

`;
// add required npm libraries to the report if needed
if (final_check.data.npm_packages.length>0) {
    report += `## Required NPM Packages to Install: ${final_check.data.npm_packages.join(', ')}\n`;
}
// add how to run the code to the report if needed
if (final_check.data.how_to_run.trim()!='') {
    report += `## How to Run the Code:\n${final_check.data.how_to_run}\n`;
}

// plan
// answer the results to the user
console.log(''); // clear the progress
log(renderMD(report));
await answer(`The source code has been generated and saved successfully. You can find it at ${filename}.`);
```