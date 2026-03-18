/**
 * Crewly Remote Browser — Background Service Worker
 *
 * Maintains a WebSocket connection to the Crewly Cloud relay server,
 * receives JSON commands, routes them to the appropriate Chrome API
 * or content script, and returns results.
 */

// ── State ────────────────────────────────────────────────────────────────────
let ws = null;
let serverUrl = '';
let connectionState = 'disconnected'; // disconnected | connecting | connected
let reconnectTimer = null;
let heartbeatTimer = null;

// Tab grouping state (Task 1)
let crewlyGroupId = null;

// First-control bring-to-front state (Task 3)
let firstControlDone = false;

// Navigate→Screenshot tracking (Task 4)
let lastNavigatedTabId = null;

// Glow indicator timing (Task 2)
let indicatorShownAt = 0;
const INDICATOR_MIN_DISPLAY_MS = 1000;

// Log reporting state (Task 5)
const _logBuffer = [];
const LOG_BUFFER_MAX = 200;
let logReportingUrl = '';   // e.g. http://localhost:3000/api/extension/logs
let logFlushTimer = null;
const LOG_FLUSH_INTERVAL_MS = 10000; // flush every 10s

const RECONNECT_DELAY_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 25000; // well under the 30s idle timeout

// ── Public helpers (called from popup) ───────────────────────────────────────

/**
 * Returns the current connection state for the popup UI.
 */
function getState() {
  return { connectionState, serverUrl };
}

/**
 * Initiates a WebSocket connection to the given URL.
 * @param {string} url - WebSocket server URL (ws:// or wss://)
 */
function connect(url) {
  serverUrl = url;
  chrome.storage.local.set({ serverUrl: url });
  _openSocket(url);
}

/**
 * Tears down the current WebSocket connection.
 */
function disconnect() {
  _cleanup();
  connectionState = 'disconnected';
  _broadcastState();
}

// ── WebSocket lifecycle ──────────────────────────────────────────────────────

function _openSocket(url) {
  _cleanup();
  connectionState = 'connecting';
  _broadcastState();

  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error('[crewly] WebSocket constructor error:', err);
    connectionState = 'disconnected';
    _broadcastState();
    _scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[crewly] Connected to', url);
    connectionState = 'connected';
    _appendLog('info', 'WebSocket connected', { url });
    _broadcastState();
    _startHeartbeat();
  };

  ws.onmessage = async (event) => {
    let cmd;
    try {
      cmd = JSON.parse(event.data);
    } catch {
      console.warn('[crewly] Non-JSON message ignored');
      return;
    }
    // Ignore heartbeat acks
    if (cmd.type === 'pong') return;

    console.log('[crewly] Received command:', cmd.tool, cmd.id);
    _appendLog('info', `Command received: ${cmd.tool}`, { id: cmd.id, tool: cmd.tool, params: cmd.params });
    const result = await _handleCommand(cmd);
    _appendLog(result.success ? 'info' : 'error', `Command ${result.success ? 'completed' : 'failed'}: ${cmd.tool}`, { id: cmd.id, success: result.success, error: result.error || null });
    _send(result);
  };

  ws.onclose = (e) => {
    console.log('[crewly] Connection closed:', e.code, e.reason);
    _appendLog('warn', 'WebSocket closed', { code: e.code, reason: e.reason });
    connectionState = 'disconnected';
    firstControlDone = false;
    lastNavigatedTabId = null;
    _broadcastState();
    _stopHeartbeat();
    _scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[crewly] WebSocket error:', err);
    _appendLog('error', 'WebSocket error', { message: err.message || 'unknown' });
  };
}

function _cleanup() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  _stopHeartbeat();
  firstControlDone = false;
  lastNavigatedTabId = null;
  crewlyGroupId = null;
  if (ws) {
    ws.onclose = null; // prevent reconnect on intentional close
    ws.close();
    ws = null;
  }
}

function _scheduleReconnect() {
  if (reconnectTimer) return;
  if (!serverUrl) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log('[crewly] Reconnecting...');
    _openSocket(serverUrl);
  }, RECONNECT_DELAY_MS);
}

// ── Heartbeat (keeps Service Worker alive) ───────────────────────────────────

