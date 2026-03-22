/**
 * CLI Cloud Command Group
 *
 * Provides subcommands for managing CrewlyAI Cloud connection:
 *   crewly cloud login [--token <token>]  — Authenticate with CrewlyAI Cloud
 *   crewly cloud status                   — Show current connection status
 *   crewly cloud logout                   — Disconnect from CrewlyAI Cloud
 *
 * The login flow supports three modes:
 * 1. Direct token login via --token flag
 * 2. Browser-based OAuth: starts a local HTTP callback server, opens the
 *    backend Google OAuth URL, receives the token via redirect, persists
 *    credentials to ~/.crewly/cloud/config.json, then calls POST /api/cloud/connect.
 * 3. Mobile/no-browser login via --no-browser flag: prints a URL for the user
 *    to open on their phone, which displays the token after OAuth for manual copy-paste.
 *
 * @module cli/commands/cloud
 */

import chalk from 'chalk';
import axios from 'axios';
import http from 'http';
import readline from 'readline';
import { exec } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { DEFAULT_WEB_PORT } from '../constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Backend base URL (local Crewly backend for connect/status/disconnect) */
const BACKEND_URL = `http://localhost:${DEFAULT_WEB_PORT}`;

/** CrewlyAI Cloud API base URL (where OAuth happens — NOT local backend) */
const CLOUD_API_URL = process.env['CREWLY_CLOUD_URL'] || 'https://api.crewlyai.com';

/** Cloud connect endpoint (local backend) */
const CLOUD_CONNECT_ENDPOINT = '/api/cloud/connect';

/** Cloud disconnect endpoint (local backend) */
const CLOUD_DISCONNECT_ENDPOINT = '/api/cloud/disconnect';

/** Cloud status endpoint (local backend) */
const CLOUD_STATUS_ENDPOINT = '/api/cloud/status';

/** Google OAuth start endpoint (on Cloud API, NOT local backend) */
const GOOGLE_OAUTH_START_ENDPOINT = '/api/cloud/google/start';

/** Cloud Console URL (where the CLI token page is hosted) */
const CLOUD_CONSOLE_URL = process.env['CLOUD_CONSOLE_URL'] || 'https://crewlyai.com';

/** CLI token display page path on the Cloud Console */
const CLI_TOKEN_PAGE_PATH = '/cloud/cli-token';

/** Timeout for backend API requests (ms) */
const API_TIMEOUT_MS = 15_000;

/** Directory for cloud credentials */
const CLOUD_CONFIG_DIR = join(homedir(), '.crewly', 'cloud');

