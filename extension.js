/**
 * Shadow Accept — VS Code Extension v1.1
 * by Nakedo Corp — MIT License
 *
 * Premium open-source auto-accept for AI agent prompts.
 * VS Code · Antigravity · Cursor
 * 100% free · no limits · no telemetry · no external API
 *
 * v1.1 fixes:
 *  - Connection status indicator in status bar
 *  - Separated discovery polling (slow) from stats refresh (fast)
 *  - User notification when CDP is not available with setup instructions
 *  - Custom debug port configuration
 */

'use strict';

const vscode = require('vscode');
const { CDPHandler } = require('./main_scripts/cdp-handler');

// ─── Constants ────────────────────────────────────────────────────────────────

const STATE_ENABLED_KEY  = 'shadow-accept.enabled';
const STATE_TOTAL_CLICKS = 'shadow-accept.totalClicks';

// Polling intervals
const DISCOVERY_INTERVAL_MS = 3000;  // How often to scan for CDP ports (slow)
const STATS_INTERVAL_MS     = 1500;  // How often to refresh click stats (fast)

// ─── Module-level state ───────────────────────────────────────────────────────

let isEnabled         = false;
let discoveryTimer    = null;
let statsTimer        = null;
let statusBarItem     = null;
let outputChannel     = null;
let cdpHandler        = null;
let globalContext     = null;
let currentIDE        = 'Code';
let sessionClicks     = 0;
let hasShownCDPHelp   = false;  // Only show CDP help once per session

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
    const ts = new Date().toISOString().split('T')[1].split('.')[0];
    const line = `[${ts}] ${msg}`;
    console.log(line);
    if (outputChannel) outputChannel.appendLine(line);
}

function detectIDE() {
    const name = (vscode.env.appName || '').toLowerCase();
    if (name.includes('cursor'))      return 'Cursor';
    if (name.includes('antigravity')) return 'Antigravity';
    if (name.includes('windsurf'))    return 'Windsurf';
    return 'Code';
}

function getConfig() {
    const cfg = vscode.workspace.getConfiguration('shadowAccept');
    return {
        pollInterval:    cfg.get('pollInterval',    800),
        bannedCommands:  cfg.get('bannedCommands',  getDefaultBannedCommands()),
        enableOnStartup: cfg.get('enableOnStartup', false),
        debugPort:       cfg.get('debugPort',       0),
    };
}

function getDefaultBannedCommands() {
    return [
        'rm -rf /', 'rm -rf ~', 'rm -rf *',
        'format c:', 'del /f /s /q', 'rmdir /s /q',
        ':(){:|:&};:', 'dd if=', 'mkfs.', '> /dev/sda', 'chmod -R 777 /',
    ];
}

// ─── Status bar ───────────────────────────────────────────────────────────────

function updateStatusBar() {
    if (!statusBarItem) return;
    const totalClicks = (globalContext?.globalState.get(STATE_TOTAL_CLICKS) ?? 0) + sessionClicks;
    const clickLabel  = totalClicks > 0 ? ` (${formatCount(totalClicks)})` : '';

    if (isEnabled) {
        const connected = cdpHandler?.isConnected;
        if (connected) {
            const port = cdpHandler.connectedPort ? `:${cdpHandler.connectedPort}` : '';
            statusBarItem.text            = `$(check) Shadow${clickLabel}`;
            statusBarItem.tooltip         = `Shadow Accept is ON — Connected${port}\n${totalClicks} auto-accepted total\nClick to disable`;
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            statusBarItem.color           = undefined;
        } else {
            statusBarItem.text            = `$(sync~spin) Shadow`;
            statusBarItem.tooltip         = `Shadow Accept is ON — Searching for CDP...\nEnsure IDE was launched with --remote-debugging-port=9222\nClick to disable`;
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            statusBarItem.color           = undefined;
        }
    } else {
        statusBarItem.text            = `$(circle-slash) Shadow`;
        statusBarItem.tooltip         = `Shadow Accept is OFF\nClick to enable`;
        statusBarItem.backgroundColor = undefined;
        statusBarItem.color           = new vscode.ThemeColor('statusBarItem.foreground');
    }
}

