// .pdf file reader
const Reader = require('./default');
const pdfParse = require('pdf-parse');
const fs = require('fs').promises;
const path = require('path');

class PDF extends Reader {
    constructor(file) {
        super('pdf', file);
    }

    async read() {
        try {
            // silence pdf-parse warnings
            const originalConsoleLog = console.log; 
            console.log = () => {};
            // Read the PDF file and parse its contents
            const dataBuffer = await fs.readFile(this.file);
            const data = await pdfParse(dataBuffer);
            // restore console.log
            console.log = originalConsoleLog;
            // Extract the metadata and text content
            const metadataMarkdown = await this.extractMetadataAsMarkdown(data.metadata);
            const textMarkdown = this.convertToMarkdown(data.text);
            return `${metadataMarkdown}\n\n${textMarkdown}`;
        } catch (error) {
            console.error('Failed to read the PDF file:', error);
            return null;
        }
    }

    convertToMarkdown(text) {
        // Simple conversion to Markdown (e.g., wrap lines in Markdown paragraphs)
        return text
            .split('\n')
            .filter(line => line.trim() !== '')
            .map(line => line.trim())
            .join('\n\n');  // Double newline for Markdown paragraph separation
    }

    async extractMetadataAsMarkdown(metadata) {
        // Format the metadata into a Markdown section
        let metadataMarkdown = '## PDF Metadata\n';
        if (metadata) {
            for (const [key, value] of Object.entries(metadata)) {
                metadataMarkdown += `**${key.charAt(0).toUpperCase() + key.slice(1)}**: ${value}\n`;
            }
        } else {
            metadataMarkdown += 'No metadata available.';
        }
        return metadataMarkdown;
    }
    
}

module.exports = PDF;