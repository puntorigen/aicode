// aicode interactive TUI session (Ink)
// -----------------------------------------------------------------------------
// Opened when `aicode` is run with no input argument in an interactive terminal.
// Each submitted prompt runs the exact same pipeline as a one-shot invocation
// (deps.runPrompt) but with a UI adapter that renders into this Ink app instead
// of the transcript renderer. Completed items (steps, answers, diffs) go into a
// <Static> scrollback so terminal history stays native and selectable, matching
// the Claude Code pattern.
//
// Written with React.createElement (no JSX) so it runs directly as ESM with no
// build step.

import React from 'react';
import { render, Box, Text, Static, useInput, useApp, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import uiLib from '../ui.js';
import historyLib from '../history.js';

// session history trimming is shared with the Agent Server (lib/history.js)
const { trimSessionHistory } = historyLib;

const h = React.createElement;

// -----------------------------------------------------------------------------
// UI adapter: implements the same interface runPrompt + actions expect, but
// pushes pre-formatted ANSI strings into the Ink app via `controller`.
// -----------------------------------------------------------------------------
function makeTuiAdapter(controller, shared) {
    const {
        colors, renderMarkdown, colorize, formatStep, formatFooter,
        formatFileWritten, formatNote, formatError, formatDiff, formatData, debug,
    } = shared;
    let streamBuf = '';
    let lastAnswer = '';
    const api = {
        colorize: (s) => colorize(s, colors),
        renderMarkdown: (md) => renderMarkdown(md),
        header() { /* the status bar shows provider/model; nothing to print */ },
        footer(summary) { const line = formatFooter(summary, colors); if (line) controller.addItem(line); },
        step(label) {
            controller.setLive({ label, spinner: true });
            const start = Date.now();
            return {
                update: (t) => controller.setLive({ label: t, spinner: true }),
                done: (extra) => {
                    const el = ((Date.now() - start) / 1000).toFixed(1);
                    controller.addItem(formatStep({ ok: true, label, elapsed: el, extra: extra || '' }, colors));
                    controller.setLive(null);
                },
                fail: (text) => {
                    const el = ((Date.now() - start) / 1000).toFixed(1);
                    controller.addItem(formatStep({ ok: false, label: text || label, elapsed: el }, colors));
                    controller.setLive(null);
                },
            };
        },
        status(text) { controller.setLive({ label: text, spinner: true }); },
        statusStart(text) { controller.setLive({ label: text || '', spinner: true }); },
        statusStop() { controller.setLive(null); },
        streamStart() { streamBuf = ''; controller.setLive(null); controller.setStreamText(''); },
        streamChunk(chunk) { streamBuf += chunk; controller.setLive(null); controller.setStreamText(renderMarkdown(streamBuf).replace(/\n+$/, '')); },
        streamEnd() {
            if (streamBuf.trim() !== '') { lastAnswer = streamBuf; controller.addItem(renderMarkdown(streamBuf).replace(/\n+$/, '')); }
            streamBuf = '';
            controller.setStreamText('');
        },
        isStreaming() { return streamBuf.length > 0; },
        answer(text) { if (String(text).trim() !== '') lastAnswer = String(text); controller.addItem(colorize(String(text), colors)); },
        markdown(md) { if (String(md).trim() !== '') lastAnswer = String(md); controller.addItem(renderMarkdown(md).replace(/\n+$/, '')); },
        // session-memory helpers (used by the TUI to build the agent loop's history)
        getLastAnswer() { return lastAnswer; },
        resetAnswer() { lastAnswer = ''; },
        raw(text) { controller.addItem(String(text)); },
        note(message, data, color = 'cyan') { controller.addItem(formatNote(message, data, color, colors)); },
        debug(message, data) {
            if (!debug) return;
            const extra = (data !== undefined && data !== null && data !== '') ? '\n' + colors.dim(formatData(data)) : '';
            controller.addItem(colors.dim('· ' + String(message)) + extra);
        },
        diff(file, oldStr, newStr) { controller.addItem(formatDiff(file, oldStr, newStr, colors)); },
        fileWritten(file, opts = {}) { controller.addItem(formatFileWritten(file, opts, colors)); },
        error(err) { controller.addItem(formatError(err, { debug }, colors)); },
        confirm(message) { return controller.prompt({ kind: 'confirm', message: colorize(String(message), colors) }); },
        select(message, choices) { return controller.prompt({ kind: 'select', message: colorize(String(message), colors), choices }); },
        ask(message, opts = {}) { return controller.prompt({ kind: 'ask', message: colorize(String(message), colors), secret: !!(opts && opts.secret) }); },
        progressShim() { return { text: (t) => api.status(t), start: () => api.statusStart(), stop: () => api.statusStop() }; },
        dispose() { },
    };
    return api;
}

function helpText(c) {
    const cmd = (name, desc) => `  ${c.cyan(name.padEnd(10))} ${c.dim(desc)}`;
    return [
        c.bold('commands'),
        cmd('/help', 'show this help'),
        cmd('/actions', 'list the available action templates'),
        cmd('/model', 'pick a model (OpenRouter included) · /model <spec> | max | clear'),
        cmd('/keys', 'set a provider API key · /keys openrouter'),
        cmd('/local', 'toggle the local model provider (Ollama/LM Studio)'),
        cmd('/agent', 'toggle agent mode (multi-step tool-using loop)'),
        cmd('/skills', 'list installed skills · /skills install <owner/repo>'),
        cmd('/orvix', 'code index of this project · /orvix status | index | init [agents] | gain'),
        cmd('/clear', 'clear the screen transcript + session memory'),
        cmd('/exit', 'quit the session'),
        c.dim('  ↑/↓ history · esc cancels a running turn'),
    ].join('\n');
}

// 200000 -> "200k", 1000000 -> "1M"
const formatContext = (tokens) => {
    if (!tokens) return '-';
    return tokens >= 1000000 ? `${Number((tokens / 1000000).toFixed(1))}M` : `${Math.round(tokens / 1000)}k`;
};

// the title of a model in the /model pickers: "Kimi K3 · openrouter · 256k · $0.6/$2.5"
const modelTitle = (m) => [
    m.shortName,
    m.provider.toLowerCase(),
    formatContext(m.contextLength),
    m.pricing ? `$${m.pricing.prompt}/$${m.pricing.completion}` : '-',
].join(' · ');

const MODEL_CHOICES_SHOWN = 12;

// -----------------------------------------------------------------------------
// App component
// -----------------------------------------------------------------------------
const App = ({ deps }) => {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const shared = deps.shared;
    const c = shared.colors;

    const [items, setItems] = React.useState([]);
    const [live, setLive] = React.useState(null);          // { label, spinner }
    const [streamText, setStreamText] = React.useState('');
    const [input, setInput] = React.useState('');
    const [askValue, setAskValue] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [promptSpec, setPromptSpec] = React.useState(null);
    const [selIndex, setSelIndex] = React.useState(0);
    const [usage, setUsage] = React.useState({ inputTokens: 0, outputTokens: 0, cost: 0 });
    const [localOn, setLocalOn] = React.useState(false);
    const [agentOn, setAgentOn] = React.useState(!!deps.agentEnabled);
    // provider/model chip of the status bar; /model and /keys refresh it
    const [chip, setChip] = React.useState({ provider: deps.provider, model: deps.model });

    const idRef = React.useRef(0);
    const abortRef = React.useRef(null);
    const historyRef = React.useRef([]);
    const historyIdx = React.useRef(-1);
    const sessionHistoryRef = React.useRef([]);   // [{ role, content }] for agent-loop memory
    const promptResolveRef = React.useRef(null);

    const addItem = React.useCallback((text) => {
        setItems((prev) => [...prev, { key: idRef.current++, text }]);
    }, []);

    const controller = React.useMemo(() => ({
        addItem,
        setLive,
        setStreamText,
        prompt: (spec) => new Promise((resolve) => {
            promptResolveRef.current = resolve;
            setAskValue('');
            setSelIndex(0);
            setPromptSpec(spec);
        }),
    }), [addItem]);

    const adapter = React.useMemo(() => makeTuiAdapter(controller, shared), [controller, shared]);

    const finishPrompt = (value) => {
        const resolve = promptResolveRef.current;
        promptResolveRef.current = null;
        setPromptSpec(null);
        setSelIndex(0);
        setAskValue('');
        if (resolve) resolve(value);
    };

    const cleanupExit = () => {
        try { if (abortRef.current) abortRef.current.abort(); } catch (e) { }
        exit();
    };

    const runInput = async (text) => {
        addItem(c.cyan('❯ ') + c.bold(text));
        setBusy(true);
        const ac = new AbortController();
        abortRef.current = ac;
        if (adapter.resetAnswer) adapter.resetAnswer();
        try {
            // the model picked with /model lives in the runtime's flags, which runPrompt reads live
            const u = await deps.runPrompt(text, adapter, {
                signal: ac.signal,
                history: sessionHistoryRef.current.slice(),
            });
            if (u) setUsage((s) => ({
                inputTokens: (s.inputTokens || 0) + (u.inputTokens || 0),
                outputTokens: (s.outputTokens || 0) + (u.outputTokens || 0),
                cost: (s.cost || 0) + (u.cost || 0),
            }));
            // remember this turn for follow-up context (used by the agent loop)
            const answer = adapter.getLastAnswer ? adapter.getLastAnswer() : '';
            if (answer && answer.trim() && !(ac.signal && ac.signal.aborted)) {
                sessionHistoryRef.current = trimSessionHistory([
                    ...sessionHistoryRef.current,
                    { role: 'user', content: text },
                    { role: 'assistant', content: answer },
                ]);
            }
        } catch (e) {
            addItem(shared.formatError(e, { debug: shared.debug }, c));
        } finally {
            setBusy(false);
            abortRef.current = null;
            setLive(null);
            setStreamText('');
        }
    };

    // ---- /model ---------------------------------------------------------------
    // validate and remember `selection` (null = back to Auto), then refresh the status-bar chip
    const chooseModel = (selection) => {
        try {
            deps.models.select(selection);
        } catch (e) {
            addItem(c.yellow(e.message));
            return;
        }
        const now = deps.models.chip();
        setChip(now);
        addItem(selection
            ? c.green(`✓ model set to ${now.model} (${now.provider})`)
            : c.green('✓ model: auto — default provider order'));
        if (selection && localOn) addItem(c.dim('  the local provider is on: this model applies once you turn it off (/local)'));
    };

    const pickModel = async () => {
        let listing = deps.models.list();
        // first use after a key was added: the OpenRouter catalog is not cached yet
        if (!listing.catalog && deps.models.hasOpenRouterKey()) {
            addItem(c.dim('loading the OpenRouter catalog …'));
            try { await deps.models.refresh(); } catch (e) { addItem(c.yellow('could not load the catalog: ' + e.message)); }
            listing = deps.models.list();
        }
        const current = deps.models.current();
        const keepMax = current && current.effort === 'max' ? 'max' : null; // MAX stays on while you switch models
        const choiceFor = (m) => ({ title: modelTitle(m), value: { type: 'model', selection: { provider: m.provider, model: m.id, effort: keepMax } } });
        const featured = listing.models.filter((m) => m.available && (m.groups.includes('recent') || m.groups.includes('featured')));
        if (featured.length === 0) addItem(c.dim('no featured models yet — use search…, or add a key with /keys'));
        const choices = [{ title: 'search…', value: { type: 'search' } }, ...featured.slice(0, MODEL_CHOICES_SHOWN).map(choiceFor)];
        if (current) {
            choices.push({ title: `MAX: ${current.effort === 'max' ? 'on' : 'off'} (toggle for the current model)`, value: { type: 'max' } });
            choices.push({ title: 'Auto — default provider order', value: { type: 'clear' } });
        }
        const picked = await controller.prompt({ kind: 'select', message: 'Select a model', choices });
        if (!picked) return;
        if (picked.type === 'model') { chooseModel(picked.selection); return; }
        if (picked.type === 'max') { chooseModel({ ...current, effort: current.effort === 'max' ? null : 'max' }); return; }
        if (picked.type === 'clear') { chooseModel(null); return; }
        // search…
        const query = String(await controller.prompt({ kind: 'ask', message: 'Search models (e.g. kimi, sonnet 5.5):' }) || '').trim();
        if (!query) return;
        const found = deps.models.list(query).models;
        const usable = found.filter((m) => m.available);
        if (usable.length === 0) {
            addItem(c.yellow(found.length
                ? `${found.length} model(s) match "${query}" but need an API key — try /keys openrouter`
                : `no model matches "${query}"`));
            return;
        }
        const second = await controller.prompt({ kind: 'select', message: `Models matching "${query}"`, choices: usable.slice(0, 15).map(choiceFor) });
        if (second && second.type === 'model') chooseModel(second.selection);
    };

    const handleModel = async (arg) => {
        const word = arg.toLowerCase();
        if (word === 'clear' || word === 'auto') { chooseModel(null); return; }
        if (word === 'max') {
            const current = deps.models.current();
            if (!current) { addItem(c.yellow('pick a model first with /model')); return; }
            chooseModel({ ...current, effort: current.effort === 'max' ? null : 'max' });
            return;
        }
        if (!arg) { await pickModel(); return; }
        let selection;
        try {
            // a phrase like "sonnet 5.5 max" is matched against the catalog: load it first when missing
            if (!deps.models.list().catalog && deps.models.hasOpenRouterKey()) await deps.models.refresh().catch(() => { });
            selection = deps.models.parse(arg);
        } catch (e) {
            addItem(c.yellow(e.message));
            return;
        }
        chooseModel(selection);
    };

    // ---- /keys ----------------------------------------------------------------
    const KEY_PROVIDERS = ['openrouter', 'anthropic', 'openai', 'groq', 'local'];
    const handleKeys = async (arg) => {
        let provider = arg.toLowerCase();
        if (!provider) {
            provider = await controller.prompt({
                kind: 'select',
                message: 'Set the key of which provider?',
                choices: deps.keys.list().map((row) => ({
                    title: `${row.provider.toLowerCase().padEnd(10)} ${row.configured ? c.green('✓ ' + row.masked) : c.dim('not set')}`,
                    value: row.provider.toLowerCase(),
                })),
            });
            if (!provider) return;
        }
        if (!KEY_PROVIDERS.includes(provider)) {
            addItem(c.yellow(`unknown provider: ${provider} (use ${KEY_PROVIDERS.join(', ')})`));
            return;
        }
        let value;
        if (provider === 'local') {
            const baseURL = String(await controller.prompt({ kind: 'ask', message: 'Local server base URL (e.g. http://localhost:11434/v1):' }) || '').trim();
            if (!baseURL) return;
            const model = String(await controller.prompt({ kind: 'ask', message: 'Model name served there:' }) || '').trim();
            if (!model) return;
            value = { baseURL, model };
        } else {
            value = String(await controller.prompt({
                kind: 'ask',
                secret: true,
                message: provider === 'openrouter' ? 'Paste your OpenRouter API key (openrouter.ai/settings/keys):' : `Paste your ${provider} API key:`,
            }) || '').trim();
            if (!value) { addItem(c.dim('cancelled')); return; }
        }
        try {
            deps.keys.set(provider, value);
        } catch (e) {
            addItem(c.yellow(e.message));
            return;
        }
        addItem(c.green(`✓ ${provider} key saved`));
        setBusy(true);
        try {
            const res = await deps.keys.test(provider);
            addItem(res.ok ? c.green('ok · ' + res.detail) : c.yellow('failed · ' + res.detail));
            // a working OpenRouter key: load its catalog now so /model has something to list
            if (res.ok && provider === 'openrouter') deps.models.refresh().catch(() => { });
        } finally {
            setBusy(false);
        }
        setChip(deps.models.chip());
    };

    // ---- /orvix ---------------------------------------------------------------
    const handleOrvix = async (sub, rest) => {
        const api = deps.orvix;
        if (!api) { addItem(c.yellow('the code index is not available in this session')); return; }
        const title = c.bold('code index (orvix)');
        if (sub === 'status') {
            const s = api.status();
            addItem(title + '\n' + (s.enabled
                ? `  ${c.green('active')} · ${s.symbols} symbols${s.indexing ? ' · indexing …' : ''}${s.dirty ? ' · changes pending' : ''}`
                : `  ${c.yellow('off')} · ${api.reason()}`));
        } else if (sub === 'index') {
            addItem(c.dim('indexing …'));
            setBusy(true);
            try {
                const res = await api.index();
                const s = res.summary;
                if (res.ok) addItem(c.green('✓ indexed') + c.dim(s ? ` · ${s.files} files, ${s.symbols} symbols (${s.added} added, ${s.updated} updated, ${s.removed} removed)` : ''));
                else addItem(c.yellow('indexing failed: ' + res.error));
            } finally { setBusy(false); }
        } else if (sub === 'init') {
            let agents = rest.join(',').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
            if (agents.length === 0) {
                const picked = await controller.prompt({
                    kind: 'select',
                    message: 'Set orvix up for which agent? (writes its instruction file and builds the index)',
                    choices: [...api.agents.map((name) => ({ title: name, value: name })), { title: 'all of them', value: 'all' }],
                });
                if (!picked) return;
                agents = picked === 'all' ? [...api.agents] : [picked];
            }
            const unknown = agents.filter((name) => !api.agents.includes(name));
            if (unknown.length) { addItem(c.yellow(`unknown agent: ${unknown.join(', ')} (use ${api.agents.join(', ')})`)); return; }
            addItem(c.dim('running orvix init …'));
            setBusy(true);
            try {
                const res = await api.init(agents);
                addItem((res.ok ? c.green('✓ orvix init done') : c.yellow('orvix init failed')) + (res.output ? '\n' + c.dim(res.output) : ''));
            } finally { setBusy(false); }
        } else if (sub === 'gain') {
            const total = await api.gain();
            if (total.error) { addItem(c.yellow(total.error)); return; }
            addItem(title + '\n' + `  ${total.compressions} compression${total.compressions === 1 ? '' : 's'} · ${total.saved} tokens saved (${total.before} → ${total.after})`);
        } else {
            addItem(c.yellow('usage: /orvix status | index | init [agents] | gain'));
        }
    };

    const handleCommand = async (text) => {
        const parts = text.slice(1).trim().split(/\s+/);
        const cmd = (parts[0] || '').toLowerCase();
        if (cmd === 'help' || cmd === '') {
            addItem(helpText(c));
        } else if (cmd === 'actions') {
            const list = (deps.actions || []).map((a) => c.dim(' • ') + a).join('\n');
            addItem(c.bold('available actions') + '\n' + (list || c.dim('  (none found)')));
        } else if (cmd === 'clear') {
            setItems([]);
            sessionHistoryRef.current = [];
            // Static content lives in scrollback; wipe the screen + scrollback too
            try { if (stdout && stdout.isTTY) stdout.write('\x1b[2J\x1b[3J\x1b[H'); } catch (e) { }
        } else if (cmd === 'agent') {
            const on = !agentOn;
            setAgentOn(on);
            if (deps.setAgent) deps.setAgent(on);
            addItem(c.green('✓ agent mode ' + (on ? 'enabled — multi-step tool-using loop' : 'disabled — back to auto routing')));
        } else if (cmd === 'exit' || cmd === 'quit') {
            cleanupExit();
        } else if (cmd === 'model') {
            await handleModel(parts.slice(1).join(' ').trim());
        } else if (cmd === 'keys') {
            await handleKeys((parts[1] || '').trim());
        } else if (cmd === 'orvix') {
            await handleOrvix((parts[1] || 'status').toLowerCase(), parts.slice(2));
        } else if (cmd === 'local') {
            const on = !localOn;
            if (on && !deps.hasLocal) {
                addItem(c.yellow('no local model configured — start Ollama/LM Studio, then run `aicode --local "…"` once to select a model'));
                return;
            }
            setLocalOn(on);
            if (deps.setLocal) deps.setLocal(on);
            addItem(c.green('✓ local provider ' + (on ? 'enabled' : 'disabled')));
        } else if (cmd === 'skills') {
            const sub = (parts[1] || '').toLowerCase();
            if (sub === 'install' || sub === 'add') {
                const source = parts.slice(2).join(' ').trim();
                if (!source) { addItem(c.yellow('usage: /skills install <owner/repo | url>')); return; }
                addItem(c.dim('installing ' + source + ' via skills.sh …'));
                setBusy(true);
                try {
                    const res = deps.installSkill ? await deps.installSkill(source) : { ok: false, output: 'install unavailable' };
                    if (res.ok) addItem(c.green('✓ installed ' + source));
                    else addItem(c.yellow('skill install failed' + (res.code != null ? ' (exit ' + res.code + ')' : '')) + (res.output ? '\n' + c.dim(res.output) : ''));
                } catch (e) {
                    addItem(shared.formatError(e, { debug: shared.debug }, c));
                } finally { setBusy(false); }
            } else {
                const list = deps.listSkills ? deps.listSkills() : [];
                if (!list.length) {
                    addItem(c.bold('installed skills') + '\n' + c.dim('  (none — install with /skills install <owner/repo>)'));
                    return;
                }
                const lines = list.map((s) => c.dim(' • ') + c.cyan(s.name) + c.dim(' (' + s.origin + ')') + (s.description ? '\n     ' + c.dim(s.description) : '')).join('\n');
                addItem(c.bold('installed skills (' + list.length + ')') + '\n' + lines);
            }
        } else {
            addItem(c.yellow('unknown command: /' + cmd) + c.dim('  (try /help)'));
        }
    };

    const onSubmit = (value) => {
        const text = (value || '').trim();
        setInput('');
        if (!text) return;
        if (text.startsWith('/')) { handleCommand(text); return; }
        historyRef.current = [...historyRef.current, text];
        historyIdx.current = -1;
        runInput(text);
    };

    useInput((ch, key) => {
        if (promptSpec) {
            if (promptSpec.kind === 'confirm') {
                if (key.return || ch === 'y' || ch === 'Y') finishPrompt(true);
                else if (ch === 'n' || ch === 'N' || key.escape) finishPrompt(false);
            } else if (promptSpec.kind === 'select') {
                if (key.upArrow) setSelIndex((i) => Math.max(0, i - 1));
                else if (key.downArrow) setSelIndex((i) => Math.min(promptSpec.choices.length - 1, i + 1));
                else if (key.return) finishPrompt(promptSpec.choices[selIndex] ? promptSpec.choices[selIndex].value : undefined);
                else if (key.escape) finishPrompt(undefined);
            } else if (promptSpec.kind === 'ask') {
                if (key.escape) finishPrompt(undefined);
                // typing + enter handled by the ask TextInput
            }
            return;
        }
        if (key.escape) {
            if (busy && abortRef.current) abortRef.current.abort();
            return;
        }
        if (!busy) {
            const hist = historyRef.current;
            if (key.upArrow) {
                if (hist.length === 0) return;
                historyIdx.current = historyIdx.current === -1 ? hist.length - 1 : Math.max(0, historyIdx.current - 1);
                setInput(hist[historyIdx.current]);
            } else if (key.downArrow) {
                if (hist.length === 0 || historyIdx.current === -1) return;
                historyIdx.current += 1;
                if (historyIdx.current >= hist.length) { historyIdx.current = -1; setInput(''); }
                else setInput(hist[historyIdx.current]);
            }
        }
    });

    // ---- live / prompt / input regions ---------------------------------------
    const liveRegion = (live && live.spinner)
        ? h(Box, { key: 'live' }, h(Text, { color: 'cyan' }, h(Spinner, { type: 'dots' }), ' ', live.label || ''))
        : null;

    const streamRegion = streamText
        ? h(Box, { key: 'stream', flexDirection: 'column' }, h(Text, null, streamText))
        : null;

    let interactiveRegion;
    if (promptSpec) {
        if (promptSpec.kind === 'confirm') {
            interactiveRegion = h(Box, { key: 'confirm' },
                h(Text, { color: 'yellow' }, '? '),
                h(Text, null, promptSpec.message + ' '),
                h(Text, { dimColor: true }, '(Y/n)'));
        } else if (promptSpec.kind === 'select') {
            interactiveRegion = h(Box, { key: 'select', flexDirection: 'column' },
                h(Text, { color: 'yellow' }, '? ' + promptSpec.message),
                ...promptSpec.choices.map((choice, i) => h(Text, {
                    key: i,
                    color: i === selIndex ? 'cyan' : undefined,
                }, (i === selIndex ? '❯ ' : '  ') + (choice.title != null ? choice.title : String(choice.value)))));
        } else {
            interactiveRegion = h(Box, { key: 'ask' },
                h(Text, { color: 'yellow' }, '? ' + promptSpec.message + ' '),
                // a key being typed is shown as dots
                h(TextInput, { value: askValue, mask: promptSpec.secret ? '•' : undefined, onChange: setAskValue, onSubmit: (v) => finishPrompt(v) }));
        }
    } else if (busy) {
        interactiveRegion = h(Text, { key: 'busy', dimColor: true }, 'esc to cancel');
    } else {
        interactiveRegion = h(Box, { key: 'input' },
            h(Text, { color: 'cyan' }, '❯ '),
            h(TextInput, {
                value: input,
                onChange: setInput,
                onSubmit,
                placeholder: 'Ask anything about this folder…  (/help for commands)',
            }));
    }

    // ---- status bar -----------------------------------------------------------
    const chipText = [chip.provider, chip.model].filter(Boolean).join('/');
    const tok = `${shared.fmtTokens(usage.inputTokens)}/${shared.fmtTokens(usage.outputTokens)} tok`;
    const cost = usage.cost > 0 ? `~$${usage.cost.toFixed(usage.cost < 0.01 ? 4 : 2)}` : '';
    const mode = [localOn ? 'local' : '', agentOn ? 'agent' : ''].filter(Boolean).join(', ');
    const statusBar = [deps.cwd, chipText + (mode ? ' (' + mode + ')' : ''), tok, cost].filter(Boolean).join('  ·  ');

    return h(Box, { flexDirection: 'column' },
        h(Static, { items }, (item) => h(Box, { key: item.key, flexDirection: 'column' }, h(Text, null, item.text))),
        liveRegion,
        streamRegion,
        h(Box, { key: 'interactive', marginTop: (liveRegion || streamRegion) ? 1 : 0 }, interactiveRegion),
        h(Box, { key: 'statusbar', marginTop: 1 }, h(Text, { dimColor: true }, statusBar)),
    );
};

// -----------------------------------------------------------------------------
// entry point
// -----------------------------------------------------------------------------
export async function startTui(deps) {
    const colorEnabled = deps.colorEnabled !== false;
    const colors = uiLib.makeColors(colorEnabled);
    const shared = {
        colorEnabled,
        colors,
        debug: !!deps.debug,
        width: () => (process.stdout.columns || 80),
        renderMarkdown: (md) => uiLib.renderMarkdown(md, { width: process.stdout.columns || 80 }),
        renderDiff: uiLib.renderDiff,
        colorize: uiLib.colorize,
        fmtTokens: uiLib.fmtTokens,
        formatStep: uiLib.formatStep,
        formatFooter: uiLib.formatFooter,
        formatFileWritten: uiLib.formatFileWritten,
        formatNote: uiLib.formatNote,
        formatError: uiLib.formatError,
        formatDiff: uiLib.formatDiff,
        formatData: uiLib.formatData,
        SYMBOLS: uiLib.SYMBOLS,
    };

    // intro (printed once, above the Ink live area)
    process.stdout.write('\n' + uiLib.formatHeader({
        name: 'aicode', version: deps.version, cwd: deps.cwd, provider: deps.provider, model: deps.model,
    }, colors) + '\n');
    process.stdout.write(colors.dim('  interactive session · type a request, /help for commands, /exit to quit') + '\n\n');

    const app = render(h(App, { deps: { ...deps, shared } }));
    await app.waitUntilExit();
}

export { App };
export default { startTui };
