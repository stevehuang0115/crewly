#!/usr/bin/env node
/**
 * Crewly Remote Browser — Test WebSocket Server
 *
 * A simple CLI tool for testing the Chrome Extension.
 * Starts a WebSocket server, accepts one extension connection,
 * and lets you type commands interactively.
 *
 * Usage:
 *   npm install ws   (if not already installed)
 *   node test-server.js [port]
 *
 * Commands (type JSON or use shortcuts):
 *   navigate <url>        — Navigate active tab
 *   screenshot             — Capture visible tab
 *   readText [selector]    — Read page text
 *   getTabs                — List open tabs
 *   exec <code>            — Execute JS in active tab
 *   raw <json>             — Send raw JSON command
 *   help                   — Show this help
 *   quit                   — Exit
 */

const { WebSocketServer } = require('ws');
const readline = require('readline');

const PORT = parseInt(process.argv[2], 10) || 9222;
let cmdCounter = 0;
let extensionSocket = null;

// ── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT });

console.log(`\n  Crewly Remote Browser — Test Server`);
console.log(`  WebSocket listening on ws://localhost:${PORT}`);
console.log(`  Waiting for Chrome Extension to connect...\n`);

wss.on('connection', (socket, req) => {
  extensionSocket = socket;
  console.log(`  [+] Extension connected from ${req.socket.remoteAddress}`);
  showPrompt();

  socket.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.log(`  [recv] (non-JSON) ${data}`);
      return;
    }

    // Handle heartbeat pings
    if (msg.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    // Print command results
    console.log(`\n  [result] id=${msg.id} success=${msg.success}`);
    if (msg.success && msg.result) {
      const display = { ...msg.result };
      // Truncate base64 for readability
      if (display.base64) {
        display.base64 = display.base64.substring(0, 60) + '... (' + display.length + ' chars)';
      }
      // Truncate long text
      if (display.text && display.text.length > 500) {
        display.text = display.text.substring(0, 500) + '... (' + display.length + ' chars)';
      }
      console.log('  ' + JSON.stringify(display, null, 2).replace(/\n/g, '\n  '));
    } else if (msg.error) {
      console.log(`  [error] ${msg.error}`);
    }
    showPrompt();
  });

  socket.on('close', () => {
    console.log(`\n  [-] Extension disconnected`);
    extensionSocket = null;
    showPrompt();
  });
});

// ── CLI Interface ────────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function showPrompt() {
  const status = extensionSocket ? '\x1b[32mconnected\x1b[0m' : '\x1b[31mdisconnected\x1b[0m';
  rl.setPrompt(`  [${status}] crewly> `);
  rl.prompt();
}

rl.on('line', (line) => {
  const input = line.trim();
  if (!input) { showPrompt(); return; }

  if (input === 'quit' || input === 'exit') {
    console.log('  Bye!');
    process.exit(0);
  }

  if (input === 'help') {
    printHelp();
    showPrompt();
    return;
  }

  if (!extensionSocket) {
    console.log('  [!] No extension connected. Load the extension and connect from popup.');
    showPrompt();
    return;
  }

  const cmd = parseShortcut(input);
  if (!cmd) {
    console.log('  [!] Unknown command. Type "help" for usage.');
    showPrompt();
    return;
  }

  console.log(`  [send] ${JSON.stringify(cmd)}`);
  extensionSocket.send(JSON.stringify(cmd));
});

/**
 * Parses shortcut commands into JSON command objects.
 * @param {string} input - User input string
 * @returns {object|null} Command object or null if unrecognized
 */
function parseShortcut(input) {
  const id = `cmd-${++cmdCounter}`;

  // navigate <url>
  if (input.startsWith('navigate ')) {
    const url = input.substring(9).trim();
    return { id, tool: 'navigate', params: { url } };
  }

  // screenshot
  if (input === 'screenshot') {
    return { id, tool: 'screenshot', params: {} };
  }

  // readText [selector]
  if (input === 'readText' || input.startsWith('readText ')) {
    const selector = input.substring(8).trim() || undefined;
    return { id, tool: 'readText', params: { selector } };
  }

  // getTabs
  if (input === 'getTabs') {
    return { id, tool: 'getTabs', params: {} };
  }

  // exec <code>
  if (input.startsWith('exec ')) {
    const code = input.substring(5).trim();
    return { id, tool: 'executeScript', params: { code } };
  }

  // raw JSON
  if (input.startsWith('raw ') || input.startsWith('{')) {
    try {
      const json = input.startsWith('raw ') ? input.substring(4) : input;
      const parsed = JSON.parse(json);
      if (!parsed.id) parsed.id = id;
      return parsed;
    } catch {
      console.log('  [!] Invalid JSON');
      return null;
    }
  }

  return null;
}

function printHelp() {
  console.log(`
  Commands:
    navigate <url>        Navigate active tab to URL
    screenshot            Capture visible tab as PNG
    readText [selector]   Read page text (optional CSS selector)
    getTabs               List all open tabs
    exec <code>           Execute JavaScript in active tab
    raw <json>            Send raw JSON command
    help                  Show this help
    quit                  Exit
  `);
}

showPrompt();
