```description
Generates a nodejs script for answering the request of the user. Specialy useful for things like 'how many lines of code does this project have?' or "what's the time complexity of the functions on [file]", etc.
```

```js:pre
let context_ = '';
// ask the LLM if there's a file specified in the user input
//console.log('source_tree', source_tree);
//console.log('english_user_prompt', english_user_prompt);
const file = await queryLLM(
    `# Consider the following sourcetree as the source of truth:
    ${source_tree}

    # Extract the file from the following text if there's one that matches from the sourcetree, or empty if there's none:
    ${english_user_prompt}
    `, 
    z.object({
        file: z.string().describe('the file name'),
    })
);
// read the file and return it as context for the next code block
//log('file', file.data);
if (file.data.file!='') {
    const input_without_file = await queryLLM(
        `The following a user's text request. I need you to extract the action that the user is requesting without trying to reply it and without mentioning any file names: ${english_user_prompt}`
    );
    const write_function = await queryLLM(
        `act as an expert software engineer, expert in nodeJS. Consider the following custom methods are available to you, and you don't have access to 'require':
        async readFile(file_from_sourcetree)-> returns a string
        async writeFile(filename, content)

        # generate and return the contents for a nodejs async function named 'runme' code block that "${input_without_file.data}"" and return it. Name the function 'runme' that accepts a filename and write it as a const assignment:\n`, z.object({
            //function_name: z.string().describe('the nodejs function name'),
            //function_params: z.string().describe('the nodejs function params'),
            code: z.string().describe('the nodejs async runme function code block'),
        })
    )
    //log('input_without_file', input_without_file.data);
    //log('write_function', write_function.data);
    //const test = await executeScript(`log('HELLO FROM DYNAMIC SCRIPT on TEMPLATE')`);
    const test2 = await executeScript(write_function.data.code + `
    return await runme('${file.data.file}');`);
    //log('test2', test2);
    // generate a response to the user considering the response from the nodejs script and initial question asked.
    const llm_answer = await queryLLM(
        `# Consider the following user request:
        ${english_user_prompt}

        # The following is the response from our analysis:
        ${test2}

        # Generate a suitable literal response to the user based on the analysis above.
        # Answer in a friendly tone, using markdown syntax, and in ${language}.
        `,z.object({
            answer: z.string().describe('the answer for the user'),
        })
    );
    progress.stop();
    console.log(renderMD(llm_answer.data.answer));
    // if there is, read the file and use it as context for generating a script
    //context_ = await readFile(file.data.file);
    //log('content of specific file',context_);
} else {
    log('No file specified in the user input; TODO');
}

```