const fs = require('fs');
const path = require('path');
const os = require('os');

class CacheWithTTL {
    constructor(filename) {
        this.cacheFile = path.join(os.homedir(), '.aicode', filename);
        this.cache = {};
        this.loadCache();
    }

    loadCache() {
        if (fs.existsSync(this.cacheFile)) {
            const fileData = fs.readFileSync(this.cacheFile, 'utf8');
            this.cache = JSON.parse(fileData);
        }
    }

    saveCache() {
        const data = JSON.stringify(this.cache, null, 4);
        fs.writeFileSync(this.cacheFile, data, 'utf8');
    }

    set(key, value, ttl) {
        const expireAt = Date.now() + ttl;
        this.cache[key] = { value, expireAt };
        this.saveCache();
    }

    get(key) {
        if (this.cache[key] && this.cache[key].expireAt > Date.now()) {
            return this.cache[key].value;
        } else {
            // Optionally remove the key if expired
            this.delete(key);
            return null;
        }
    }

    delete(key) {
        if (this.cache.hasOwnProperty(key)) {
            delete this.cache[key];
            this.saveCache();
        }
    }

    clear() {
        this.cache = {};
        this.saveCache();
    }
}

module.exports = CacheWithTTL;