function formatCount(n) {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

// ─── CDP Help Notification ────────────────────────────────────────────────────

function showCDPHelpIfNeeded() {
    if (hasShownCDPHelp || !isEnabled || !cdpHandler) return;
    if (cdpHandler.isConnected) return; // Connected, no help needed

    // Show help after 8 seconds of no connection
    setTimeout(() => {
        if (hasShownCDPHelp || !isEnabled || cdpHandler?.isConnected) return;
        hasShownCDPHelp = true;

        const ide = currentIDE;
        let helpMsg;
        if (ide === 'Cursor') {
            helpMsg = 'Shadow Accept needs Cursor\'s debug port. Try launching Cursor with: cursor --remote-debugging-port=9222';
        } else if (ide === 'Antigravity') {
            helpMsg = 'Shadow Accept needs Antigravity\'s debug port. Try launching with: antigravity --remote-debugging-port=9222';
        } else {
            helpMsg = 'Shadow Accept needs VS Code\'s debug port. Launch VS Code with: code --remote-debugging-port=9222';
        }

        vscode.window.showWarningMessage(
            helpMsg,
            'Copy command', 'Set custom port', 'View log'
        ).then(choice => {
            if (choice === 'Copy command') {
                const cmd = ide === 'Cursor' ? 'cursor' : ide === 'Antigravity' ? 'antigravity' : 'code';
                vscode.env.clipboard.writeText(`${cmd} --remote-debugging-port=9222`);
                vscode.window.showInformationMessage('Command copied! Restart your IDE with this flag.');
            }
            if (choice === 'Set custom port') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'shadowAccept.debugPort');
            }
            if (choice === 'View log') {
                outputChannel?.show(true);
            }
        });
    }, 8000);
}

// ─── Polling (separated discovery & stats) ────────────────────────────────────

async function runDiscoveryCycle() {
    if (!isEnabled || !cdpHandler) return;
    const cfg = getConfig();

    // Pass custom port to handler
    if (cfg.debugPort > 0) {
        cdpHandler.setCustomPorts([cfg.debugPort]);
    }

    try {
        await cdpHandler.start({
            ide:            currentIDE,
            pollInterval:   cfg.pollInterval,
            bannedCommands: cfg.bannedCommands,
        });
    } catch (e) {
        log(`[Discovery] ${e.message}`);
    }

    updateStatusBar();
}

async function runStatsCycle() {
    if (!isEnabled || !cdpHandler || !cdpHandler.isConnected) return;
    try {
        const stats = await cdpHandler.getStats();
        if (stats.clicks !== sessionClicks) {
            sessionClicks = stats.clicks;
            updateStatusBar();
        }
    } catch (e) {
        log(`[Stats] ${e.message}`);
    }
}

function startPolling() {
    stopPolling();
    log(`Starting — discovery every ${DISCOVERY_INTERVAL_MS}ms, stats every ${STATS_INTERVAL_MS}ms on ${currentIDE}`);

    // Run discovery immediately, then on slow interval
    runDiscoveryCycle();
    discoveryTimer = setInterval(runDiscoveryCycle, DISCOVERY_INTERVAL_MS);

    // Stats on faster interval
    statsTimer = setInterval(runStatsCycle, STATS_INTERVAL_MS);

    // Show CDP help if needed
    showCDPHelpIfNeeded();
}

function stopPolling() {
    if (discoveryTimer) { clearInterval(discoveryTimer); discoveryTimer = null; }
    if (statsTimer)     { clearInterval(statsTimer);     statsTimer = null; }
    cdpHandler?.stop().catch(() => {});
}

// ─── Toggle command ───────────────────────────────────────────────────────────

