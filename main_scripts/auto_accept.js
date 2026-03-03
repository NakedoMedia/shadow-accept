/**
 * Shadow Accept — DOM Injection Script
 * by Nakedo Corp — MIT License
 *
 * Injected into the IDE's Electron renderer via CDP.
 * Polls the DOM to find and click AI agent "accept" buttons.
 *
 * Global API (called from cdp-handler.js):
 *   window.__shadowAcceptStart(config)  — start/restart with config
 *   window.__shadowAcceptStop()         — stop all loops
 *   window.__shadowAcceptGetStats()     — returns { clicks, blocked, lastAction, uptime }
 *
 * Security:
 *   - No network requests
 *   - No data exfiltration
 *   - Banned command list prevents clicking dangerous shell commands
 *   - User interaction detection: pauses when user is actively typing/clicking
 */
(function () {
    'use strict';

    if (typeof window === 'undefined') return;

    // Prevent double-injection
    if (window.__shadowAcceptLoaded) return;
    window.__shadowAcceptLoaded = true;

    console.log('[ShadowAccept] Script loaded');

    // ── State ─────────────────────────────────────────────────────────────────

    const state = {
        running:         false,
        ide:             'Code',
        pollInterval:    800,
        bannedCommands:  [],
        clicks:          0,
        blocked:         0,
        lastAction:      null,   // { text, time } of last accepted button
        startedAt:       null,
        userInteracting: false,  // paused during user mouse/keyboard activity
    };

    window.__shadowAcceptState = state;

    // ── Timers ────────────────────────────────────────────────────────────────

    let pollTimer          = null;
    let interactTimer      = null;
    const INTERACT_GRACE_MS = 1200; // ms to pause after user activity

    // ── Logging ───────────────────────────────────────────────────────────────

    const log = (msg) => console.log(`[ShadowAccept] ${msg}`);

    // ── DOM traversal (including iframes) ────────────────────────────────────

    function getAllDocuments(root = document) {
        const docs = [root];
        try {
            for (const frame of root.querySelectorAll('iframe, frame')) {
                try {
                    const d = frame.contentDocument || frame.contentWindow?.document;
                    if (d) docs.push(...getAllDocuments(d));
                } catch (_) {}
            }
        } catch (_) {}
        return docs;
    }

    function queryAllDocs(selector) {
        const results = [];
        for (const doc of getAllDocuments()) {
            try {
                results.push(...Array.from(doc.querySelectorAll(selector)));
            } catch (_) {}
        }
        return results;
    }

    // ── Button selectors (per IDE) ────────────────────────────────────────────

    function getButtonSelectors() {
        if (state.ide === 'Antigravity') {
            return [
                '.bg-ide-button-background',
                'button.bg-primary',
                'button.cursor-pointer',
                'button.rounded-l',
                'button',
            ];
        }
        // Cursor and VS Code (Copilot / ChatGPT extension / Claude Code)
        return [
            'button',
            '[role="button"]',
            '[class*="button"]',
            '[class*="anysphere"]',
            '[class*="action-button"]',
        ];
    }

    // ── Text pattern matching ─────────────────────────────────────────────────

    const ACCEPT_PATTERNS = [
        'accept all', 'accept', 'apply all', 'apply', 'run', 'retry',
        'execute', 'confirm', 'always allow', 'allow once', 'allow',
        'approve', 'yes', 'ok', 'proceed', 'continue',
    ];

    const REJECT_PATTERNS = [
        'skip', 'reject', 'cancel', 'close', 'refine', 'decline',
        'deny', 'no', 'stop', 'abort', 'dismiss',
    ];

    function matchesPatterns(text, patterns) {
        for (const p of patterns) {
            if (text.includes(p)) return true;
        }
        return false;
    }

    // ── Banned command detection ──────────────────────────────────────────────

    function extractNearbyCommandText(el) {
        let text = '';
        let node = el.parentElement;
        let depth = 0;

        while (node && depth < 10) {
            let sib = node.previousElementSibling;
            let sibCount = 0;
            while (sib && sibCount < 5) {
                if (sib.matches && sib.matches('pre, code')) {
                    text += ' ' + sib.textContent.trim();
                }
                try {
                    for (const code of sib.querySelectorAll('pre, code, pre code')) {
                        const t = code.textContent.trim();
                        if (t && t.length < 4000) text += ' ' + t;
                    }
                } catch (_) {}
                sib = sib.previousElementSibling;
                sibCount++;
            }
            if (text.length > 10) break;
            node = node.parentElement;
            depth++;
        }

        text += ' ' + (el.getAttribute('aria-label') || '');
        text += ' ' + (el.getAttribute('title') || '');
        return text.trim().toLowerCase();
    }

    function isBannedCommand(commandText) {
        if (!commandText || state.bannedCommands.length === 0) return false;
        const lower = commandText.toLowerCase();
        for (const pattern of state.bannedCommands) {
            const p = (pattern || '').trim();
            if (!p) continue;
            try {
                if (p.startsWith('/') && p.lastIndexOf('/') > 0) {
                    const last  = p.lastIndexOf('/');
                    const regex = new RegExp(p.slice(1, last), p.slice(last + 1) || 'i');
                    if (regex.test(commandText)) {
                        log(`[BLOCKED] Regex match: ${p}`);
                        state.blocked++;
                        return true;
                    }
                } else if (lower.includes(p.toLowerCase())) {
                    log(`[BLOCKED] Pattern match: "${p}"`);
                    state.blocked++;
                    return true;
                }
            } catch (_) {
                if (lower.includes(p.toLowerCase())) {
                    state.blocked++;
                    return true;
                }
            }
        }
        return false;
    }

    // ── Button validation ─────────────────────────────────────────────────────

    function isVisible(el) {
        try {
            const style = window.getComputedStyle(el);
            const rect  = el.getBoundingClientRect();
            return (
                style.display    !== 'none'   &&
                style.visibility !== 'hidden' &&
                style.pointerEvents !== 'none' &&
                rect.width  > 0 &&
                rect.height > 0 &&
                !el.disabled
            );
        } catch (_) {
            return false;
        }
    }

    function isAcceptButton(el) {
        const rawText = (el.textContent || '').trim();
        const text    = rawText.toLowerCase();

        // Ignore empty or very long text
        if (text.length === 0 || rawText.length > 60) return false;

        // Hard reject patterns first
        if (matchesPatterns(text, REJECT_PATTERNS)) return false;

        // Must match at least one accept pattern
        if (!matchesPatterns(text, ACCEPT_PATTERNS)) return false;

        // Must be visible
        if (!isVisible(el)) return false;

        // Safety check for run/execute: inspect nearby command text
        if (text.includes('run') || text.includes('execute')) {
            const cmd = extractNearbyCommandText(el);
            if (isBannedCommand(cmd)) return false;
        }

        return true;
    }

    // ── Deduplication ─────────────────────────────────────────────────────────

    // Track recently-clicked buttons to avoid spamming the same button
    const recentlyClicked = new WeakSet();

    function markClicked(el) {
        recentlyClicked.add(el);
        setTimeout(() => {
            try { recentlyClicked.delete(el); } catch (_) {}
        }, 2000);
    }

    // ── Core click loop ───────────────────────────────────────────────────────

    function clickAcceptButtons() {
        if (!state.running || state.userInteracting) return;

        let clicked = 0;
        for (const selector of getButtonSelectors()) {
            for (const el of queryAllDocs(selector)) {
                if (recentlyClicked.has(el)) continue;
                if (!isAcceptButton(el)) continue;

                const label = (el.textContent || '').trim();
                log(`Clicking: "${label}"`);

                el.dispatchEvent(new MouseEvent('click', {
                    view: window, bubbles: true, cancelable: true,
                }));

                markClicked(el);
                state.clicks++;
                state.lastAction = { text: label, time: new Date().toISOString() };
                clicked++;
            }
        }
        return clicked;
    }

    // ── User interaction detection ────────────────────────────────────────────
    // Pause auto-accept briefly when the user is manually clicking or typing,
    // to prevent fighting with the user's own actions.

    function onUserActivity() {
        state.userInteracting = true;
        clearTimeout(interactTimer);
        interactTimer = setTimeout(() => {
            state.userInteracting = false;
        }, INTERACT_GRACE_MS);
    }

    function attachActivityListeners() {
        document.addEventListener('mousedown', onUserActivity, { passive: true, capture: true });
        document.addEventListener('keydown',   onUserActivity, { passive: true, capture: true });
    }

    function detachActivityListeners() {
        document.removeEventListener('mousedown', onUserActivity, { capture: true });
        document.removeEventListener('keydown',   onUserActivity, { capture: true });
    }

    // ── Public API ────────────────────────────────────────────────────────────

    window.__shadowAcceptStart = function (config) {
        // Apply config
        if (config.ide)            state.ide            = config.ide;
        if (config.pollInterval)   state.pollInterval   = config.pollInterval;
        if (config.bannedCommands) state.bannedCommands = config.bannedCommands;

        // If already running, just update config
        if (state.running) {
            log(`Config updated: ${JSON.stringify(config)}`);
            return;
        }

        state.running   = true;
        state.startedAt = Date.now();
        log(`Started on ${state.ide} (poll: ${state.pollInterval}ms)`);

        attachActivityListeners();

        // Run immediately, then on interval
        clickAcceptButtons();
        pollTimer = setInterval(clickAcceptButtons, state.pollInterval);
    };

    window.__shadowAcceptStop = function () {
        state.running = false;
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        clearTimeout(interactTimer);
        detachActivityListeners();
        log('Stopped');
    };

    window.__shadowAcceptGetStats = function () {
        return {
            clicks:     state.clicks,
            blocked:    state.blocked,
            lastAction: state.lastAction,
            uptime:     state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0,
        };
    };

    log('Ready. Call window.__shadowAcceptStart(config) to begin.');
})();
