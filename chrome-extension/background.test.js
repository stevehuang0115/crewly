/**
 * Tests for Background Service Worker (background.js)
 *
 * Validates tab grouping, CDP screenshot integration,
 * and command routing.
 *
 * Run: node background.test.js
 */

// ── Chrome API Mocks ──────────────────────────────────────────────────────────

let mockGroups = [];
let mockGroupIdCounter = 100;
let mockTabs = [{ id: 1, active: true, url: 'https://example.com', windowId: 1 }];
let debuggerAttachShouldFail = false;
let groupCreateShouldFail = false;
let indicatorMessages = [];

const chrome = {
  debugger: {
    attach: async (target, version) => {
      if (debuggerAttachShouldFail) throw new Error('Debugger unavailable');
    },
    detach: async () => {},
    sendCommand: async (target, command, params) => {
      if (command === 'Page.captureScreenshot') {
        return { data: 'cdp-base64-screenshot' };
      }
      if (command === 'Page.getLayoutMetrics') {
        return { cssContentSize: { width: 1920, height: 3000 } };
      }
      return {};
    },
  },
  tabs: {
    query: async () => [...mockTabs],
    get: async (id) => {
      const tab = mockTabs.find(t => t.id === id);
      if (!tab) throw new Error(`No tab with id ${id}`);
      return tab;
    },
    update: async (id, props) => {
      const tab = mockTabs.find(t => t.id === id);
      if (tab) Object.assign(tab, props);
      return tab || { id, ...props };
    },
    group: async ({ tabIds, groupId }) => {
      if (groupCreateShouldFail) throw new Error('Cannot group tabs');
      if (groupId !== undefined) {
        // Add to existing group
        return groupId;
      }
      // Create new group
      const newId = mockGroupIdCounter++;
      mockGroups.push({ id: newId, title: '', color: 'grey' });
      return newId;
    },
    captureVisibleTab: async () => 'data:image/png;base64,fallback-data',
    sendMessage: async (tabId, msg) => {
      indicatorMessages.push({ tabId, ...msg });
      return { ok: true };
    },
    onUpdated: {
      addListener: () => {},
      removeListener: () => {},
    },
  },
  tabGroups: {
    get: async (id) => {
      const g = mockGroups.find(g => g.id === id);
      if (!g) throw new Error(`No group with id ${id}`);
      return g;
    },
    query: async ({ title }) => {
      return mockGroups.filter(g => g.title === title);
    },
    update: async (id, props) => {
      const g = mockGroups.find(g => g.id === id);
      if (g) Object.assign(g, props);
      return g;
    },
  },
  windows: {
    update: async () => {},
  },
  scripting: {
    executeScript: async ({ func, args }) => {
      // Simulate script execution
      if (func) {
        try {
          const result = func(...(args || []));
          return [{ result }];
        } catch {
          return [{ result: null }];
        }
      }
      return [{ result: null }];
    },
  },
  storage: {
    local: {
      set: () => {},
      get: (keys, cb) => { if (cb) cb({}); },
    },
  },
  runtime: {
    sendMessage: async () => {},
    onMessage: {
      addListener: () => {},
    },
    lastError: null,
  },
  cookies: {
    getAll: async () => [],
  },
};

globalThis.chrome = chrome;
globalThis.WebSocket = class MockWebSocket {
  constructor() { this.readyState = 1; }
  send() {}
  close() {}
};
globalThis.WebSocket.OPEN = 1;

// ── Load modules ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

// Load cdp-screenshot.js first (simulates importScripts)
const cdpCode = fs.readFileSync(path.join(__dirname, 'cdp-screenshot.js'), 'utf8');
eval(cdpCode);

// Load background.js (skip importScripts line since we already loaded cdp-screenshot)
let bgCode = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
bgCode = bgCode.replace("importScripts('cdp-screenshot.js');", '// importScripts already loaded');
// Replace let with var for key state variables so tests can access them
bgCode = bgCode.replace(/^let crewlyGroupId/m, 'var crewlyGroupId');
bgCode = bgCode.replace(/^let lastNavigatedTabId/m, 'var lastNavigatedTabId');
bgCode = bgCode.replace(/^let ws /m, 'var ws ');
bgCode = bgCode.replace(/^let serverUrl/m, 'var serverUrl');
bgCode = bgCode.replace(/^let connectionState/m, 'var connectionState');
bgCode = bgCode.replace(/^let firstControlDone/m, 'var firstControlDone');
bgCode = bgCode.replace(/^let controlledTabId/m, 'var controlledTabId');
// Also skip the chrome.storage.local.get auto-connect at the end
bgCode = bgCode.replace(/chrome\.storage\.local\.get\(\['serverUrl'[\s\S]*?\}\);$/m, '// auto-connect disabled for tests');
eval(bgCode);

// ── Test Utilities ───────────────────────────────────────────────────────────

let testsPassed = 0;
let testsFailed = 0;
const failures = [];