async function cmdToggle(context) {
    isEnabled = !isEnabled;
    await context.globalState.update(STATE_ENABLED_KEY, isEnabled);
    updateStatusBar();

    if (isEnabled) {
        log('Enabled');
        hasShownCDPHelp = false; // Reset help flag on re-enable
        startPolling();
        vscode.window.showInformationMessage(
            `$(check) Shadow Accept is ON`,
            'Settings', 'Disable'
        ).then(choice => {
            if (choice === 'Settings') cmdOpenSettings(context);
            if (choice === 'Disable')  cmdToggle(context);
        });
    } else {
        // Persist session clicks before disabling
        const prev  = context.globalState.get(STATE_TOTAL_CLICKS) ?? 0;
        await context.globalState.update(STATE_TOTAL_CLICKS, prev + sessionClicks);
        sessionClicks = 0;
        stopPolling();
        log('Disabled');
        vscode.window.showInformationMessage(`$(circle-slash) Shadow Accept is OFF`);
        updateStatusBar();
    }
}

// ─── Settings webview ─────────────────────────────────────────────────────────

function cmdOpenSettings(context) {
    const panel = vscode.window.createWebviewPanel(
        'shadowAcceptSettings',
        'Shadow Accept',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');

    const cfg        = getConfig();
    const bannedStr  = cfg.bannedCommands.join('\n');
    const totalClicks = (context.globalState.get(STATE_TOTAL_CLICKS) ?? 0) + sessionClicks;
    const connected   = cdpHandler?.isConnected ?? false;
    const port        = cdpHandler?.connectedPort ?? null;

    panel.webview.html = buildSettingsHTML(cfg, bannedStr, totalClicks, currentIDE, isEnabled, connected, port);

    panel.webview.onDidReceiveMessage(async msg => {
        switch (msg.type) {

            case 'getStats': {
                const stats = cdpHandler ? await cdpHandler.getStats() : { clicks: 0, blocked: 0, uptime: 0 };
                const total = (context.globalState.get(STATE_TOTAL_CLICKS) ?? 0) + stats.clicks;
                panel.webview.postMessage({
                    type: 'stats', ...stats, total, enabled: isEnabled, ide: currentIDE,
                    connected: cdpHandler?.isConnected ?? false,
                    port: cdpHandler?.connectedPort ?? null,
                });
                break;
            }

            case 'toggle': {
                await cmdToggle(context);
                const stats2 = cdpHandler ? await cdpHandler.getStats() : { clicks: 0, blocked: 0 };
                const total2 = (context.globalState.get(STATE_TOTAL_CLICKS) ?? 0) + stats2.clicks;
                panel.webview.postMessage({
                    type: 'stats', ...stats2, total: total2, enabled: isEnabled, ide: currentIDE,
                    connected: cdpHandler?.isConnected ?? false,
                    port: cdpHandler?.connectedPort ?? null,
                });
                break;
            }

            case 'save': {
                const wcfg = vscode.workspace.getConfiguration('shadowAccept');
                await wcfg.update('pollInterval',   msg.pollInterval,   vscode.ConfigurationTarget.Global);
                await wcfg.update('bannedCommands', msg.bannedCommands, vscode.ConfigurationTarget.Global);
                if (msg.debugPort !== undefined) {
                    await wcfg.update('debugPort', msg.debugPort, vscode.ConfigurationTarget.Global);
                }
                if (isEnabled) startPolling(); // restart with new config
                panel.webview.postMessage({ type: 'saved' });
                log(`Settings saved — pollInterval=${msg.pollInterval}ms, banned=${msg.bannedCommands.length}`);
                break;
            }

            case 'openOutput': {
                outputChannel?.show(true);
                break;
            }
        }
    }, undefined, context.subscriptions);
}

// ─── Settings HTML ────────────────────────────────────────────────────────────

function buildSettingsHTML(cfg, bannedStr, totalClicks, ide, enabled, connected, port) {
    const connLabel = connected ? `Connected on port ${port}` : 'Not connected — see log';
    const connClass = connected ? 'conn-ok' : 'conn-err';
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Shadow Accept</title>
<style>
:root {
    --fg:       var(--vscode-foreground);
    --bg:       var(--vscode-editor-background);
    --input-bg: var(--vscode-input-background);
    --input-bd: var(--vscode-input-border, rgba(255,255,255,.12));
    --btn-bg:   var(--vscode-button-background);
    --btn-fg:   var(--vscode-button-foreground);
    --btn-hov:  var(--vscode-button-hoverBackground);
    --accent:   #7c6af7;
    --green:    #22c55e;
    --red:      #f87171;
    --orange:   #fb923c;
    --font:     var(--vscode-font-family, system-ui, sans-serif);
    --mono:     var(--vscode-editor-font-family, 'Courier New', monospace);
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--font);
    color: var(--fg);
    background: var(--bg);
    padding: 32px 40px;
    max-width: 680px;
    line-height: 1.5;
}

/* ── Header ── */
.header { display: flex; align-items: center; gap: 16px; margin-bottom: 28px; }
.header-logo {
    width: 44px; height: 44px; border-radius: 10px;
    background: linear-gradient(135deg, #7c6af7, #a855f7);
    display: flex; align-items: center; justify-content: center;
    font-size: 22px; flex-shrink: 0;
}
.header-title { font-size: 22px; font-weight: 700; letter-spacing: -0.4px; }
.header-sub { font-size: 12px; opacity: 0.5; margin-top: 2px; }

/* ── Connection status ── */
.conn-badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 12px; border-radius: 6px; font-size: 11px; font-weight: 600;
    margin-bottom: 16px;
}
.conn-badge.conn-ok { background: rgba(34,197,94,.1); color: var(--green); border: 1px solid rgba(34,197,94,.2); }
.conn-badge.conn-err { background: rgba(248,113,113,.08); color: var(--orange); border: 1px solid rgba(248,113,113,.15); }
.conn-dot { width: 7px; height: 7px; border-radius: 50%; }
.conn-ok .conn-dot { background: var(--green); }
.conn-err .conn-dot { background: var(--orange); animation: pulse 1.5s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }

/* ── Toggle button ── */
.toggle-btn {
    display: flex; align-items: center; gap: 10px;
    width: 100%; padding: 14px 18px; margin-bottom: 28px;
    border: 1.5px solid rgba(255,255,255,.08); border-radius: 10px;
    background: rgba(255,255,255,.03); cursor: pointer; transition: all .15s;
    font-size: 15px; font-weight: 600; color: var(--fg); font-family: var(--font);
}
.toggle-btn:hover { background: rgba(255,255,255,.07); border-color: var(--accent); }
.toggle-btn.on { border-color: var(--green); background: rgba(34,197,94,.06); }
.toggle-btn.on .dot { background: var(--green); box-shadow: 0 0 8px var(--green); }
.toggle-btn.off .dot { background: var(--red); }
.dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; transition: all .2s; }
.toggle-label { flex: 1; text-align: left; }
.toggle-ide { font-size: 11px; opacity: 0.5; font-weight: 400; }

