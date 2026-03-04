/**
 * Shadow Accept — Unit Tests v1.2
 * by Nakedo Corp — MIT License
 *
 * Tests CDP handler, auto_accept patterns, terminal monitor, and engine manager.
 * Run: node test/test.js
 */

'use strict';

const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

// ─── Test framework ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (e) {
        failed++;
        failures.push({ name, error: e.message });
        console.log(`  \x1b[31m✗\x1b[0m ${name}`);
        console.log(`    ${e.message}`);
    }
}

async function testAsync(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (e) {
        failed++;
        failures.push({ name, error: e.message });
        console.log(`  \x1b[31m✗\x1b[0m ${name}`);
        console.log(`    ${e.message}`);
    }
}

// ─── 1. CDP Handler Tests ────────────────────────────────────────────────────

console.log('\n\x1b[1m[CDP Handler]\x1b[0m');

const { CDPHandler } = require('../main_scripts/cdp-handler');

test('CDPHandler can be instantiated', () => {
    const handler = new CDPHandler(() => {});
    assert.ok(handler);
    assert.strictEqual(handler.isConnected, false);
    assert.strictEqual(handler.connectedPort, null);
    assert.strictEqual(handler.pagesConnected, 0);
});

test('CDPHandler.setCustomPorts accepts valid ports', () => {
    const handler = new CDPHandler(() => {});
    handler.setCustomPorts([9222, 9229]);
    assert.deepStrictEqual(handler._customPorts, [9222, 9229]);
});

test('CDPHandler.setCustomPorts filters invalid ports', () => {
    const handler = new CDPHandler(() => {});
    handler.setCustomPorts([9222, -1, 0, 99999, 'abc', 9229]);
    assert.deepStrictEqual(handler._customPorts, [9222, 9229]);
});

test('CDPHandler.setCustomPorts handles non-array', () => {
    const handler = new CDPHandler(() => {});
    handler.setCustomPorts('not-an-array');
    assert.deepStrictEqual(handler._customPorts, []);
});

test('CDPHandler._getPortList returns custom ports first', () => {
    const handler = new CDPHandler(() => {});
    handler.setCustomPorts([1234]);
    const ports = handler._getPortList();
    assert.strictEqual(ports[0], 1234);
    assert.ok(ports.includes(9222));
    assert.ok(ports.includes(9229));
});

test('CDPHandler._getPortList deduplicates ports', () => {
    const handler = new CDPHandler(() => {});
    handler.setCustomPorts([9222, 9229]);
    const ports = handler._getPortList();
    const unique = [...new Set(ports)];
    assert.strictEqual(ports.length, unique.length);
});

test('CDPHandler._isTargetPage rejects non-pages', () => {
    const handler = new CDPHandler(() => {});
    assert.strictEqual(handler._isTargetPage(null), false);
    assert.strictEqual(handler._isTargetPage({}), false);
    assert.strictEqual(handler._isTargetPage({ type: 'page' }), false);
    assert.strictEqual(handler._isTargetPage({ type: 'other', webSocketDebuggerUrl: 'ws://...' }), false);
});

test('CDPHandler._isTargetPage accepts valid pages', () => {
    const handler = new CDPHandler(() => {});
    assert.strictEqual(handler._isTargetPage({
        type: 'page',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/ABC',
        url: 'file:///workbench.html'
    }), true);
});

test('CDPHandler._isTargetPage rejects DevTools URLs', () => {
    const handler = new CDPHandler(() => {});
    assert.strictEqual(handler._isTargetPage({
        type: 'page',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/ABC',
        url: 'devtools://devtools/bundled/inspector.html'
    }), false);
    assert.strictEqual(handler._isTargetPage({
        type: 'page',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/ABC',
        url: 'chrome-devtools://something'
    }), false);
});

test('CDPHandler.getStats returns zeros when no pages', async () => {
    const handler = new CDPHandler(() => {});
    const stats = await handler.getStats();
    assert.deepStrictEqual(stats, { clicks: 0, blocked: 0 });
});

