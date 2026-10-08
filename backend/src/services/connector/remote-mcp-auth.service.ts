/**
 * OAuth for remote MCP servers — the owner signs in once, from a phone.
 *
 * Flow (owner-away: nothing runs on `localhost` in the owner's browser):
 *
 * 1. A server answers 401 + `WWW-Authenticate: Bearer resource_metadata=…`
 *    (on add, on test, or through the agent proxy). Discovery, dynamic
 *    client registration and PKCE run here (see remote-mcp-oauth).
 * 2. The authorize URL (minus `state`) goes to the Crewly Cloud broker,
 *    which adds `state`, hosts the public redirect URI and returns a
 *    single-use ticket link. The PKCE verifier never leaves this machine.
 * 3. The link reaches the owner as a Slack card (throttled), in the API
 *    response and on the Connections / portal card.
 * 4. This service polls the broker; when the code arrives it exchanges it
 *    with the verifier, stores the tokens and tells the broker (the page on
 *    the owner's phone then says "connected") and Slack.
 * 5. {@link RemoteMcpAuthService.getAccessToken} hands the agent proxy a
 *    fresh token, refreshing before expiry (single-flight per server).
 *
 * State lives in `<CREWLY_HOME>/remote-mcp-oauth.enc`: AES-256-GCM under
 * the install's master key, mode 0600. Nothing secret is logged.
 *
 * @module services/connector/remote-mcp-auth.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { CloudClientService } from '../cloud/cloud-client.service.js';
import { REMOTE_MCP_CONSTANTS } from '../../constants.js';
import { decrypt, encrypt, ensureMasterKey } from '../../utils/encryption.utils.js';
import {
  RemoteMcpOAuthError,
  buildAuthorizeUrl,
  createPkcePair,
  discoverAuthorization,
  exchangeCode,
  parseWwwAuthenticate,
  refreshTokens,
  registerClient,
  type BearerChallenge,
  type DiscoveredAuthorization,
  type OAuthClient,
  type OAuthFetch,
  type OAuthTokens,
} from './remote-mcp-oauth.js';
import { RemoteMcpService, type RemoteMcpServer } from './remote-mcp.service.js';
import { probeRemoteMcp } from './remote-mcp-probe.service.js';

const C = REMOTE_MCP_CONSTANTS;

/** A sign-in waiting on the owner. */
export interface PendingAuthorization {
  /** Broker session (never logged). */
  state: string;
  verifier: string;
  /** Ticket link (single-use). */
  url: string;
  startedAt: number;
  /** When the link stops working. */
  expiresAt: number;
  /** The owner has opened the link. */
  opened?: boolean;
  /** The agent whose call needed it (its Slack DM gets the receipt). */
  agentSession?: string;
}

/** Per-server OAuth record. */
export interface RemoteMcpOAuthRecord {
  status: 'needs_auth' | 'connected' | 'error';
  discovered?: DiscoveredAuthorization;
  client?: OAuthClient;
  /** The client was entered by the owner (no dynamic registration). */
  manualClient?: boolean;
  tokens?: OAuthTokens;
  connectedAt?: string;
  lastError?: string;
  pending?: PendingAuthorization;
  /** Last Slack card: when, and for which link. */
  lastCard?: { at: number; state: string };
}

/** The whole encrypted file. */
interface OAuthStoreData {
  /** Random per-install key that binds broker sessions to this machine. */
  instanceKey: string;
  servers: Record<string, RemoteMcpOAuthRecord>;
}

/** What the API shows about a server's sign-in (no secrets). */
export interface RemoteMcpAuthView {
  mode: 'oauth';
  status: 'needs_auth' | 'connected' | 'error';
  /** Host of the authorization server. */
  authorizationServer?: string;
  scopes?: string[];
  /** ISO time the current access token expires. */
  expiresAt?: string;
  connectedAt?: string;
  error?: string;
  /** A live sign-in link, when one is pending. */
  authorizeUrl?: string;
  authorizeExpiresAt?: string;
}

