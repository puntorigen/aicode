```description
Creates a summary for a project.
```

Project Path: {{ absolute_code_path }}

Write a summary for what this project is about so an LLM can understand it to use it as context when writing a tutorial

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

```json:schema
{
    "summary": "summary text for the project"
}
```

```js
log(schema.summary, '', 'cyan')
```