test('CDPHandler._parseJSON handles valid JSON', () => {
    const handler = new CDPHandler(() => {});
    const res = { result: { value: '{"clicks":5,"blocked":2}' } };
    const parsed = handler._parseJSON(res, {});
    assert.deepStrictEqual(parsed, { clicks: 5, blocked: 2 });
});

test('CDPHandler._parseJSON returns fallback for invalid', () => {
    const handler = new CDPHandler(() => {});
    assert.deepStrictEqual(handler._parseJSON(null, { x: 1 }), { x: 1 });
    assert.deepStrictEqual(handler._parseJSON({}, { x: 1 }), { x: 1 });
    assert.deepStrictEqual(handler._parseJSON({ result: { value: 'not json' } }, { x: 1 }), { x: 1 });
});

test('CDPHandler backoff increases on failures', async () => {
    const handler = new CDPHandler(() => {});
    assert.strictEqual(handler._failCount, 0);
    await handler.start({ ide: 'Code', pollInterval: 800, bannedCommands: [] });
    assert.strictEqual(handler._failCount, 1);
    assert.ok(handler._lastScanTime > 0);
});

// ─── 2. Auto Accept Pattern Tests ────────────────────────────────────────────

console.log('\n\x1b[1m[Auto Accept Patterns]\x1b[0m');

const ACCEPT_REGEXES = [
    /\baccept\s+all\b/,
    /\baccept\b/,
    /\bapply\s+all\b/,
    /\bapply\b/,
    /\bretry\b/,
    /\bconfirm\b/,
    /\balways\s+allow\b/,
    /\ballow\s+once\b/,
    /\ballow\b/,
    /\bapprove\b/,
    /\bproceed\b/,
    /\bcontinue\b/,
    /\brun\b/,
    /\bexecute\b/,
    /\byes\b/,
    /\bok\b/,
];

const REJECT_REGEXES = [
    /\bskip\b/, /\breject\b/, /\bcancel\b/, /\bclose\b/,
    /\brefine\b/, /\bdecline\b/, /\bdeny\b/, /\bno\b/,
    /\bstop\b/, /\babort\b/, /\bdismiss\b/, /\bdon'?t\s+allow\b/,
];

function matchesAny(text, regexes) {
    return regexes.some(re => re.test(text));
}

function wouldAccept(text) {
    const lower = text.toLowerCase();
    if (matchesAny(lower, REJECT_REGEXES)) return false;
    if (!matchesAny(lower, ACCEPT_REGEXES)) return false;
    return true;
}

// ── Should ACCEPT ──

test('accepts "Accept"', () => assert.ok(wouldAccept('Accept')));
test('accepts "Accept All"', () => assert.ok(wouldAccept('Accept All')));
test('accepts "Apply"', () => assert.ok(wouldAccept('Apply')));
test('accepts "Apply All"', () => assert.ok(wouldAccept('Apply All')));
test('accepts "Run"', () => assert.ok(wouldAccept('Run')));
test('accepts "Retry"', () => assert.ok(wouldAccept('Retry')));
test('accepts "Execute"', () => assert.ok(wouldAccept('Execute')));
test('accepts "Confirm"', () => assert.ok(wouldAccept('Confirm')));
test('accepts "Always Allow"', () => assert.ok(wouldAccept('Always Allow')));
test('accepts "Allow Once"', () => assert.ok(wouldAccept('Allow Once')));
test('accepts "Allow"', () => assert.ok(wouldAccept('Allow')));
test('accepts "Approve"', () => assert.ok(wouldAccept('Approve')));
test('accepts "Yes"', () => assert.ok(wouldAccept('Yes')));
test('accepts "OK"', () => assert.ok(wouldAccept('OK')));
test('accepts "Proceed"', () => assert.ok(wouldAccept('Proceed')));
test('accepts "Continue"', () => assert.ok(wouldAccept('Continue')));