function _startHeartbeat() {
  _stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    _send({ type: 'ping' });
  }, HEARTBEAT_INTERVAL_MS);
}

function _stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ── Send helper ──────────────────────────────────────────────────────────────

function _send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ── Broadcast state change to popup ──────────────────────────────────────────

function _broadcastState() {
  chrome.runtime.sendMessage({ type: 'stateChanged', ...getState() }).catch(() => {
    // popup may not be open — ignore
  });
}

// ── Visual indicator helpers ─────────────────────────────────────────────────

/**
 * Send a showIndicator message to the active tab's content script.
 * Called once at the start of a WS command — stays visible until command ends.
 * @param {string} tool - Tool name being executed
 * @returns {Promise<number|null>} Tab ID that received the indicator, or null
 */
async function _showToolIndicator(tool) {
  // Skip indicator for non-visual tools
  if (tool === 'getTabs' || tool === 'getCookies') return null;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || tab.url?.startsWith('chrome://')) return null;

    indicatorShownAt = Date.now();
    chrome.tabs.sendMessage(tab.id, { type: 'showIndicator', action: tool }).catch(() => {
      // Content script may not be loaded yet — try injecting it
      _ensureContentScriptAndShow(tab.id, tool);
    });
    return tab.id;
  } catch {
    return null;
  }
}

/**
 * Inject content script if not loaded, then show indicator.
 * Handles the case where content script hasn't loaded yet on the tab.
 * @param {number} tabId - Tab to inject into
 * @param {string} tool - Tool name for indicator label
 */
async function _ensureContentScriptAndShow(tabId, tool) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    // Small delay for script to initialize
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, { type: 'showIndicator', action: tool }).catch(() => {});
    }, 50);
  } catch {
    // chrome:// or restricted page — ignore
  }
}

/**
 * Send a hideIndicator message to a specific tab, respecting minimum display time.
 * Ensures the glow is visible for at least INDICATOR_MIN_DISPLAY_MS.
 * @param {number|null} tabId - Tab to clear indicator from
 */
async function _hideToolIndicator(tabId) {
  if (!tabId) return;
  const elapsed = Date.now() - indicatorShownAt;
  if (elapsed < INDICATOR_MIN_DISPLAY_MS) {
    await new Promise(r => setTimeout(r, INDICATOR_MIN_DISPLAY_MS - elapsed));
  }
  chrome.tabs.sendMessage(tabId, { type: 'hideIndicator' }).catch(() => {
    // Tab may have closed — ignore
  });
}

// ── Command router ───────────────────────────────────────────────────────────

/**
 * Routes an incoming command to the appropriate tool handler.
 * @param {{id: string, tool: string, params?: object}} cmd
 * @returns {Promise<{id: string, success: boolean, result?: any, error?: string}>}
 */
async function _handleCommand(cmd) {
  const { id, tool, params = {} } = cmd;

  // First-control: bring the tab to foreground on the first real command (Task 3)
  if (!firstControlDone && tool !== 'getTabs' && tool !== 'getCookies') {
    firstControlDone = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch {
      // Best-effort — ignore errors
    }
  }

  // Show visual indicator on the active tab before executing
  const indicatorTabId = await _showToolIndicator(tool);

  try {
    let result;
    switch (tool) {
      case 'navigate':
        result = await toolNavigate(params);
        break;
      case 'screenshot':
        result = await toolScreenshot(params);
        break;
      case 'readText':
        result = await toolReadText(params);
        break;
      case 'getTabs':
        result = await toolGetTabs(params);
        break;
      case 'executeScript':
        result = await toolExecuteScript(params);
        break;
      case 'click':
        result = await toolClick(params);
        break;
      case 'fill':
        result = await toolFill(params);
        break;
      case 'type':
        result = await toolType(params);
        break;
      case 'scroll':
        result = await toolScroll(params);
        break;
      case 'hover':
        result = await toolHover(params);
        break;
      case 'pressKey':
        result = await toolPressKey(params);
        break;
      case 'getElement':
        result = await toolGetElement(params);
        break;
      case 'waitForSelector':
        result = await toolWaitForSelector(params);
        break;
      case 'getCookies':
        result = await toolGetCookies(params);
        break;
      case 'getLocalStorage':
        result = await toolGetLocalStorage(params);
        break;
      case 'getConsoleMessages':
        result = await toolGetConsoleMessages(params);
        break;
      case 'fullPageScreenshot':
        result = await toolFullPageScreenshot(params);
        break;
      default:
        _hideToolIndicator(indicatorTabId);
        return { id, success: false, error: `Unknown tool: ${tool}` };
    }
    _hideToolIndicator(indicatorTabId);
    return { id, success: true, result };
  } catch (err) {
    console.error(`[crewly] Tool "${tool}" failed:`, err);
    _hideToolIndicator(indicatorTabId);
    return { id, success: false, error: err.message || String(err) };
  }
}

