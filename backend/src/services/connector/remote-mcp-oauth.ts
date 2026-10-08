/**
 * MCP authorization, client side: the protocol pieces a remote MCP server
 * that wants OAuth needs (MCP spec "Authorization", 2025-06-18).
 *
 * 1. The server answers 401 with
 *    `WWW-Authenticate: Bearer resource_metadata="<url>"` ({@link parseWwwAuthenticate}).
 * 2. Protected resource metadata (RFC 9728) names the authorization server
 *    ({@link fetchProtectedResourceMetadata}).
 * 3. Authorization server metadata (RFC 8414, OpenID Connect discovery as a
 *    fallback) gives the endpoints ({@link fetchAuthorizationServerMetadata}).
 * 4. Dynamic client registration (RFC 7591) when the server offers it
 *    ({@link registerClient}); otherwise the owner enters a client id.
 * 5. Authorization code + PKCE S256 ({@link createPkcePair},
 *    {@link buildAuthorizeUrl}), `resource` (RFC 8707) on every request.
 * 6. Code exchange and refresh ({@link exchangeCode}, {@link refreshTokens}).
 *
 * Pure functions over an injectable fetch. No URL, code, token or secret
 * ever goes into an error message.
 *
 * @module services/connector/remote-mcp-oauth
 */

import { createHash, randomBytes } from 'crypto';
import { REMOTE_MCP_CONSTANTS } from '../../constants.js';

const C = REMOTE_MCP_CONSTANTS;

/** Minimal fetch (injectable for tests). */
export type OAuthFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: 'follow' | 'manual' | 'error' }) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** An OAuth failure. `code` is stable; the message is owner-safe. */
export class RemoteMcpOAuthError extends Error {
  constructor(
    readonly code: 'discovery_failed' | 'registration_unsupported' | 'registration_failed' | 'pkce_unsupported' | 'token_failed' | 'invalid_grant' | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'RemoteMcpOAuthError';
  }
}

/** What `WWW-Authenticate: Bearer …` carried. */
export interface BearerChallenge {
  resourceMetadata?: string;
  scope?: string;
  error?: string;
}

/** RFC 9728 protected resource metadata (the fields we use). */
export interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

/** RFC 8414 authorization server metadata (the fields we use). */
export interface AuthorizationServerMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

/** Everything discovery learned. */
export interface DiscoveredAuthorization {
  /** `resource` to send (RFC 8707). */
  resource: string;
  /** Scope to ask for, if any. */
  scope?: string;
  /** Issuer / AS base. */
  issuer: string;
  metadata: AuthorizationServerMetadata;
}

/** A registered (or owner-entered) client. */
export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  /** How the token endpoint wants the client to authenticate. */
  tokenAuthMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
  /** The redirect URI it was registered for. */
  redirectUri: string;
}

/** Tokens from the token endpoint. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
  scope?: string;
  tokenType: string;
}

/**
 * Parse `WWW-Authenticate` for a Bearer challenge.
 *
 * @param header - Header value (may hold several challenges)
 * @returns The Bearer challenge's parameters, or null when there is none
 */
export function parseWwwAuthenticate(header: string | null | undefined): BearerChallenge | null {
  if (!header) return null;
  const m = /(?:^|,\s*)Bearer\b(.*)$/i.exec(header) ?? /^\s*Bearer\b(.*)$/i.exec(header);
  if (!m) return null;
  const params: Record<string, string> = {};
  const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let p: RegExpExecArray | null;
  while ((p = re.exec(m[1])) !== null) params[p[1].toLowerCase()] = (p[2] ?? p[3] ?? '').replace(/\\(.)/g, '$1');
  return {
    ...(params['resource_metadata'] ? { resourceMetadata: params['resource_metadata'] } : {}),
    ...(params['scope'] ? { scope: params['scope'] } : {}),
    ...(params['error'] ? { error: params['error'] } : {}),
  };
}

/**
 * A discovery URL must be https (http only for a localhost server).
 *
 * @param raw - URL from a header or document
 * @param serverUrl - The MCP server (decides whether http is acceptable)
 * @returns The parsed URL, or null when unacceptable
 */
