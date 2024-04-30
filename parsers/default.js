// default file reader interface
class Reader {
    constructor(ext,file) {
        this.ext = ext;
        this.file = file;
    }

    read() {
        return `Reading ${this.ext} file: ${this.file}`;
    }
}

module.exports = Reader;