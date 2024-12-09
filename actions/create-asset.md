```description
Creates or generates an image/video asset within the folder
```

```js:pre
await setModelPreferences(["OPENAI","ANTHROPIC","GROQ"]);
// 1. detect type,size,output_format to generate from 'user_prompt'
progress.text(`*Detecting required asset type and specs ...*`);
const analysis_prompt = `# The user seems to be requesting us to generate a kind of asset. Please try to determine from the following prompt, the type of asset (image, illustration or video), the resolution required (e.g. width:640, height:480, or empty if not found), the output_format (e.g. jpg, png, mp4), and the cleaned topic request (e.g. a dog jumping on a field):
"${user_prompt}" 
`;
const analysis_ = await queryLLM(analysis_prompt, 
    z.object({
        type: z.enum(["image","illustration","video","other"]).describe(`the type of requested asset to generate; choose illustration if it's a drawing, cartoon or illustration image`),
        resolution: z.object({
            width: z.number().describe('the asset resolution width'),
            height: z.number().describe('the asset resolution height'),
        }).describe('the asset resolution'),
        filename: z.string().describe('the output filename with extension'),
        output_format: z.enum(["jpg","png","mp4","none"]).describe('the asset output format'),
        cleaned_topic: z.string().describe("cleaned topic request in english")
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

# can you determine the best output filename (with extension) and location for this new asset? Use the naming conventions from the source tree if possible.

# if the user didn't specify a location reference for the file, use the current folder as the default location.
`;
const file_ = await queryLLM(file_prompt, 
    z.object({
        filename: z.string().describe('the output filename with extension'),
        location: z.string().describe('the output location within the source tree')
    })
);

progress.text(`*Generating* #${analysis_.data.output_format.toUpperCase()}# *image* #${analysis_.data.resolution.width}x${analysis_.data.resolution.height}# *...*`);
// generate an image; TODO add support for video
let image = await replicate_models['create-image']({
    prompt: analysis_.data.cleaned_topic,
});
if (image.raw.length==0) {
    // TODO handle error retrying with a different approach
    throw new Error('Failed to generate image');
} else {
    // download image, scale it to the required resolution, and save it to the output location
    // outputdir: location + filename Path join
    debug('image',image.raw[0]);
    const output_ = joinPaths(file_.data.location,file_.data.filename)
    debug('saving as:',output_);
    await downloadFile(image.raw[0], output_);
    log(`Image saved as: ${output_}`, '', 'green');
    //progress.text(`*Filed save as: ${output_} ...*`);
}


return {
    specs: analysis_.data,
    generated_image: image.raw[0],
    //related_files: filtered,
    source_tree
}
// 4. generate image using Flux
// 4.2. if it's video, generate a sequence of image descriptions:
// - generate them with flux, then animate them using j2vgen-xl
```

```python
#print('received context into python:',globals().keys())
#require installs a python package
require("qrcode-term")
from qrcode_term import qrcode_string

#picture = qrcode_string(generated_image)
picture = qrcode_string("Hello from AI Code")
print("Scan the QR to see the generated image")
print(picture)
#print(f"checking spects from JS (python)", specs)
#print(f"Testing python code execution block")
return {
    "from_python": True
}
```

```js
// 18-aug-24: work in progress
log('JS reading the python return:',from_python);
```