/* ── Stats row ── */
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 28px; }
.stat-card {
    padding: 14px 16px; border-radius: 8px;
    background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.06);
}
.stat-val { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
.stat-lbl { font-size: 11px; opacity: 0.5; margin-top: 2px; }
.stat-card.green .stat-val { color: var(--green); }
.stat-card.red   .stat-val { color: var(--red); }
.stat-card.acc   .stat-val { color: var(--accent); }

/* ── Sections ── */
.section { margin-bottom: 24px; }
.section-title { font-size: 11px; font-weight: 600; letter-spacing: .6px; text-transform: uppercase; opacity: .45; margin-bottom: 10px; }
label { display: block; font-size: 13px; margin-bottom: 6px; font-weight: 500; }
.hint { font-size: 11px; opacity: .45; margin-top: 5px; line-height: 1.4; }

input[type=range] { width: 100%; cursor: pointer; accent-color: var(--accent); }
.range-row { display: flex; align-items: center; gap: 12px; }
.range-val { font-size: 13px; font-weight: 600; min-width: 44px; text-align: right; opacity: .85; }

input[type=number] {
    width: 100px; background: var(--input-bg); color: var(--fg);
    border: 1px solid var(--input-bd); border-radius: 6px;
    padding: 6px 10px; font-size: 13px; font-family: var(--mono);
}
input[type=number]:focus { outline: none; border-color: var(--accent); }

textarea {
    width: 100%; min-height: 130px; resize: vertical;
    background: var(--input-bg); color: var(--fg);
    border: 1px solid var(--input-bd); border-radius: 6px;
    padding: 10px 12px; font-size: 12px; font-family: var(--mono);
    line-height: 1.6;
}
textarea:focus { outline: none; border-color: var(--accent); }

/* ── Buttons ── */
.btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
button.btn {
    padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px;
    font-family: var(--font); font-weight: 500; border: none; transition: all .12s;
}
button.btn-primary { background: var(--btn-bg); color: var(--btn-fg); }
button.btn-primary:hover { background: var(--btn-hov); }
button.btn-secondary {
    background: rgba(255,255,255,.05); color: var(--fg);
    border: 1px solid rgba(255,255,255,.1);
}
button.btn-secondary:hover { background: rgba(255,255,255,.09); }

/* ── Toast ── */
.toast {
    position: fixed; bottom: 20px; right: 20px;
    background: var(--green); color: #000; font-weight: 600;
    padding: 10px 18px; border-radius: 8px; font-size: 13px;
    opacity: 0; transform: translateY(8px); transition: all .2s;
    pointer-events: none;
}
.toast.show { opacity: 1; transform: translateY(0); }

/* ── Help box ── */
.help-box {
    padding: 12px 16px; border-radius: 8px; font-size: 12px; line-height: 1.6;
    background: rgba(124,106,247,.06); border: 1px solid rgba(124,106,247,.15);
    margin-bottom: 24px;
}
.help-box code {
    background: rgba(255,255,255,.08); padding: 2px 6px; border-radius: 3px;
    font-family: var(--mono); font-size: 11px;
}

/* ── Footer ── */
.footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,.06); display: flex; justify-content: space-between; align-items: center; }
.footer-logo { font-size: 11px; opacity: .35; font-weight: 600; letter-spacing: .3px; }
.footer-links { display: flex; gap: 14px; }
.footer-links a { font-size: 11px; opacity: .4; color: var(--fg); text-decoration: none; cursor: pointer; }
.footer-links a:hover { opacity: .8; }
</style>
</head>
<body>