// ── Tool implementations ─────────────────────────────────────────────────────

/**
 * Navigates the active tab to the specified URL.
 * Adds the tab to a 'Crewly' tab group (purple) and tracks it for screenshots.
 */
async function toolNavigate({ url }) {
  if (!url) throw new Error('Missing required param: url');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');
  const updated = await chrome.tabs.update(tab.id, { url });
  // Wait for page load
  await _waitForTabLoad(updated.id);

  // Track this tab for screenshot targeting (Task 4)
  lastNavigatedTabId = updated.id;

  // Add tab to Crewly tab group (Task 1)
  await _addToCrewlyGroup(updated.id);

  const final = await chrome.tabs.get(updated.id);
  return { title: final.title, url: final.url };
}

/**
 * Adds a tab to the 'Crewly' tab group. Creates the group if it doesn't exist.
 * Uses a cached groupId to avoid duplicate groups.
 * @param {number} tabId - Tab to add to the group
 */
async function _addToCrewlyGroup(tabId) {
  try {
    // Verify cached group still exists
    if (crewlyGroupId !== null) {
      try {
        await chrome.tabGroups.get(crewlyGroupId);
      } catch {
        // Group was closed/removed — reset cache
        crewlyGroupId = null;
      }
    }

    if (crewlyGroupId !== null) {
      // Add to existing group
      await chrome.tabs.group({ tabIds: [tabId], groupId: crewlyGroupId });
    } else {
      // Create new group
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, { title: 'crewly-tabs', color: 'purple' });
      crewlyGroupId = groupId;
    }
  } catch (err) {
    console.warn('[crewly] Tab grouping failed (non-fatal):', err.message);
  }
}

/**
 * Captures a screenshot of the last navigated tab (or current visible tab).
 * If the user switched away from the navigated tab, brings it back to focus first.
 */
async function toolScreenshot() {
  // Ensure we screenshot the correct tab (Task 4)
  if (lastNavigatedTabId !== null) {
    try {
      const tab = await chrome.tabs.get(lastNavigatedTabId);
      if (tab && !tab.active) {
        await chrome.tabs.update(lastNavigatedTabId, { active: true });
        // Small delay to let Chrome render the tab
        await new Promise(r => setTimeout(r, 150));
      }
    } catch {
      // Tab was closed — fall back to current visible tab
      lastNavigatedTabId = null;
    }
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
  // Strip the data:image/png;base64, prefix
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  return { base64, format: 'png', length: base64.length };
}

/**
 * Reads text content from the active tab, optionally filtered by CSS selector.
 */
async function toolReadText({ selector }) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel) => {
      if (sel) {
        const el = document.querySelector(sel);
        return el ? el.innerText : null;
      }
      return document.body.innerText;
    },
    args: [selector || null],
  });

  const text = results?.[0]?.result;
  return { text, selector: selector || null, length: text ? text.length : 0 };
}

/**
 * Returns a list of all open tabs.
 */
async function toolGetTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      active: t.active,
      windowId: t.windowId,
    })),
    count: tabs.length,
  };
}

/**
 * Executes arbitrary JavaScript in the active tab.
 */
async function toolExecuteScript({ code }) {
  if (!code) throw new Error('Missing required param: code');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: new Function('return (' + code + ')'),
  });

  return { value: results?.[0]?.result ?? null };
}

// ── Input action tools ───────────────────────────────────────────────────────

