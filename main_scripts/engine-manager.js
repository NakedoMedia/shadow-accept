/**
 * Shadow Accept — Engine Manager v1.2
 * by Nakedo Corp — MIT License
 *
 * Orchestrates TerminalMonitorEngine (zero-config) and CDPHandler (debug port).
 * Terminal engine is always attempted first. CDP is optional secondary.
 *
 * Engine modes:
 *   auto          — Try terminal first, then CDP (default)
 *   terminal-only — Terminal engine only, skip CDP
 *   cdp-only      — CDP only (v1.1 behavior)
 */

'use strict';

const { TerminalMonitorEngine } = require('./terminal-monitor');
const { CDPHandler }            = require('./cdp-handler');

class EngineManager {
    /**
     * @param {(msg: string) => void} logger
     * @param {object} vscodeApi  — the `vscode` module, injected for testability
     */
    constructor(logger, vscodeApi) {
        this._log      = logger;
        this._vscode   = vscodeApi;
        this._terminal = new TerminalMonitorEngine(logger, vscodeApi);
        this._cdp      = new CDPHandler(logger);
        this._mode     = 'auto';
        this._running  = false;
    }

    // ── Public state ─────────────────────────────────────────────────────────

    get isConnected() {
        return this._terminal.isActive || this._cdp.isConnected;
    }

    get primaryEngine() {
        if (this._terminal.isActive && this._cdp.isConnected) return 'terminal+cdp';
        if (this._terminal.isActive) return 'terminal';
        if (this._cdp.isConnected)   return 'cdp';
        return 'none';
    }

    get connectedPort() {
        return this._cdp.connectedPort;
    }

    get cdp() { return this._cdp; }
    get terminal() { return this._terminal; }

    // ── Public API ───────────────────────────────────────────────────────────

    start(config) {
        this._running = true;
        this._mode = config.engineMode || 'auto';

        // Terminal engine (zero-config, always try unless cdp-only)
        if (this._mode !== 'cdp-only') {
            this._terminal.start(config);
        }

        // Return self for chaining; CDP start is async and called separately
        return this;
    }

    /**
     * Start CDP engine. Separated because CDP discovery is async.
     * Called from the extension's discovery polling loop.
     */
    async startCDP(config) {
        if (this._mode === 'terminal-only') return;
        await this._cdp.start(config);
    }

    async stop() {
        this._running = false;
        this._terminal.stop();
        await this._cdp.stop();
    }

    /** Aggregate stats from both engines. */
    async getStats() {
        const cdpStats = await this._cdp.getStats();
        const termStats = this._terminal.getStats();

        return {
            clicks:         (termStats.clicks || 0) + (cdpStats.clicks || 0),
            blocked:        (termStats.blocked || 0) + (cdpStats.blocked || 0),
            terminalClicks: termStats.clicks || 0,
            cdpClicks:      cdpStats.clicks || 0,
            lastAction:     termStats.lastAction || cdpStats.lastAction || null,
            terminalActive: this._terminal.isActive,
            cdpConnected:   this._cdp.isConnected,
            engine:         this.primaryEngine,
        };
    }

    /** Forward custom ports to CDP handler. */
    setCustomPorts(ports) {
        this._cdp.setCustomPorts(ports);
    }
}

module.exports = { EngineManager };
