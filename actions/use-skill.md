```description
Runs an installed Agent Skill (a SKILL.md from skills.sh / .agents/skills) to fulfill the user's request. Chosen when the user asks to use a specific skill, or when an installed skill's description matches the request better than any other action.
```

```js:pre
// pull the skill selected by the router (loaded with its full instructions)
const skill = getSelectedSkill ? getSelectedSkill() : null;
if (!skill) {
    debug('use-skill: no skill selected');
    return { skill_name: '', skill_dir: '', skill_instructions: '', skill_files: '' };
}
return {
    skill_name: skill.name,
    skill_dir: skill.dir,
    skill_instructions: skill.body,
    skill_files: (skill.files || []).join('\n'),
};
```

Project Path: {{ absolute_code_path }}

{{#if skill_name}}
You are executing the Agent Skill **{{ skill_name }}** to fulfill the user's request. Follow the skill's instructions below precisely. Adapt them to this project and the user's request. Prefer concrete, actionable output: when the skill says to create or modify files, return their full contents in `files_to_write`; when it says to run commands or scripts, return them in `commands` (they run from the project root and may reference the skill's bundled files by absolute path).

The skill is installed at: `{{ skill_dir }}`
{{#if skill_files}}
Bundled files available to the skill (paths relative to the skill directory — prefix with the skill directory above to reference them):
```
{{ skill_files }}
```
{{/if}}

# Skill instructions ({{ skill_name }}):

{{{ skill_instructions }}}
{{else}}
No matching installed skill was found for this request. Briefly explain to the user that no skill matched and suggest they install one with `aicode --install-skill <owner/repo>` or `npx skills add <owner/repo>`.
{{/if}}

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
# Always write the `answer` in {{ language }}.
{{/if}}
# User request: {{ english_user_prompt }}

```json:schema
{
    "answer": "concise markdown summary of what the skill produced or the steps taken, written in the user's language",
    "files_to_write": [
        { "path": "relative path of a file to create or overwrite in the project", "content": "the full contents of the file" }
    ],
    "commands": [
        { "command": "a single shell command to run from the project root to carry out the skill", "reason": "why this command is needed" }
    ]
}
```

```js
// runs after the LLM responds. ai=true when invoked by the assistant.
if (ai && schema) {
    // 1) create/overwrite any files the skill produced (diff preview + confirm gate)
    if (Array.isArray(schema.files_to_write)) {
        for (const f of schema.files_to_write) {
            if (f && f.path && typeof f.content === 'string' && f.content.length > 0) {
                await writeFile(f.path, f.content);
            }
        }
    }
    // 2) run any commands the skill needs (confirm-gated via --confirm)
    if (Array.isArray(schema.commands)) {
        for (const c of schema.commands) {
            if (!c || !c.command) continue;
            log('running: #' + String(c.command).split('\n')[0] + '#' + (c.reason ? '  — ' + c.reason : ''), '', 'cyan');
            const res = await executeBash(c.command);
            if (res && res.output) log(res.output);
            if (res && res.error) log(res.error, '', 'yellow');
        }
    }
    // 3) show the summary
    if (schema.answer) log(renderMD(schema.answer), '', 'cyan');
}
```
