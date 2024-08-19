```description
Creates and renders a diagram on the console.
```

```js:pre
await setModelPreferences(["OPENAI","ANTHROPIC","GROQ"]);
const asciiDiagramContextPrompt = `
# Introduction to Creating ASCII Console Diagrams from Text Descriptions

This guide will help you understand how to generate ASCII art diagrams directly in the console based on text descriptions. ASCII diagrams are a simple and effective way to visually represent information, such as flowcharts, organizational structures, or other diagram types, using plain text characters.

## Basic ASCII Elements:
- **Boxes**: Represent nodes or steps in a process.
  - Example: \`┌───────┐\`, \`│ Box  │\`, \`└───────┘\`
- **Arrows**: Indicate direction or flow between boxes.
  - Example: \`───▶\` (horizontal arrow), \`▼\` (downward arrow)
- **Lines**: Connect boxes vertically or horizontally.
  - Example: \`│\` (vertical line), \`───\` (horizontal line)
- **Branches**: Split flow into different paths, often used in decision points.
  - Example: \`├──\` (branching line)

## Guidelines for Creating Diagrams

1. **Identify Key Components**: Determine the key elements in the diagram, such as start points, steps, decisions, and endpoints.
2. **Arrange Elements**: Position the elements in a way that clearly shows the flow or structure. Use boxes for nodes, arrows for direction, and lines for connections.
3. **Handle Branching**: Use branching lines and labels to represent decisions or multiple paths.
4. **Use Spacing**: Insert spaces between elements to ensure the diagram is clear and readable.

## Example 1: Simple Vertical Flowchart

Given the text description "Create a vertical flowchart with steps: Start, Process, Decision, End":

### Generated Diagram:
\`\`\`
┌───────┐
│ Start │
└───────┘
    │
    ▼
┌─────────┐
│ Process │
└─────────┘
    │
    ▼
┌──────────┐
│ Decision │
└──────────┘
    │
    ▼
┌─────┐
│ End │
└─────┘
\`\`\`

## Example 2: Horizontal Flowchart with Branching

Given the text description "Create a left-to-right flowchart with steps: Start, Process, Decision branching to Yes (leads to Success) and No (leads to Failure)":

### Generated Diagram:
\`\`\`
┌───────┐    ┌────────┐    ┌──────────┐
│ Start │───▶│ Process │───▶│ Decision │
└───────┘    └────────┘    └──────────┘
                             │
                        yes  ▼  no
                        ┌─────┐    ┌───────┐
                        │Success│  │Failure│
                        └─────┘    └───────┘
\`\`\`

## Example 3: Organizational Chart

Given the text description "Create an organizational chart with a CEO at the top, two Managers below, each with two Employees":

### Generated Diagram:
\`\`\`
      ┌─────┐
      │ CEO │
      └─────┘
       /   \\
      /     \\
┌────────┐  ┌────────┐
│Manager1│  │Manager2│
└────────┘  └────────┘
    /  \\        /  \\
┌────┐ ┌────┐  ┌────┐ ┌────┐
│Emp1│ │Emp2│  │Emp3│ │Emp4│
└────┘ └────┘  └────┘ └────┘
\`\`\`

## Additional Tips:
- **Loopbacks**: To represent loops or iterative processes, use a combination of arrows and lines to connect elements back to previous steps.
- **Complex Structures**: For more complex diagrams, break down the text description into smaller, manageable sections and create the diagram piece by piece.
- **Labeling**: Use text labels on arrows or near branches to indicate conditions or decisions.

## Request Handling Example:

When asked to generate a specific type of diagram based on a text description, follow the guidelines and examples above to create the ASCII diagram accurately.

### Example Requests

1. **Request**: "Create a vertical flowchart with three steps: Initialize, Process, Terminate."
   - **Generated Diagram**:
   \`\`\`
   ┌───────────┐
   │Initialize │
   └───────────┘
       │
       ▼
   ┌─────────┐
   │ Process │
   └─────────┘
       │
       ▼
   ┌──────────┐
   │Terminate │
   └──────────┘
   \`\`\`

2. **Request**: "Create a horizontal flowchart with two steps: Input leading to Output."
   - **Generated Diagram**:
   \`\`\`
   ┌───────┐    ┌───────┐
   │ Input │───▶│Output │
   └───────┘    └───────┘
   \`\`\`
`;
// what kind of files should I read from this project source to generate the SpecLang file?
const files_ = await queryLLM(asciiDiagramContextPrompt+'What are the main files we need from the sourcetree to generate a diagram about the files on this project?\n'+source_tree, 
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
    asciiDiagramContextPrompt
}
```

```js:pre
//log('SECOND JS BLOCK');
//log('files2', files);
```
{{ asciiDiagramContextPrompt }}
# The following is the codebase we need to understand and use as source for generating an accurate description for a diagram flow about this codebase:

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

Start by analyzing the sourcetree organization and the contents of each file, and generate a summary of it focusing on the flow of information and how the important elements of the folder and contents are organized and related to each other.

Feel free to infer reasonable details if needed, but try to stick to what can be determined from the contents themselfs, always avoiding replying there's something missing. Return only the diagram flow description and as accurate as posible. An engineer will then take this diagram description and build an ASCII diagram from it, so be as precise as posible and double check your response is right.

```json:schema
{
    "description_diagram_flow": "Textual description about the flow of information, for generating later an ASCII diagram"
}
```

```js
// ai=true when running this code block from AI, false when manually running it
const ascii_prompt = `Generate just the ASCII diagram to be rendered to the user's console and nothing else. Use your analysis of the files and their contents, to provide a meaninful diagram structure and flow, and generate accurate and precise diagrams, with clear and easy to understand labels.

ASCII diagram to be rendered to the user and nothing else. Ensure the labels are always inside the boxes and everything is aligned.`;

if (ai) {
    // use the schema.description_diagram_flow for generating an ASCII diagram on the console
    const prompt_ = `${asciiDiagramContextPrompt}

    # ${ascii_prompt}

    # Also use the following codebase file's content for reference: 
    \`\`\`files contents
    ${JSON.stringify(files)}
    \`\`\`

    # Transform the following textual diagram description into an ASCII diagram for displaying it on the console, given the above teachings.
    \`\`\`textual_diagram:
    ${schema.description_diagram_flow}
    \`\`\`

    # return only the ASCII diagram, using boxes with labels, arrows and descriptions, and nothing else. Be sure to return a DIAGRAM and only an ASCII diagram that can be rendered on the console.
    `;
    //log('Prompt for diagram',prompt_);
    const request_diagram = await queryLLM(prompt_, 
        z.object({
            diagram: z.string().describe('ASCII diagram to render on the console'),
        })
    );
    //const output_ = renderMD(schema.ascii_diagram);
    progress.stop();
    console.log('\n\n'+request_diagram.data.diagram);
    //await writeFile(`${absolute_code_path}/speclang.md`, schema.speclang);
    //log('speclang.md saved!');
}
// if you return an object here, it will be available for the next code block
```

```bash
# commands to run after the previous nodejs code block
```
