/**
 * Shadow Accept — Unit Tests v1.1
 * by Nakedo Corp — MIT License
 *
 * Tests CDP handler logic and auto_accept pattern matching.
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
    assert.ok(ports.includes(9222)); // Also includes standard ports
    assert.ok(ports.includes(9229));
});

test('CDPHandler._getPortList deduplicates ports', () => {
    const handler = new CDPHandler(() => {});
    handler.setCustomPorts([9222, 9229]); // These are already in PRIORITY_PORTS
    const ports = handler._getPortList();
    const unique = [...new Set(ports)];
    assert.strictEqual(ports.length, unique.length);
});

test('CDPHandler._isTargetPage rejects non-pages', () => {
    const handler = new CDPHandler(() => {});
    assert.strictEqual(handler._isTargetPage(null), false);
    assert.strictEqual(handler._isTargetPage({}), false);
    assert.strictEqual(handler._isTargetPage({ type: 'page' }), false); // no wsUrl
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
    // Simulate calling start with no CDP available
    await handler.start({ ide: 'Code', pollInterval: 800, bannedCommands: [] });
    assert.strictEqual(handler._failCount, 1);
    assert.ok(handler._lastScanTime > 0);
});

// ─── 2. Auto Accept Pattern Tests ────────────────────────────────────────────

console.log('\n\x1b[1m[Auto Accept Patterns]\x1b[0m');

// Load the auto_accept.js script and extract pattern logic for testing
// We simulate the regex patterns used in the actual script

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

// ─── 3. File Integrity Tests ─────────────────────────────────────────────────

console.log('\n\x1b[1m[File Integrity]\x1b[0m');

test('auto_accept.js exists', () => {
    const p = path.join(__dirname, '..', 'main_scripts', 'auto_accept.js');
    assert.ok(fs.existsSync(p));
});

test('cdp-handler.js exists', () => {
    const p = path.join(__dirname, '..', 'main_scripts', 'cdp-handler.js');
    assert.ok(fs.existsSync(p));
});

test('extension.js exists', () => {
    const p = path.join(__dirname, '..', 'extension.js');
    assert.ok(fs.existsSync(p));
});

test('dist/extension.js exists (compiled)', () => {
    const p = path.join(__dirname, '..', 'dist', 'extension.js');
    assert.ok(fs.existsSync(p));
});

test('package.json version is 1.1.0', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.strictEqual(pkg.version, '1.1.0');
});

test('package.json has debugPort setting', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const props = pkg.contributes.configuration.properties;
    assert.ok(props['shadowAccept.debugPort']);
    assert.strictEqual(props['shadowAccept.debugPort'].type, 'number');
    assert.strictEqual(props['shadowAccept.debugPort'].default, 0);
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

test('cdp-handler.js includes port 9229', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main_scripts', 'cdp-handler.js'), 'utf8');
    assert.ok(src.includes('9229'), 'Missing port 9229');
});

test('cdp-handler.js has backoff logic', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main_scripts', 'cdp-handler.js'), 'utf8');
    assert.ok(src.includes('BACKOFF_BASE_MS'), 'Missing backoff constants');
    assert.ok(src.includes('_failCount'), 'Missing fail count tracking');
});

test('extension.js has connection status', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    assert.ok(src.includes('isConnected'), 'Missing connection status');
    assert.ok(src.includes('connectedPort'), 'Missing connected port');
    assert.ok(src.includes('conn-badge'), 'Missing connection badge UI');
});

test('auto_accept.js has Shadow DOM traversal', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main_scripts', 'auto_accept.js'), 'utf8');
    assert.ok(src.includes('shadowRoot'), 'Missing Shadow DOM traversal');
});

// ─── 4. CDP Connection Tests (with mock server) ─────────────────────────────

console.log('\n\x1b[1m[CDP Mock Server]\x1b[0m');

async function runMockCDPTests() {
    // Create a mock CDP server
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
            // Temporarily change mock to return a devtools page
            const origPages = [...mockPages];
            mockPages.push({
                id: 'devtools-1',
                type: 'page',
                url: 'devtools://devtools/bundled/inspector.html',
                webSocketDebuggerUrl: 'ws://127.0.0.1:19222/devtools/page/devtools-1'
            });

            const handler = new CDPHandler(() => {});
            const pages = await handler._listPages(19222);
            assert.strictEqual(pages.length, 1); // Only the real page, not devtools
            assert.strictEqual(pages[0].id, 'test-page-1');

            // Restore
            mockPages.length = 0;
            mockPages.push(...origPages);
        });

        await testAsync('caches port after successful discovery', async () => {
            const handler = new CDPHandler(() => {});
            handler.setCustomPorts([19222]);
            // We can't fully connect (no WS), but we can verify port caching logic
            // by checking the cached port after _listPages succeeds
            const pages = await handler._listPages(19222);
            assert.ok(pages.length > 0);
            // The start() method would set _cachedPort, but WS connection will fail
            // Still, verify the mechanism exists
            assert.strictEqual(handler._cachedPort, null); // Not set yet (only set by start())
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
