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
            const originalConsoleLog = console.log; 
            console.log = () => {};
    
            const dataBuffer = await fs.readFile(this.file);
            const data = await pdfParse(dataBuffer);
    
            // restore console.log
            console.log = originalConsoleLog;
    
            // Use data.info for stable metadata instead
            const metadataMarkdown = await this.extractMetadataAsMarkdown(data.info);
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
        
        // If no metadata, bail out early
        if (!metadata) {
            metadataMarkdown += 'No metadata available.';
            return metadataMarkdown;
        }
    
        try {
            // Try treating metadata as a plain object first
            const entries = Object.entries(metadata);
            
            if (entries.length === 0) {
                // No entries or metadata might not be a plain object
                metadataMarkdown += 'No metadata available.';
                return metadataMarkdown;
            }
    
            for (const [key, value] of entries) {
                // Ensure both key and value are strings before concatenation
                const stringKey = String(key);
                const stringValue = (typeof value === 'object') ? JSON.stringify(value) : String(value);
                metadataMarkdown += `**${stringKey.charAt(0).toUpperCase() + stringKey.slice(1)}**: ${stringValue}\n`;
            }
            
        } catch (err) {
            // If Object.entries fails because metadata is not a plain object,
            // fallback gracefully or just print a message.
            metadataMarkdown += 'No metadata available (unrecognized metadata structure).';
        }
    
        return metadataMarkdown;
    }
    
    
}

module.exports = PDF;