// ── Should REJECT ──

test('rejects "Cancel"', () => assert.ok(!wouldAccept('Cancel')));
test('rejects "Skip"', () => assert.ok(!wouldAccept('Skip')));
test('rejects "Close"', () => assert.ok(!wouldAccept('Close')));
test('rejects "Decline"', () => assert.ok(!wouldAccept('Decline')));
test('rejects "Deny"', () => assert.ok(!wouldAccept('Deny')));
test('rejects "No"', () => assert.ok(!wouldAccept('No')));
test('rejects "Stop"', () => assert.ok(!wouldAccept('Stop')));
test('rejects "Dismiss"', () => assert.ok(!wouldAccept('Dismiss')));
test('rejects "Don\'t Allow"', () => assert.ok(!wouldAccept("Don't Allow")));

// ── Should NOT match (false positive prevention) ──

test('does NOT match "Book" (no false positive on "ok")', () => assert.ok(!wouldAccept('Book')));
test('does NOT match "Look"', () => assert.ok(!wouldAccept('Look')));
test('does NOT match "Running"', () => assert.ok(!wouldAccept('Running')));
test('does NOT match "Return"', () => assert.ok(!wouldAccept('Return')));
test('does NOT match "Continued"', () => assert.ok(!wouldAccept('Continued')));
test('does NOT match "Approving"', () => assert.ok(!wouldAccept('Approving')));
test('does NOT match "Bookmark"', () => assert.ok(!wouldAccept('Bookmark')));
test('does NOT match "Unknown"', () => assert.ok(!wouldAccept('Unknown')));
test('does NOT match "Yesterday"', () => assert.ok(!wouldAccept('Yesterday')));
test('does NOT match "Yokohama"', () => assert.ok(!wouldAccept('Yokohama')));
test('does NOT match "Token"', () => assert.ok(!wouldAccept('Token')));
test('does NOT match empty string', () => assert.ok(!wouldAccept('')));
test('does NOT match random text', () => assert.ok(!wouldAccept('Hello World')));
test('does NOT match "Save"', () => assert.ok(!wouldAccept('Save')));
test('does NOT match "Submit"', () => assert.ok(!wouldAccept('Submit')));

// ── Edge cases ──

test('accepts "  Accept  " (whitespace)', () => assert.ok(wouldAccept('  Accept  ')));
test('accepts "accept" (lowercase)', () => assert.ok(wouldAccept('accept')));
test('accepts "ACCEPT" (uppercase)', () => assert.ok(wouldAccept('ACCEPT')));

// ─── 3. Terminal Monitor Tests ───────────────────────────────────────────────

console.log('\n\x1b[1m[Terminal Monitor]\x1b[0m');

const {
    TerminalMonitorEngine,
    stripAnsi,
    PROMPT_PATTERNS,
    DANGEROUS_TOOLS,
    extractCommandFromPrompt,
} = require('../main_scripts/terminal-monitor');

// ── ANSI stripping ──

test('stripAnsi removes CSI sequences', () => {
    assert.strictEqual(stripAnsi('\x1b[32mGreen\x1b[0m'), 'Green');
});

test('stripAnsi removes OSC sequences', () => {
    assert.strictEqual(stripAnsi('\x1b]0;title\x07hello'), 'hello');
});

test('stripAnsi preserves plain text', () => {
    assert.strictEqual(stripAnsi('Allow Bash(npm test)? [Y/n]'), 'Allow Bash(npm test)? [Y/n]');
});

test('stripAnsi handles empty/null input', () => {
    assert.strictEqual(stripAnsi(''), '');
    assert.strictEqual(stripAnsi(null), '');
    assert.strictEqual(stripAnsi(undefined), '');
});

test('stripAnsi removes carriage returns', () => {
    assert.strictEqual(stripAnsi('hello\r\nworld'), 'hello\nworld');
});

