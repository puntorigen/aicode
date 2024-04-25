```description
Creates a presentation using revelo npm. Posible example requests:
- Create a presentation
- Show a presentation
- Create and save a presentation as presentation.mp4
- Create a presentation about document1.doc
- Create a presentation about document1.doc and save it as presentation.mp4
- Create a 5 slides presentation about document1.doc and save it as presentation.gif
```

```js:pre
// read npm revelo pkg for readme context
progress.stop();
//// generate summary
const files_ = await queryLLM('What are the main files we need from the sourcetree to generate a README of this project?\n'+source_tree, 
    z.array(z.string()).describe('filenames to read from the given source tree')
);
log('reading files:',files_.data);
let files__ = '';
let filtered = [];
files = files.map((item)=>{ // original folder files array
    files_.data.some((file)=>{ // filtered files array
        if (item.path.includes(file)){
            // also truncate the files to 1000 chars or what's left of files__ max 5000 words
            const total_words_sofar = files__.split(' ').length;
            console.log('words so far:'+total_words_sofar);
            if (total_words_sofar>5000) {
                item.code = "-- TRUNCATED --: request for this file if you need it ...";
                files__ += `${item.path}:\n${item.code}\n\n`;
                filtered.push(item);
                return true;
            }
            item.code = item.code.substring(0, 1000);
            files__ += `${item.path}:\n${item.code}\n\n`;
            filtered.push(item);
            return true;
        }
    });
});
// rebuild source_tree using filtered files
source_tree = stringifyTreeFromPaths(files_.data);
//console.log('new source_tree',source_tree);

const summary_prompt = await queryLLM(
    `# Project Path: ${absolute_code_path}

Act as an expert in code analysis and documentation and generate a high-quality markdown README file for this project or folder. 
Analyze the following files in detail to first understand their purpose, functionality and contents, if it's a CLI, library, class, program or documentation, then check if there're usage examples within the code or other files, and use that information to generate your response. 

Source Tree:
${source_tree}

${files__}

The README should include the following sections:

1. Project Title
2. Brief description (1-2 sentences)
3. Features
4. Some usage examples

Write the content in Markdown format. Use your analysis of the code to generate accurate and helpful content, but also explain things clearly for users who may not be familiar with the implementation details.

Feel free to infer reasonable details if needed, but try to stick to what can be determined from the codebase itself always avoiding replying there's something missing.
    `, z.object({
        summary: z.string().describe('the summary of the project'),
        files: z.array(z.string()).describe('array of files for which you need more info if any'),
    })
);
const summary_ = summary_prompt.data.summary;
log('summary_',summary_prompt.data);
////
////
let info = {};
const revelo_readme = await getNpmReadme('revelo');
const initial_analysis = await queryLLM(
    `# Act as an expert text analyst.

    # Given the following source_tree for matching a source_file if needed:
    ${source_tree}

    # And the following summary for context:
    ${summary_}

    # Analyze the following user text request and provide a summary analysis:
    ${user_prompt}
    `, 
    z.object({
        action: z.enum(["create","show","save"]).describe('action to take'),
        presentation_type: z.enum(["business","tutorial","marketing"]).describe('the type of presentation to create'),
        save_file: z.string().describe('the file name to create, if any or empty'),
        source_file: z.string().describe('the exact referenced filename in the user request on the source_tree, if any or empty'),
        slides: z.number().optional().describe('the number of slides to create if any or zero'),
        recommended_slides: z.number().optional().describe('the number of slides recommended to create'),
        //recommended_reason: z.string().optional().describe('the reason for the recommended number of slides'),
        tone: z.enum(["friendly","formal"]).describe('the tone for the presentation, if any or empty')
    })
);
// create a summary of the project files
if (initial_analysis.data.slides==0) {
    initial_analysis.data.slides = 5;
}
info = {...info, ...initial_analysis.data};
info.summary = summary_;

//info.summary = summary.data;
//log('revelo_readme',revelo_readme);
//log('initial_analysis',initial_analysis);
// estimate the number of slides needed for the presentation
// create a presentation with the slides as an array of objects
let slides = [];
info.topic = (await queryLLM(
    `# Act as an expert text analyst. Determine the main topic for the following text:
    ${info.summary}
    `, z.object({
        topic: z.enum(["software engineering","documentation","real state","finance","marketing"]).describe('the main topic of the text')
    })
)).data.topic;
const create_ = await queryLLM(
    `# Act as an experienced writer, expert in ${info.topic} and at creating impactful and ${info.tone} presentations.

    # Consider the following text as context for creating the presentation slides:
    ${info.summary}

    # Consider the presentation as a narrative with a beginning, introduction, impactful middle, a couple of examples and a meaninful conclusion.
    # Always generate the slides texts in ${language} language. Use a ${info.tone} tone.
    # For each of the ${info.slides} slides, create a title, content as bullet points, amount of time in ms for showing slide, and supporting background image keywords and background color:
    `, 
    z.object({
        slides: z.array(z.object({
            title: z.string().describe('the title of the slide, without :'),
            content: z.array(z.string()).describe('the content bullet points of the slide, you may use emoji\'s'),
            background_color: z.enum(["white","green","blue","black","magenta"]).describe('the background color of the slide'),
            amount_of_time: z.number().describe('the amount of time in ms for showing the slide'),
            background_image_keyword: z.enum(["neutral","happy people","nature","forrest","github","ai","programming","diagrams","peace","sky"]).describe('the keywords for a supporting background image, like: happy people, nature, business, ocean, etc.'),
        })).describe('the slides to create')
    })
);
info.created = create_.data.slides;
// create revelo markdown from the slides
info.revelo = info.created.map((slide, index, array) => {
    const slideContent = slide.content.map((item) => `- ${item.replace('`',"'")}`).join('\n');
    const time_ = (slide.amount_of_time==0) ? 1500 : slide.amount_of_time/slide.content.length;
return `## ${slide.title.replace('`',"'")}
:::{incremental}
${slideContent.replace('`',"'")}
:::
->background-color[${slide.background_color}]
->background[${slide.background_image_keyword},0.4]
->wait[${time_}]
${index < array.length - 1 ? '\n---\n' : ''}`; // Add '---' if it's not the last item
});
log('info',info)
// save markdown to tmp disk
await writeFile('presentation.md',info.revelo.join('\n'));
// if action=create and save_file is not empty, render to disk
// if action=show, serve the generated file (npx revelo server)
// launch respective bash action
// save to disk if needed (if ext not .mp4 or .gif, save revelo string to file)
return {
    info
}
```

```bash
# render
```