/**
 * Clicks an element by CSS selector or dispatches a click at (x, y) coordinates.
 */
async function toolClick({ selector, x, y }) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, cx, cy) => {
      if (sel) {
        const el = document.querySelector(sel);
        if (!el) return { clicked: false, error: `Element not found: ${sel}` };
        el.click();
        return { clicked: true, selector: sel };
      }
      if (typeof cx === 'number' && typeof cy === 'number') {
        const el = document.elementFromPoint(cx, cy);
        const event = new MouseEvent('click', {
          bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window,
        });
        (el || document).dispatchEvent(event);
        return { clicked: true, x: cx, y: cy, tag: el ? el.tagName : null };
      }
      return { clicked: false, error: 'Provide selector or x,y coordinates' };
    },
    args: [selector || null, x ?? null, y ?? null],
  });

  return results?.[0]?.result;
}

/**
 * Sets the value of an input element and dispatches input + change events.
 */
async function toolFill({ selector, value }) {
  if (!selector) throw new Error('Missing required param: selector');
  if (value === undefined || value === null) throw new Error('Missing required param: value');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return { filled: false, error: `Element not found: ${sel}` };
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: true, selector: sel, length: val.length };
    },
    args: [selector, String(value)],
  });

  return results?.[0]?.result;
}

/**
 * Types text character-by-character into a focused element.
 * Dispatches keydown, input, and keyup events per character (React-compatible).
 */
async function toolType({ selector, text, delay }) {
  if (!selector) throw new Error('Missing required param: selector');
  if (!text) throw new Error('Missing required param: text');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (sel, txt, delayMs) => {
      const el = document.querySelector(sel);
      if (!el) return { typed: false, error: `Element not found: ${sel}` };
      el.focus();
      for (const char of txt) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
        el.dispatchEvent(new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true }));
        el.value = (el.value || '') + char;
        el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { typed: true, selector: sel, length: txt.length };
    },
    args: [selector, text, delay || 0],
  });

  return results?.[0]?.result;
}

/**
 * Scrolls the page or an element into view.
 */
async function toolScroll({ selector, x, y, direction }) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, sx, sy, dir) => {
      if (sel) {
        const el = document.querySelector(sel);
        if (!el) return { scrolled: false, error: `Element not found: ${sel}` };
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return { scrolled: true, method: 'scrollIntoView', selector: sel };
      }
      if (typeof sx === 'number' && typeof sy === 'number') {
        window.scrollBy(sx, sy);
        return { scrolled: true, method: 'scrollBy', x: sx, y: sy };
      }
      if (dir) {
        const amount = 500;
        switch (dir) {
          case 'up':     window.scrollBy(0, -amount); break;
          case 'down':   window.scrollBy(0, amount); break;
          case 'top':    window.scrollTo(0, 0); break;
          case 'bottom': window.scrollTo(0, document.body.scrollHeight); break;
          default: return { scrolled: false, error: `Unknown direction: ${dir}` };
        }
        return { scrolled: true, method: 'direction', direction: dir };
      }
      return { scrolled: false, error: 'Provide selector, x/y, or direction' };
    },
    args: [selector || null, x ?? null, y ?? null, direction || null],
  });

  return results?.[0]?.result;
}

/**
 * Dispatches mouseenter and mouseover events on an element (hover).
 */
async function toolHover({ selector }) {
  if (!selector) throw new Error('Missing required param: selector');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { hovered: false, error: `Element not found: ${sel}` };
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return { hovered: true, selector: sel, tag: el.tagName };
    },
    args: [selector],
  });

  return results?.[0]?.result;
}

/**
 * Simulates a keyboard key press with optional modifiers.
 */
async function toolPressKey({ key, modifiers }) {
  if (!key) throw new Error('Missing required param: key');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (k, mods) => {
      const opts = {
        key: k,
        bubbles: true,
        cancelable: true,
        ctrlKey: !!(mods && mods.includes('ctrl')),
        shiftKey: !!(mods && mods.includes('shift')),
        altKey: !!(mods && mods.includes('alt')),
        metaKey: !!(mods && mods.includes('meta')),
      };
      const target = document.activeElement || document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', opts));
      target.dispatchEvent(new KeyboardEvent('keyup', opts));
      return { pressed: true, key: k, modifiers: mods || [], target: target.tagName };
    },
    args: [key, modifiers || []],
  });

  return results?.[0]?.result;
}