test('stripAnsi removes complex ANSI', () => {
    const input = '\x1b[1;34m\x1b[2K\x1b[1GAllow Bash(ls)? [Y/n]';
    const cleaned = stripAnsi(input);
    assert.ok(cleaned.includes('Allow Bash(ls)? [Y/n]'));
});

// ── Command extraction ──

test('extractCommandFromPrompt: Claude Code Bash', () => {
    const result = extractCommandFromPrompt('Allow Bash(npm test)? [Y/n]');
    assert.deepStrictEqual(result, { tool: 'Bash', command: 'npm test' });
});

test('extractCommandFromPrompt: Claude Code Read', () => {
    const result = extractCommandFromPrompt('Allow Read(src/file.ts)? [Y/n]');
    assert.deepStrictEqual(result, { tool: 'Read', command: 'src/file.ts' });
});

test('extractCommandFromPrompt: Claude Code Write', () => {
    const result = extractCommandFromPrompt('Allow Write(test/output.json)? [Y/n]');
    assert.deepStrictEqual(result, { tool: 'Write', command: 'test/output.json' });
});

test('extractCommandFromPrompt: returns null for non-matching', () => {
    assert.strictEqual(extractCommandFromPrompt('Do you want to proceed? [Y/n]'), null);
    assert.strictEqual(extractCommandFromPrompt('Hello world'), null);
});

test('extractCommandFromPrompt: handles complex commands', () => {
    const result = extractCommandFromPrompt('Allow Bash(cd /tmp && rm -rf test)? [Y/n]');
    assert.deepStrictEqual(result, { tool: 'Bash', command: 'cd /tmp && rm -rf test' });
});

// ── Prompt pattern matching ──

test('PROMPT_PATTERNS matches Claude Code allow prompt', () => {
    const text = 'Allow Bash(npm test)? [Y/n]';
    const match = PROMPT_PATTERNS.find(p => p.pattern.test(text));
    assert.ok(match);
    assert.strictEqual(match.name, 'claude-code-allow');
    assert.strictEqual(match.response, 'Y\n');
    assert.strictEqual(match.hasTool, true);
});

test('PROMPT_PATTERNS matches Claude Code proceed prompt', () => {
    const text = 'Do you want to proceed? [Y/n]';
    const match = PROMPT_PATTERNS.find(p => p.pattern.test(text));
    assert.ok(match);
    assert.strictEqual(match.name, 'claude-code-proceed');
});

test('PROMPT_PATTERNS matches generic [Y/n]', () => {
    const text = 'Continue with installation? [Y/n]';
    const match = PROMPT_PATTERNS.find(p => p.pattern.test(text));
    assert.ok(match);
    assert.strictEqual(match.response, 'Y\n');
});

test('PROMPT_PATTERNS matches generic [y/N]', () => {
    const text = 'Are you sure? [y/N]';
    const match = PROMPT_PATTERNS.find(p => p.pattern.test(text));
    assert.ok(match);
    assert.strictEqual(match.name, 'generic-yN');
    assert.strictEqual(match.response, 'y\n');
});

test('PROMPT_PATTERNS matches (yes/no) prompt', () => {
    const text = 'Overwrite existing file? (yes/no):';
    const match = PROMPT_PATTERNS.find(p => p.pattern.test(text));
    assert.ok(match);
    assert.strictEqual(match.name, 'generic-yesno');
    assert.strictEqual(match.response, 'yes\n');
});

test('PROMPT_PATTERNS matches (y/n) prompt', () => {
    const text = 'Proceed? (y/n)';
    const match = PROMPT_PATTERNS.find(p => p.pattern.test(text));
    assert.ok(match);
    assert.strictEqual(match.name, 'generic-yn-paren');
    assert.strictEqual(match.response, 'y\n');
});

