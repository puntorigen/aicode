// aicode Agent Server
// -----------------------------------------------------------------------------
// A loopback-only WebSocket server that exposes the runtime (runPrompt, the agent
// loop, sessions) to frontends: the VS Code extension, `aicode serve` clients,
// tests. The wire protocol is documented in docs/aicode-ide.spec.md (Protocol).
//
// Security model: it binds a loopback address only, every connection must send a
// `hello` carrying the per-process token within `helloTimeoutMs` (otherwise it is
// closed with code 4401), and browser upgrades whose Host/Origin are not loopback
// are refused. Keys travel only client -> server and are never echoed.
'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { loadConfig } = require('../config');
const { SessionManager, ProtocolError } = require('./sessions');
const { handlers } = require('./handlers');

const AUTH_FAILED = 4401;
const DEFAULT_HELLO_TIMEOUT_MS = 5000;
const DEFAULT_MAX_PAYLOAD = 8 * 1024 * 1024;
const HEARTBEAT_MS = 30 * 1000;
const CLIENTS = new Set(['ide', 'cli', 'tui', 'test']);
const LOOPBACK_NAMES = new Set(['localhost', '[::1]', '::1']);

const isLoopbackHost = (host) => LOOPBACK_NAMES.has(host) || (net.isIPv4(host) && host.startsWith('127.'));

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

// hostname part of a Host header value ("127.0.0.1:7865", "[::1]:7865", "localhost")
function hostnameOf(hostHeader) {
    const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(String(hostHeader || '').trim());
    return match ? match[1].toLowerCase() : '';
}

function packageVersion() {
    try { return require('../../package.json').version; } catch (e) { return '0.0.0'; }
}

/**
 * @param {object} options
 * @param {string} [options.host='127.0.0.1']  must be a loopback address
 * @param {number} [options.port=0]            0 picks a free port
 * @param {string} [options.token]             handshake token (random when omitted)
 * @param {Function} options.runtimeFactory    (cwd, flags, { ide, debug }) => Runtime
 * @param {object} [options.keysData]          the credentials object the runtimes share (kept by reference:
 *                                             `keys.*` messages mutate it, so a saved key reaches every session)
 * @param {Function} [options.debug]           (message, data) server log hook
 * @param {number} [options.helloTimeoutMs=5000]
 * @param {number} [options.sessionTtlMs]      how long detached sessions stay resumable (10 min)
 * @param {number} [options.ideTimeoutMs]      how long an ide.call waits for its result (10 s)
 * @returns {Promise<{ url: string, port: number, host: string, token: string, sessions: SessionManager, close: () => Promise<void> }>}
 */
