/**
 * Which local process is on the other end of a TCP connection, and does it
 * belong to an agent? (#999, specs/2026-10-03-owner-auth.md §4)
 *
 * Agents run as the owner's OS user, so they can read `~/.crewly/api-token`
 * and could ask for a dashboard session over loopback. File permissions
 * cannot stop that. What does distinguish an agent is how it was started:
 * every agent process descends from this backend (PTY shells, crewly-agent
 * children, Codex daemons started from a PTY), runs on an agent PTY's
 * terminal, or carries an agent's environment. The owner's browser, terminal,
 * Vite dev server and Electron app have none of these.
 *
 * For a connection from this host, this service finds the client process
 * (`lsof`, or `ss` on Linux) and checks those signals against one `ps`
 * snapshot (the environment signal is Linux-only: macOS does not expose
 * another process's environment). A lookup that cannot run (tool missing)
 * or times out answers `unknown`, and the caller fails open with a warning
 * (residual risk 3 in the spec). A lookup that ran but found no client
 * process — it exited first, which an agent can arrange by writing the
 * request over a raw socket — answers `gone`, and the caller fails CLOSED.
 *
 * A determined process can still shed all three signals (double-fork,
 * `setsid`, `env -i`). That is the same-OS-user limit the spec documents.
 *
 * @module services/core/peer-process.service
 */

import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import * as os from 'os';
import { OWNER_AUTH_CONSTANTS, API_SECURITY_CONSTANTS } from '../../constants.js';

/** One row of the process table. */
export interface PeerProcessEntry {
  ppid: number;
  /** Controlling terminal (`??` / `?` when none) */
  tty: string;
}

/** The verdict on a connection's client process. */
export type PeerVerdict =
  | { kind: 'remote' }
  | { kind: 'self' }
  | { kind: 'agent'; pid: number; signal: 'ancestry' | 'tty' | 'env'; session: string | null }
  | { kind: 'not-agent'; pid: number }
  /**
   * The lookup ran but the client process is not there (it exited before it
   * could be looked up, or no socket matched). Fails CLOSED: an agent can
   * write a request over a raw socket and exit at once (#1010 review).
   */
  | { kind: 'gone'; reason: string }
  /** The lookup could not run: the tool is missing or it timed out. Fails open. */
  | { kind: 'unknown'; reason: string };

/** The parts of a socket the lookup needs. */
export interface PeerSocketLike {
  remoteAddress?: string;
  remotePort?: number;
  localPort?: number;
}

/** Injectable collaborators (tests). */
export interface PeerProcessDeps {
  /** Pid of the client end of `clientPort → serverPort`, or null */
  findPeerPid?: (clientPort: number, serverPort: number) => Promise<number | null>;
  /** pid → {ppid, tty} for every process */
  readTable?: () => Promise<Map<number, PeerProcessEntry>>;
  /** The environment of a process, or null when unreadable */
  readEnv?: (pid: number) => Promise<Record<string, string> | null>;
  /** PTY shell pid → session name for the live agent sessions */
  listSessionPids?: () => Map<number, string>;
  /** This backend's pid */
  selfPid?: number;
  /** Whether an address belongs to this host */
  isHostAddress?: (address: string) => boolean;
  /** Lookup budget */
  timeoutMs?: number;
}

/**
 * Normalise an address for comparison (`::ffff:1.2.3.4` → `1.2.3.4`).
 *
 * @param address - Address string
 * @returns Normalised address
 */
function normaliseAddress(address: string): string {
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

/**
 * Whether an address belongs to this host: loopback, or any of its own
 * interface addresses (an agent can connect to the machine's LAN IP too).
 *
 * @param address - Remote address of a connection
 * @param interfaces - `os.networkInterfaces()` (tests)
 * @returns True for a connection from this machine
 */
export function isHostAddress(address: string, interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): boolean {
  if (!address) return false;
  if ((API_SECURITY_CONSTANTS.LOOPBACK_ADDRESSES as readonly string[]).includes(address)) return true;
  const target = normaliseAddress(address);
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (normaliseAddress(entry.address) === target) return true;
    }
  }
  return false;
}

/**
 * Run a command, resolving stdout ('' on a non-zero exit with no output).
 *
 * @param cmd - Executable
 * @param args - Arguments
 * @param timeoutMs - Budget
 * @returns stdout
 */
function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      // lsof exits 1 when nothing matched: that is an answer, not a failure.
      if (error && !(stdout && stdout.length > 0) && (error as { code?: unknown }).code !== 1) {
        reject(error);
        return;
      }
      resolve(stdout ?? '');
    });
  });
}

/**
 * Parse `lsof -nP -iTCP:<port> -Fpn` output: the pid whose socket's LOCAL
 * end is `clientPort` and remote end is `serverPort`.
 *
 * @param output - lsof field output (`p<pid>` / `n<a>:<p>-><b>:<q>` lines)
 * @param clientPort - The client's ephemeral port
 * @param serverPort - This backend's port
 * @returns The client pid, or null
 */
