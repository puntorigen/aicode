```description
Execute this if the user is requesting to configure the API keys that are not of the current project
```

```js:validate
// return false if the user_prompt is not for this template
```

```js:pre
// {language} is the language of the user
progress.stop();
const keys = db.load('keys.json');
const old_ = JSON.parse(JSON.stringify(keys));
keys.OPENAI_KEY = await ask('Enter your OPENAI API key (or empty if none):');
keys.GROQ_KEY = await ask('Enter your GROQ API key (or empty if none):');
if (keys.OPENAI_KEY=='') keys.OPENAI_KEY = old_.OPENAI_KEY;
if (keys.GROQ_KEY=='') keys.GROQ_KEY = old_.GROQ_KEY;
db.save('keys.json',keys);
await answer('API keys configured successfully');    
```