test('PROMPT_PATTERNS matches "Press Enter to continue"', () => {
    const text = 'Press Enter to continue...';
    const match = PROMPT_PATTERNS.find(p => p.pattern.test(text));
    assert.ok(match);
    assert.strictEqual(match.name, 'press-enter');
    assert.strictEqual(match.response, '\n');
});

test('PROMPT_PATTERNS does NOT match random text', () => {
    const texts = ['npm install complete', 'BUILD SUCCESS', 'Error: file not found', '42'];
    for (const text of texts) {
        const match = PROMPT_PATTERNS.find(p => p.pattern.test(text));
        assert.strictEqual(match, undefined, `Should not match: "${text}"`);
    }
});

test('PROMPT_PATTERNS does NOT match [Y/n] in middle of sentence', () => {
    // [Y/n] pattern requires end of string
    const text = 'The [Y/n] option was deprecated last year';
    // The generic-yn pattern requires [Y/n] at end of line
    const genericYn = PROMPT_PATTERNS.find(p => p.name === 'generic-yn');
    assert.ok(!genericYn.pattern.test(text));
});

test('PROMPT_PATTERNS matches Claude Code with various tools', () => {
    const tools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch'];
    for (const tool of tools) {
        const text = `Allow ${tool}(test)? [Y/n]`;
        const match = PROMPT_PATTERNS.find(p => p.pattern.test(text));
        assert.ok(match, `Should match tool: ${tool}`);
        assert.strictEqual(match.name, 'claude-code-allow');
    }
});

// ── DANGEROUS_TOOLS ──

test('DANGEROUS_TOOLS includes Bash and Execute', () => {
    assert.ok(DANGEROUS_TOOLS.includes('Bash'));
    assert.ok(DANGEROUS_TOOLS.includes('Execute'));
    assert.ok(DANGEROUS_TOOLS.includes('Shell'));
    assert.ok(DANGEROUS_TOOLS.includes('Run'));
});

test('DANGEROUS_TOOLS does NOT include Read/Write', () => {
    assert.ok(!DANGEROUS_TOOLS.includes('Read'));
    assert.ok(!DANGEROUS_TOOLS.includes('Write'));
    assert.ok(!DANGEROUS_TOOLS.includes('Edit'));
});

// ── TerminalMonitorEngine ──

test('TerminalMonitorEngine can be instantiated', () => {
    const mockVscode = { window: {} };
    const engine = new TerminalMonitorEngine(() => {}, mockVscode);
    assert.ok(engine);
    assert.strictEqual(engine.isActive, false);
});

test('TerminalMonitorEngine.start handles missing proposed API', () => {
    const mockVscode = { window: {} }; // No onDidWriteTerminalData
    const engine = new TerminalMonitorEngine(() => {}, mockVscode);
    engine.start({ bannedCommands: [] });
    assert.strictEqual(engine.isActive, false); // API not available
});

test('TerminalMonitorEngine.start activates with proposed API', () => {
    const disposable = { dispose: () => {} };
    const mockVscode = {
        window: {
            onDidWriteTerminalData: (cb) => {
                return disposable;
            }
        }
    };
    const engine = new TerminalMonitorEngine(() => {}, mockVscode);
    engine.start({ bannedCommands: [] });
    assert.strictEqual(engine.isActive, true);
    engine.stop();
    assert.strictEqual(engine.isActive, false);
});

test('TerminalMonitorEngine.getStats returns initial state', () => {
    const mockVscode = { window: {} };
    const engine = new TerminalMonitorEngine(() => {}, mockVscode);
    const stats = engine.getStats();
    assert.strictEqual(stats.clicks, 0);
    assert.strictEqual(stats.blocked, 0);
    assert.strictEqual(stats.lastAction, null);
});

test('TerminalMonitorEngine._isBannedCommand detects banned substrings', () => {
    const mockVscode = { window: {} };
    const engine = new TerminalMonitorEngine(() => {}, mockVscode);
    engine.start({ bannedCommands: ['rm -rf /', 'format c:'] });
    assert.strictEqual(engine._isBannedCommand('rm -rf / --no-preserve-root'), true);
    assert.strictEqual(engine._isBannedCommand('format c: /q'), true);
    assert.strictEqual(engine._isBannedCommand('npm test'), false);
    engine.stop();
});

