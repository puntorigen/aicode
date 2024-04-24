const EncryptedJsonDB = require('./db');
const db = new EncryptedJsonDB('translator.json'); // for cache
const { z } = require('zod');

class Translator {
    constructor(topic, user_language='English', queryLLM) {
        this.queryLLM = queryLLM;
        this.language = user_language;
        this.topic = topic; // group
        this.cache = db.load();
        if (!this.cache[this.topic]) this.cache[this.topic] = {};
    }
    
    async t(text) {
        return await this.translate(text);
    }

    async translate(text) {
        // check cache
        if (!this.cache[this.topic][text]) this.cache[this.topic][text] = {};
        if (this.cache[this.topic][text] && this.cache[this.topic][text][this.language]) {
            return this.cache[this.topic][text][this.language];
        }
        // translate
        const translated = await this.queryLLM(`Translate the following text: ${text}`,
            z.object({
                [this.language]: z.string().describe(this.language+' version of text'),
            })
        );
        console.log('translated',translated);
        this.cache[this.topic][text][this.language] = translated.data[this.language];
        db.save(this.cache);
        return translated.data[this.language];
    }

    async setupFetchPolyfill() {
        if (!globalThis.fetch) {
          const fetch = (await import('node-fetch')).default;
          globalThis.fetch = fetch;
          globalThis.Request = fetch.Request;
          globalThis.Response = fetch.Response;
          globalThis.Headers = fetch.Headers;
        }
    }
}

module.exports = Translator;