// ── Inspection & utility tools ────────────────────────────────────────────────

/**
 * Gets detailed info about a DOM element by CSS selector.
 */
async function toolGetElement({ selector }) {
  if (!selector) throw new Error('Missing required param: selector');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        tagName: el.tagName,
        id: el.id || null,
        className: el.className || null,
        text: (el.textContent || '').substring(0, 500),
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        attributes: Object.fromEntries([...el.attributes].map(a => [a.name, a.value])),
        visible: rect.width > 0 && rect.height > 0,
        childCount: el.children.length,
      };
    },
    args: [selector],
  });

  const element = results?.[0]?.result;
  if (!element) return { found: false, selector };
  return { found: true, selector, element };
}

/**
 * Waits for an element matching the selector to appear in the DOM.
 * Polls every 200ms up to the specified timeout (default 10s).
 */
async function toolWaitForSelector({ selector, timeout }) {
  if (!selector) throw new Error('Missing required param: selector');
  const timeoutMs = timeout || 10000;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (sel, tMs) => {
      const start = Date.now();
      while (Date.now() - start < tMs) {
        const el = document.querySelector(sel);
        if (el) {
          return { found: true, selector: sel, elapsed: Date.now() - start };
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return { found: false, selector: sel, elapsed: tMs, timedOut: true };
    },
    args: [selector, timeoutMs],
  });

  return results?.[0]?.result;
}

/**
 * Gets cookies for a domain using chrome.cookies API.
 */
async function toolGetCookies({ domain }) {
  if (!domain) {
    // Default to current tab's domain
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) throw new Error('No active tab or URL available');
    domain = new URL(tab.url).hostname;
  }
  const cookies = await chrome.cookies.getAll({ domain });
  return {
    domain,
    cookies: cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      expirationDate: c.expirationDate || null,
    })),
    count: cookies.length,
  };
}

/**
 * Reads localStorage from the active tab.
 * If keys are provided, returns only those keys; otherwise returns all.
 */
async function toolGetLocalStorage({ keys }) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (requestedKeys) => {
      if (requestedKeys && requestedKeys.length > 0) {
        const data = {};
        for (const key of requestedKeys) {
          data[key] = localStorage.getItem(key);
        }
        return { data, count: requestedKeys.length };
      }
      const data = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        data[key] = localStorage.getItem(key);
      }
      return { data, count: localStorage.length };
    },
    args: [keys || null],
  });

  return results?.[0]?.result;
}

/**
 * Gets captured console messages from the content script.
 */
async function toolGetConsoleMessages({ clear }) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Content script did not respond within 5s'));
    }, 5000);

    chrome.tabs.sendMessage(tab.id, { type: 'getConsoleMessages', clear: !!clear }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        // Content script not loaded — return empty
        resolve({ messages: [], count: 0, error: chrome.runtime.lastError.message });
        return;
      }
      resolve({
        messages: response.messages || [],
        count: (response.messages || []).length,
      });
    });
  });
}

/**
 * Takes a full page screenshot by scrolling and capturing segments.
 * Returns an array of base64 screenshot segments from top to bottom.
 */
async function toolFullPageScreenshot() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');

  // Get page dimensions
  const dimResults = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    }),
  });
  const dims = dimResults?.[0]?.result;
  if (!dims) throw new Error('Could not read page dimensions');

  const segments = [];
  const steps = Math.ceil(dims.scrollHeight / dims.viewportHeight);

  // Scroll to top first
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => window.scrollTo(0, 0),
  });
  await new Promise(r => setTimeout(r, 150));

  for (let i = 0; i < steps; i++) {
    // Scroll to position
    const scrollY = i * dims.viewportHeight;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (y) => window.scrollTo(0, y),
      args: [scrollY],
    });
    await new Promise(r => setTimeout(r, 200)); // wait for render

    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    segments.push({ index: i, scrollY, base64 });
  }

  // Restore original scroll position
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (x, y) => window.scrollTo(x, y),
    args: [dims.scrollX, dims.scrollY],
  });

  return {
    segments,
    totalHeight: dims.scrollHeight,
    viewportHeight: dims.viewportHeight,
    segmentCount: segments.length,
    format: 'png',
  };
}