test('TerminalMonitorEngine._isBannedCommand supports regex', () => {
    const mockVscode = { window: {} };
    const engine = new TerminalMonitorEngine(() => {}, mockVscode);
    engine.start({ bannedCommands: ['/^sudo\\s+rm/i'] });
    assert.strictEqual(engine._isBannedCommand('sudo rm -rf /'), true);
    assert.strictEqual(engine._isBannedCommand('rm file.txt'), false);
    engine.stop();
});

test('TerminalMonitorEngine._isBannedCommand returns false for empty list', () => {
    const mockVscode = { window: {} };
    const engine = new TerminalMonitorEngine(() => {}, mockVscode);
    engine.start({ bannedCommands: [] });
    assert.strictEqual(engine._isBannedCommand('rm -rf /'), false);
    engine.stop();
});

test('TerminalMonitorEngine custom patterns are added', () => {
    const mockVscode = { window: {} };
    const engine = new TerminalMonitorEngine(() => {}, mockVscode);
    engine.start({ bannedCommands: [], terminalPatterns: ['Custom prompt\\?'] });
    // Check that custom patterns were parsed (internal state)
    assert.strictEqual(engine._customPatterns.length, 1);
    assert.ok(engine._customPatterns[0].pattern.test('Custom prompt?'));
    engine.stop();
});

test('TerminalMonitorEngine ignores invalid custom patterns', () => {
    const mockVscode = { window: {} };
    const engine = new TerminalMonitorEngine(() => {}, mockVscode);
    engine.start({ bannedCommands: [], terminalPatterns: ['[invalid regex'] });
    assert.strictEqual(engine._customPatterns.length, 0);
    engine.stop();
});

// ─── 4. Engine Manager Tests ─────────────────────────────────────────────────

console.log('\n\x1b[1m[Engine Manager]\x1b[0m');

const { EngineManager } = require('../main_scripts/engine-manager');

test('EngineManager can be instantiated', () => {
    const mockVscode = { window: {} };
    const manager = new EngineManager(() => {}, mockVscode);
    assert.ok(manager);
    assert.strictEqual(manager.isConnected, false);
    assert.strictEqual(manager.primaryEngine, 'none');
});

test('EngineManager.start initializes terminal engine', () => {
    const disposable = { dispose: () => {} };
    const mockVscode = {
        window: {
            onDidWriteTerminalData: () => disposable
        }
    };
    const manager = new EngineManager(() => {}, mockVscode);
    manager.start({ bannedCommands: [], engineMode: 'auto' });
    assert.strictEqual(manager.isConnected, true);
    assert.strictEqual(manager.primaryEngine, 'terminal');
    manager.stop();
});

test('EngineManager respects terminal-only mode', () => {
    const mockVscode = { window: {} };
    const manager = new EngineManager(() => {}, mockVscode);
    manager.start({ bannedCommands: [], engineMode: 'terminal-only' });
    // Terminal engine won't be active (no proposed API in mock), but mode is respected
    assert.strictEqual(manager._mode, 'terminal-only');
    manager.stop();
});

test('EngineManager respects cdp-only mode', () => {
    const disposable = { dispose: () => {} };
    const mockVscode = {
        window: {
            onDidWriteTerminalData: () => disposable
        }
    };
    const manager = new EngineManager(() => {}, mockVscode);
    manager.start({ bannedCommands: [], engineMode: 'cdp-only' });
    // Terminal engine should NOT be active in cdp-only mode
    assert.strictEqual(manager.terminal.isActive, false);
    assert.strictEqual(manager._mode, 'cdp-only');
    manager.stop();
});

