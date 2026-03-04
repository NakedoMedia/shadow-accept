/**
 * Shadow Accept — Terminal Monitor Engine v1.2
 * by Nakedo Corp — MIT License
 *
 * Zero-config engine that monitors terminal output for AI tool permission
 * prompts and auto-responds. Uses the proposed `onDidWriteTerminalData` API
 * when available, with graceful fallback.
 *
 * Works with: Claude Code CLI, Aider, Cody, and any tool using [Y/n] prompts.
 */

'use strict';

// ─── ANSI / VT sequence stripping ────────────────────────────────────────────

function stripAnsi(text) {
    if (!text) return '';
    return text
        .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')          // CSI sequences
        .replace(/\x1B\][^\x07]*\x07/g, '')              // OSC with BEL
        .replace(/\x1B\][^\x1B]*\x1B\\/g, '')            // OSC with ST
        .replace(/\x1B[()][A-Z0-9]/g, '')                // Character set select
        .replace(/\x1B[#=]/g, '')                         // Line attributes
        .replace(/[\x00-\x08\x0E-\x1A\x1C-\x1F]/g, '')  // Control chars (keep \n \r \t)
        .replace(/\r/g, '');                              // Carriage returns
}

// ─── Prompt patterns ─────────────────────────────────────────────────────────

const PROMPT_PATTERNS = [
    // Claude Code CLI: "Allow Bash(npm test)? [Y/n]"
    {
        name: 'claude-code-allow',
        pattern: /Allow\s+\w+\(.*?\)\?\s*\[Y\/n\]/,
        response: 'Y\n',
        hasTool: true,
    },
    // Claude Code CLI: "Do you want to proceed? [Y/n]"
    {
        name: 'claude-code-proceed',
        pattern: /Do you want to proceed\?\s*\[Y\/n\]/i,
        response: 'Y\n',
        hasTool: false,
    },
    // Generic [Y/n] at end of line
    {
        name: 'generic-yn',
        pattern: /\[Y\/n\]\s*$/,
        response: 'Y\n',
        hasTool: false,
    },
    // Generic [y/N] at end of line
    {
        name: 'generic-yN',
        pattern: /\[y\/N\]\s*$/,
        response: 'y\n',
        hasTool: false,
    },
    // Generic (yes/no) prompt
    {
        name: 'generic-yesno',
        pattern: /\(yes\/no\)\s*:?\s*$/i,
        response: 'yes\n',
        hasTool: false,
    },
    // Generic (y/n) prompt
    {
        name: 'generic-yn-paren',
        pattern: /\(y\/n\)\s*:?\s*$/i,
        response: 'y\n',
        hasTool: false,
    },
    // Press Enter to continue
    {
        name: 'press-enter',
        pattern: /Press Enter to continue/i,
        response: '\n',
        hasTool: false,
    },
];

// ─── Command extraction ──────────────────────────────────────────────────────

/**
 * Extract the command from a Claude Code permission prompt.
 * "Allow Bash(npm test)? [Y/n]" → { tool: "Bash", command: "npm test" }
 * "Allow Read(src/file.ts)? [Y/n]" → { tool: "Read", command: "src/file.ts" }
 * Returns null if no tool/command found.
 */
function extractCommandFromPrompt(text) {
    const match = text.match(/Allow\s+(\w+)\((.+?)\)\?/);
    if (!match) return null;
    return { tool: match[1], command: match[2] };
}

// Tools where the command argument could be dangerous
const DANGEROUS_TOOLS = ['Bash', 'Execute', 'Shell', 'Run'];

// ─── TerminalMonitorEngine ───────────────────────────────────────────────────

class TerminalMonitorEngine {
    constructor(logger, vscodeApi) {
        this._log       = logger;
        this._vscode    = vscodeApi;  // injected for testability
        this._running   = false;
        this._available = false;      // whether proposed API exists
        this._disposables = [];

        // Per-terminal state
        this._buffers     = new Map();   // Terminal → accumulated text
        this._cooldowns   = new Map();   // Terminal → last response timestamp
        this._flushTimers = new Map();   // Terminal → setTimeout handle

        // Config
        this._bannedCommands   = [];
        this._customPatterns   = [];
        this._cooldownMs       = 1000;

        // Stats
        this._stats = { clicks: 0, blocked: 0, lastAction: null };

        // Public state
        this.isActive = false;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    start(config) {
        this._bannedCommands = config.bannedCommands || [];
        this._customPatterns = (config.terminalPatterns || []).map(p => {
            try { return { name: 'custom', pattern: new RegExp(p), response: 'Y\n', hasTool: false }; }
            catch (_) { return null; }
        }).filter(Boolean);

        if (this._running) return;
        this._running = true;

        // Try to access proposed API
        try {
            if (this._vscode.window.onDidWriteTerminalData) {
                const disposable = this._vscode.window.onDidWriteTerminalData(event => {
                    this._onTerminalData(event);
                });
                this._disposables.push(disposable);
                this._available = true;
                this.isActive = true;
                this._log('[Terminal] Engine started — onDidWriteTerminalData available');
            } else {
                this._log('[Terminal] Proposed API not available (onDidWriteTerminalData is undefined)');
            }
        } catch (e) {
            this._log(`[Terminal] Proposed API not available: ${e.message}`);
        }
    }

    stop() {
        this._running = false;
        this.isActive = false;
        for (const d of this._disposables) {
            try { d.dispose(); } catch (_) {}
        }
        this._disposables = [];
        for (const timer of this._flushTimers.values()) {
            clearTimeout(timer);
        }
        this._buffers.clear();
        this._cooldowns.clear();
        this._flushTimers.clear();
        this._log('[Terminal] Engine stopped');
    }

    getStats() {
        return { ...this._stats };
    }

    // ── Terminal data handler ─────────────────────────────────────────────────

    _onTerminalData(event) {
        if (!this._running) return;
        const { terminal, data } = event;

        const cleaned = stripAnsi(data);
        if (!cleaned) return;

        // Accumulate in buffer
        const existing = this._buffers.get(terminal) || '';
        const combined = existing + cleaned;

        // Split into lines — last element is the current partial line (potential prompt)
        const lines = combined.split('\n');
        const lastLine = lines[lines.length - 1];

        // Keep only the last partial line in buffer
        this._buffers.set(terminal, lastLine);

        // Check if the partial line matches a prompt pattern
        if (lastLine.length > 2) {
            this._detectPrompt(lastLine, terminal);
        }

        // Safety: flush buffer after 2s to prevent unbounded growth
        clearTimeout(this._flushTimers.get(terminal));
        this._flushTimers.set(terminal, setTimeout(() => {
            this._buffers.delete(terminal);
        }, 2000));
    }

    // ── Prompt detection ──────────────────────────────────────────────────────

    _detectPrompt(text, terminal) {
        // Check cooldown
        const lastResponse = this._cooldowns.get(terminal) || 0;
        if (Date.now() - lastResponse < this._cooldownMs) return;

        // Try all patterns (built-in + custom)
        const allPatterns = [...PROMPT_PATTERNS, ...this._customPatterns];

        for (const p of allPatterns) {
            if (p.pattern.test(text)) {
                this._respondToPrompt(terminal, p, text);
                return; // One response per detection
            }
        }
    }

    _respondToPrompt(terminal, pattern, matchedText) {
        // Check banned commands for dangerous tools
        if (pattern.hasTool) {
            const extracted = extractCommandFromPrompt(matchedText);
            if (extracted && DANGEROUS_TOOLS.includes(extracted.tool)) {
                if (this._isBannedCommand(extracted.command)) {
                    this._log(`[Terminal] BLOCKED: ${extracted.tool}(${extracted.command})`);
                    this._stats.blocked++;
                    return;
                }
            }
        }

        // Send response
        try {
            terminal.sendText(pattern.response, false);
        } catch (e) {
            this._log(`[Terminal] sendText failed: ${e.message}`);
            return;
        }

        // Update state
        this._cooldowns.set(terminal, Date.now());
        this._stats.clicks++;
        this._stats.lastAction = { text: pattern.name, time: new Date().toISOString() };
        this._log(`[Terminal] Auto-accepted: "${pattern.name}" → sent "${pattern.response.trim()}"`);
    }

    // ── Banned command check ──────────────────────────────────────────────────

    _isBannedCommand(commandText) {
        if (!commandText || this._bannedCommands.length === 0) return false;
        const lower = commandText.toLowerCase();

        for (const pattern of this._bannedCommands) {
            const p = (pattern || '').trim();
            if (!p) continue;
            try {
                if (p.startsWith('/') && p.lastIndexOf('/') > 0) {
                    const last  = p.lastIndexOf('/');
                    const regex = new RegExp(p.slice(1, last), p.slice(last + 1) || 'i');
                    if (regex.test(commandText)) return true;
                } else if (lower.includes(p.toLowerCase())) {
                    return true;
                }
            } catch (_) {
                if (lower.includes(p.toLowerCase())) return true;
            }
        }
        return false;
    }
}

module.exports = {
    TerminalMonitorEngine,
    // Exported for testing
    stripAnsi,
    PROMPT_PATTERNS,
    DANGEROUS_TOOLS,
    extractCommandFromPrompt,
};
