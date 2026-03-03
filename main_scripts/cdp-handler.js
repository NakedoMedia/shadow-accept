/**
 * Shadow Accept — CDP Handler
 * by Nakedo Corp — MIT License
 *
 * Connects to the Electron DevTools Protocol (CDP) of VS Code / Antigravity / Cursor
 * via WebSocket on the local debug port (9000–9006), then injects and controls the
 * auto_accept.js DOM script.
 *
 * Security notes:
 *  - Only connects to 127.0.0.1 (loopback). Never to remote hosts.
 *  - Only pages of type "page" or "webview" are targeted.
 *  - DevTools pages are explicitly excluded.
 *  - Injected script is loaded from disk — no eval of user/network strings.
 *  - All WebSocket messages are JSON-parsed with try/catch.
 */

'use strict';

const WebSocket = require('ws');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');

const CDP_BASE_PORT  = 9000;
const CDP_PORT_RANGE = 3;          // scan 9000 ± 3
const CONNECT_TIMEOUT_MS  = 800;
const EVALUATE_TIMEOUT_MS = 2500;

// ─── Script loader (cached) ───────────────────────────────────────────────────

let _cachedScript = null;

function loadAutoAcceptScript() {
    if (_cachedScript) return _cachedScript;
    const scriptPath = path.join(__dirname, 'auto_accept.js');
    if (!fs.existsSync(scriptPath)) {
        throw new Error(`auto_accept.js not found at ${scriptPath}`);
    }
    _cachedScript = fs.readFileSync(scriptPath, 'utf8');
    return _cachedScript;
}

// ─── CDPHandler ───────────────────────────────────────────────────────────────

class CDPHandler {
    /**
     * @param {(msg: string) => void} logger
     */
    constructor(logger = console.log) {
        this._log     = logger;
        this._pages   = new Map();   // key: "port:pageId" → { ws, injected, config }
        this._msgId   = 1;
        this._running = false;
    }

    log(msg) { this._log(`[CDP] ${msg}`); }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Start (or refresh) connections to all IDE pages and inject the script.
     * Safe to call repeatedly — already-injected pages are not re-injected.
     */
    async start(config) {
        this._running = true;
        for (let port = CDP_BASE_PORT - CDP_PORT_RANGE; port <= CDP_BASE_PORT + CDP_PORT_RANGE; port++) {
            const pages = await this._listPages(port);
            for (const page of pages) {
                const key = `${port}:${page.id}`;
                await this._ensureConnected(key, page.webSocketDebuggerUrl);
                await this._ensureInjected(key, config);
            }
        }
    }

    /** Stop all connections and tell the injected script to stop. */
    async stop() {
        this._running = false;
        for (const [key, conn] of this._pages) {
            try {
                await this._eval(key, 'if(window.__shadowAcceptStop) window.__shadowAcceptStop()');
            } catch (_) {}
            try { conn.ws.close(); } catch (_) {}
        }
        this._pages.clear();
    }

    /** Retrieve click/block counters from all connected pages. */
    async getStats() {
        const totals = { clicks: 0, blocked: 0 };
        for (const [key] of this._pages) {
            try {
                const res = await this._eval(key,
                    'JSON.stringify(window.__shadowAcceptGetStats ? window.__shadowAcceptGetStats() : {})');
                const v = this._parseJSON(res, {});
                totals.clicks  += (v.clicks  || 0);
                totals.blocked += (v.blocked || 0);
            } catch (_) {}
        }
        return totals;
    }

    // ── Connection helpers ────────────────────────────────────────────────────

    /** GET /json/list from the Electron DevTools endpoint. Returns filtered pages. */
    async _listPages(port) {
        return new Promise((resolve) => {
            const req = http.get(
                { hostname: '127.0.0.1', port, path: '/json/list', timeout: CONNECT_TIMEOUT_MS },
                (res) => {
                    let body = '';
                    res.on('data', c => body += c);
                    res.on('end', () => {
                        try {
                            const pages = JSON.parse(body);
                            resolve(pages.filter(p => this._isTargetPage(p)));
                        } catch (_) { resolve([]); }
                    });
                }
            );
            req.on('error',   () => resolve([]));
            req.on('timeout', () => { req.destroy(); resolve([]); });
        });
    }