/** Path to cloud config file */
const CLOUD_CONFIG_FILE = join(CLOUD_CONFIG_DIR, 'config.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for the login subcommand */
interface LoginOptions {
  token?: string;
  /** Commander.js sets this to false when --no-browser is passed */
  browser?: boolean;
}

/**
 * Shape of the credentials saved to config.json.
 *
 * Must match PersistedCloudConfig in cloud-client.service.ts so the backend
 * can load credentials saved by the CLI (and vice versa).
 */
interface CloudCredentials {
  cloudUrl: string;
  token: string;
  refreshToken?: string;
  tier: string;
  connectedAt: string;
}

/** Shape of the cloud status response data */
interface CloudStatusData {
  connectionStatus?: string;
  tier?: string;
  cloudUrl?: string;
  lastSyncAt?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Save cloud credentials to ~/.crewly/cloud/config.json.
 *
 * Creates the directory hierarchy if it does not exist.
 *
 * @param token - JWT access token
 * @param refreshToken - Optional refresh token
 */
/**
 * Save cloud credentials to ~/.crewly/cloud/config.json.
 *
 * Creates the directory hierarchy if it does not exist. The format matches
 * PersistedCloudConfig so the backend's loadPersistedConfig() can read it.
 *
 * @param token - JWT access token
 * @param refreshToken - Optional refresh token for auto-renewal
 */
export function saveCloudCredentials(token: string, refreshToken?: string): void {
  if (!existsSync(CLOUD_CONFIG_DIR)) {
    mkdirSync(CLOUD_CONFIG_DIR, { recursive: true });
  }

  // Merge with existing config to preserve fields the backend may have written
  let existing: Partial<CloudCredentials> = {};
  try {
    if (existsSync(CLOUD_CONFIG_FILE)) {
      existing = JSON.parse(readFileSync(CLOUD_CONFIG_FILE, 'utf-8'));
    }
  } catch {
    // Ignore parse errors — overwrite with new credentials
  }

  const credentials: CloudCredentials = {
    cloudUrl: existing.cloudUrl || CLOUD_API_URL,
    token,
    tier: existing.tier || 'pro',
    connectedAt: new Date().toISOString(),
    ...(refreshToken && { refreshToken }),
    // Preserve existing refreshToken if new one not provided
    ...(!refreshToken && existing.refreshToken && { refreshToken: existing.refreshToken }),
  };
  writeFileSync(CLOUD_CONFIG_FILE, JSON.stringify(credentials, null, 2), 'utf-8');
}

/**
 * Load cloud credentials from ~/.crewly/cloud/config.json.
 *
 * @returns The saved credentials, or null if the file does not exist or is invalid
 */
export function loadCloudCredentials(): CloudCredentials | null {
  if (!existsSync(CLOUD_CONFIG_FILE)) {
    return null;
  }
  try {
    const raw = readFileSync(CLOUD_CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as CloudCredentials;
  } catch {
    return null;
  }
}

/**
 * Detect whether the current environment can open a browser.
 *
 * Returns false for SSH sessions, Docker containers, and Linux systems
 * without a display server. Returns true for macOS terminals and Linux
 * desktops with DISPLAY or WAYLAND_DISPLAY set.
 *
 * @returns true if browser can likely be opened
 */
export function canOpenBrowser(): boolean {
  // SSH session — no local browser available
  if (process.env['SSH_CLIENT'] || process.env['SSH_TTY'] || process.env['SSH_CONNECTION']) {
    return false;
  }

  // Docker container (common marker file)
  try {
    if (existsSync('/.dockerenv')) {
      return false;
    }
  } catch {
    // Ignore — assume we're not in Docker
  }

  // CI environments
  if (process.env['CI'] || process.env['GITHUB_ACTIONS'] || process.env['JENKINS_URL']) {
    return false;
  }

  // Linux without display server
  if (platform() === 'linux' && !process.env['DISPLAY'] && !process.env['WAYLAND_DISPLAY']) {
    return false;
  }

  return true;
}

/**
 * Open a URL in the user's default browser.
 *
 * Uses `open` on macOS and `xdg-open` on Linux.
 *
 * @param url - The URL to open
 */
export function openBrowser(url: string): void {
  const cmd = platform() === 'darwin' ? 'open' : 'xdg-open';
  exec(`${cmd} "${url}"`);
}

/**
 * Handle API errors with user-friendly output.
 *
 * Differentiates between network errors (backend not running) and
 * server errors (backend returned an error status).
 *
 * @param error - The caught error
 * @param action - Description of the failed action for the error message
 */
function handleApiError(error: unknown, action: string): never {
  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNREFUSED') {
      console.log(chalk.red(`  ✗ Cannot ${action}: Crewly backend is not running.`));
      console.log(chalk.gray('  Start with: crewly start'));
    } else if (error.response) {
      const msg = error.response.data?.error || error.response.statusText || 'Server error';
      console.log(chalk.red(`  ✗ Failed to ${action}: ${msg}`));
    } else {
      console.log(chalk.red(`  ✗ Failed to ${action}: ${error.message}`));
    }
  } else {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`  ✗ Failed to ${action}: ${msg}`));
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Login subcommand
// ---------------------------------------------------------------------------

/**
 * Start a temporary HTTP server to receive the OAuth callback.
 *
 * The server listens on a random port and resolves with the token and
 * refreshToken query parameters from the callback URL. It automatically
 * shuts down after receiving the callback or after a 120-second timeout.
 *
 * @returns An object containing the server instance, the port, and a
 *          promise that resolves with the received credentials
 */
export function startCallbackServer(): {
  server: http.Server;
  port: Promise<number>;
  credentials: Promise<{ token: string; refreshToken?: string }>;
} {
  let resolvePort: (port: number) => void;
  let resolveCreds: (creds: { token: string; refreshToken?: string }) => void;
  let rejectCreds: (err: Error) => void;

  const portPromise = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });

  const credsPromise = new Promise<{ token: string; refreshToken?: string }>((resolve, reject) => {
    resolveCreds = resolve;
    rejectCreds = reject;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost`);
    if (url.pathname === '/callback') {
      const token = url.searchParams.get('token');
      const refreshToken = url.searchParams.get('refreshToken') || undefined;

      if (token) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Login successful!</h2><p>You can close this tab.</p></body></html>');
        resolveCreds({ token, refreshToken });
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Login failed</h2><p>No token received.</p></body></html>');
        rejectCreds(new Error('No token received in callback'));
      }

      // Shut down server after response
      setTimeout(() => server.close(), 500);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(0, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    resolvePort!(port);
  });

  // Timeout after 120 seconds
  const timeout = setTimeout(() => {
    server.close();
    rejectCreds!(new Error('Login timed out — no callback received within 120 seconds'));
  }, 120_000);

  // Clean up timeout when credentials resolve
  credsPromise.then(() => clearTimeout(timeout)).catch(() => clearTimeout(timeout));

  return { server, port: portPromise, credentials: credsPromise };
}

/**
 * Prompt the user to paste a token from stdin.
 *
 * Creates a readline interface and waits for the user to paste the token
 * they copied from the mobile login page.
 *
 * @param prompt - The prompt message to display
 * @returns The trimmed user input
 */
export function promptForToken(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Handle the `crewly cloud login` subcommand.
 *
 * Supports three login modes:
 * 1. `--token <token>`: saves the token and calls POST /api/cloud/connect directly.
 * 2. `--no-browser`: prints a URL for mobile login, waits for user to paste token.
 * 3. Default: starts a local HTTP callback server, opens the browser to the
 *    backend OAuth URL, waits for the callback, saves credentials.
 *
 * @param options - Login command options (optional --token, --no-browser)
 */
export async function loginCommand(options: LoginOptions): Promise<void> {
  if (options.token) {
    // Direct token login
    console.log(chalk.blue('Logging in with provided token...'));
    await connectWithToken(options.token);
    return;
  }

  // Auto-detect: use mobile flow if --no-browser was passed OR environment
  // cannot open a browser (SSH, Docker, CI, headless Linux).
  const useBrowser = options.browser !== false && canOpenBrowser();

  if (!useBrowser) {
    if (options.browser !== false) {
      // Auto-detected headless — inform the user
      console.log(chalk.yellow('  Headless environment detected — using manual token flow.'));
    }
    await mobileLoginFlow();
    return;
  }

  // Browser-based OAuth flow — redirects to crewlyai.com (Cloud), NOT local backend.
  // The Cloud server handles Google OAuth and redirects back to our local callback
  // with token + refreshToken as query parameters.
  console.log('');
  console.log(chalk.blue('CrewlyAI Cloud Login'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log('');

  const { server, port: portPromise, credentials } = startCallbackServer();

  try {
    const port = await portPromise;
    const redirectUrl = `http://localhost:${port}/callback`;

    // Build OAuth URL pointing to Cloud API (crewlyai.com), not local backend.
    // The Cloud server has Google OAuth credentials configured — local backend does not.
    const oauthUrl = `${CLOUD_API_URL}${GOOGLE_OAUTH_START_ENDPOINT}?redirect=${encodeURIComponent(redirectUrl)}`;

    console.log(chalk.white('Opening browser for Google OAuth...'));
    console.log(chalk.gray(`  Auth server: ${CLOUD_API_URL}`));
    console.log(chalk.gray(`  Callback:    http://localhost:${port}/callback`));
    openBrowser(oauthUrl);
    console.log(chalk.gray('  Waiting for OAuth callback...'));
    console.log('');

    const creds = await credentials;
    saveCloudCredentials(creds.token, creds.refreshToken);
    console.log(chalk.green('  ✓ Credentials saved'));

    if (creds.refreshToken) {
      console.log(chalk.green('  ✓ Refresh token saved (enables auto-renewal)'));
    } else {
      console.log(chalk.yellow('  ⚠ No refresh token received — token will expire without auto-renewal'));
    }

    await connectWithToken(creds.token, creds.refreshToken);
  } catch (error) {
    server.close();
    const msg = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`  ✗ Login failed: ${msg}`));
    process.exit(1);
  }
}

