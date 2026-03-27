/**
 * Crewly Remote Browser — Content Script
 *
 * Injected into all pages. Provides DOM access helpers
 * that can be invoked from the background service worker
 * via chrome.scripting.executeScript or message passing.
 *
 * Features:
 * - Console message capture (buffers last 50 log/warn/error messages)
 * - Visual indicators when AI is controlling the tab
 */

// ── Console Message Capture ──────────────────────────────────────────────────

const _crewlyConsoleBuffer = [];
const _CONSOLE_BUFFER_MAX = 50;

/**
 * Hook a console method to capture messages into the buffer.
 * @param {string} level - Console level (log, warn, error)
 */
function _hookConsole(level) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    _crewlyConsoleBuffer.push({
      level,
      message: args.map(a => {
        try { return typeof a === 'string' ? a : JSON.stringify(a); }
        catch { return String(a); }
      }).join(' '),
      timestamp: Date.now(),
    });
    // Keep buffer bounded
    while (_crewlyConsoleBuffer.length > _CONSOLE_BUFFER_MAX) {
      _crewlyConsoleBuffer.shift();
    }
    original(...args);
  };
}

_hookConsole('log');
_hookConsole('warn');
_hookConsole('error');

// ── Visual Control Indicators ────────────────────────────────────────────────

const CREWLY_BLUE = '#2a73ea';
const INDICATOR_ID = '__crewly-ai-indicator';
const BORDER_ID = '__crewly-ai-border';
const CURSOR_ID = '__crewly-ai-cursor';

/** Action labels for the floating panel */
const ACTION_LABELS = {
  navigate: 'Navigating...',
  screenshot: 'Taking screenshot...',
  readText: 'Reading page...',
  click: 'Clicking...',
  fill: 'Filling input...',
  type: 'Typing...',
  scroll: 'Scrolling...',
  hover: 'Hovering...',
  pressKey: 'Pressing key...',
  executeScript: 'Running script...',
  getElement: 'Inspecting element...',
  waitForSelector: 'Waiting for element...',
  getCookies: 'Reading cookies...',
  getLocalStorage: 'Reading storage...',
  getConsoleMessages: 'Reading console...',
  fullPageScreenshot: 'Full page capture...',
  getTabs: 'Listing tabs...',
};

/**
 * Show the AI control indicator — glowing border + floating panel + custom cursor.
 * Glow: Full-edge inset box-shadow with pulsing animation (OSS blue).
 * Panel: Bottom-center floating div showing current action and agent name.
 * Cursor: Custom crosshair-style cursor indicating AI control.
 *
 * @param {string} action - Tool name being executed
 * @param {string} [agentName] - Name of the agent performing the action
 */
function showControlIndicator(action, agentName) {
  hideControlIndicator(); // Remove any existing indicator first

  // ── Glowing edge overlay with pulsing inset box-shadow ──
  const border = document.createElement('div');
  border.id = BORDER_ID;
  Object.assign(border.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    right: '0',
    bottom: '0',
    pointerEvents: 'none',
    zIndex: '2147483646',
    boxShadow: 'inset 0 0 30px rgba(42, 115, 234, 0.3)',
    animation: '__crewlyBorderPulse 2s ease-in-out infinite',
  });
  document.documentElement.appendChild(border);

  // ── Custom cursor overlay ──
  const cursorOverlay = document.createElement('div');
  cursorOverlay.id = CURSOR_ID;
  Object.assign(cursorOverlay.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    right: '0',
    bottom: '0',
    zIndex: '2147483645',
    pointerEvents: 'none',
    cursor: 'none',
  });
  document.documentElement.appendChild(cursorOverlay);

  // ── Floating panel (bottom center) ──
  const panel = document.createElement('div');
  panel.id = INDICATOR_ID;

  const label = ACTION_LABELS[action] || 'Working...';
  const titleText = agentName
    ? `${agentName} is taking over`
    : 'Crewly is taking over';

  // Build indicator DOM safely — no innerHTML with dynamic data
  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px' });

  const dot = document.createElement('div');
  Object.assign(dot.style, {
    width: '8px', height: '8px', borderRadius: '50%',
    background: CREWLY_BLUE,
    animation: '__crewlyPulse 1.5s ease-in-out infinite',
  });

  const title = document.createElement('span');
  Object.assign(title.style, { fontWeight: '600', color: '#ffffff', fontSize: '13px' });
  title.textContent = titleText;

  const actionLabel = document.createElement('span');
  Object.assign(actionLabel.style, { color: 'rgba(255,255,255,0.7)', fontSize: '12px' });
  actionLabel.textContent = `· ${label}`;

  row.appendChild(dot);
  row.appendChild(title);
  row.appendChild(actionLabel);
  panel.appendChild(row);

  Object.assign(panel.style, {
    position: 'fixed',
    bottom: '20px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '2147483647',
    background: 'rgba(42, 115, 234, 0.9)',
    backdropFilter: 'blur(10px)',
    borderRadius: '12px',
    padding: '8px 20px',
    fontFamily: '"Nunito", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    boxShadow: '0 4px 24px rgba(0,0,0,0.3), 0 0 16px rgba(42, 115, 234, 0.3)',
    pointerEvents: 'none',
    transition: 'opacity 0.3s ease',
  });

  // Inject keyframe animation + custom cursor styles if not already present
  if (!document.getElementById('__crewlyStyles')) {
    const style = document.createElement('style');
    style.id = '__crewlyStyles';
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600&display=swap');
      @keyframes __crewlyPulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(0.85); }
      }
      @keyframes __crewlyBorderPulse {
        0%, 100% {
          box-shadow: inset 0 0 30px rgba(42, 115, 234, 0.3);
        }
        50% {
          box-shadow: inset 0 0 50px rgba(42, 115, 234, 0.5);
        }
      }
      .__crewly-ai-cursor-active,
      .__crewly-ai-cursor-active * {
        cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='none' stroke='%232a73ea' stroke-width='2' opacity='0.8'/%3E%3Ccircle cx='12' cy='12' r='3' fill='%232a73ea'/%3E%3C/svg%3E") 12 12, crosshair !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  // Apply custom cursor class to body
  document.body.classList.add('__crewly-ai-cursor-active');

  document.documentElement.appendChild(panel);
}

/**
 * Hide the AI control indicator, cursor overlay, and custom cursor class.
 */
function hideControlIndicator() {
  const border = document.getElementById(BORDER_ID);
  const panel = document.getElementById(INDICATOR_ID);
  const cursorOverlay = document.getElementById(CURSOR_ID);
  if (border) border.remove();
  if (panel) panel.remove();
  if (cursorOverlay) cursorOverlay.remove();
  document.body.classList.remove('__crewly-ai-cursor-active');
}

// ── Message handler (from background script) ────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getConsoleMessages') {
    const messages = [..._crewlyConsoleBuffer];
    if (msg.clear) {
      _crewlyConsoleBuffer.length = 0;
    }
    sendResponse({ messages });
    return false;
  }

  if (msg.type === 'showIndicator') {
    showControlIndicator(msg.action || 'unknown', msg.agentName || '');
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'hideIndicator') {
    hideControlIndicator();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

console.log('[crewly] Content script loaded on', window.location.href);
