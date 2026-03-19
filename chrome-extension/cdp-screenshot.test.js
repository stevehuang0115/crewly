/**
 * Tests for CDP Screenshot Module (cdp-screenshot.js)
 *
 * Validates CDP-based screenshot capture, Retina handling,
 * and fallback to captureVisibleTab when debugger is unavailable.
 *
 * Run: node cdp-screenshot.test.js
 */

// ── Chrome API Mocks ──────────────────────────────────────────────────────────

let debuggerAttached = false;
let debuggerAttachShouldFail = false;
let lastDebuggerTarget = null;
let lastCdpCommand = null;
let lastCdpParams = null;
let captureVisibleTabCalled = false;

const chrome = {
  debugger: {
    attach: async (target, version) => {
      lastDebuggerTarget = target;
      if (debuggerAttachShouldFail) throw new Error('Another debugger is already attached');
      debuggerAttached = true;
    },
    detach: async (target) => {
      debuggerAttached = false;
    },
    sendCommand: async (target, command, params) => {
      lastCdpCommand = command;
      lastCdpParams = params;
      if (command === 'Page.captureScreenshot') {
        return { data: 'base64-png-data-from-cdp' };
      }
      if (command === 'Page.getLayoutMetrics') {
        return {
          cssContentSize: { width: 1920, height: 5000 },
          contentSize: { width: 1920, height: 5000 },
        };
      }
      throw new Error(`Unknown CDP command: ${command}`);
    },
  },
  tabs: {
    query: async () => [{ id: 1, active: true, url: 'https://example.com' }],
    sendMessage: async () => ({ ok: true }),
    captureVisibleTab: async (windowId, opts) => {
      captureVisibleTabCalled = true;
      return 'data:image/png;base64,fallback-png-data';
    },
  },
  scripting: {
    executeScript: async ({ func }) => {
      // Simulate DPR result
      return [{ result: 2 }];
    },
  },
  tabGroups: {
    query: async () => [],
    get: async () => ({}),
    update: async () => ({}),
  },
};

// Make chrome global
globalThis.chrome = chrome;

// ── Load module ──────────────────────────────────────────────────────────────
// In service worker, importScripts makes functions global.
// For testing, we eval the file to simulate that behavior.
const fs = require('fs');
const path = require('path');
const moduleCode = fs.readFileSync(path.join(__dirname, 'cdp-screenshot.js'), 'utf8');
eval(moduleCode);

// ── Test Utilities ───────────────────────────────────────────────────────────

let testsPassed = 0;
let testsFailed = 0;
const failures = [];

function resetState() {
  debuggerAttached = false;
  debuggerAttachShouldFail = false;
  lastDebuggerTarget = null;
  lastCdpCommand = null;
  lastCdpParams = null;
  captureVisibleTabCalled = false;
}