<div class="header">
    <div class="header-logo">&#9889;</div>
    <div>
        <div class="header-title">Shadow Accept</div>
        <div class="header-sub">by NakedoMedia — nakedo.ai — Free forever</div>
    </div>
</div>

<!-- Connection status -->
<div class="conn-badge ${connClass}" id="connBadge">
    <span class="conn-dot"></span>
    <span id="connLabel">${connLabel}</span>
</div>

<!-- Toggle -->
<button class="toggle-btn ${enabled ? 'on' : 'off'}" id="toggleBtn" onclick="toggleAccept()">
    <span class="dot" id="dot"></span>
    <span class="toggle-label" id="toggleLabel">${enabled ? 'Auto Accept is ON' : 'Auto Accept is OFF'}</span>
    <span class="toggle-ide" id="toggleIde">${ide}</span>
</button>

<!-- Stats -->
<div class="stats">
    <div class="stat-card green">
        <div class="stat-val" id="statClicks">0</div>
        <div class="stat-lbl">Session accepts</div>
    </div>
    <div class="stat-card acc">
        <div class="stat-val" id="statTotal">${totalClicks}</div>
        <div class="stat-lbl">All-time accepts</div>
    </div>
    <div class="stat-card red">
        <div class="stat-val" id="statBlocked">0</div>
        <div class="stat-lbl">Blocked commands</div>
    </div>
</div>

<!-- Help box (shown when not connected) -->
<div class="help-box" id="helpBox" style="${connected ? 'display:none' : ''}">
    <strong>Not connected?</strong> Launch your IDE with the debug flag:<br>
    <code>${ide === 'Cursor' ? 'cursor' : ide === 'Antigravity' ? 'antigravity' : 'code'} --remote-debugging-port=9222</code><br>
    Or set a custom port below if your IDE uses a different one.