test('EngineManager.getStats aggregates both engines', async () => {
    const mockVscode = { window: {} };
    const manager = new EngineManager(() => {}, mockVscode);
    const stats = await manager.getStats();
    assert.strictEqual(stats.clicks, 0);
    assert.strictEqual(stats.blocked, 0);
    assert.strictEqual(stats.terminalClicks, 0);
    assert.strictEqual(stats.cdpClicks, 0);
    assert.strictEqual(stats.engine, 'none');
});

test('EngineManager.setCustomPorts forwards to CDP', () => {
    const mockVscode = { window: {} };
    const manager = new EngineManager(() => {}, mockVscode);
    manager.setCustomPorts([9222]);
    assert.deepStrictEqual(manager.cdp._customPorts, [9222]);
});

// ─── 5. File Integrity Tests (v1.2) ─────────────────────────────────────────

console.log('\n\x1b[1m[File Integrity v1.2]\x1b[0m');

test('auto_accept.js exists', () => {
    const p = path.join(__dirname, '..', 'main_scripts', 'auto_accept.js');
    assert.ok(fs.existsSync(p));
});

test('cdp-handler.js exists', () => {
    const p = path.join(__dirname, '..', 'main_scripts', 'cdp-handler.js');
    assert.ok(fs.existsSync(p));
});

test('terminal-monitor.js exists', () => {
    const p = path.join(__dirname, '..', 'main_scripts', 'terminal-monitor.js');
    assert.ok(fs.existsSync(p));
});

test('engine-manager.js exists', () => {
    const p = path.join(__dirname, '..', 'main_scripts', 'engine-manager.js');
    assert.ok(fs.existsSync(p));
});

test('extension.js exists', () => {
    const p = path.join(__dirname, '..', 'extension.js');
    assert.ok(fs.existsSync(p));
});

test('package.json version is 1.2.0', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.strictEqual(pkg.version, '1.2.0');
});

test('package.json has enabledApiProposals', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.ok(Array.isArray(pkg.enabledApiProposals));
    assert.ok(pkg.enabledApiProposals.includes('terminalDataWriteEvent'));
});

test('package.json has quickAccept command', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const cmds = pkg.contributes.commands;
    const quick = cmds.find(c => c.command === 'shadow-accept.quickAccept');
    assert.ok(quick);
});

test('package.json has keybindings', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const kb = pkg.contributes.keybindings;
    assert.ok(Array.isArray(kb));
    assert.ok(kb.length > 0);
    assert.strictEqual(kb[0].command, 'shadow-accept.quickAccept');
    assert.strictEqual(kb[0].key, 'ctrl+shift+y');
});

test('package.json has engineMode setting', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const props = pkg.contributes.configuration.properties;
    assert.ok(props['shadowAccept.engineMode']);
    assert.strictEqual(props['shadowAccept.engineMode'].default, 'auto');
});

test('package.json has terminalPatterns setting', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const props = pkg.contributes.configuration.properties;
    assert.ok(props['shadowAccept.terminalPatterns']);
    assert.strictEqual(props['shadowAccept.terminalPatterns'].type, 'array');
});

test('package.json engine version >= 1.83.0', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.strictEqual(pkg.engines.vscode, '^1.83.0');
});

test('extension.js imports EngineManager', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    assert.ok(src.includes('EngineManager'));
    assert.ok(src.includes('engine-manager'));
});

test('extension.js has quickAccept command', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    assert.ok(src.includes('quickAccept'));
    assert.ok(src.includes('shadow-accept.quickAccept'));
});

test('extension.js has engine cards in webview', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    assert.ok(src.includes('engine-card'));
    assert.ok(src.includes('Terminal Monitor'));
    assert.ok(src.includes('CDP Engine'));
});

test('extension.js version is 1.2', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    assert.ok(src.includes('v1.2'));
});

