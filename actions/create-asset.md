```description
Creates or generates an image/video asset within the folder
```

```js:pre
await setModelPreferences(["OPENAI","ANTHROPIC","GROQ"]);
// 1. detect type,size,output_format to generate from 'user_prompt'
progress.text(`*Detecting required asset type and specs ...*`);
const analysis_prompt = `# The user seems to be requesting us to generate a kind of asset. Please try to determine from the following prompt, the type of asset (image or video), the resolution required (e.g. width:640, height:480, or empty if not found), the output_format (e.g. jpg, png, mp4), and the cleaned topic request (e.g. a dog jumping on a field):
"${user_prompt}" 
`;
const analysis_ = await queryLLM(analysis_prompt, 
    z.object({
        type: z.enum(["image","video","other"]).describe('the type of requested asset to generate'),
        resolution: z.object({
            width: z.number().describe('the asset resolution width'),
            height: z.number().describe('the asset resolution height'),
        }).describe('the asset resolution'),
        output_format: z.enum(["jpg","png","mp4","none"]).describe('the asset output format'),
        cleaned_topic: z.string().describe("cleaned topic request")
    })
);
log('analysis_',analysis_.data);
// 1.5. check if we can determine the output filename and location from prompt, and also using the sourcetree we have.
progress.text(`*Determining output filename and best location ...*`);
const file_prompt = `# given the following user task:
'${user_prompt}'

# and the already known specs:
${JSON.stringify(analysis_.data)}

# and the following source tree:
${source_tree}

# can you determine the output filename (with extension) and location for this new asset? Use the naming conventions from the source tree if possible.
`;
const file_ = await queryLLM(file_prompt, 
    z.object({
        filename: z.string().describe('the output filename with extension'),
        location: z.string().describe('the output location within the source tree')
    })
);
log('file_',file_.data);
// 2. check if the cleaned_topic is related somehow to some file within the source_tree or not
const related_prompt = `# given the following task:
"${analysis_.data.cleaned_topic}"
# check if it is related to one or more files from the following source tree:
${source_tree}
# return which files should we read to perform the requested task, or none if there's no need.
`;
const related_ = await queryLLM(related_prompt, 
    z.array(z.string()).describe('filenames to read from the given source tree')
);
log('related_',related_.data);
// 3. find a suitable output filename and best location for it within the source_tree
let filtered = [];
if (related_.data && related_.data.length>0) {
    progress.text(`*Reading related files ...*`);
    //log('reading files:',files_.data);
    let files__ = '';
    files = files.map((item)=>{ // original folder files array
        related_.data.some((file)=>{ // filtered files array
            if (item.path.includes(file)){
                // also truncate the files to 1000 chars or what's left of files__ max 5000 words
                const total_words_sofar = files__.split(' ').length;
                //console.log('words so far:'+total_words_sofar);
                if (total_words_sofar>5000) {
                    item.code = "-- TRUNCATED --: request for this file if you need it ...";
                    files__ += `### ${item.path}:\n"${item.code}"\n\n`;
                    filtered.push(item);
                    return true;
                }
                item.code = item.code.substring(0, 1000);
                files__ += `### ${item.path}:\n"${item.code}"\n\n`;
                filtered.push(item);
                return true;
            }
        });
    });
    // rebuild source_tree using filtered files
    source_tree = stringifyTreeFromPaths(related_.data);
    log('new source_tree and files',{ source_tree,filtered })
}

return {
    specs: analysis_.data,
    related_files: filtered,
    source_tree
}
// 4. generate image using Flux
// 4.2. if it's video, generate a sequence of image descriptions:
// - generate them with flux, then animate them using j2vgen-xl
```

```json:schema
{
    "summary": "summary text for the project"
}
```

```js
// 18-aug-24: work in progress
//log(schema.summary, '', 'cyan')
```