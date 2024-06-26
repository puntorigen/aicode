```description
Creates a reactJS webapp project.
```

```js:pre 
// javascript code to run on project before executing the template prompt
// contains a 'context' object with the keys:
//  'input' = user input text prompt
// if you want, you may return an object to make the values available for the next code-block or template
// this codeblock gets executed isolated within an async function
// you can also use any of the variables available on the handlebar template such as source_tree, absolute_code_path, etc
// you also have some methods for asking info to the user like (await prompt)
// anything queried to the user is translated to the user's language using the LLM
const project_name = await prompt('What is the name of your project?')
const app_name = await queryLLM('Create a short but meaningful folder name (between 8-12 chars, dash-case, lowercase) extracted from the following text: ' + project_name, 
    z.object({
        name: z.string().describe('the reactjs folder name for the text'),
    })
);
return {
    app_name: app_name.data.name
}
```

```bash:pre
# terminal commands to run on project before executing the template prompt
# if OS is different than MacOS we could ask the LLM for translating them to another OS later before execution
# any bash here executes with the env CI=true so it won't prompt the user for anything
# you may use context vars as {context.x} to replace with the variable value 
# e.g. {context.input} will be replaced with the user input
npx create-react-app {context.app_name} --template typescript --use-npm
```
