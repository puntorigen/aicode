const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ENCRYPTION_KEY = 'abcdefghijklmnopqrstuvwxyz123456'; // Must be 256 bits (32 characters)
const IV_LENGTH = 16; // For AES, this is always 16

class EncryptedJsonDB {
    constructor(filename) {
        this.filename = path.join(os.homedir(), '.aicode', filename);
        this.ensureDirectoryExistence(this.filename);
    }

    encrypt(text) {
        let iv = crypto.randomBytes(IV_LENGTH);
        let cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
        let encrypted = cipher.update(text);
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        return iv.toString('hex') + ':' + encrypted.toString('hex');
    }

    decrypt(text) {
        let textParts = text.split(':');
        let iv = Buffer.from(textParts.shift(), 'hex');
        let encryptedText = Buffer.from(textParts.join(':'), 'hex');
        let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    }

    save(data) {
        let encryptedData = this.encryptObject(data);
        fs.writeFileSync(this.filename, JSON.stringify(encryptedData, null, 4));
    }

    load() {
        if (!fs.existsSync(this.filename)) {
            return {};
        }
        let data = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
        let decryptedData = this.decryptObject(data);
        return decryptedData;
    }

    encryptObject(obj) {
        let result = {};
        for (let key in obj) {
            if (typeof obj[key] === 'string') {
                result[key] = this.encrypt(obj[key]);
            } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                result[key] = this.encryptObject(obj[key]); // Recursive call for nested objects
            } else {
                result[key] = obj[key]; // Copy other types as-is
            }
        }
        return result;
    }

    decryptObject(obj) {
        let result = {};
        for (let key in obj) {
            if (typeof obj[key] === 'string' && obj[key].includes(':')) {
                result[key] = this.decrypt(obj[key]);
            } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                result[key] = this.decryptObject(obj[key]); // Recursive call for nested objects
            } else {
                result[key] = obj[key]; // Copy other types as-is
            }
        }
        return result;
    }

    ensureDirectoryExistence(filePath) {
        let dirname = path.dirname(filePath);
        if (fs.existsSync(dirname)) {
            return true;
        }
        this.ensureDirectoryExistence(dirname);
        fs.mkdirSync(dirname);
    }
}

module.exports = EncryptedJsonDB;
