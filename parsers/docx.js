// .docx file default
const Reader = require('./default');
const JSZip = require('jszip');
const xml2js = require('xml2js');
const fs = require('fs').promises;
const path = require('path');

class DocX extends Reader {
    constructor(file) {
        super('docx', file);
    }

    async read() {
        try {

            const data = await fs.readFile(this.file, null);
            const zip = await new JSZip().loadAsync(data);
            if (!zip.file('word/document.xml')) {
                console.error('No document.xml found in the DOCX');
                return null;
            }
            const xmlData = await zip.file('word/document.xml').async('string');
            const parser = new xml2js.Parser();
            const result = await parser.parseStringPromise(xmlData);
            const texts = this.parseDocument(result);
            return this.convertToMarkdown(texts);
        } catch(error) {
            console.error('Failed to extract text:', error);
            return null;
        }
    }

    parseDocument(doc) {
        const paragraphs = doc['w:document']['w:body'][0]['w:p'];
        let texts = [];
        for (let p of paragraphs) {
            let paraText = '';
            let styleId = '';
            if (p['w:pPr'] && p['w:pPr'][0]['w:pStyle']) {
                styleId = p['w:pPr'][0]['w:pStyle'][0]['$']['w:val'];
            }

            if (p['w:r']) {
                for (let r of p['w:r']) {
                    if (r['w:t']) {
                        paraText += r['w:t'][0]['_'] || r['w:t'][0];
                    }
                }
            }

            texts.push({ text: paraText, style: styleId });
        }
        return texts;
    }

    convertToMarkdown(texts) {
        let markdown = texts.map(entry => {
            switch (entry.style) {
                case 'Heading1':
                    return `# ${entry.text}`;
                case 'Heading2':
                    return `## ${entry.text}`;
                case 'Heading3':
                    return `### ${entry.text}`;
                default:
                    return entry.text ? `* ${entry.text}` : '';
            }
        }).join('\n');
        markdown = markdown.replace(/\[object Object\]/g, '');
        markdown = markdown.replace(/(\n\s*\n){2,}/g, '\n\n');
        return markdown;
    }

}

module.exports = DocX;