async function test(name, fn) {
  resetState();
  try {
    await fn();
    testsPassed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    testsFailed++;
    failures.push({ name, error: err.message });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\nCDP Screenshot Module Tests\n');

  // ── cdpCaptureScreenshot ──

  await test('cdpCaptureScreenshot attaches debugger with CDP 1.3', async () => {
    const result = await cdpCaptureScreenshot(42);
    assertEqual(lastDebuggerTarget.tabId, 42);
    assertEqual(result.method, 'cdp');
  });

  await test('cdpCaptureScreenshot returns base64 PNG data', async () => {
    const result = await cdpCaptureScreenshot(1);
    assertEqual(result.base64, 'base64-png-data-from-cdp');
    assertEqual(result.format, 'png');
    assert(result.length > 0, 'Length should be > 0');
  });

  await test('cdpCaptureScreenshot reports devicePixelRatio', async () => {
    const result = await cdpCaptureScreenshot(1);
    assertEqual(result.devicePixelRatio, 2, 'Should report Retina DPR');
  });

  await test('cdpCaptureScreenshot detaches debugger after capture', async () => {
    await cdpCaptureScreenshot(1);
    assertEqual(debuggerAttached, false, 'Debugger should be detached');
  });

  await test('cdpCaptureScreenshot detaches debugger even on CDP error', async () => {
    const origSendCommand = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = async () => { throw new Error('CDP failed'); };
    try {
      await cdpCaptureScreenshot(1);
      assert(false, 'Should have thrown');
    } catch {
      assertEqual(debuggerAttached, false, 'Debugger should be detached on error');
    }
    chrome.debugger.sendCommand = origSendCommand;
  });

  await test('cdpCaptureScreenshot uses Page.captureScreenshot with png format', async () => {
    await cdpCaptureScreenshot(1);
    assertEqual(lastCdpCommand, 'Page.captureScreenshot');
    assertEqual(lastCdpParams.format, 'png');
    assertEqual(lastCdpParams.captureBeyondViewport, false);
  });

  await test('cdpCaptureScreenshot hides indicator before capture', async () => {
    let hideMessageSent = false;
    const origSendMessage = chrome.tabs.sendMessage;
    chrome.tabs.sendMessage = async (tabId, msg) => {
      if (msg.type === 'hideIndicator') hideMessageSent = true;
      return { ok: true };
    };
    await cdpCaptureScreenshot(1);
    assert(hideMessageSent, 'Should send hideIndicator before capture');
    chrome.tabs.sendMessage = origSendMessage;
  });

  // ── cdpCaptureFullPage ──

  await test('cdpCaptureFullPage captures full page in one shot', async () => {
    const result = await cdpCaptureFullPage(1);
    assertEqual(result.method, 'cdp');
    assertEqual(result.segmentCount, 1, 'CDP full page should be single segment');
    assertEqual(result.totalHeight, 5000, 'Should use layout metrics height');
  });

  await test('cdpCaptureFullPage uses captureBeyondViewport: true', async () => {
    await cdpCaptureFullPage(1);
    // Last CDP command should be Page.captureScreenshot with captureBeyondViewport
    assertEqual(lastCdpParams.captureBeyondViewport, true);
    assert(lastCdpParams.clip !== undefined, 'Should include clip region');
    assertEqual(lastCdpParams.clip.width, 1920);
    assertEqual(lastCdpParams.clip.height, 5000);
  });

  // ── screenshotWithFallback ──

  await test('screenshotWithFallback uses CDP when available', async () => {
    const result = await screenshotWithFallback(1);
    assertEqual(result.method, 'cdp');
    assertEqual(captureVisibleTabCalled, false, 'Should not call captureVisibleTab');
  });

  await test('screenshotWithFallback falls back to captureVisibleTab on debugger error', async () => {
    debuggerAttachShouldFail = true;
    const result = await screenshotWithFallback(1);
    assertEqual(result.method, 'captureVisibleTab');
    assertEqual(captureVisibleTabCalled, true, 'Should call captureVisibleTab as fallback');
    assertEqual(result.base64, 'fallback-png-data');
  });

  await test('screenshotWithFallback resolves tab ID when null', async () => {
    const result = await screenshotWithFallback(null);
    assertEqual(result.method, 'cdp');
    assertEqual(lastDebuggerTarget.tabId, 1, 'Should resolve to active tab ID');
  });

  // ── fullPageScreenshotWithFallback ──

  await test('fullPageScreenshotWithFallback uses CDP when available', async () => {
    const result = await fullPageScreenshotWithFallback(
      { id: 1 },
      async () => ({ method: 'scroll-capture' })
    );
    assertEqual(result.method, 'cdp');
  });

  await test('fullPageScreenshotWithFallback uses fallback when CDP fails', async () => {
    debuggerAttachShouldFail = true;
    let fallbackCalled = false;
    const result = await fullPageScreenshotWithFallback(
      { id: 1 },
      async () => { fallbackCalled = true; return { method: 'scroll-capture' }; }
    );
    assert(fallbackCalled, 'Fallback should be called');
    assertEqual(result.method, 'scroll-capture');
  });

  // ── Summary ──

  console.log(`\n${testsPassed + testsFailed} tests, ${testsPassed} passed, ${testsFailed} failed\n`);
  if (failures.length > 0) {
    console.log('Failures:');
    failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