/** Slack side, wired at boot (see slack-initializer). */
export interface RemoteMcpAuthNotifier {
  /** Post the "sign in once" card to the owner. */
  postAuthCard(args: { serverLabel: string; url: string; expiresAt: string; agentSession?: string }): Promise<boolean>;
  /** Tell the owner how it went. */
  postReceipt(args: { serverLabel: string; text: string; agentSession?: string }): Promise<boolean>;
}

/** Collaborators (tests inject). */
export interface RemoteMcpAuthDeps {
  crewlyHome?: string;
  fetchImpl?: OAuthFetch;
  cloud?: { getToken(): string | null; getCloudUrl(): string | null };
  now?: () => number;
  /** Schedules a poll (tests drive it by hand). */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void } | unknown;
  clearTimer?: (handle: unknown) => void;
  /** Server lookup (label, URL) for polls that outlive the caller. */
  getServer?: (id: string) => Promise<RemoteMcpServer | undefined>;
  /** List tools after sign-in (for the receipt). */
  countTools?: (server: RemoteMcpServer, headers: Record<string, string>) => Promise<number | null>;
}

/** Owner-facing failure of an authorization start. */
export class RemoteMcpAuthError extends Error {
  constructor(readonly code: 'not_signed_in' | 'cloud_error' | 'oauth' | 'not_oauth', message: string) {
    super(message);
    this.name = 'RemoteMcpAuthError';
  }
}

/** `{ jsonrpc, id, method }` initialize body used to detect OAuth. */
const DETECT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: C.PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'crewly', version: '1.0.0' } },
});

let notifier: RemoteMcpAuthNotifier | null = null;

/**
 * Wire (or clear) the Slack notifier.
 *
 * @param next - Notifier, or null
 */
export function setRemoteMcpAuthNotifier(next: RemoteMcpAuthNotifier | null): void {
  notifier = next;
}

/**
 * Remote MCP OAuth — see module docs.
 */
export class RemoteMcpAuthService {
  private static instance: RemoteMcpAuthService | null = null;
  private readonly logger: ComponentLogger;
  private readonly crewlyHome: string;
  private readonly fetchImpl: OAuthFetch;
  private readonly cloud: { getToken(): string | null; getCloudUrl(): string | null };
  private readonly now: () => number;
  private readonly setTimer: NonNullable<RemoteMcpAuthDeps['setTimer']>;
  private readonly clearTimer: NonNullable<RemoteMcpAuthDeps['clearTimer']>;
  private readonly deps: RemoteMcpAuthDeps;
  private cache: OAuthStoreData | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();
  private readonly refreshing = new Map<string, Promise<string | null>>();
  private readonly timers = new Map<string, unknown>();
  private redirectUri: string | null = null;
  private readonly lastUnauthorized = new Map<string, number>();