/**
 * Mobile-friendly login flow for headless or remote environments.
 *
 * Generates a URL that the user opens on their phone. After Google OAuth,
 * they land on a page that displays the token for copying. The user then
 * pastes the token back into the CLI.
 *
 * Flow:
 * 1. CLI prints a URL pointing to Cloud OAuth with redirect to /cloud/cli-token
 * 2. User opens URL on phone, completes Google OAuth
 * 3. Cloud redirects to crewlyai.com/cloud/cli-token?token=X&refreshToken=Y
 * 4. Page displays the token with a copy button
 * 5. User pastes the token into the CLI prompt
 */
async function mobileLoginFlow(): Promise<void> {
  console.log('');
  console.log(chalk.blue('CrewlyAI Cloud Login (Mobile)'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log('');

  // Build the OAuth URL that redirects to the CLI token page after login
  const cliTokenPageUrl = `${CLOUD_CONSOLE_URL}${CLI_TOKEN_PAGE_PATH}`;
  const oauthUrl = `${CLOUD_API_URL}${GOOGLE_OAUTH_START_ENDPOINT}?redirect=${encodeURIComponent(cliTokenPageUrl)}`;

  console.log(chalk.white('  Open this URL on your phone or any browser:'));
  console.log('');
  console.log(chalk.cyan(`  ${oauthUrl}`));
  console.log('');
  console.log(chalk.gray('  After logging in, you\'ll see a token on the page.'));
  console.log(chalk.gray('  Copy the token and paste it below.'));
  console.log('');

  const token = await promptForToken(chalk.white('  Paste token here: '));

  if (!token) {
    console.log(chalk.red('  ✗ No token provided'));
    process.exit(1);
  }

  console.log('');
  console.log(chalk.blue('  Connecting with token...'));
  await connectWithToken(token);
}

/**
 * Connect to CrewlyAI Cloud by calling POST /api/cloud/connect.
 *
 * On success, displays the connection tier info.
 *
 * @param token - JWT access token
 * @param refreshToken - Optional refresh token
 */
/**
 * Connect to CrewlyAI Cloud by calling POST /api/cloud/connect on the local backend.
 *
 * If the local backend is not running, saves credentials locally and informs the user
 * that the connection will be established on next `crewly start`.
 *
 * @param token - JWT access token
 * @param refreshToken - Optional refresh token for auto-renewal
 */
async function connectWithToken(token: string, refreshToken?: string): Promise<void> {
  // Always save credentials first — even if backend is down, next start will use them
  saveCloudCredentials(token, refreshToken);

  try {
    const response = await axios.post(
      `${BACKEND_URL}${CLOUD_CONNECT_ENDPOINT}`,
      { token, refreshToken },
      { timeout: API_TIMEOUT_MS },
    );

    if (response.data?.success) {
      console.log(chalk.green('  ✓ Connected to CrewlyAI Cloud'));
      const tier = response.data.data?.tier || response.data.tier || 'unknown';
      console.log(chalk.green(`  ✓ Tier: ${tier}`));
    } else {
      const msg = response.data?.error || 'Unknown error';
      console.log(chalk.yellow(`  ⚠ Backend connect returned: ${msg}`));
      console.log(chalk.gray('  Credentials saved — connection will activate on next crewly start'));
    }
  } catch (error) {
    if (axios.isAxiosError(error) && error.code === 'ECONNREFUSED') {
      // Backend not running — this is OK, credentials are saved
      console.log(chalk.green('  ✓ Credentials saved to ~/.crewly/cloud/config.json'));
      console.log(chalk.gray('  Backend not running — Cloud will connect automatically on next crewly start'));
    } else {
      const msg = axios.isAxiosError(error)
        ? (error.response?.data?.error || error.message)
        : (error instanceof Error ? error.message : String(error));
      console.log(chalk.yellow(`  ⚠ Backend connect failed: ${msg}`));
      console.log(chalk.gray('  Credentials saved — connection will activate on next crewly start'));
    }
  }
}

// ---------------------------------------------------------------------------
// Status subcommand
// ---------------------------------------------------------------------------

/**
 * Handle the `crewly cloud status` subcommand.
 *
 * Calls GET /api/cloud/status and displays the connection state,
 * tier, cloud URL, and last sync time with color-coded output.
 */
export async function statusCommand(): Promise<void> {
  console.log(chalk.blue('Checking CrewlyAI Cloud status...'));
  console.log('');

  try {
    const response = await axios.get(
      `${BACKEND_URL}${CLOUD_STATUS_ENDPOINT}`,
      { timeout: API_TIMEOUT_MS },
    );

    if (response.data?.success) {
      const data: CloudStatusData = response.data.data || {};
      const status = data.connectionStatus || 'unknown';
      const tier = data.tier || 'none';
      const cloudUrl = data.cloudUrl || 'N/A';
      const lastSyncAt = data.lastSyncAt || 'never';

      // Color-code the status
      let statusDisplay: string;
      if (status === 'connected') {
        statusDisplay = chalk.green(status);
      } else if (status === 'token_expired') {
        statusDisplay = chalk.yellow(status);
      } else {
        statusDisplay = chalk.red(status);
      }

      console.log(`  Status:     ${statusDisplay}`);
      console.log(`  Tier:       ${chalk.white(tier)}`);
      console.log(`  Cloud URL:  ${chalk.gray(cloudUrl)}`);
      console.log(`  Last sync:  ${chalk.gray(lastSyncAt)}`);
    } else {
      console.log(chalk.yellow('  Could not retrieve cloud status.'));
    }
  } catch (error) {
    handleApiError(error, 'check cloud status');
  }
}

// ---------------------------------------------------------------------------
// Logout subcommand
// ---------------------------------------------------------------------------

/**
 * Handle the `crewly cloud logout` subcommand.
 *
 * Calls POST /api/cloud/disconnect to terminate the cloud session.
 */
export async function logoutCommand(): Promise<void> {
  console.log(chalk.blue('Disconnecting from CrewlyAI Cloud...'));

  try {
    const response = await axios.post(
      `${BACKEND_URL}${CLOUD_DISCONNECT_ENDPOINT}`,
      {},
      { timeout: API_TIMEOUT_MS },
    );

    if (response.data?.success) {
      console.log(chalk.green('  ✓ Disconnected from CrewlyAI Cloud'));
    } else {
      console.log(chalk.yellow('  No active cloud session to disconnect.'));
    }
  } catch (error) {
    handleApiError(error, 'disconnect from CrewlyAI Cloud');
  }
}