    /**
     * Accept only page/webview types and exclude DevTools UI pages.
     * This prevents accidentally injecting into the developer tools window.
     */
    _isTargetPage(p) {
        if (!p || !p.webSocketDebuggerUrl) return false;
        if (p.type !== 'page' && p.type !== 'webview') return false;
        const url = (p.url || '').toLowerCase();
        if (url.startsWith('devtools://'))        return false;
        if (url.startsWith('chrome-devtools://')) return false;
        if (url.includes('devtools/devtools'))    return false;
        return true;
    }

    async _ensureConnected(key, wsUrl) {
        if (this._pages.has(key)) return;
        await new Promise((resolve) => {
            let settled = false;
            const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };

            const ws = new WebSocket(wsUrl, { handshakeTimeout: CONNECT_TIMEOUT_MS });
            ws.on('open', () => {
                this._pages.set(key, { ws, injected: false, config: null });
                this.log(`Connected: ${key}`);
                done(true);
            });
            ws.on('error', () => done(false));
            ws.on('close', () => {
                this._pages.delete(key);
                this.log(`Disconnected: ${key}`);
            });

            setTimeout(() => done(false), CONNECT_TIMEOUT_MS + 100);
        });
    }

    async _ensureInjected(key, config) {
        const conn = this._pages.get(key);
        if (!conn) return;

        const cfgJson = JSON.stringify({
            ide:            config.ide || 'Code',
            pollInterval:   config.pollInterval || 800,
            bannedCommands: config.bannedCommands || [],
        });

        try {
            if (!conn.injected) {
                const script = loadAutoAcceptScript();
                this.log(`Injecting script into ${key} (${(script.length / 1024).toFixed(1)} KB)...`);
                await this._eval(key, script);
                conn.injected = true;
                this.log(`Injected: ${key}`);
            }

            const configChanged = conn.config !== cfgJson;
            if (configChanged) {
                await this._eval(key, `if(window.__shadowAcceptStart) window.__shadowAcceptStart(${cfgJson})`);
                conn.config = cfgJson;
                this.log(`Started with config: ${cfgJson}`);
            }
        } catch (e) {
            this.log(`Injection failed for ${key}: ${e.message}`);
            // Mark for re-injection on next cycle
            if (conn) conn.injected = false;
        }
    }

    // ── CDP Runtime.evaluate ─────────────────────────────────────────────────

    async _eval(key, expression) {
        const conn = this._pages.get(key);
        if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
            throw new Error(`Page ${key} not connected`);
        }

        return new Promise((resolve, reject) => {
            const id      = this._msgId++;
            const timer   = setTimeout(() => {
                conn.ws.off('message', onMessage);
                reject(new Error(`CDP timeout for message ${id}`));
            }, EVALUATE_TIMEOUT_MS);

            const onMessage = (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.id !== id) return;
                    conn.ws.off('message', onMessage);
                    clearTimeout(timer);
                    if (msg.error) {
                        reject(new Error(msg.error.message || 'CDP error'));
                    } else {
                        resolve(msg.result);
                    }
                } catch (_) {}
            };

            conn.ws.on('message', onMessage);
            conn.ws.send(JSON.stringify({
                id,
                method: 'Runtime.evaluate',
                params: { expression, userGesture: true, awaitPromise: true },
            }));
        });
    }

    _parseJSON(res, fallback) {
        const value = res?.result?.value;
        if (typeof value !== 'string') return fallback;
        try { return JSON.parse(value); } catch (_) { return fallback; }
    }
}

module.exports = { CDPHandler };
