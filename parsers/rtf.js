// .rtf file reader
const Reader = require('./default');
const rtfParser = require('@bacali/rtf-parser');
const fs = require('fs');
const path = require('path');

class RTF extends Reader {
    constructor(file) {
        super('rtf', file);
    }

    async read() {
        return new Promise((resolve, reject) => {
            const stream = fs.createReadStream(this.file);
            const handleDoc = (err, doc) => {
                if (err) {
                    reject('Failed to parse RTF file: ' + err);
                } else {
                    const text = this.extractTextFromDoc(doc);
                    const markdown = this.convertToMarkdown(text);
                    resolve(markdown);
                }
            };
            rtfParser.parseStream(stream, handleDoc);
        });
    }

    extractTextFromDoc(doc) {
        let text = '';
        if (doc.content) {
            doc.content.forEach(paragraph => {
                if (paragraph.content && paragraph.content.length > 0) {
                    paragraph.content.forEach(span => {
                        if (span.value) {
                            text += span.value + ' ';
                        }
                    });
                }
                text += '\n'; // Add a new line at the end of each paragraph for better separation
            });
        }
        return text.trim();
    }    

    convertToMarkdown(text) {
        return text.split('\n').map(line => line.trim()).join('\n\n');
    }

}

module.exports = RTF;