</div>

<!-- Debug port -->
<div class="section">
    <div class="section-title">Connection</div>
    <label for="debugPort">Custom debug port (0 = auto-scan)</label>
    <input type="number" id="debugPort" min="0" max="65535" value="${cfg.debugPort || 0}">
    <p class="hint">If your IDE uses a specific debug port, set it here for faster connection. Leave 0 for automatic scanning.</p>
</div>

<!-- Poll interval -->
<div class="section">
    <div class="section-title">Performance</div>
    <label for="pollRange">Poll interval</label>
    <div class="range-row">
        <input type="range" id="pollRange" min="300" max="3000" step="100" value="${cfg.pollInterval}" oninput="updatePollLabel()">
        <span class="range-val" id="pollLabel">${cfg.pollInterval} ms</span>
    </div>
    <p class="hint">How often Shadow Accept scans for buttons. 300ms = fastest · 3000ms = most conservative. Default: 800ms.</p>
</div>

<!-- Banned commands -->
<div class="section">
    <div class="section-title">Safety</div>
    <label for="bannedArea">Banned command patterns</label>
    <textarea id="bannedArea" placeholder="One pattern per line.\nSupports /regex/flags syntax.">${bannedStr}</textarea>
    <p class="hint">Run/execute buttons are <strong>never</strong> clicked if the nearby terminal command matches one of these patterns.</p>
</div>

<!-- Actions -->
<div class="btn-row">
    <button class="btn btn-primary" onclick="save()">Save settings</button>
    <button class="btn btn-secondary" onclick="resetDefaults()">Reset defaults</button>
    <button class="btn btn-secondary" onclick="showLog()">View log</button>
</div>

<!-- Footer -->
<div class="footer">
    <span class="footer-logo">NAKEDO CORP</span>
    <div class="footer-links">
        <a onclick="openWebsite()">nakedo.ai</a>
        <a onclick="openGitHub()">GitHub</a>
        <a onclick="reportIssue()">Report issue</a>
    </div>
</div>

<div class="toast" id="toast"></div>

<script>
const vscode = acquireVsCodeApi();
let refreshInterval;

// ── Init ────────────────────────────────────────────────────────────────────

window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'stats') {
        document.getElementById('statClicks').textContent  = m.clicks  ?? 0;
        document.getElementById('statBlocked').textContent = m.blocked ?? 0;
        document.getElementById('statTotal').textContent   = m.total   ?? 0;
        const on = !!m.enabled;
        const btn = document.getElementById('toggleBtn');
        btn.className = 'toggle-btn ' + (on ? 'on' : 'off');
        document.getElementById('toggleLabel').textContent = on ? 'Auto Accept is ON' : 'Auto Accept is OFF';
        document.getElementById('toggleIde').textContent   = m.ide || '';

        // Update connection badge
        const badge = document.getElementById('connBadge');
        const label = document.getElementById('connLabel');
        const helpBox = document.getElementById('helpBox');
        if (m.connected) {
            badge.className = 'conn-badge conn-ok';
            label.textContent = 'Connected on port ' + (m.port || '?');
            helpBox.style.display = 'none';
        } else if (on) {
            badge.className = 'conn-badge conn-err';
            label.textContent = 'Searching for CDP...';
            helpBox.style.display = '';
        } else {
            badge.className = 'conn-badge conn-err';
            label.textContent = 'Disabled';
            helpBox.style.display = 'none';
        }
    }
    if (m.type === 'saved') {
        showToast('Settings saved');
    }
});

function refresh() { vscode.postMessage({ type: 'getStats' }); }
refresh();
refreshInterval = setInterval(refresh, 1500);

// ── Actions ─────────────────────────────────────────────────────────────────

function toggleAccept() { vscode.postMessage({ type: 'toggle' }); }

function updatePollLabel() {
    document.getElementById('pollLabel').textContent = document.getElementById('pollRange').value + ' ms';
}