async function startAgentServer(options = {}) {
    const {
        host = '127.0.0.1',
        runtimeFactory,
        debug = null,
        helloTimeoutMs = DEFAULT_HELLO_TIMEOUT_MS,
        sessionTtlMs,
        ideTimeoutMs,
        maxPayload = DEFAULT_MAX_PAYLOAD,
    } = options;
    if (typeof runtimeFactory !== 'function') throw new TypeError('startAgentServer: runtimeFactory is required');
    if (!isLoopbackHost(host)) throw new Error(`the Agent Server only binds loopback addresses (got "${host}")`);
    const requestedPort = options.port === undefined || options.port === null ? 0 : Number(options.port);
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new RangeError(`invalid port: ${options.port}`);
    const token = typeof options.token === 'string' && options.token !== '' ? options.token : crypto.randomBytes(24).toString('hex');
    const tokenDigest = digest(token);
    const serverVersion = packageVersion();

    // never pass tokens, key values or message bodies here: only types and ids
    const log = (message, data) => { if (typeof debug === 'function') { try { debug(`agent server: ${message}`, data); } catch (e) { /* ignore */ } } };

    const sessionOptions = { runtimeFactory, getConfig: loadConfig, debug: log };
    if (sessionTtlMs !== undefined) sessionOptions.ttlMs = sessionTtlMs;
    if (ideTimeoutMs !== undefined) sessionOptions.ideTimeoutMs = ideTimeoutMs;
    const sessions = new SessionManager(sessionOptions);

    const httpServer = http.createServer((req, res) => {
        res.writeHead(426, { 'Content-Type': 'text/plain', Upgrade: 'websocket', Connection: 'Upgrade' });
        res.end('aicode agent server: connect with a WebSocket\n');
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload });
    const conns = new Set();
    let connSeq = 0;
    let closing = false;
    let boundPort = 0;

    const keysData = options.keysData && typeof options.keysData === 'object' ? options.keysData : {};
    const ctx = { sessions, config: loadConfig, keysData, host, version: serverVersion };

    // ---- connection plumbing -------------------------------------------------------
    const closeConn = (conn, code, reason) => {
        try { conn.ws.close(code, reason); } catch (e) { try { conn.ws.terminate(); } catch (e2) { /* gone */ } }
        if (!conn.killTimer) {
            // a peer that never answers the close frame must not linger
            conn.killTimer = setTimeout(() => { try { conn.ws.terminate(); } catch (e) { /* gone */ } }, 1000);
            if (conn.killTimer.unref) conn.killTimer.unref();
        }
    };

    const withId = (msg, payload) => (msg && msg.id !== undefined ? { ...payload, id: msg.id } : payload);

    const failure = (conn, msg, err) => {
        const isProtocol = err instanceof ProtocolError;
        const code = isProtocol ? err.code : 'internal';
        const message = isProtocol ? err.message : `internal error: ${err && err.message ? err.message : err}`;
        if (!isProtocol) log('handler failed', { type: msg.type, error: err && err.message });
        const sessionId = isProtocol ? err.sessionId : (typeof msg.sessionId === 'string' ? msg.sessionId : undefined);
        if (sessionId) conn.send(withId(msg, { type: 'session.error', sessionId, code, message }));
        else conn.send(withId(msg, { type: 'error', code, message }));
    };

    const authenticate = (conn, raw) => {
        let msg = null;
        try { msg = JSON.parse(raw); } catch (e) { /* closed below */ }
        const valid = msg && typeof msg === 'object' && msg.type === 'hello'
            && typeof msg.token === 'string' && crypto.timingSafeEqual(digest(msg.token), tokenDigest);
        if (!valid) { closeConn(conn, AUTH_FAILED, 'unauthorized'); return; }
        clearTimeout(conn.helloTimer);
        conn.authed = true;
        conn.client = CLIENTS.has(msg.client) ? msg.client : 'cli';
        conn.version = typeof msg.version === 'string' ? msg.version : '';
        log('client connected', { connection: conn.id, client: conn.client });
        conn.send(withId(msg, { type: 'hello.ok', serverVersion, host }));
    };

    const dispatch = async (conn, raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) {
            conn.send({ type: 'error', code: 'bad_json', message: 'messages must be valid JSON' });
            return;
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
            conn.send({ type: 'error', code: 'bad_message', message: 'every message must be a JSON object with a string "type"' });
            return;
        }
        if (msg.type === 'hello') { // already authenticated: answer again, nothing to change
            conn.send(withId(msg, { type: 'hello.ok', serverVersion, host }));
            return;
        }
        const handler = handlers[msg.type];
        if (!handler) {
            conn.send(withId(msg, { type: 'error', code: 'unknown_type', message: `unknown message type: ${msg.type}` }));
            return;
        }
        try {
            await handler(ctx, conn, msg);
        } catch (err) {
            failure(conn, msg, err);
        }
    };

    const onConnection = (ws) => {
        const conn = {
            id: ++connSeq,
            ws,
            client: null,
            version: '',
            authed: false,
            alive: true,
            sessions: new Set(),
            helloTimer: null,
            killTimer: null,
            send(message) {
                if (ws.readyState !== WebSocket.OPEN) return;
                try { ws.send(JSON.stringify(message)); } catch (e) { log('could not send a message', { type: message && message.type, error: e.message }); }
            },
        };
        conns.add(conn);
        conn.helloTimer = setTimeout(() => closeConn(conn, AUTH_FAILED, 'hello timeout'), helloTimeoutMs);
        ws.on('pong', () => { conn.alive = true; });
        ws.on('message', (data, isBinary) => {
            if (isBinary) {
                if (conn.authed) conn.send({ type: 'error', code: 'bad_message', message: 'binary frames are not supported' });
                else closeConn(conn, AUTH_FAILED, 'unauthorized');
                return;
            }
            const raw = data.toString('utf8');
            if (!conn.authed) authenticate(conn, raw);
            else dispatch(conn, raw).catch((err) => log('dispatch failed', { error: err && err.message }));
        });
        ws.on('error', (err) => log('socket error', { connection: conn.id, error: err.message }));
        ws.on('close', () => {
            clearTimeout(conn.helloTimer);
            clearTimeout(conn.killTimer);
            conns.delete(conn);
            sessions.detach(conn);
            log('client disconnected', { connection: conn.id });
        });
    };

    // ---- upgrade: refuse anything that is not a loopback page/client ------------------
    const allowedHostnames = new Set(['127.0.0.1', 'localhost', '[::1]', host.toLowerCase()]);
    httpServer.on('upgrade', (req, socket, head) => {
        const refuse = (status, text) => {
            try { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch (e) { /* gone */ }
            socket.destroy();
        };
        if (closing) { refuse(503, 'Service Unavailable'); return; }
        // DNS rebinding: a page on another name that resolves to 127.0.0.1 still sends its own Host
        if (!allowedHostnames.has(hostnameOf(req.headers.host))) { refuse(403, 'Forbidden'); return; }
        // browsers always send Origin; node clients (the extension host, tests) send none
        if (req.headers.origin !== undefined) {
            let originHost = '';
            try { originHost = new URL(req.headers.origin).hostname.toLowerCase(); } catch (e) { /* opaque origin */ }
            if (!allowedHostnames.has(originHost)) { refuse(403, 'Forbidden'); return; }
        }
        wss.handleUpgrade(req, socket, head, onConnection);
    });
    httpServer.on('clientError', (err, socket) => { try { socket.destroy(); } catch (e) { /* gone */ } });

    // dead peers (a suspended laptop, a killed browser) must not hold sessions open
    const heartbeat = setInterval(() => {
        for (const conn of conns) {
            if (!conn.alive) { try { conn.ws.terminate(); } catch (e) { /* gone */ } continue; }
            conn.alive = false;
            try { conn.ws.ping(); } catch (e) { /* closing */ }
        }
    }, HEARTBEAT_MS);
    if (heartbeat.unref) heartbeat.unref();

    // ---- listen -------------------------------------------------------------------------
    await new Promise((resolve, reject) => {
        httpServer.once('error', (err) => {
            if (err && err.code === 'EADDRINUSE') {
                const inUse = new Error(`port ${requestedPort} is already in use`);
                inUse.code = 'EADDRINUSE';
                reject(inUse);
            } else reject(err);
        });
        httpServer.listen(requestedPort, host, () => { boundPort = httpServer.address().port; resolve(); });
    }).catch((err) => { clearInterval(heartbeat); throw err; });
    // after startup an unhandled 'error' event would crash the process
    httpServer.on('error', (err) => log('http server error', { error: err && err.message }));

    const url = `ws://${host.includes(':') ? `[${host}]` : host}:${boundPort}`;
    log('listening', { url });

    let closed = null;
    const close = () => {
        if (closed) return closed;
        closing = true;
        closed = new Promise((resolve) => {
            clearInterval(heartbeat);
            sessions.closeAll(); // abort running turns, resolve pending prompts
            for (const conn of conns) {
                clearTimeout(conn.helloTimer);
                closeConn(conn, 1001, 'server shutting down');
            }
            const force = setTimeout(() => {
                for (const conn of conns) { try { conn.ws.terminate(); } catch (e) { /* gone */ } }
                if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
            }, 1500);
            if (force.unref) force.unref();
            httpServer.close(() => {
                clearTimeout(force);
                wss.close();
                resolve();
            });
        });
        return closed;
    };

    return { url, port: boundPort, host, token, sessions, close };
}

module.exports = { startAgentServer, AUTH_FAILED };