export function safeDiscoveryUrl(raw: unknown, serverUrl: string): URL | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const u = new URL(raw);
    if (u.username || u.password) return null;
    if (u.protocol === 'https:') return u;
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(serverUrl).hostname);
    return u.protocol === 'http:' && local && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ? u : null;
  } catch {
    return null;
  }
}

/**
 * GET a JSON document.
 *
 * @param fetchImpl - fetch
 * @param url - Where
 * @returns The parsed object, or null on any failure
 */
async function getJson<T>(fetchImpl: OAuthFetch, url: string): Promise<T | null> {
  try {
    const res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(C.OAUTH_REQUEST_TIMEOUT_MS) });
    if (!res.ok) return null;
    const parsed = JSON.parse(await res.text()) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

/**
 * RFC 9728 metadata: the URL the challenge named, else the well-known
 * locations (path-suffixed first, then root).
 *
 * @param serverUrl - MCP server URL
 * @param challenge - Parsed challenge, if any
 * @param fetchImpl - fetch
 * @returns The metadata, or null when the server publishes none
 */
export async function fetchProtectedResourceMetadata(serverUrl: string, challenge: BearerChallenge | null, fetchImpl: OAuthFetch): Promise<ProtectedResourceMetadata | null> {
  const candidates: string[] = [];
  const named = safeDiscoveryUrl(challenge?.resourceMetadata, serverUrl);
  if (named) candidates.push(named.toString());
  const u = new URL(serverUrl);
  // The path-suffixed form would carry the server's key path (Zoho), so it
  // is only tried when the challenge named nothing.
  if (!named) {
    if (u.pathname && u.pathname !== '/') candidates.push(`${u.origin}/.well-known/oauth-protected-resource${u.pathname.replace(/\/$/, '')}`);
    candidates.push(`${u.origin}/.well-known/oauth-protected-resource`);
  }
  for (const url of candidates) {
    const doc = await getJson<ProtectedResourceMetadata>(fetchImpl, url);
    if (doc && Array.isArray(doc.authorization_servers) && doc.authorization_servers.length > 0) return doc;
  }
  return null;
}

/**
 * RFC 8414 / OIDC discovery for an issuer, in the order the MCP spec gives.
 *
 * @param issuer - Authorization server issuer URL
 * @param serverUrl - MCP server (for the https rule)
 * @param fetchImpl - fetch
 * @returns The metadata
 * @throws RemoteMcpOAuthError discovery_failed | pkce_unsupported
 */
export async function fetchAuthorizationServerMetadata(issuer: string, serverUrl: string, fetchImpl: OAuthFetch): Promise<AuthorizationServerMetadata> {
  const base = safeDiscoveryUrl(issuer, serverUrl);
  if (!base) throw new RemoteMcpOAuthError('discovery_failed', 'The server named an authorization server that is not https.');
  const path = base.pathname.replace(/\/$/, '');
  const candidates = path
    ? [
        `${base.origin}/.well-known/oauth-authorization-server${path}`,
        `${base.origin}/.well-known/openid-configuration${path}`,
        `${base.origin}${path}/.well-known/openid-configuration`,
      ]
    : [`${base.origin}/.well-known/oauth-authorization-server`, `${base.origin}/.well-known/openid-configuration`];
  for (const url of candidates) {
    const doc = await getJson<AuthorizationServerMetadata>(fetchImpl, url);
    if (!doc) continue;
    const auth = safeDiscoveryUrl(doc.authorization_endpoint, serverUrl);
    const token = safeDiscoveryUrl(doc.token_endpoint, serverUrl);
    if (!auth || !token) continue;
    const methods = doc.code_challenge_methods_supported;
    if (Array.isArray(methods) && !methods.includes('S256')) {
      throw new RemoteMcpOAuthError('pkce_unsupported', 'The authorization server does not support PKCE (S256), which MCP requires.');
    }
    const registration = safeDiscoveryUrl(doc.registration_endpoint, serverUrl);
    return {
      ...doc,
      authorization_endpoint: auth.toString(),
      token_endpoint: token.toString(),
      ...(registration ? { registration_endpoint: registration.toString() } : { registration_endpoint: undefined }),
    };
  }
  throw new RemoteMcpOAuthError('discovery_failed', 'Could not read the authorization server\'s metadata.');
}

