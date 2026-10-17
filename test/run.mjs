// Runs every test/*.test.mjs sequentially, one child process each, and exits
// non-zero on the first failure. `npm test` calls this.
//
//   node test/run.mjs            # all test files
//   node test/run.mjs runtime    # only files whose name contains "runtime"
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(testDir, '..');
const filters = process.argv.slice(2);

const files = readdirSync(testDir)
    .filter((f) => f.endsWith('.test.mjs'))
    .filter((f) => filters.length === 0 || filters.some((p) => f.includes(p)))
    .sort();

if (files.length === 0) {
    console.error('no test files matched' + (filters.length ? ` (${filters.join(', ')})` : ''));
    process.exit(1);
}

const started = Date.now();
for (const file of files) {
    console.log(`\n===== ${file} =====`);
    const res = spawnSync(process.execPath, [path.join(testDir, file)], {
        cwd: root,
        env: process.env,
        stdio: 'inherit',
    });
    if (res.status !== 0) {
        console.error(`\nFAILED: ${file} (${res.status !== null ? `exit ${res.status}` : `signal ${res.signal}`})`);
        process.exit(res.status || 1);
    }
}
console.log(`\nALL TEST FILES PASSED (${files.length} files, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