  constructor(deps: RemoteMcpAuthDeps = {}) {
    this.deps = deps;
    this.logger = LoggerService.getInstance().createComponentLogger('RemoteMcpAuth');
    this.crewlyHome = deps.crewlyHome || getCrewlyHomePath();
    this.fetchImpl = deps.fetchImpl ?? (fetch as unknown as OAuthFetch);
    this.cloud = deps.cloud ?? CloudClientService.getInstance();
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  static getInstance(): RemoteMcpAuthService {
    if (!RemoteMcpAuthService.instance) {
      RemoteMcpAuthService.instance = new RemoteMcpAuthService({
        getServer: (id) => RemoteMcpService.getInstance().get(id),
        countTools: async (server, headers) => {
          const r = await probeRemoteMcp({ url: server.url, headers: { ...(server.headers ?? {}), ...headers } });
          return r.ok ? r.toolCount : null;
        },
      });
    }
    return RemoteMcpAuthService.instance;
  }

  /** Reset the singleton (tests). */
  static resetInstance(): void {
    RemoteMcpAuthService.instance?.stop();
    RemoteMcpAuthService.instance = null;
  }

  /** Install an instance (tests / wiring). */
  static setInstance(service: RemoteMcpAuthService): void {
    RemoteMcpAuthService.instance = service;
  }

  /** Absolute path of the encrypted store. */
  getFilePath(): string {
    return path.join(this.crewlyHome, C.OAUTH_STORE_FILE);
  }

  private masterKeyPath(): string {
    return path.join(this.crewlyHome, C.OAUTH_MASTER_KEY_FILE);
  }

  /** Stop every poll timer. */
  stop(): void {
    for (const h of this.timers.values()) this.clearTimer(h);
    this.timers.clear();
  }

  // ---------------------------------------------------------------- store

  private async load(): Promise<OAuthStoreData> {
    if (this.cache) return this.cache;
    let data: OAuthStoreData | null = null;
    try {
      const buf = await fs.readFile(this.getFilePath());
      data = JSON.parse(await decrypt(buf, this.masterKeyPath())) as OAuthStoreData;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Never the content: only that it could not be read.
        this.logger.error('Remote MCP OAuth store unreadable — starting empty (owners will be asked to sign in again)', {
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
    }
    if (!data || typeof data.instanceKey !== 'string' || !data.servers || typeof data.servers !== 'object') {
      data = { instanceKey: randomBytes(18).toString('base64url'), servers: {} };
    }
    this.cache = data;
    return data;
  }

  private async mutate<T>(fn: (data: OAuthStoreData) => T | Promise<T>): Promise<T> {
    const run = this.writeChain.then(async () => {
      const data = await this.load();
      const result = await fn(data);
      await ensureMasterKey(this.masterKeyPath());
      const enc = await encrypt(JSON.stringify(data), this.masterKeyPath());
      const file = this.getFilePath();
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
      await fs.writeFile(tmp, enc, { mode: 0o600 });
      await fs.chmod(tmp, 0o600);
      await fs.rename(tmp, file);
      return result;
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  /**
   * The record for a server, if it uses OAuth.
   *
   * @param id - Server id
   * @returns A copy of the record, or undefined
   */
  async getRecord(id: string): Promise<RemoteMcpOAuthRecord | undefined> {
    const rec = (await this.load()).servers[id];
    return rec ? JSON.parse(JSON.stringify(rec)) as RemoteMcpOAuthRecord : undefined;
  }

  /**
   * Whether a server signs in with OAuth.
   *
   * @param id - Server id
   * @returns True when it has an OAuth record
   */
  async usesOAuth(id: string): Promise<boolean> {
    return !!(await this.load()).servers[id];
  }

  /**
   * The API view of a server's sign-in.
   *
   * @param id - Server id
   * @returns The view, or undefined for a static-key server
   */
  async view(id: string): Promise<RemoteMcpAuthView | undefined> {
    const rec = (await this.load()).servers[id];
    if (!rec) return undefined;
    const now = this.now();
    const live = rec.pending && rec.pending.expiresAt > now && !rec.pending.opened ? rec.pending : undefined;
    let asHost: string | undefined;
    try {
      asHost = rec.discovered ? new URL(rec.discovered.metadata.authorization_endpoint).host : undefined;
    } catch {
      asHost = undefined;
    }
    return {
      mode: 'oauth',
      status: rec.status,
      ...(asHost ? { authorizationServer: asHost } : {}),
      ...(rec.tokens?.scope ? { scopes: rec.tokens.scope.split(/[\s,]+/).filter(Boolean) } : {}),
      ...(rec.tokens ? { expiresAt: new Date(rec.tokens.expiresAt).toISOString() } : {}),
      ...(rec.connectedAt ? { connectedAt: rec.connectedAt } : {}),
      ...(rec.lastError ? { error: rec.lastError } : {}),
      ...(live ? { authorizeUrl: live.url, authorizeExpiresAt: new Date(live.expiresAt).toISOString() } : {}),
    };
  }

  /**
   * Forget a server's sign-in (server removed).
   *
   * @param id - Server id
   */
  async forget(id: string): Promise<void> {
    const h = this.timers.get(id);
    if (h) this.clearTimer(h);
    this.timers.delete(id);
    if (!(await this.load()).servers[id]) return;
    await this.mutate((d) => {
      delete d.servers[id];
    });
  }

  /**
   * Set an owner-entered client (servers without dynamic registration).
   *
   * @param id - Server id
   * @param client - Client id and optional secret
   */
  async setManualClient(id: string, client: { clientId: string; clientSecret?: string }): Promise<void> {
    await this.mutate((d) => {
      const rec = d.servers[id] ?? { status: 'needs_auth' as const };
      rec.manualClient = true;
      // The redirect URI is filled in when the authorization starts.
      rec.client = {
        clientId: client.clientId,
        ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
        tokenAuthMethod: client.clientSecret ? 'client_secret_post' : 'none',
        redirectUri: '',
      };
      d.servers[id] = rec;
    });
  }

  // ------------------------------------------------------------ detection

  /**
   * Ask the server (no credentials beyond its static headers) whether it
   * wants OAuth.
   *
   * @param server - Stored server
   * @returns The Bearer challenge when it answered 401, else null
   */
  async detect(server: RemoteMcpServer): Promise<BearerChallenge | null> {
    try {
      const res = await this.fetchImpl(server.url, {
        method: 'POST',
        headers: { ...(server.headers ?? {}), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: DETECT_BODY,
        signal: AbortSignal.timeout(C.TEST_TIMEOUT_MS),
      });
      if (res.status !== 401) return null;
      return parseWwwAuthenticate(res.headers.get('www-authenticate')) ?? {};
    } catch {
      return null;
    }
  }

  /**
   * Record that a server needs OAuth and run discovery.
   *
   * @param server - Stored server
   * @param challenge - What its 401 said
   * @returns The record
   * @throws RemoteMcpAuthError oauth (discovery failed)
   */
  async markOAuth(server: RemoteMcpServer, challenge: BearerChallenge | null): Promise<RemoteMcpOAuthRecord> {
    let discovered: DiscoveredAuthorization;
    try {
      discovered = await discoverAuthorization(server.url, challenge, this.fetchImpl);
    } catch (err) {
      const message = err instanceof RemoteMcpOAuthError ? err.message : 'Could not discover how to sign in to this server.';
      await this.mutate((d) => {
        d.servers[server.id] = { ...(d.servers[server.id] ?? {}), status: 'error', lastError: message };
      });
      throw new RemoteMcpAuthError('oauth', message);
    }
    return this.mutate((d) => {
      const prev = d.servers[server.id];
      const rec: RemoteMcpOAuthRecord = { ...(prev ?? {}), status: prev?.tokens ? prev.status : 'needs_auth', discovered };
      delete rec.lastError;
      // A server that moved to another authorization server needs a new client.
      if (prev?.discovered && prev.discovered.issuer !== discovered.issuer && !prev.manualClient) delete rec.client;
      d.servers[server.id] = rec;
      this.logger.info('Remote MCP server uses OAuth', { id: server.id, authorizationServer: safeHost(discovered.metadata.authorization_endpoint) });
      return rec;
    });
  }

  // --------------------------------------------------------- authorization

  private async cloudRequest<T>(method: 'GET' | 'POST', suffix: string, body?: unknown): Promise<T> {
    const token = this.cloud.getToken();
    const base = this.cloud.getCloudUrl();
    if (!token || !base) throw new RemoteMcpAuthError('not_signed_in', 'Sign in to Crewly Cloud first (Settings → Cloud & devices): it hosts the sign-in page your phone opens.');
    let res: Awaited<ReturnType<OAuthFetch>>;
    try {
      res = await this.fetchImpl(`${base.replace(/\/$/, '')}${C.OAUTH_CLOUD_PATH}${suffix}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(C.OAUTH_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new RemoteMcpAuthError('cloud_error', 'Crewly Cloud is unreachable.');
    }
    const parsed = (await res.text().then((t) => JSON.parse(t) as { success?: boolean; data?: T; code?: string; message?: string }).catch(() => ({}))) as { success?: boolean; data?: T; code?: string; message?: string };
    if (res.status === 404 && !parsed.code) {
      throw new RemoteMcpAuthError('cloud_error', 'Crewly Cloud does not support remote MCP sign-in yet (update pending).');
    }
    if (!res.ok || parsed.success !== true) {
      const err = new RemoteMcpAuthError('cloud_error', `Crewly Cloud refused: ${String(parsed.message ?? parsed.code ?? res.status).slice(0, 120)}`);
      (err as RemoteMcpAuthError & { status?: number; cloudCode?: string }).status = res.status;
      (err as RemoteMcpAuthError & { cloudCode?: string }).cloudCode = parsed.code;
      throw err;
    }
    return (parsed.data ?? {}) as T;
  }

  private async getRedirectUri(): Promise<string> {
    if (this.redirectUri) return this.redirectUri;
    const data = await this.cloudRequest<{ redirectUri?: string }>('GET', '/config');
    if (!data.redirectUri) throw new RemoteMcpAuthError('cloud_error', 'Crewly Cloud did not name a redirect URI.');
    this.redirectUri = data.redirectUri;
    return data.redirectUri;
  }

  /**
   * Start (or reuse) a sign-in and return the link for the owner.
   *
   * @param server - Stored server
   * @param options - Who needed it, and whether to post the Slack card
   * @returns The ticket link and its expiry
   * @throws RemoteMcpAuthError
   */
  async startAuthorization(server: RemoteMcpServer, options: { agentSession?: string; notify?: boolean; challenge?: BearerChallenge | null } = {}): Promise<{ url: string; expiresAt: string; posted: boolean }> {
    let rec = (await this.load()).servers[server.id];
    if (!rec?.discovered) {
      const challenge = options.challenge ?? (await this.detect(server));
      // A server that never asked for OAuth is left alone (no record).
      if (!challenge && !rec) throw new RemoteMcpAuthError('not_oauth', 'This server does not ask for a sign-in (it did not answer 401).');
      rec = await this.markOAuth(server, challenge);
    }
    const now = this.now();

    // An untapped, live link is reused: one link per server at a time.
    if (rec.pending && !rec.pending.opened && rec.pending.expiresAt - now > 5 * 60_000) {
      this.schedulePoll(server.id, C.OAUTH_POLL_SLOW_MS);
      const posted = options.notify ? await this.maybePostCard(server, rec.pending, options.agentSession) : false;
      return { url: rec.pending.url, expiresAt: new Date(rec.pending.expiresAt).toISOString(), posted };
    }

    const redirectUri = await this.getRedirectUri();
    const discovered = rec.discovered!;
    let client = rec.client;
    if (client && rec.manualClient) {
      client = { ...client, redirectUri };
    } else if (!client || client.redirectUri !== redirectUri) {
      try {
        client = await registerClient(discovered.metadata, redirectUri, this.fetchImpl);
      } catch (err) {
        const message = err instanceof RemoteMcpOAuthError ? err.message : 'Could not register Crewly with the server.';
        await this.mutate((d) => {
          d.servers[server.id] = { ...d.servers[server.id], status: 'error', lastError: message };
        });
        throw new RemoteMcpAuthError('oauth', message);
      }
    }
    const { verifier, challenge } = createPkcePair();
    const authorizeUrl = buildAuthorizeUrl(discovered, client, challenge);
    const instanceKey = (await this.load()).instanceKey;
    const session = await this.cloudRequest<{ state: string; url: string; expiresAt: string }>('POST', '/sessions', {
      instanceKey,
      serverId: server.id,
      label: server.label,
      authorizeUrl,
    });
    const pending: PendingAuthorization = {
      state: session.state,
      verifier,
      url: session.url,
      startedAt: now,
      expiresAt: new Date(session.expiresAt).getTime() || now + 24 * 60 * 60_000,
      ...(options.agentSession ? { agentSession: options.agentSession } : {}),
    };
    const finalClient = client;
    await this.mutate((d) => {
      const r = d.servers[server.id] ?? rec!;
      r.client = finalClient;
      r.pending = pending;
      if (r.status !== 'connected') r.status = 'needs_auth';
      d.servers[server.id] = r;
    });
    this.logger.info('Remote MCP sign-in link created', { id: server.id, authorizationServer: safeHost(discovered.metadata.authorization_endpoint) });
    this.schedulePoll(server.id, C.OAUTH_POLL_SLOW_MS);
    const posted = options.notify ? await this.maybePostCard(server, pending, options.agentSession) : false;
    return { url: pending.url, expiresAt: new Date(pending.expiresAt).toISOString(), posted };
  }

  /**
   * Post the Slack card unless one carrying this same live link went out
   * within the throttle window.
   *
   * @param server - Server
   * @param pending - The live sign-in
   * @param agentSession - Agent whose DM should carry it
   * @returns Whether a card was posted
   */
  private async maybePostCard(server: RemoteMcpServer, pending: PendingAuthorization, agentSession?: string): Promise<boolean> {
    const rec = (await this.load()).servers[server.id];
    const now = this.now();
    if (rec?.lastCard && rec.lastCard.state === pending.state && now - rec.lastCard.at < C.OAUTH_CARD_THROTTLE_MS) return false;
    if (!notifier) return false;
    let posted = false;
    try {
      posted = await notifier.postAuthCard({ serverLabel: server.label, url: pending.url, expiresAt: new Date(pending.expiresAt).toISOString(), ...(agentSession ? { agentSession } : {}) });
    } catch (err) {
      this.logger.warn('Remote MCP sign-in card not posted', { id: server.id, error: err instanceof Error ? err.message : String(err) });
    }
    if (posted) {
      await this.mutate((d) => {
        if (d.servers[server.id]) d.servers[server.id].lastCard = { at: now, state: pending.state };
      });
      this.logger.info('Remote MCP sign-in card posted', { id: server.id, agentSession });
    }
    return posted;
  }

  /**
   * The proxy got a 401 it could not fix: ask the owner (throttled).
   *
   * @param server - Server
   * @param agentSession - The calling agent
   */
  async onUnauthorized(server: RemoteMcpServer, agentSession?: string): Promise<void> {
    // Many agent calls can fail at once: one attempt per server per minute.
    const last = this.lastUnauthorized.get(server.id) ?? 0;
    if (this.now() - last < 60_000) return;
    this.lastUnauthorized.set(server.id, this.now());
    await this.mutate((d) => {
      const r = d.servers[server.id];
      if (r && r.status === 'connected') {
        r.status = 'needs_auth';
        r.lastError = 'The server no longer accepts the sign-in.';
      }
    });
    try {
      await this.startAuthorization(server, { agentSession, notify: true });
    } catch (err) {
      this.logger.warn('Remote MCP: could not start a sign-in after a refusal', { id: server.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---------------------------------------------------------------- polls

  /**
   * Resume polls for sign-ins in flight (boot).
   */
  async resumePending(): Promise<void> {
    const data = await this.load();
    for (const [id, rec] of Object.entries(data.servers)) {
      if (rec.pending && rec.pending.expiresAt > this.now()) this.schedulePoll(id, 1000);
    }
  }

  private schedulePoll(id: string, ms: number): void {
    const prev = this.timers.get(id);
    if (prev) this.clearTimer(prev);
    this.timers.set(id, this.setTimer(() => {
      this.timers.delete(id);
      void this.pollOnce(id).catch((err) => this.logger.warn('Remote MCP poll failed', { id, error: err instanceof Error ? err.message : String(err) }));
    }, ms));
  }

  /**
   * One broker poll for a server's pending sign-in (exposed for tests).
   *
   * @param id - Server id
   * @returns The broker status seen
   */
  async pollOnce(id: string): Promise<string> {
    const rec = (await this.load()).servers[id];
    const pending = rec?.pending;
    if (!pending) return 'none';
    if (pending.expiresAt <= this.now()) {
      await this.clearPending(id, pending.state);
      return 'expired';
    }
    const instanceKey = (await this.load()).instanceKey;
    let status: { status: string; code?: string; error?: string };
    try {
      status = await this.cloudRequest<typeof status>('GET', `/sessions/${encodeURIComponent(pending.state)}?instanceKey=${encodeURIComponent(instanceKey)}`);
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        await this.clearPending(id, pending.state);
        return 'gone';
      }
      this.schedulePoll(id, C.OAUTH_POLL_SLOW_MS);
      return 'error';
    }
    switch (status.status) {
      case 'waiting':
        this.schedulePoll(id, C.OAUTH_POLL_SLOW_MS);
        break;
      case 'opened':
        if (!pending.opened) {
          await this.mutate((d) => {
            if (d.servers[id]?.pending?.state === pending.state) d.servers[id].pending!.opened = true;
          });
        }
        this.schedulePoll(id, C.OAUTH_POLL_FAST_MS);
        break;
      case 'authorized':
        if (status.code) await this.complete(id, pending, status.code);
        break;
      case 'declined':
        await this.mutate((d) => {
          const r = d.servers[id];
          if (r?.pending?.state !== pending.state) return;
          delete r.pending;
          if (r.status !== 'connected') r.lastError = 'Access was not granted.';
        });
        await this.receipt(id, pending, `Access was not granted, so nothing changed.`);
        break;
      default:
        await this.clearPending(id, pending.state);
    }
    return status.status;
  }

  private async clearPending(id: string, state: string): Promise<void> {
    await this.mutate((d) => {
      if (d.servers[id]?.pending?.state === state) delete d.servers[id].pending;
    });
  }

  /**
   * Exchange the code and store the tokens; tell Cloud and Slack.
   *
   * @param id - Server id
   * @param pending - The sign-in
   * @param code - Authorization code
   */
  private async complete(id: string, pending: PendingAuthorization, code: string): Promise<void> {
    const rec = (await this.load()).servers[id];
    const server = await this.deps.getServer?.(id);
    const label = server?.label ?? id;
    let ok = false;
    let message: string;
    try {
      if (!rec?.discovered || !rec.client) throw new RemoteMcpOAuthError('token_failed', 'The sign-in was set up on another version of Crewly; try again.');
      const tokens = await exchangeCode({
        tokenEndpoint: rec.discovered.metadata.token_endpoint,
        client: rec.client,
        code,
        verifier: pending.verifier,
        resource: rec.discovered.resource,
      }, this.fetchImpl, this.now);
      await this.mutate((d) => {
        const r = d.servers[id];
        if (!r) return;
        r.tokens = tokens;
        r.status = 'connected';
        r.connectedAt = new Date(this.now()).toISOString();
        delete r.lastError;
        if (r.pending?.state === pending.state) delete r.pending;
      });
      ok = true;
      let tools: number | null = null;
      if (server && this.deps.countTools) {
        tools = await this.deps.countTools(server, { Authorization: `Bearer ${tokens.accessToken}` }).catch(() => null);
      }
      message = tools !== null ? `${tools} tool${tools === 1 ? '' : 's'} ready for your agents.` : 'Your agents can use it now.';
      this.logger.info('Remote MCP server signed in', { id, tools });
    } catch (err) {
      message = err instanceof RemoteMcpOAuthError ? err.message : 'Crewly could not finish the sign-in.';
      await this.mutate((d) => {
        const r = d.servers[id];
        if (!r) return;
        if (r.pending?.state === pending.state) delete r.pending;
        r.status = r.tokens ? r.status : 'error';
        r.lastError = message;
      });
      this.logger.warn('Remote MCP sign-in exchange failed', { id, error: message });
    }
    const instanceKey = (await this.load()).instanceKey;
    await this.cloudRequest('POST', `/sessions/${encodeURIComponent(pending.state)}/result`, { instanceKey, ok, message }).catch(() => undefined);
    await this.receipt(id, pending, ok ? `${label} is connected — ${message} Agents started before now pick it up when they restart.` : `${label} sign-in did not finish: ${message}`, label);
  }

  private async receipt(id: string, pending: PendingAuthorization, text: string, label?: string): Promise<void> {
    if (!notifier) return;
    const serverLabel = label ?? (await this.deps.getServer?.(id))?.label ?? id;
    await notifier.postReceipt({ serverLabel, text, ...(pending.agentSession ? { agentSession: pending.agentSession } : {}) }).catch(() => false);
  }

  // ---------------------------------------------------------------- tokens

  /**
   * A usable access token for a server, refreshed when it is about to
   * expire (or when `force`).
   *
   * @param id - Server id
   * @param options - `force` refreshes even when the token looks fresh
   * @returns The access token, or null when the owner must sign in
   */
  async getAccessToken(id: string, options: { force?: boolean } = {}): Promise<string | null> {
    const rec = (await this.load()).servers[id];
    if (!rec?.tokens) return null;
    const fresh = rec.tokens.expiresAt - this.now() > C.OAUTH_REFRESH_MARGIN_MS;
    if (fresh && !options.force) return rec.tokens.accessToken;
    const inflight = this.refreshing.get(id);
    if (inflight) return inflight;
    const run = this.refresh(id).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, run);
    return run;
  }

  private async refresh(id: string): Promise<string | null> {
    const rec = (await this.load()).servers[id];
    if (!rec?.tokens) return null;
    if (!rec.tokens.refreshToken || !rec.discovered || !rec.client) {
      if (rec.tokens.expiresAt > this.now()) return rec.tokens.accessToken;
      await this.mutate((d) => {
        if (d.servers[id]) {
          d.servers[id].status = 'needs_auth';
          d.servers[id].lastError = 'The sign-in expired.';
        }
      });
      return null;
    }
    try {
      const next = await refreshTokens({
        tokenEndpoint: rec.discovered.metadata.token_endpoint,
        client: rec.client,
        refreshToken: rec.tokens.refreshToken,
        resource: rec.discovered.resource,
      }, this.fetchImpl, this.now);
      const merged: OAuthTokens = { ...next, refreshToken: next.refreshToken ?? rec.tokens.refreshToken, scope: next.scope ?? rec.tokens.scope };
      await this.mutate((d) => {
        if (!d.servers[id]) return;
        d.servers[id].tokens = merged;
        d.servers[id].status = 'connected';
        delete d.servers[id].lastError;
      });
      this.logger.info('Remote MCP token refreshed', { id, expiresAt: new Date(merged.expiresAt).toISOString() });
      return merged.accessToken;
    } catch (err) {
      const dead = err instanceof RemoteMcpOAuthError && err.code === 'invalid_grant';
      this.logger.warn('Remote MCP token refresh failed', { id, dead, error: err instanceof Error ? err.message : String(err) });
      if (dead) {
        await this.mutate((d) => {
          if (!d.servers[id]) return;
          d.servers[id].status = 'needs_auth';
          d.servers[id].lastError = 'The sign-in is no longer valid.';
        });
        return null;
      }
      // A network blip: the old token may still work for a while.
      return rec.tokens.expiresAt > this.now() ? rec.tokens.accessToken : null;
    }
  }
}

/**
 * Host of a URL, for logs.
 *
 * @param url - URL
 * @returns Host, or `(unknown)`
 */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(unknown)';
  }
}