// ── Utilities ────────────────────────────────────────────────────────────────

/**
 * Waits for a tab to finish loading (up to 10 seconds).
 */
function _waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 10000);

    function listener(updatedId, changeInfo) {
      if (updatedId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── Log reporting ────────────────────────────────────────────────────────

/**
 * Append a structured log entry to the local buffer.
 * @param {'info'|'warn'|'error'|'debug'} level - Log level
 * @param {string} message - Log message
 * @param {object} [data] - Optional structured data
 */
function _appendLog(level, message, data) {
  _logBuffer.push({
    timestamp: new Date().toISOString(),
    level,
    message,
    data: data || null,
  });
  if (_logBuffer.length > LOG_BUFFER_MAX) {
    _logBuffer.splice(0, _logBuffer.length - LOG_BUFFER_MAX);
  }
}

/**
 * Flush buffered logs to the Crewly backend.
 * Sends all accumulated logs and clears the buffer on success.
 * Non-blocking, fire-and-forget — errors are logged but ignored.
 */
async function _flushLogs() {
  if (!logReportingUrl || _logBuffer.length === 0) return;

  const batch = _logBuffer.splice(0, _logBuffer.length);
  try {
    const response = await fetch(logReportingUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'chrome-extension', logs: batch }),
    });
    if (!response.ok) {
      console.warn('[crewly] Log flush failed:', response.status);
      // Put logs back so they're not lost
      _logBuffer.unshift(...batch);
      if (_logBuffer.length > LOG_BUFFER_MAX) {
        _logBuffer.splice(0, _logBuffer.length - LOG_BUFFER_MAX);
      }
    }
  } catch (err) {
    console.warn('[crewly] Log flush error:', err.message);
    // Put logs back
    _logBuffer.unshift(...batch);
    if (_logBuffer.length > LOG_BUFFER_MAX) {
      _logBuffer.splice(0, _logBuffer.length - LOG_BUFFER_MAX);
    }
  }
}

/**
 * Start periodic log flushing to the backend.
 */
function _startLogFlush() {
  _stopLogFlush();
  logFlushTimer = setInterval(() => _flushLogs(), LOG_FLUSH_INTERVAL_MS);
}

/**
 * Stop periodic log flushing.
 */
function _stopLogFlush() {
  if (logFlushTimer) {
    clearInterval(logFlushTimer);
    logFlushTimer = null;
  }
}

/**
 * Get current buffered logs (for popup or external inspection).
 * @param {number} [limit=50] - Maximum entries to return
 * @returns {{logs: Array, count: number}}
 */
function getLogBuffer(limit = 50) {
  const slice = _logBuffer.slice(-limit);
  return { logs: slice, count: _logBuffer.length };
}

// ── Message handler (from popup) ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getState') {
    sendResponse(getState());
    return false;
  }
  if (msg.type === 'connect') {
    connect(msg.url);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'disconnect') {
    disconnect();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'getLogs') {
    sendResponse(getLogBuffer(msg.limit || 50));
    return false;
  }
  if (msg.type === 'setLogReporting') {
    logReportingUrl = msg.url || '';
    chrome.storage.local.set({ logReportingUrl: logReportingUrl });
    if (logReportingUrl) {
      _startLogFlush();
      _appendLog('info', 'Log reporting enabled', { url: logReportingUrl });
    } else {
      _stopLogFlush();
    }
    sendResponse({ ok: true, url: logReportingUrl });
    return false;
  }
  if (msg.type === 'flushLogs') {
    _flushLogs().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true; // async response
  }
  return false;
});

// ── Restore connection on Service Worker wake ────────────────────────────────

chrome.storage.local.get(['serverUrl', 'logReportingUrl'], (data) => {
  if (data.serverUrl) {
    serverUrl = data.serverUrl;
    // Auto-reconnect on SW restart
    _openSocket(serverUrl);
  }
  if (data.logReportingUrl) {
    logReportingUrl = data.logReportingUrl;
    _startLogFlush();
  }
});
