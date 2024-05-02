// .xlsx file reader with cell coordinates
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
                markdownSheets[sheetName] = this.convertToAsciiTableWithHeaderAndRowPrefixes(worksheet);
            });
            // concatenate all sheets key values into a single markdown string
            let output = '';
            for (const key in markdownSheets) {
                output += `## Sheet '${key}' contents:\n\`\`\`${markdownSheets[key]}\`\`\`\n\n`;
            }
            return output;

        } catch (error) {
            console.error('Failed to read the Excel file:', error);
            return null;
        }
    }

    convertToAsciiTableWithHeaderAndRowPrefixes(worksheet) {
        const range = XLSX.utils.decode_range(worksheet['!ref']); // Get the range of the sheet
        let asciiTable = [];

        // Create column headers (A, B, C, ...)
        let headers = [' ']; // Start with an empty space for the top-left corner
        for (let C = range.s.c; C <= range.e.c; ++C) {
            headers.push(XLSX.utils.encode_col(C));
        }
        asciiTable.push(this.buildSeparator(headers));
        asciiTable.push(this.buildRow(headers));

        // Prepare rows with row number prefixes (1, 2, 3, ...)
        for (let R = range.s.r; R <= range.e.r; ++R) {
            let row = [R + 1]; // Excel rows are 1-based
            for (let C = range.s.c; C <= range.e.c; ++C) {
                let cellAddress = XLSX.utils.encode_cell({r: R, c: C});
                let cell = worksheet[cellAddress];
                //console.log('cell',cell);
                let value = cell && cell.v !== undefined ? cell.v.toString() : '';
                row.push(value);
            }
            asciiTable.push(this.buildSeparator(row));
            asciiTable.push(this.buildRow(row));
        }
        asciiTable.push(this.buildSeparator(headers)); // Use headers to size final separator

        return asciiTable.join('\n');
    }

    buildSeparator(row) {
        // Create separator based on the length of each cell content in the row
        return '+' + row.map(cellContent => '-'.repeat(cellContent.length + 2)).join('+') + '+';
    }

    buildRow(row) {
        // Create content row, padding each cell to the width of the headers
        return '|' + row.map(cellContent => ` ${cellContent.toString().padEnd(cellContent.length, ' ')} |`).join('');
    }

}

module.exports = XlsX;