function save() {
    vscode.postMessage({
        type:           'save',
        pollInterval:   parseInt(document.getElementById('pollRange').value, 10),
        debugPort:      parseInt(document.getElementById('debugPort').value, 10) || 0,
        bannedCommands: document.getElementById('bannedArea').value
            .split('\\n').map(s => s.trim()).filter(Boolean),
    });
}

function resetDefaults() {
    document.getElementById('pollRange').value = 800;
    document.getElementById('debugPort').value = 0;
    updatePollLabel();
    document.getElementById('bannedArea').value = [
        'rm -rf /', 'rm -rf ~', 'rm -rf *', 'format c:',
        'del /f /s /q', 'rmdir /s /q', ':(){:|:&};:',
        'dd if=', 'mkfs.', '> /dev/sda', 'chmod -R 777 /',
    ].join('\\n');
    showToast('Defaults restored');
}

function showLog()       { vscode.postMessage({ type: 'openOutput' }); }
function openGitHub()    { vscode.postMessage({ type: 'openLink', url: 'https://github.com/NakedoMedia/shadow-accept' }); }
function reportIssue()   { vscode.postMessage({ type: 'openLink', url: 'https://github.com/NakedoMedia/shadow-accept/issues' }); }
function openWebsite()   { vscode.postMessage({ type: 'openLink', url: 'https://nakedo.ai' }); }

// ── Toast ───────────────────────────────────────────────────────────────────

function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2200);
}
</script>
</body>
</html>`;
}

// ─── Activation ───────────────────────────────────────────────────────────────

async function activate(context) {
    globalContext = context;
    currentIDE    = detectIDE();

    outputChannel = vscode.window.createOutputChannel('Shadow Accept');
    context.subscriptions.push(outputChannel);

    log(`Shadow Accept v1.1 activating on ${currentIDE}`);

    cdpHandler = new CDPHandler(log);

    // Apply custom port from config
    const cfg = getConfig();
    if (cfg.debugPort > 0) {
        cdpHandler.setCustomPorts([cfg.debugPort]);
    }

    // ── Status bar ────────────────────────────────────────────────────────────
    statusBarItem         = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'shadow-accept.toggle';
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();

    // ── Restore state ─────────────────────────────────────────────────────────
    isEnabled = context.globalState.get(STATE_ENABLED_KEY, cfg.enableOnStartup);
    updateStatusBar();

    if (isEnabled) {
        log('Restoring enabled state...');
        startPolling();
    }

    // ── Commands ──────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('shadow-accept.toggle',       () => cmdToggle(context)),
        vscode.commands.registerCommand('shadow-accept.openSettings', () => cmdOpenSettings(context)),
    );

    // ── Config watcher ────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('shadowAccept')) {
                const newCfg = getConfig();
                if (newCfg.debugPort > 0) {
                    cdpHandler.setCustomPorts([newCfg.debugPort]);
                }
                if (isEnabled) {
                    log('Config changed, restarting poll');
                    startPolling();
                }
            }
        })
    );

    // ── First-launch hint ─────────────────────────────────────────────────────
    const hasSeenWelcome = context.globalState.get('shadow-accept.welcomed', false);
    if (!hasSeenWelcome) {
        await context.globalState.update('shadow-accept.welcomed', true);
        vscode.window.showInformationMessage(
            'Shadow Accept by Nakedo Corp is ready. Click the status bar to enable.',
            'Enable now', 'Settings'
        ).then(choice => {
            if (choice === 'Enable now') cmdToggle(context);
            if (choice === 'Settings')   cmdOpenSettings(context);
        });
    }

    log('Activation complete.');
}

function deactivate() {
    stopPolling();
    if (globalContext && sessionClicks > 0) {
        const prev = globalContext.globalState.get(STATE_TOTAL_CLICKS) ?? 0;
        globalContext.globalState.update(STATE_TOTAL_CLICKS, prev + sessionClicks);
    }
    log('Deactivated.');
}

module.exports = { activate, deactivate };