export function parseLsofPeer(output: string, clientPort: number, serverPort: number): number | null {
  let pid: number | null = null;
  const re = new RegExp(`:${clientPort}->.*:${serverPort}$`);
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1));
      pid = Number.isInteger(n) && n > 0 ? n : null;
    } else if (line.startsWith('n') && pid !== null && re.test(line.slice(1).trim())) {
      return pid;
    }
  }
  return null;
}

/**
 * Parse `ss -Htnp '( sport = :<clientPort> )'` output: the first pid listed
 * for a connection to `serverPort`.
 *
 * @param output - ss output
 * @param serverPort - This backend's port
 * @returns The client pid, or null
 */
export function parseSsPeer(output: string, serverPort: number): number | null {
  for (const line of output.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    if (!cols.some((c, i) => i >= 3 && new RegExp(`:${serverPort}$`).test(c))) continue;
    const m = /pid=(\d+)/.exec(line);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Find the client pid of a connection with the platform's tools.
 *
 * @param clientPort - Client's ephemeral port (the connection's remotePort)
 * @param serverPort - This backend's port (the connection's localPort)
 * @param timeoutMs - Budget
 * @returns pid or null
 */
async function defaultFindPeerPid(clientPort: number, serverPort: number, timeoutMs: number): Promise<number | null> {
  if (process.platform === 'linux') {
    let output: string | null = null;
    try {
      output = await run('ss', ['-Htnp', `( sport = :${clientPort} )`], timeoutMs);
    } catch {
      output = null; // ss unusable: fall through to lsof
    }
    // ss ran: its answer stands, including "nothing" (falling through to a
    // missing lsof would turn "not found" into "could not look").
    if (output !== null) return parseSsPeer(output, serverPort);
  }
  return parseLsofPeer(await run('lsof', ['-nP', `-iTCP:${clientPort}`, '-Fpn'], timeoutMs), clientPort, serverPort);
}

/**
 * Parse `ps -Ao pid=,ppid=,tty=` output.
 *
 * @param output - ps output
 * @returns pid → entry
 */
export function parsePsTable(output: string): Map<number, PeerProcessEntry> {
  const table = new Map<number, PeerProcessEntry>();
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), tty: m[3] ?? '?' });
  }
  return table;
}

/**
 * Read another process's environment (same user) — Linux only, from
 * `/proc/<pid>/environ`. macOS does not expose another process's
 * environment (`ps -E` prints none, checked on macOS 15), so there the
 * ancestry and terminal signals carry the check.
 *
 * @param pid - Process
 * @returns The variables this check cares about, or null when unreadable
 */
