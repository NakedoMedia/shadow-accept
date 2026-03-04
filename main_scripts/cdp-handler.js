/**
 * Shadow Accept — CDP Handler v1.1
 * by Nakedo Corp — MIT License
 *
 * Connects to the Electron DevTools Protocol (CDP) of VS Code / Antigravity / Cursor
 * via WebSocket, then injects and controls the auto_accept.js DOM script.
 *
 * v1.1 fixes:
 *  - Smart port discovery: common ports (9222, 9229) + configurable + wide scan
 *  - Port caching: once found, reuse until disconnected
 *  - Backoff: exponential delay when no CDP port is found
 *  - Connection state: isConnected / connectedPort exposed for status bar
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

// ─── Port discovery ───────────────────────────────────────────────────────────
// Priority-ordered list of ports to scan.
// Common Electron/Chrome DevTools ports first, then a wider sweep.

const PRIORITY_PORTS = [
    9222,                    // Chrome / Electron default
    9229,                    // Node.js inspector default
    9333,                    // Cursor (some versions)
    9000, 9001, 9002, 9003, // Previous Shadow Accept range
    8997, 8998, 8999,       // Extended previous range
    9004, 9005, 9006,
    5858, 5859,             // Legacy Node.js debug
    9230, 9231,             // Additional inspector ports
];

const CONNECT_TIMEOUT_MS  = 600;
const EVALUATE_TIMEOUT_MS = 2500;
const BACKOFF_BASE_MS     = 2000;
const BACKOFF_MAX_MS      = 30000;

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
        this._log            = logger;
        this._pages          = new Map();   // key: "port:pageId" → { ws, injected, config }
        this._msgId          = 1;
        this._running        = false;

        // Port caching & backoff
        this._cachedPort     = null;        // last working port
        this._failCount      = 0;           // consecutive scan failures
        this._lastScanTime   = 0;           // timestamp of last full scan
        this._customPorts    = [];          // user-configured extra ports

        // Public state
        this.isConnected     = false;
        this.connectedPort   = null;
        this.pagesConnected  = 0;
    }

    log(msg) { this._log(`[CDP] ${msg}`); }

    /** Allow user to specify extra ports via settings. */
    setCustomPorts(ports) {
        this._customPorts = Array.isArray(ports) ? ports.filter(p => Number.isInteger(p) && p > 0 && p < 65536) : [];
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Start (or refresh) connections to IDE pages and inject the script.
     * Uses smart port caching: tries cached port first, then full scan with backoff.
     */
    async start(config) {
        this._running = true;

        // 1. If we have a cached port, try it first (fast path)
        if (this._cachedPort) {
            const pages = await this._listPages(this._cachedPort);
            if (pages.length > 0) {
                await this._connectAndInject(this._cachedPort, pages, config);
                this._updateConnectionState();
                return;
            }
            // Cached port stopped working
            this.log(`Cached port ${this._cachedPort} no longer responding`);
            this._cachedPort = null;
        }

        // 2. Check if we should do a full scan (with backoff)
        const backoffMs = Math.min(BACKOFF_BASE_MS * Math.pow(1.5, this._failCount), BACKOFF_MAX_MS);
        const elapsed   = Date.now() - this._lastScanTime;
        if (this._failCount > 0 && elapsed < backoffMs) {
            return; // Still in backoff period
        }

        // 3. Full port scan
        this._lastScanTime = Date.now();
        const portsToScan  = this._getPortList();

        let foundAny = false;
        for (const port of portsToScan) {
            const pages = await this._listPages(port);
            if (pages.length > 0) {
                this._cachedPort = port;
                this._failCount  = 0;
                this.log(`Found CDP on port ${port} (${pages.length} page(s))`);
                await this._connectAndInject(port, pages, config);
                foundAny = true;
                break; // Use first working port
            }
        }

        if (!foundAny) {
            this._failCount++;
            if (this._failCount === 1) {
                this.log(`No CDP port found. Scanning ${portsToScan.length} ports. Will retry with backoff.`);
            } else if (this._failCount % 10 === 0) {
                this.log(`Still no CDP port after ${this._failCount} scans. Ensure IDE is launched with --remote-debugging-port=9222`);
            }
        }

        this._updateConnectionState();
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
        this._updateConnectionState();
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

    // ── Internal helpers ──────────────────────────────────────────────────────

    _getPortList() {
        // Custom ports first, then priority ports, deduplicated
        const seen = new Set();
        const list = [];
        for (const p of [...this._customPorts, ...PRIORITY_PORTS]) {
            if (!seen.has(p)) { seen.add(p); list.push(p); }
        }
        return list;
    }

    async _connectAndInject(port, pages, config) {
        for (const page of pages) {
            const key = `${port}:${page.id}`;
            await this._ensureConnected(key, page.webSocketDebuggerUrl);
            await this._ensureInjected(key, config);
        }
    }

    _updateConnectionState() {
        // Remove dead connections
        for (const [key, conn] of this._pages) {
            if (conn.ws.readyState !== WebSocket.OPEN) {
                this._pages.delete(key);
            }
        }
        this.pagesConnected = this._pages.size;
        this.isConnected    = this._pages.size > 0;
        this.connectedPort  = this.isConnected ? this._cachedPort : null;
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
                            resolve(Array.isArray(pages) ? pages.filter(p => this._isTargetPage(p)) : []);
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
        const existing = this._pages.get(key);
        if (existing && existing.ws.readyState === WebSocket.OPEN) return;
        // Clean up stale entry
        if (existing) this._pages.delete(key);

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
