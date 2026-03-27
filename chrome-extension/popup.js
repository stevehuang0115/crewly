/**
 * Crewly Remote Browser — Popup Script
 *
 * Controls the popup UI: server URL input, connect/disconnect buttons,
 * and live connection status display.
 */

const statusBar = document.getElementById('statusBar');
const statusText = document.getElementById('statusText');
const errorText = document.getElementById('errorText');
const urlInput = document.getElementById('serverUrl');
const btnConnect = document.getElementById('btnConnect');
const btnDisconnect = document.getElementById('btnDisconnect');

const STATUS_LABELS = {
  disconnected: 'Disconnected',
  connecting: 'Connecting...',
  connected: 'Connected',
  error: 'Connection Failed',
};

/** Debounce timer for auto-saving URL input */
let urlSaveTimer = null;

/** Poll timer for syncing state when broadcast is missed */
let statePollTimer = null;

/**
 * Updates the UI to reflect the current connection state.
 * @param {string} state - One of: disconnected, connecting, connected, error
 * @param {string} [url] - The server URL (optional)
 * @param {string} [error] - Error message (optional)
 */
function updateUI(state, url, error) {
  // Treat 'error' as a disconnected variant for CSS
  const cssClass = state === 'error' ? 'disconnected error' : state;
  statusBar.className = 'status-bar ' + cssClass;
  statusText.textContent = STATUS_LABELS[state] || state;
  btnConnect.disabled = state === 'connected' || state === 'connecting';
  btnDisconnect.disabled = state === 'disconnected' || state === 'error';
  if (url) {
    urlInput.value = url;
  }
  // Show/hide error message
  if (errorText) {
    errorText.textContent = error || '';
    errorText.style.display = error ? 'block' : 'none';
  }

  // Stop polling once we reach a final state
  if (state === 'connected' || state === 'disconnected' || state === 'error') {
    _stopStatePoll();
  }
}

/**
 * Queries the background SW for current state and updates the UI.
 * Handles cases where the SW is not ready (dead, restarting).
 */
function syncState() {
  chrome.runtime.sendMessage({ type: 'getState' }, (response) => {
    if (chrome.runtime.lastError) {
      // SW not ready — show error hint
      updateUI('error', urlInput.value, 'Extension service worker not responding. Try reloading the extension.');
      return;
    }
    if (response) {
      updateUI(
        response.connectionState,
        response.serverUrl || urlInput.value,
        response.lastError || '',
      );
    }
  });
}

/**
 * Starts polling the SW state every 1.5s for up to 10s.
 * This catches the case where _broadcastState from the SW
 * doesn't reach the popup (e.g. timing issues in MV3).
 */
function _startStatePoll() {
  _stopStatePoll();
  let elapsed = 0;
  statePollTimer = setInterval(() => {
    elapsed += 1500;
    if (elapsed > 10000) {
      _stopStatePoll();
      // Timed out — check final state
      syncState();
      return;
    }
    syncState();
  }, 1500);
}

function _stopStatePoll() {
  if (statePollTimer) {
    clearInterval(statePollTimer);
    statePollTimer = null;
  }
}

/**
 * Saves the server URL to chrome.storage.local.
 * Called on every input change (debounced) so the URL persists even if
 * the popup closes before the user clicks Connect.
 * @param {string} url - URL to persist
 */
function persistUrl(url) {
  chrome.storage.local.set({ serverUrl: url });
}

// ── Initial state ────────────────────────────────────────────────────────────

// Always restore URL from storage first (reliable, survives SW restarts).
// Then sync connection state from the background service worker.
// This avoids a race where getState() returns empty serverUrl because the SW
// hasn't finished reading from chrome.storage.local yet.
chrome.storage.local.get('serverUrl', (data) => {
  if (data.serverUrl) {
    urlInput.value = data.serverUrl;
  }
  // After storage is loaded, get live connection state from SW
  syncState();
});

// ── Button handlers ──────────────────────────────────────────────────────────

btnConnect.addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (!url) {
    urlInput.focus();
    return;
  }
  // Validate URL format
  if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    updateUI('error', url, 'URL must start with ws:// or wss://');
    return;
  }
  chrome.runtime.sendMessage({ type: 'connect', url }, (response) => {
    if (chrome.runtime.lastError) {
      updateUI('error', url, 'Failed to reach extension background. Try reloading.');
      return;
    }
  });
  updateUI('connecting', url);
  // Start polling to catch the state transition (connecting → connected/error)
  _startStatePoll();
});

btnDisconnect.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'disconnect' });
  updateUI('disconnected');
});

// Allow Enter key to trigger connect
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnConnect.click();
});

// Auto-save URL as user types (debounced 500ms) so it persists
// even if the popup closes before clicking Connect.
urlInput.addEventListener('input', () => {
  clearTimeout(urlSaveTimer);
  urlSaveTimer = setTimeout(() => {
    const url = urlInput.value.trim();
    if (url) {
      persistUrl(url);
    }
  }, 500);
});

// ── Listen for state changes from background ─────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'stateChanged') {
    updateUI(msg.connectionState, msg.serverUrl, msg.lastError || '');
  }
});