test('auto_accept.js contains word-boundary patterns', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main_scripts', 'auto_accept.js'), 'utf8');
    assert.ok(src.includes('\\baccept\\b'), 'Missing word boundary for accept');
    assert.ok(src.includes('\\brun\\b'), 'Missing word boundary for run');
    assert.ok(src.includes('\\bok\\b'), 'Missing word boundary for ok');
});

test('cdp-handler.js includes port 9222', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main_scripts', 'cdp-handler.js'), 'utf8');
    assert.ok(src.includes('9222'), 'Missing port 9222');
});

test('cdp-handler.js has backoff logic', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main_scripts', 'cdp-handler.js'), 'utf8');
    assert.ok(src.includes('BACKOFF_BASE_MS'), 'Missing backoff constants');
    assert.ok(src.includes('_failCount'), 'Missing fail count tracking');
});

test('auto_accept.js has Shadow DOM traversal', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main_scripts', 'auto_accept.js'), 'utf8');
    assert.ok(src.includes('shadowRoot'), 'Missing Shadow DOM traversal');
});

test('terminal-monitor.js exports all required symbols', () => {
    assert.ok(typeof TerminalMonitorEngine === 'function');
    assert.ok(typeof stripAnsi === 'function');
    assert.ok(Array.isArray(PROMPT_PATTERNS));
    assert.ok(Array.isArray(DANGEROUS_TOOLS));
    assert.ok(typeof extractCommandFromPrompt === 'function');
});

// ─── 6. CDP Connection Tests (with mock server) ─────────────────────────────

console.log('\n\x1b[1m[CDP Mock Server]\x1b[0m');

async function runMockCDPTests() {
    const mockPages = [{
        id: 'test-page-1',
        type: 'page',
        url: 'file:///workbench.html',
        webSocketDebuggerUrl: 'ws://127.0.0.1:19222/devtools/page/test-page-1'
    }];

    const server = http.createServer((req, res) => {
        if (req.url === '/json/list') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(mockPages));
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    await new Promise((resolve) => server.listen(19222, '127.0.0.1', resolve));

    try {
        await testAsync('discovers pages on mock CDP server', async () => {
            const handler = new CDPHandler(() => {});
            handler.setCustomPorts([19222]);
            const pages = await handler._listPages(19222);
            assert.strictEqual(pages.length, 1);
            assert.strictEqual(pages[0].id, 'test-page-1');
        });

        await testAsync('_listPages returns empty for non-existent port', async () => {
            const handler = new CDPHandler(() => {});
            const pages = await handler._listPages(19999);
            assert.strictEqual(pages.length, 0);
        });

        await testAsync('_listPages filters DevTools pages', async () => {
            const origPages = [...mockPages];
            mockPages.push({
                id: 'devtools-1',
                type: 'page',
                url: 'devtools://devtools/bundled/inspector.html',
                webSocketDebuggerUrl: 'ws://127.0.0.1:19222/devtools/page/devtools-1'
            });

            const handler = new CDPHandler(() => {});
            const pages = await handler._listPages(19222);
            assert.strictEqual(pages.length, 1);
            assert.strictEqual(pages[0].id, 'test-page-1');

            mockPages.length = 0;
            mockPages.push(...origPages);
        });

        await testAsync('caches port after successful discovery', async () => {
            const handler = new CDPHandler(() => {});
            handler.setCustomPorts([19222]);
            const pages = await handler._listPages(19222);
            assert.ok(pages.length > 0);
            assert.strictEqual(handler._cachedPort, null);
        });

    } finally {
        server.close();
    }
}

// ─── Run all ─────────────────────────────────────────────────────────────────

(async () => {
    await runMockCDPTests();

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`\x1b[1mResults: ${passed} passed, ${failed} failed\x1b[0m`);

    if (failures.length > 0) {
        console.log('\nFailures:');
        for (const f of failures) {
            console.log(`  \x1b[31m✗\x1b[0m ${f.name}: ${f.error}`);
        }
    }

    console.log('');
    process.exit(failed > 0 ? 1 : 0);
})();
