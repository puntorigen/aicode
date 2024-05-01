// .xlsx file reader
const Reader = require('./default');
const fs = require('fs').promises;
const XLSX = require('xlsx');
const path = require('path');

class XlsX extends Reader {
    constructor(file) {
        super('xlsx', file);
    }

    async read() {
        try {
            const fileBuffer = await fs.readFile(this.file);
            const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
            let markdownSheets = {};
            workbook.SheetNames.forEach(sheetName => {
                const worksheet = workbook.Sheets[sheetName];
                const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 }); // Read as an array of arrays
                markdownSheets[sheetName] = this.convertToAsciiTable(data);
            });
            // concatenate all sheets key values into a single markdown string
            let output = '';
            for (const key in markdownSheets) {
                output += `## Sheet '${key}' contents:\n\`\`\`${markdownSheets[key]}\`\`\`\n\n`;
            }
            return output;

        } catch(error) {
            console.error('Failed to extract text:', error);
            return null;
        }
    }

    convertToAsciiTable(data) {
        if (data.length === 0) return "";

        // Calculate column widths
        const columnWidths = data[0].map((_, colIndex) => Math.max(...data.map(row => row[colIndex] ? row[colIndex].toString().length : 0)));

        // Build the separator
        const separator = '+' + columnWidths.map(width => '-'.repeat(width + 2)).join('+') + '+';

        // Build the header and rows
        const buildRow = row => '|' + row.map((cell, index) => ` ${cell.toString().padEnd(columnWidths[index], ' ')} |`).join('');

        let asciiTable = [separator];
        data.forEach((row, index) => {
            asciiTable.push(buildRow(row));
            if (index === 0) asciiTable.push(separator); // Repeat separator after header
        });
        asciiTable.push(separator);

        return asciiTable.join('\n');
    }

}

module.exports = XlsX;