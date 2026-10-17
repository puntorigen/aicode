// Offline checks for lib/engine.js template loading (no network, no model calls).
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const Code2Prompt = require('../lib/engine');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '}${name}`); if (!cond) failures++; };

// =============================================================================
// Template loading is awaited (regression: warm directory cache race)
// =============================================================================
console.log('\n[A] template loading race');
{
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-engine-project-'));
    fs.writeFileSync(path.join(project, 'hello.js'), 'console.log("hi");\n');
    const template = path.join(ROOT, 'actions', 'default.md');
    const mk = (tpl = template) => new Code2Prompt({ path: project, template: tpl, OPENAI_KEY: 'test' });

    await mk().generateContextPrompt(); // warms the process-wide directory cache
    let rendered = null, error = null;
    try {
        // a fresh engine right after: the cached traversal resolves before the
        // template file has been read, unless generateContextPrompt waits for it
        rendered = await mk().generateContextPrompt();
    } catch (e) { error = e; }
    ok('a fresh engine renders with a warm directory cache', !error && typeof rendered === 'string' && rendered.includes('hello.js'));

    // a missing template: no unhandled-rejection crash, the error shows up where it is used
    const broken = mk(path.join(project, 'does-not-exist.md'));
    let brokenError = null;
    try { await broken.generateContextPrompt(); } catch (e) { brokenError = e; }
    ok('a missing template file surfaces at generateContextPrompt', brokenError && /ENOENT/.test(brokenError.message));
    let recovered = null;
    try { recovered = await broken.generateContextPrompt(template); } catch (e) { /* fails the check below */ }
    ok('an explicit template replaces a failed initial one', typeof recovered === 'string' && recovered.includes('hello.js'));

    Code2Prompt.invalidateTraverseCache();
    fs.rmSync(project, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
