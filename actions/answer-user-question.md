```description
Tries to answer the user's question related to the project or specific type of files.
```

Project Path: {{ absolute_code_path }}

Analyze the following source_tree and files contents to understand what the user is asking. Ensure your answers are always in '{{ language }}'.

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

{{#if language}}
# Always answer in {{ language }}.
{{/if}}
# user question: {{ english_user_prompt }}

```json:schema
{
    "answer": "detailed answer to the user's question in a friendly tone and using markdown syntax."
}
```

```js
log(renderMD(schema.answer), '', 'cyan')
```