async function defaultReadEnv(pid: number): Promise<Record<string, string> | null> {
  if (process.platform !== 'linux') return null;
  const wanted = ['CREWLY_SESSION_NAME', OWNER_AUTH_CONSTANTS.AGENT_BADGE_ENV];
  const out: Record<string, string> = {};
  try {
    const raw = await fsp.readFile(`/proc/${pid}/environ`, 'utf8');
    for (const pair of raw.split('\0')) {
      const eq = pair.indexOf('=');
      if (eq > 0 && wanted.includes(pair.slice(0, eq))) out[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return out;
  } catch {
    return null;
  }
}

/** Terminal names that mean "no controlling terminal". */
const NO_TTY = new Set(['?', '??', '-', '']);

/**
 * Decide whether a process is an agent's, from a process-table snapshot.
 *
 * @param pid - The client process
 * @param table - pid → {ppid, tty}
 * @param selfPid - This backend's pid
 * @param sessionPids - PTY shell pid → session name
 * @returns `agent` with the signal that matched, or null
 */
export function agentSignalFromTable(
  pid: number,
  table: ReadonlyMap<number, PeerProcessEntry>,
  selfPid: number,
  sessionPids: ReadonlyMap<number, string>,
): { signal: 'ancestry' | 'tty'; session: string | null } | null {
  // 1. Ancestry: anything the backend spawned (directly or not) is an agent's.
  let current = pid;
  let session: string | null = null;
  const seen = new Set<number>();
  for (let depth = 0; depth < OWNER_AUTH_CONSTANTS.PEER_MAX_ANCESTRY_DEPTH && current > 1 && !seen.has(current); depth++) {
    seen.add(current);
    session ??= sessionPids.get(current) ?? null;
    const entry = table.get(current);
    if (!entry) break;
    if (entry.ppid === selfPid) return { signal: 'ancestry', session };
    current = entry.ppid;
  }
  // 2. Terminal: a process orphaned out of an agent's shell keeps its PTY.
  const tty = table.get(pid)?.tty ?? '';
  if (!NO_TTY.has(tty)) {
    for (const [shellPid, name] of sessionPids) {
      if (table.get(shellPid)?.tty === tty) return { signal: 'tty', session: name };
    }
  }
  return null;
}

/** Thrown when a lookup takes longer than its budget. */
class LookupTimeoutError extends Error {}

/**
 * Reject with {@link LookupTimeoutError} if the work takes longer than `ms`.
 *
 * @param promise - Work
 * @param ms - Budget
 * @returns The work's result
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new LookupTimeoutError('timed out')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Whether a lookup error means "could not look" (fail open) rather than
 * "looked and it is not there" (fail closed): the tool is missing, or it
 * was killed for running past its budget.
 *
 * @param error - The error
 * @returns True for a missing tool or a timeout
 */
export function isLookupUnavailable(error: unknown): boolean {
  if (error instanceof LookupTimeoutError) return true;
  const e = error as { code?: unknown; killed?: unknown } | null;
  return Boolean(e && (e.code === 'ENOENT' || e.killed === true));
}

/**
 * Classifies the client process of local connections, once per socket.
 */
export class PeerProcessService {
  private readonly cache = new WeakMap<object, Promise<PeerVerdict>>();
  private readonly deps: Required<PeerProcessDeps>;

  /**
   * @param deps - Injectable collaborators
   */
  constructor(deps: PeerProcessDeps = {}) {
    const timeoutMs = deps.timeoutMs ?? OWNER_AUTH_CONSTANTS.PEER_LOOKUP_TIMEOUT_MS;
    this.deps = {
      findPeerPid: deps.findPeerPid ?? ((c, s) => defaultFindPeerPid(c, s, timeoutMs)),
      readTable: deps.readTable ?? (async () => parsePsTable(await run('ps', ['-Ao', 'pid=,ppid=,tty='], timeoutMs))),
      readEnv: deps.readEnv ?? ((pid) => defaultReadEnv(pid)),
      listSessionPids: deps.listSessionPids ?? (() => new Map()),
      selfPid: deps.selfPid ?? process.pid,
      isHostAddress: deps.isHostAddress ?? ((a) => isHostAddress(a)),
      timeoutMs,
    };
  }

  /**
   * Classify the client of a connection. Cached per socket object (a
   * keep-alive dashboard or CLI pays for one lookup).
   *
   * @param socket - The request's socket
   * @returns The verdict
   */
  classify(socket: PeerSocketLike | null | undefined): Promise<PeerVerdict> {
    if (!socket) return Promise.resolve({ kind: 'gone', reason: 'no socket' });
    const hit = this.cache.get(socket);
    if (hit) return hit;
    const verdict = this.lookup(socket);
    this.cache.set(socket, verdict);
    return verdict;
  }

  /**
   * Uncached classification.
   *
   * @param socket - The request's socket
   * @returns The verdict
   */
  private async lookup(socket: PeerSocketLike): Promise<PeerVerdict> {
    const address = socket.remoteAddress ?? '';
    // Node clears remoteAddress once the peer has closed the socket: a sender
    // that already hung up is not "remote", it is gone (#1010 review).
    if (!address) return { kind: 'gone', reason: 'socket already closed' };
    if (!this.deps.isHostAddress(address)) return { kind: 'remote' };
    const clientPort = socket.remotePort;
    const serverPort = socket.localPort;
    if (!clientPort || !serverPort) return { kind: 'gone', reason: 'no ports' };
    const work = async (): Promise<PeerVerdict> => {
      const pid = await this.deps.findPeerPid(clientPort, serverPort);
      if (!pid) return { kind: 'gone', reason: 'client process not found' };
      if (pid === this.deps.selfPid) return { kind: 'self' };
      const table = await this.deps.readTable();
      // Exited between the two lookups: nothing left to vouch for it.
      if (!table.has(pid)) return { kind: 'gone', reason: 'client process exited' };
      const sessionPids = this.deps.listSessionPids();
      const fromTable = agentSignalFromTable(pid, table, this.deps.selfPid, sessionPids);
      if (fromTable) return { kind: 'agent', pid, ...fromTable };
      // 3. Environment: an agent shell's variables survive an orphaning fork.
      const env = await this.deps.readEnv(pid);
      if (env && (env['CREWLY_SESSION_NAME'] || env[OWNER_AUTH_CONSTANTS.AGENT_BADGE_ENV])) {
        return { kind: 'agent', pid, signal: 'env', session: env['CREWLY_SESSION_NAME'] || null };
      }
      return { kind: 'not-agent', pid };
    };
    try {
      return await withTimeout(work(), this.deps.timeoutMs);
    } catch (error) {
      if (isLookupUnavailable(error)) {
        return { kind: 'unknown', reason: error instanceof LookupTimeoutError ? 'lookup timed out' : 'lookup tool unavailable' };
      }
      return { kind: 'gone', reason: `lookup failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