/**
 * Full discovery from a 401 challenge.
 *
 * @param serverUrl - MCP server URL (secret; never in errors)
 * @param challenge - Parsed `WWW-Authenticate`, if any
 * @param fetchImpl - fetch
 * @returns Resource, scope, issuer and endpoints
 * @throws RemoteMcpOAuthError discovery_failed | pkce_unsupported
 */
export async function discoverAuthorization(serverUrl: string, challenge: BearerChallenge | null, fetchImpl: OAuthFetch): Promise<DiscoveredAuthorization> {
  const prm = await fetchProtectedResourceMetadata(serverUrl, challenge, fetchImpl);
  const u = new URL(serverUrl);
  // 2025-03-26 servers have no resource metadata: the server's origin is the AS.
  const issuer = prm?.authorization_servers?.[0] ?? u.origin;
  const metadata = await fetchAuthorizationServerMetadata(issuer, serverUrl, fetchImpl);
  // `resource` from the metadata; otherwise the origin — never the full
  // URL, whose path is the server's key on Zoho.
  const resource = typeof prm?.resource === 'string' && prm.resource ? prm.resource : u.origin;
  const scope = challenge?.scope
    ?? (Array.isArray(prm?.scopes_supported) && prm!.scopes_supported!.length ? prm!.scopes_supported!.join(' ') : undefined);
  return { resource, issuer, metadata, ...(scope ? { scope } : {}) };
}

/**
 * Register Crewly as a public client (RFC 7591).
 *
 * @param metadata - AS metadata (must have `registration_endpoint`)
 * @param redirectUri - The Cloud callback
 * @param fetchImpl - fetch
 * @returns The client
 * @throws RemoteMcpOAuthError registration_unsupported | registration_failed
 */
export async function registerClient(metadata: AuthorizationServerMetadata, redirectUri: string, fetchImpl: OAuthFetch): Promise<OAuthClient> {
  if (!metadata.registration_endpoint) {
    throw new RemoteMcpOAuthError('registration_unsupported', 'This server does not let Crewly register itself. Enter a client ID from the server\'s developer console.');
  }
  const methods = metadata.token_endpoint_auth_methods_supported;
  const wanted: OAuthClient['tokenAuthMethod'] = !methods || methods.includes('none') ? 'none' : methods.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic';
  let res: Awaited<ReturnType<OAuthFetch>>;
  try {
    res = await fetchImpl(metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: C.OAUTH_CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: wanted,
      }),
      signal: AbortSignal.timeout(C.OAUTH_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new RemoteMcpOAuthError('network', 'Could not reach the authorization server to register Crewly.');
  }
  const body = (await res.text().then((t) => JSON.parse(t) as Record<string, unknown>).catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body['client_id'] !== 'string' || !body['client_id']) {
    const why = typeof body['error'] === 'string' ? ` (${String(body['error']).slice(0, 60)})` : '';
    throw new RemoteMcpOAuthError('registration_failed', `The authorization server refused to register Crewly: ${res.status}${why}.`);
  }
  const secret = typeof body['client_secret'] === 'string' && body['client_secret'] ? (body['client_secret'] as string) : undefined;
  const method = body['token_endpoint_auth_method'];
  const tokenAuthMethod: OAuthClient['tokenAuthMethod'] = method === 'client_secret_post' || method === 'client_secret_basic' || method === 'none'
    ? method
    : secret ? 'client_secret_post' : 'none';
  return { clientId: body['client_id'] as string, ...(secret ? { clientSecret: secret } : {}), tokenAuthMethod, redirectUri };
}

/**
 * A PKCE verifier and its S256 challenge.
 *
 * @param random - Random source (tests)
 * @returns `{ verifier, challenge }`
 */
