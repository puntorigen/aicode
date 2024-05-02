```description
Creates a summary for a project or folder.
```

Project Path: {{ absolute_code_path }}

Write a summary for what this folder files are about in an easy to understand way, indicanting all relevant information as if it was going to be used for writing a tutorial, but without saying that. Always answer in {{ language }}.

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

{{#if personality}}
Use the following writting rules:
{{personality}}
{{/if}}

```json:schema
{
    "summary": "summary text for the project"
}
```

```js
log(schema.summary, '', 'cyan')
```