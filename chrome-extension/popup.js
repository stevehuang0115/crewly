/**
 * Crewly Remote Browser — Popup Script
 *
 * Controls the popup UI: server URL input, connect/disconnect buttons,
 * and live connection status display.
 */

const statusBar = document.getElementById('statusBar');
const statusText = document.getElementById('statusText');
const urlInput = document.getElementById('serverUrl');
const btnConnect = document.getElementById('btnConnect');
const btnDisconnect = document.getElementById('btnDisconnect');

const STATUS_LABELS = {
  disconnected: 'Disconnected',
  connecting: 'Connecting...',
  connected: 'Connected',
};

/**
 * Updates the UI to reflect the current connection state.
 * @param {string} state - One of: disconnected, connecting, connected
 * @param {string} [url] - The server URL (optional)
 */
function updateUI(state, url) {
  statusBar.className = 'status-bar ' + state;
  statusText.textContent = STATUS_LABELS[state] || state;
  btnConnect.disabled = state === 'connected' || state === 'connecting';
  btnDisconnect.disabled = state === 'disconnected';
  if (url) {
    urlInput.value = url;
  }
}

// ── Initial state ────────────────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: 'getState' }, (response) => {
  if (response) {
    updateUI(response.connectionState, response.serverUrl);
  }
});

// Restore last URL from storage
chrome.storage.local.get('serverUrl', (data) => {
  if (data.serverUrl && !urlInput.value) {
    urlInput.value = data.serverUrl;
  }
});

// ── Button handlers ──────────────────────────────────────────────────────────

btnConnect.addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (!url) {
    urlInput.focus();
    return;
  }
  chrome.runtime.sendMessage({ type: 'connect', url });
  updateUI('connecting', url);
});

btnDisconnect.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'disconnect' });
  updateUI('disconnected');
});

// Allow Enter key to trigger connect
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnConnect.click();
});

// ── Listen for state changes from background ─────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'stateChanged') {
    updateUI(msg.connectionState, msg.serverUrl);
  }
});
