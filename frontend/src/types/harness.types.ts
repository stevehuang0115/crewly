/**
 * Harness Types
 *
 * Shapes returned by the `/api/harness` endpoints used by the first-run
 * setup flow (`/setup`) and the Settings → Harness tab: which coding
 * harnesses are installed, which one the orchestrator uses, install jobs
 * and browser-driven login sessions (the "login broker").
 *
 * @module types/harness.types
 */

/** Coding harness identifiers known to Crewly. */
export type HarnessId = 'claude-code' | 'codex-cli' | 'gemini-cli';

/** Whether the harness CLI currently holds a usable login. */
export type HarnessLoginState = 'logged_in' | 'logged_out' | 'unknown';

/** Login method identifiers. */
export type HarnessLoginMethodId = 'subscription' | 'api_key' | 'device';

/** How a login method is completed: through the terminal broker or a pasted API key. */
export type HarnessLoginMethodKind = 'broker' | 'api_key';

/** One way to log in to a harness. */
export interface HarnessLoginMethod {
  id: HarnessLoginMethodId;
  label: string;
  kind: HarnessLoginMethodKind;
}

/** Install / version / login status of one harness. */
export interface HarnessStatus {
  id: HarnessId;
  displayName: string;
  installed: boolean;
  version: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  loginState: HarnessLoginState;
  loginSource: string | null;
  loginMethods: HarnessLoginMethod[];
}

/** A supporting system tool (e.g. `jq`) the skills rely on. */
export interface SystemToolStatus {
  id: string;
  installed: boolean;
  installHint: string;
}

/** Payload of `GET /api/harness`. */
export interface HarnessOverview {
  harnesses: HarnessStatus[];
  orcHarness: HarnessId | null;
  systemTools: SystemToolStatus[];
}

/** Install job lifecycle. */
export type InstallJobState = 'running' | 'succeeded' | 'failed';

/** Payload of `GET /api/harness/install/:jobId`. */
export interface InstallJob {
  state: InstallJobState;
  log: string;
  /** True when npm fell back to a user-owned prefix (no admin rights needed). */
  usedUserPrefix: boolean;
}

/** Login-broker session lifecycle. */
export type LoginSessionState =
  | 'starting'
  | 'awaiting_user'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

/** A login-broker session: the harness's own login command running in a hidden terminal. */
export interface LoginSession {
  id: string;
  harnessId: HarnessId;
  method: HarnessLoginMethodId;
  state: LoginSessionState;
  url: string | null;
  userCode: string | null;
  needsInput: boolean;
  message: string | null;
  screen: string | null;
  startedAt: string;
  updatedAt: string;
}

/** Broker login methods (the ones that start a login session). */
export type BrokerLoginMethodId = Exclude<HarnessLoginMethodId, 'api_key'>;

/** States after which a login session no longer changes. */
export const TERMINAL_LOGIN_STATES: ReadonlySet<LoginSessionState> = new Set<LoginSessionState>([
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
]);

/**
 * Whether a login session has reached a final state (stop polling).
 *
 * @param state - Session state
 * @returns True for succeeded / failed / timed_out / cancelled
 */
export function isTerminalLoginState(state: LoginSessionState): boolean {
  return TERMINAL_LOGIN_STATES.has(state);
}

/**
 * Whether the broker is waiting on the user but its screen rules did not
 * recognise anything actionable (no URL, no code, no input prompt). The UI
 * then falls back to showing the raw terminal text plus a free-text box.
 *
 * @param session - Login session
 * @returns True when the raw-screen fallback should be shown
 */
export function isUnrecognizedScreen(session: LoginSession): boolean {
  return session.state === 'awaiting_user' && !session.url && !session.userCode && !session.needsInput;
}
