const EncryptedJsonDB = require('./db');
const db = new EncryptedJsonDB('translator.json'); // for cache
const { z } = require('zod');
const { translate } = require('@vitalets/google-translate-api');


class Translator {
    constructor(topic, target='en') {
        this.language = target;
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
        const translated = await translate(text, { to: this.language });
        //console.log(`translated (${this.language}): `,translated.text);
        this.cache[this.topic][text][this.language] = translated.text;
        db.save(this.cache);
        return translated.text;
    }
}

module.exports = Translator;