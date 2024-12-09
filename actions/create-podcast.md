```description
Creates and generates podcast audio file using the folder as context
```

```js:pre
await setModelPreferences(["OPENAI","ANTHROPIC","GROQ"]);
progress.text(`*Determining which files are useful ...*`);
//// generate comprensive summary from the files
const files_ = await queryLLM(`What are the main files we need from the following sourcetree to generate a comprensive summary story about this folder:
${source_tree}

# take into account the "original user request" as well for this:
'${english_user_prompt}'

# if the "original user request" specifies queries such as related to databases or models, include the definitions for those kind of files as well.

# if the "original user request" includes a specific file that exists on the sourcetree, be sure to include it or just to return that file. 
`, 
    z.array(z.string()).describe('filenames to read from the given source tree')
);
//log('reading files:',files_.data);
let files__ = '';
let filtered = [];
files = files.map((item)=>{ // original folder files array
    files_.data.some((file)=>{ // filtered files array
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
source_tree = stringifyTreeFromPaths(files_.data);
files = filtered;
debug('filtered files:',source_tree);

// determine the project folder name, suitable for a podcast show, as well as a summary of what the folder project contains, based on the files, besides the techtack and frameworks used. Also if the user prompt indicates the output filename for the podcast, capture it as well.
progress.text(`*Determining the best podcast name, summary and output file ...*`);
const prepare_podcast = await queryLLM(`
#Considering the following files contents of the current user folder:
---
${filtered.map((item)=>`### ${item.path}:\n"${item.code}"\n\n`).join('')}
---
# Determine the project's most probable name, avoiding using framework's names or common tools, suitable for a podcast show, and also provide a summary of what the project contains, besides the techtack and frameworks used.

# Also based on the following 'original user prompt', determine if it includes the output filename for the podcast show (with .mp3 extension): "${english_user_prompt}"
`,z.object({
    podcast_name: z.string().describe('the name of the podcast show based on the most probable project name ending with Talks'),
    project_summary: z.string().describe('summary of the project folder contents, focusing on what are the features and marketing pitch rather than the tech stack and frameworks used'),
    output_filename: z.string().optional().describe('output filename for the podcast show')
}));
debug('prepare_podcast',prepare_podcast.data);

//// determine the type of folder contents
/*
const analysis_ = await queryLLM('Considering the following source tree of a user folder, determine the category of the overall folder:\n'+source_tree, 
    z.object({
        kind_of_files: z.enum(["documentation","images","videos","frontend","fullstack","backend","finance","infrastructure"]).describe('category of the project folder suitable for a narration from the given source tree')
    })
);
debug('analysis_',analysis_.data);
*/
progress.text(`*Preparing podcast dialog ...*`);
let prompt = `
# Write an english podcast dialog using this folder files as context, considering the user prompt as the main guide for the podcast. The podcast should have a host and 2 participants, a male and a female. The host should introduce the topic and interact with the participants, who should provide insights and comments about the topic. The podcast should be engaging and informative. Start with an introduction with the host, then introduce the participants, and then start the conversation. The podcast should last around 5 minutes long. Always answer in english.

# Use the following podcast name: ${prepare_podcast.data.podcast_name}
# Also use the following project summary as a guide for the content to be created:
"${prepare_podcast.data.project_summary}"

# Consider the following user prompt, as a guide for the content to be created: 
"${english_user_prompt}"

# Return an array of objects, as the following example:
[
    { 
        "speaker": "male1",
        "text": "Welcome to the podcast!",
        "channel": "both"
    },
    { 
        "speaker": "female2",
        "text": "Today, we'll discuss AI advancements.",
        "channel": "left"
    },
    { 
        "speaker": "male2",
        "text": "Welcome to the podcast!",
        "channel": "right"
    }
]

# In the above example, male1 is the host, female2 is the first participant and male is the second participant. The "both" value means the speaker is in the center, "left" means the speaker is on the left, and "right" means the speaker is on the right. Using this format, write as many items as necesary for the podcast dialog using the following files as context:

${filtered.map((item)=>`### ${item.path}:\n"${item.code}"\n\n`).join('')}

# For the content, focus on what's unique about the folder files, not about the common frameworks such as react, vue, angular, next, python, node, etc. Assume the listener is a software engineer and is familiar with the common frameworks and tools.

# When assigning names to the speakers try to use gender neutral names, or names that are common in the US. Avoid names that are difficult to pronounce or are uncommon in the english language.
`;

const story_ = await queryLLM(prompt, 
    z.array(
        z.object({
            speaker: z.enum(["male1","female2","male2"]).describe('participant to talk'),
            text: z.string().describe('text to say'),
            channel: z.enum(["both","left","right"]).describe('channel to speak on; left for first participan, right for second, both for host')
        })
    ).describe('podcast dialog')
);

log('podcast dialog',story_.data);

const story_dialog = story_.data.map((item)=>{
    return {
        [item.speaker]: [item.text, item.channel]
    }
});
debug('story_dialog',story_dialog);
progress.text(`*Generating podcast audio file ...* #please wait ...#`);
podcast_output_mp3 = joinPaths(userDirectory,prepare_podcast.data.output_filename);

return {
    files: filtered,
    story: story_.data,
    story_dialog,
    source_tree,
    podcast_output_mp3
}
```

```python
#print('received context into python:',globals().keys())
#require installs a python package
require("podcast_tts")
from podcast_tts import PodcastTTS

tts = PodcastTTS(speed=5)
music_config = ["https://github.com/puntorigen/podcast_tts/raw/refs/heads/main/music1.mp3", 12, 3, 0.2]

with silence() as podcast:
    output_file = await tts.generate_podcast(
        texts=story_dialog,
        music=music_config,
        filename=podcast_output_mp3,
        pause_duration=0.5,
        normalize=True
    )
print(f"Podcast saved to: {output_file}")
return {
    "from_python": True,
    "podcast_console": str(podcast),
    "podcast_output_mp3": output_file
}
```

```js
log('Podcast saved to:',podcast_output_mp3);
// 8-dic-24: work in progress
/*try {
    log('python captured output',python_stdout,python_stderr);
} catch(e) {
}*/
debug('Captured python output',podcast_console)
```