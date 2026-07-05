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
            if (streamBuf.trim() !== '') controller.addItem(renderMarkdown(streamBuf).replace(/\n+$/, ''));
            streamBuf = '';
            controller.setStreamText('');
        },
        isStreaming() { return streamBuf.length > 0; },
        answer(text) { controller.addItem(colorize(String(text), colors)); },
        markdown(md) { controller.addItem(renderMarkdown(md).replace(/\n+$/, '')); },
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
        ask(message) { return controller.prompt({ kind: 'ask', message: colorize(String(message), colors) }); },
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
        cmd('/model', 'choose the primary model provider for this session'),
        cmd('/local', 'toggle the local model provider (Ollama/LM Studio)'),
        cmd('/clear', 'clear the screen transcript'),
        cmd('/exit', 'quit the session'),
        c.dim('  ↑/↓ history · esc cancels a running turn'),
    ].join('\n');
}

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

    const idRef = React.useRef(0);
    const abortRef = React.useRef(null);
    const historyRef = React.useRef([]);
    const historyIdx = React.useRef(-1);
    const sessionPrefsRef = React.useRef(null);
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
        try {
            const u = await deps.runPrompt(text, adapter, { signal: ac.signal, modelPreferences: sessionPrefsRef.current });
            if (u) setUsage((s) => ({
                inputTokens: (s.inputTokens || 0) + (u.inputTokens || 0),
                outputTokens: (s.outputTokens || 0) + (u.outputTokens || 0),
                cost: (s.cost || 0) + (u.cost || 0),
            }));
        } catch (e) {
            addItem(shared.formatError(e, { debug: shared.debug }, c));
        } finally {
            setBusy(false);
            abortRef.current = null;
            setLive(null);
            setStreamText('');
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
            // Static content lives in scrollback; wipe the screen + scrollback too
            try { if (stdout && stdout.isTTY) stdout.write('\x1b[2J\x1b[3J\x1b[H'); } catch (e) { }
        } else if (cmd === 'exit' || cmd === 'quit') {
            cleanupExit();
        } else if (cmd === 'model') {
            const providers = deps.availableProviders || [];
            if (providers.length === 0) { addItem(c.yellow('no cloud providers configured')); return; }
            const chosen = await controller.prompt({
                kind: 'select',
                message: 'Select primary model provider',
                choices: providers.map((p) => ({ title: p.toLowerCase(), value: p })),
            });
            if (chosen) {
                const prefs = [chosen, ...providers.filter((p) => p !== chosen), 'LOCAL'];
                sessionPrefsRef.current = prefs;
                addItem(c.green('✓ model provider set to ' + chosen.toLowerCase()));
            }
        } else if (cmd === 'local') {
            const on = !localOn;
            if (on && !deps.hasLocal) {
                addItem(c.yellow('no local model configured — start Ollama/LM Studio, then run `aicode --local "…"` once to select a model'));
                return;
            }
            setLocalOn(on);
            if (deps.setLocal) deps.setLocal(on);
            addItem(c.green('✓ local provider ' + (on ? 'enabled' : 'disabled')));
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
                h(TextInput, { value: askValue, onChange: setAskValue, onSubmit: (v) => finishPrompt(v) }));
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
    const chip = [deps.provider, deps.model].filter(Boolean).join('/');
    const tok = `${shared.fmtTokens(usage.inputTokens)}/${shared.fmtTokens(usage.outputTokens)} tok`;
    const cost = usage.cost > 0 ? `~$${usage.cost.toFixed(usage.cost < 0.01 ? 4 : 2)}` : '';
    const statusBar = [deps.cwd, chip + (localOn ? ' (local)' : ''), tok, cost].filter(Boolean).join('  ·  ');

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