export function createPkcePair(random: (n: number) => Buffer = randomBytes): { verifier: string; challenge: string } {
  const verifier = random(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * The authorize URL, without `state` (the Cloud broker adds it).
 *
 * @param discovered - Discovery result
 * @param client - Client
 * @param challenge - PKCE challenge
 * @returns The URL
 */
export function buildAuthorizeUrl(discovered: DiscoveredAuthorization, client: OAuthClient, challenge: string): string {
  const u = new URL(discovered.metadata.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', client.clientId);
  u.searchParams.set('redirect_uri', client.redirectUri);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('resource', discovered.resource);
  if (discovered.scope) u.searchParams.set('scope', discovered.scope);
  // Zoho (and Google-style servers) only return a refresh token when asked.
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  return u.toString();
}

/**
 * One token-endpoint call.
 *
 * @param tokenEndpoint - Endpoint
 * @param client - Client (decides how it authenticates)
 * @param form - Grant parameters
 * @param fetchImpl - fetch
 * @param now - Clock
 * @returns Tokens
 * @throws RemoteMcpOAuthError invalid_grant | token_failed | network
 */
async function tokenRequest(tokenEndpoint: string, client: OAuthClient, form: Record<string, string>, fetchImpl: OAuthFetch, now: () => number): Promise<OAuthTokens> {
  const body = new URLSearchParams({ ...form, client_id: client.clientId });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (client.clientSecret && client.tokenAuthMethod === 'client_secret_basic') {
    const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
    headers['Authorization'] = `Basic ${Buffer.from(`${enc(client.clientId)}:${enc(client.clientSecret)}`).toString('base64')}`;
  } else if (client.clientSecret) {
    body.set('client_secret', client.clientSecret);
  }
  let res: Awaited<ReturnType<OAuthFetch>>;
  try {
    res = await fetchImpl(tokenEndpoint, { method: 'POST', headers, body: body.toString(), signal: AbortSignal.timeout(C.OAUTH_REQUEST_TIMEOUT_MS) });
  } catch {
    throw new RemoteMcpOAuthError('network', 'Could not reach the authorization server.');
  }
  const data = (await res.text().then((t) => JSON.parse(t) as Record<string, unknown>).catch(() => ({}))) as Record<string, unknown>;
  const error = typeof data['error'] === 'string' ? (data['error'] as string) : '';
  if (!res.ok || error || typeof data['access_token'] !== 'string' || !data['access_token']) {
    // Zoho answers 200 with {"error":"invalid_code"} for a dead code/refresh token.
    if (['invalid_grant', 'invalid_code', 'invalid_token', 'unauthorized_client'].includes(error)) {
      throw new RemoteMcpOAuthError('invalid_grant', 'The sign-in is no longer valid; the owner needs to authorize again.');
    }
    throw new RemoteMcpOAuthError('token_failed', `The authorization server refused the token request (${res.status}${error ? `, ${error.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)}` : ''}).`);
  }
  const expiresIn = Number(data['expires_in']);
  return {
    accessToken: data['access_token'] as string,
    ...(typeof data['refresh_token'] === 'string' && data['refresh_token'] ? { refreshToken: data['refresh_token'] as string } : {}),
    expiresAt: now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : C.OAUTH_DEFAULT_TOKEN_TTL_MS),
    ...(typeof data['scope'] === 'string' ? { scope: data['scope'] as string } : {}),
    tokenType: typeof data['token_type'] === 'string' ? (data['token_type'] as string) : 'Bearer',
  };
}

/**
 * Exchange an authorization code.
 *
 * @param args - Endpoint, client, code, verifier, resource
 * @param fetchImpl - fetch
 * @param now - Clock
 * @returns Tokens
 */
export function exchangeCode(
  args: { tokenEndpoint: string; client: OAuthClient; code: string; verifier: string; resource: string },
  fetchImpl: OAuthFetch,
  now: () => number = Date.now,
): Promise<OAuthTokens> {
  return tokenRequest(args.tokenEndpoint, args.client, {
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: args.client.redirectUri,
    code_verifier: args.verifier,
    resource: args.resource,
  }, fetchImpl, now);
}

/**
 * Refresh an access token. A server that does not rotate refresh tokens
 * returns none; the caller keeps the old one.
 *
 * @param args - Endpoint, client, refresh token, resource
 * @param fetchImpl - fetch
 * @param now - Clock
 * @returns Tokens
 */
export function refreshTokens(
  args: { tokenEndpoint: string; client: OAuthClient; refreshToken: string; resource: string },
  fetchImpl: OAuthFetch,
  now: () => number = Date.now,
): Promise<OAuthTokens> {
  return tokenRequest(args.tokenEndpoint, args.client, {
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    resource: args.resource,
  }, fetchImpl, now);
}
