// .docx file default
const Reader = require('./default');

class DocX extends Reader {
    constructor(file) {
        super('docx', file);
    }

    read() {
        return `Reading ${this.ext} file: ${this.file}`;
    }
}