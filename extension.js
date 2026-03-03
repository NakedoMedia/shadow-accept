/**
 * Shadow Accept — VS Code Extension
 * by Nakedo Corp — MIT License
 *
 * Premium open-source auto-accept for AI agent prompts.
 * VS Code · Antigravity · Cursor
 * 100% free · no limits · no telemetry · no external API
 */

'use strict';

const vscode = require('vscode');
const { CDPHandler } = require('./main_scripts/cdp-handler');

// ─── Constants ────────────────────────────────────────────────────────────────

const STATE_ENABLED_KEY  = 'shadow-accept.enabled';
const STATE_TOTAL_CLICKS = 'shadow-accept.totalClicks';

// ─── Module-level state ───────────────────────────────────────────────────────

let isEnabled      = false;
let pollTimer      = null;
let statusBarItem  = null;
let outputChannel  = null;
let cdpHandler     = null;
let globalContext  = null;
let currentIDE     = 'Code';
let sessionClicks  = 0;

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
    return 'Code';
}

function getConfig() {
    const cfg = vscode.workspace.getConfiguration('shadowAccept');
    return {
        pollInterval:    cfg.get('pollInterval',    800),
        bannedCommands:  cfg.get('bannedCommands',  getDefaultBannedCommands()),
        enableOnStartup: cfg.get('enableOnStartup', false),
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
        statusBarItem.text            = `$(check) Shadow${clickLabel}`;
        statusBarItem.tooltip         = `Shadow Accept is ON — ${totalClicks} auto-accepted total\nClick to disable`;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusBarItem.color           = undefined;
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

// ─── Polling ──────────────────────────────────────────────────────────────────

async function runPollCycle() {
    if (!isEnabled || !cdpHandler) return;
    const cfg = getConfig();
    try {
        await cdpHandler.start({
            ide:            currentIDE,
            pollInterval:   cfg.pollInterval,
            bannedCommands: cfg.bannedCommands,
        });
        // Refresh click count from CDP
        const stats = await cdpHandler.getStats();
        if (stats.clicks !== sessionClicks) {
            sessionClicks = stats.clicks;
            updateStatusBar();
        }
    } catch (e) {
        log(`[Poll] ${e.message}`);
    }
}

function startPolling() {
    stopPolling();
    const { pollInterval } = getConfig();
    log(`Polling every ${pollInterval}ms on ${currentIDE}`);
    runPollCycle();
    pollTimer = setInterval(runPollCycle, pollInterval);
}

function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    cdpHandler?.stop().catch(() => {});
}

// ─── Toggle command ───────────────────────────────────────────────────────────

async function cmdToggle(context) {
    isEnabled = !isEnabled;
    await context.globalState.update(STATE_ENABLED_KEY, isEnabled);
    updateStatusBar();

    if (isEnabled) {
        log('Enabled');
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

    panel.webview.html = buildSettingsHTML(cfg, bannedStr, totalClicks, currentIDE, isEnabled);

    panel.webview.onDidReceiveMessage(async msg => {
        switch (msg.type) {

            case 'getStats': {
                const stats = cdpHandler ? await cdpHandler.getStats() : { clicks: 0, blocked: 0, uptime: 0 };
                const total = (context.globalState.get(STATE_TOTAL_CLICKS) ?? 0) + stats.clicks;
                panel.webview.postMessage({ type: 'stats', ...stats, total, enabled: isEnabled, ide: currentIDE });
                break;
            }

            case 'toggle': {
                await cmdToggle(context);
                const stats2 = cdpHandler ? await cdpHandler.getStats() : { clicks: 0, blocked: 0 };
                const total2 = (context.globalState.get(STATE_TOTAL_CLICKS) ?? 0) + stats2.clicks;
                panel.webview.postMessage({ type: 'stats', ...stats2, total: total2, enabled: isEnabled, ide: currentIDE });
                break;
            }

            case 'save': {
                const wcfg = vscode.workspace.getConfiguration('shadowAccept');
                await wcfg.update('pollInterval',   msg.pollInterval,   vscode.ConfigurationTarget.Global);
                await wcfg.update('bannedCommands', msg.bannedCommands, vscode.ConfigurationTarget.Global);
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

function buildSettingsHTML(cfg, bannedStr, totalClicks, ide, enabled) {
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
    <div class="header-logo">⚡</div>
    <div>
        <div class="header-title">Shadow Accept</div>
        <div class="header-sub">by NakedoMedia — nakedo.ai — Free forever</div>
    </div>
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
    }
    if (m.type === 'saved') {
        showToast('Settings saved ✓');
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
        bannedCommands: document.getElementById('bannedArea').value
            .split('\\n').map(s => s.trim()).filter(Boolean),
    });
}

function resetDefaults() {
    document.getElementById('pollRange').value = 800;
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

    log(`Shadow Accept activating on ${currentIDE} (v${require('./package.json').version})`);

    cdpHandler = new CDPHandler(log);

    // ── Status bar ────────────────────────────────────────────────────────────
    statusBarItem         = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'shadow-accept.toggle';
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();

    // ── Restore state ─────────────────────────────────────────────────────────
    const cfg = getConfig();
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
            if (e.affectsConfiguration('shadowAccept') && isEnabled) {
                log('Config changed → restarting poll');
                startPolling();
            }
        })
    );

    // ── Link handler from webview ─────────────────────────────────────────────
    // (handled in cmdOpenSettings via onDidReceiveMessage)

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