function resetState() {
  mockGroups = [];
  mockGroupIdCounter = 100;
  mockTabs = [{ id: 1, active: true, url: 'https://example.com', windowId: 1 }];
  debuggerAttachShouldFail = false;
  groupCreateShouldFail = false;
  indicatorMessages = [];
  crewlyGroupId = null;
  lastNavigatedTabId = null;
  controlledTabId = null;
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
  console.log('\nBackground Service Worker Tests\n');

  // ── Tab Group Tests ──

  console.log('Tab Grouping:');

  await test('_addToCrewlyGroup creates new group when none exists', async () => {
    await _addToCrewlyGroup(1);
    assert(crewlyGroupId !== null, 'crewlyGroupId should be set');
    const group = mockGroups.find(g => g.id === crewlyGroupId);
    assert(group, 'Group should exist in mockGroups');
    assertEqual(group.title, 'crewly-tabs');
    assertEqual(group.color, 'purple');
  });

  await test('_addToCrewlyGroup reuses cached group', async () => {
    await _addToCrewlyGroup(1);
    const firstGroupId = crewlyGroupId;
    await _addToCrewlyGroup(2);
    assertEqual(crewlyGroupId, firstGroupId, 'Should reuse same group');
    assertEqual(mockGroups.length, 1, 'Should not create duplicate groups');
  });

  await test('_addToCrewlyGroup finds existing group after cache reset', async () => {
    // Create a group first
    await _addToCrewlyGroup(1);
    const groupId = crewlyGroupId;

    // Reset cache (simulates reconnect)
    crewlyGroupId = null;

    // Should find existing group via tabGroups.query
    await _addToCrewlyGroup(2);
    assertEqual(crewlyGroupId, groupId, 'Should find and reuse existing group');
  });

  await test('_addToCrewlyGroup creates new group if cached group was removed', async () => {
    // Create and cache a group
    await _addToCrewlyGroup(1);
    const oldGroupId = crewlyGroupId;

    // Remove the group from mock (simulates user closing it)
    mockGroups = [];

    // Should detect removal and create new group
    await _addToCrewlyGroup(2);
    assert(crewlyGroupId !== oldGroupId, 'Should create new group');
    assertEqual(mockGroups.length, 1);
    assertEqual(mockGroups[0].title, 'crewly-tabs');
    assertEqual(mockGroups[0].color, 'purple');
  });

  await test('_addToCrewlyGroup handles group API errors gracefully', async () => {
    groupCreateShouldFail = true;
    // Should not throw
    await _addToCrewlyGroup(1);
    assertEqual(crewlyGroupId, null, 'Group ID should remain null on failure');
  });

  // ── Screenshot Tests ──

  console.log('\nScreenshot (CDP + Fallback):');

  await test('toolScreenshot uses CDP by default', async () => {
    const result = await toolScreenshot();
    assertEqual(result.method, 'cdp');
    assertEqual(result.base64, 'cdp-base64-screenshot');
  });

  await test('toolScreenshot falls back to captureVisibleTab on debugger error', async () => {
    debuggerAttachShouldFail = true;
    const result = await toolScreenshot();
    assertEqual(result.method, 'captureVisibleTab');
    assertEqual(result.base64, 'fallback-data');
  });

  await test('toolScreenshot focuses last navigated tab before capture', async () => {
    mockTabs = [
      { id: 1, active: true, url: 'https://other.com', windowId: 1 },
      { id: 2, active: false, url: 'https://target.com', windowId: 1 },
    ];
    lastNavigatedTabId = 2;
    let updatedTabId = null;
    const origUpdate = chrome.tabs.update;
    chrome.tabs.update = async (id, props) => {
      updatedTabId = id;
      const tab = mockTabs.find(t => t.id === id);
      if (tab && props.active) tab.active = true;
      return tab;
    };

    await toolScreenshot();
    assertEqual(updatedTabId, 2, 'Should activate the last navigated tab');

    chrome.tabs.update = origUpdate;
  });

  await test('toolScreenshot resets lastNavigatedTabId if tab was closed', async () => {
    lastNavigatedTabId = 999; // Non-existent tab
    const origGet = chrome.tabs.get;
    chrome.tabs.get = async (id) => { throw new Error('Tab not found'); };

    const result = await toolScreenshot();
    assertEqual(lastNavigatedTabId, null, 'Should reset lastNavigatedTabId');
    assert(result.base64, 'Should still return screenshot');

    chrome.tabs.get = origGet;
  });

  await test('toolFullPageScreenshot uses CDP single capture', async () => {
    const result = await toolFullPageScreenshot();
    assertEqual(result.method, 'cdp');
    assertEqual(result.segmentCount, 1, 'CDP should capture in one shot');
    assertEqual(result.totalHeight, 3000);
  });

  await test('toolFullPageScreenshot falls back to scroll-capture', async () => {
    debuggerAttachShouldFail = true;
    // Mock executeScript to return page dimensions for scroll-capture
    const origExec = chrome.scripting.executeScript;
    chrome.scripting.executeScript = async ({ func, args }) => {
      if (func) {
        const code = func.toString();
        if (code.includes('scrollHeight')) {
          return [{ result: { scrollHeight: 2000, viewportHeight: 1000, scrollX: 0, scrollY: 0 } }];
        }
      }
      return [{ result: null }];
    };

    const result = await toolFullPageScreenshot();
    assertEqual(result.method, 'captureVisibleTab');
    assert(result.segmentCount >= 1, 'Should have at least 1 segment');

    chrome.scripting.executeScript = origExec;
  });

  // ── Manifest Tests ──

  console.log('\nManifest:');

  await test('manifest.json includes debugger permission', async () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')
    );
    assert(
      manifest.permissions.includes('debugger'),
      'permissions should include "debugger"'
    );
  });

  await test('manifest.json includes tabGroups permission', async () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')
    );
    assert(
      manifest.permissions.includes('tabGroups'),
      'permissions should include "tabGroups"'
    );
  });

  await test('manifest.json is valid JSON with required fields', async () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')
    );
    assertEqual(manifest.manifest_version, 3);
    assert(manifest.name, 'Should have a name');
    assert(manifest.background?.service_worker, 'Should have service worker');
    assert(manifest.content_scripts?.length > 0, 'Should have content scripts');
  });

  // ── Indicator Tab Targeting Tests ──

  console.log('\nIndicator Tab Targeting:');

  await test('_showToolIndicator sends indicator only to controlledTabId', async () => {
    // Set up: controlled tab is 2, but active tab is 1
    mockTabs = [
      { id: 1, active: true, url: 'https://other.com', windowId: 1 },
      { id: 2, active: false, url: 'https://controlled.com', windowId: 1 },
    ];
    controlledTabId = 2;
    indicatorMessages = [];

    const tabId = await _showToolIndicator('click');
    assertEqual(tabId, 2, 'Should return controlled tab ID');
    assertEqual(indicatorMessages.length, 1, 'Should send exactly one message');
    assertEqual(indicatorMessages[0].tabId, 2, 'Message should go to controlled tab, not active tab');
  });

  await test('_showToolIndicator falls back to active tab when no controlledTabId', async () => {
    controlledTabId = null;
    mockTabs = [{ id: 1, active: true, url: 'https://example.com', windowId: 1 }];
    indicatorMessages = [];

    const tabId = await _showToolIndicator('navigate');
    assertEqual(tabId, 1, 'Should fall back to active tab');
    assertEqual(indicatorMessages.length, 1);
    assertEqual(indicatorMessages[0].tabId, 1);
  });

  await test('_showToolIndicator clears controlledTabId if tab was closed', async () => {
    controlledTabId = 999; // Non-existent tab
    const origGet = chrome.tabs.get;
    chrome.tabs.get = async (id) => { throw new Error('Tab not found'); };
    indicatorMessages = [];

    const tabId = await _showToolIndicator('click');
    assertEqual(tabId, null, 'Should return null for closed tab');
    assertEqual(controlledTabId, null, 'Should clear controlledTabId');
    assertEqual(indicatorMessages.length, 0, 'Should not send any message');

    chrome.tabs.get = origGet;
  });

  await test('_handleCommand sets controlledTabId on first command', async () => {
    firstControlDone = false;
    controlledTabId = null;
    mockTabs = [{ id: 5, active: true, url: 'https://example.com', windowId: 1 }];

    await _handleCommand({ id: 'test-1', tool: 'readText', params: {} });
    assertEqual(controlledTabId, 5, 'Should set controlledTabId to active tab on first command');
  });

  await test('toolNavigate updates controlledTabId', async () => {
    mockTabs = [{ id: 3, active: true, url: 'https://old.com', windowId: 1 }];
    controlledTabId = null;

    await toolNavigate({ url: 'https://new-site.com' });
    assertEqual(controlledTabId, 3, 'Should set controlledTabId to navigated tab');
    assertEqual(lastNavigatedTabId, 3, 'Should also set lastNavigatedTabId');
  });

  await test('indicator not shown on non-controlled tabs even when they are active', async () => {
    // Simulate: Crewly controls tab 2, user switches to tab 1
    mockTabs = [
      { id: 1, active: true, url: 'https://user-browsing.com', windowId: 1 },
      { id: 2, active: false, url: 'https://crewly-controlled.com', windowId: 1 },
    ];
    controlledTabId = 2;
    indicatorMessages = [];

    // Execute a command — indicator should go to tab 2, not tab 1
    firstControlDone = true; // Skip first-control logic
    await _handleCommand({ id: 'test-2', tool: 'readText', params: {} });

    const showMsgs = indicatorMessages.filter(m => m.type === 'showIndicator');
    const hideMsgs = indicatorMessages.filter(m => m.type === 'hideIndicator');
    assert(showMsgs.every(m => m.tabId === 2), 'All showIndicator messages should target tab 2');
    assert(hideMsgs.every(m => m.tabId === 2), 'All hideIndicator messages should target tab 2');
    assert(indicatorMessages.every(m => m.tabId !== 1), 'No messages should go to tab 1');
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
