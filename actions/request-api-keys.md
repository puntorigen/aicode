```description
Execute this if the user is requesting to configure the API keys that are not of the current project
```

```js:validate
// return false if the user_prompt is not valid for this template
```

```js:pre
// {language} is the language of the user
progress.stop();
const keys = db.load('keys.json');
const old_ = JSON.parse(JSON.stringify(keys));
keys.OPENAI_KEY = await ask('Enter your OPENAI API key (or empty if none):');
keys.GROQ_KEY = await ask('Enter your GROQ API key (or empty if none):');
keys.ANTHROPIC_KEY = await ask('Enter your ANTHROPIC API key (or empty if none):');
keys.REPLICATE_API_TOKEN = await ask('Enter your REPLICATE API key (or empty if none):');
if (keys.OPENAI_KEY=='') keys.OPENAI_KEY = old_.OPENAI_KEY;
if (keys.GROQ_KEY=='') keys.GROQ_KEY = old_.GROQ_KEY;
if (keys.ANTHROPIC_KEY=='') keys.ANTHROPIC_KEY = old_.ANTHROPIC_KEY;
if (keys.REPLICATE_API_TOKEN=='') keys.REPLICATE_API_TOKEN = old_.REPLICATE_API_TOKEN;
db.save('keys.json',keys);
await answer('API keys configured successfully');    
```