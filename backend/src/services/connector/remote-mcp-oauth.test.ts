/**
 * Tests for the MCP OAuth protocol pieces: WWW-Authenticate parsing,
 * protected-resource and authorization-server discovery (RFC 9728 / 8414 /
 * OIDC fallback), dynamic client registration, PKCE, the authorize URL,
 * code exchange and refresh — and that no secret reaches an error.
 *
 * @module services/connector/remote-mcp-oauth.test
 */

import { createHash } from 'crypto';
import {
  RemoteMcpOAuthError,
  buildAuthorizeUrl,
  createPkcePair,
  discoverAuthorization,
  exchangeCode,
  parseWwwAuthenticate,
  refreshTokens,
  registerClient,
  safeDiscoveryUrl,
  type OAuthFetch,
} from './remote-mcp-oauth.js';

const SERVER = 'https://crm-600.zohomcp.com/mcp/SECRETKEY123/message';
const PRM_URL = 'https://crm-600.zohomcp.com/.well-known/oauth-protected-resource';
const CALLBACK = 'https://api.crewlyai.com/api/cloud/mcp-oauth/callback';

type Route = { status?: number; body: unknown };

/** fetch double answering by method + URL; records calls. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const impl: OAuthFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
    const route = routes[`${init.method} ${url}`];
    const status = route ? route.status ?? 200 : 404;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => null },
      text: async () => (route ? JSON.stringify(route.body) : 'not found'),
    };
  };
  return { impl, calls };
}

const ZOHO_AS = {
  issuer: 'https://accounts.zoho.com',
  authorization_endpoint: 'https://accounts.zoho.com/oauth/v2/auth',
  token_endpoint: 'https://accounts.zoho.com/oauth/v2/token',
  registration_endpoint: 'https://accounts.zoho.com/oauth/v2/register',
  code_challenge_methods_supported: ['S256'],
};

describe('parseWwwAuthenticate', () => {
  it('reads Zoho\'s challenge', () => {
    expect(parseWwwAuthenticate(`Bearer resource_metadata="${PRM_URL}"`)).toEqual({ resourceMetadata: PRM_URL });
  });

  it('reads scope and error, quoted or not, among other challenges', () => {
    expect(parseWwwAuthenticate('Basic realm="x", Bearer error=invalid_token, scope="a b", resource_metadata="https://h/m"'))
      .toEqual({ resourceMetadata: 'https://h/m', scope: 'a b', error: 'invalid_token' });
  });

  it('returns null without a Bearer challenge', () => {
    expect(parseWwwAuthenticate('Basic realm="x"')).toBeNull();
    expect(parseWwwAuthenticate(null)).toBeNull();
  });
});

describe('safeDiscoveryUrl', () => {
  it('accepts https, refuses http and credentials, allows http on localhost servers', () => {
    expect(safeDiscoveryUrl('https://a.dev/x', SERVER)).not.toBeNull();
    expect(safeDiscoveryUrl('http://a.dev/x', SERVER)).toBeNull();
    expect(safeDiscoveryUrl('https://u:p@a.dev/x', SERVER)).toBeNull();
    expect(safeDiscoveryUrl('http://localhost:9/x', 'http://localhost:9/mcp')).not.toBeNull();
  });
});

describe('discoverAuthorization', () => {
  it('follows resource_metadata to the authorization server', async () => {
    const { impl, calls } = fakeFetch({
      [`GET ${PRM_URL}`]: { body: { resource: 'https://crm-600.zohomcp.com', authorization_servers: ['https://accounts.zoho.com'], scopes_supported: ['ZohoMCP.tools.ALL'] } },
      'GET https://accounts.zoho.com/.well-known/oauth-authorization-server': { body: ZOHO_AS },
    });
    const d = await discoverAuthorization(SERVER, { resourceMetadata: PRM_URL }, impl);
    expect(d).toMatchObject({ resource: 'https://crm-600.zohomcp.com', issuer: 'https://accounts.zoho.com', scope: 'ZohoMCP.tools.ALL' });
    expect(d.metadata.registration_endpoint).toBe(ZOHO_AS.registration_endpoint);
    // The server's key path is never sent anywhere during discovery.
    expect(calls.every((c) => !c.url.includes('SECRETKEY'))).toBe(true);
  });

  it('prefers the challenge scope, falls back to OIDC discovery, and to the origin as resource', async () => {
    const { impl } = fakeFetch({
      [`GET ${PRM_URL}`]: { body: { authorization_servers: ['https://login.example.com/tenant'] } },
      'GET https://login.example.com/.well-known/openid-configuration/tenant': { body: { ...ZOHO_AS, registration_endpoint: undefined } },
    });
    const d = await discoverAuthorization(SERVER, { resourceMetadata: PRM_URL, scope: 'mcp' }, impl);
    expect(d.resource).toBe('https://crm-600.zohomcp.com');
    expect(d.scope).toBe('mcp');
    expect(d.metadata.registration_endpoint).toBeUndefined();
  });

  it('treats the server origin as the authorization server when there is no resource metadata (2025-03-26)', async () => {
    const { impl } = fakeFetch({
      'GET https://crm-600.zohomcp.com/.well-known/oauth-authorization-server': { body: { ...ZOHO_AS, authorization_endpoint: 'https://crm-600.zohomcp.com/authorize', token_endpoint: 'https://crm-600.zohomcp.com/token' } },
    });
    const d = await discoverAuthorization(SERVER, {}, impl);
    expect(d.issuer).toBe('https://crm-600.zohomcp.com');
  });

  it('refuses an authorization server without S256', async () => {
    const { impl } = fakeFetch({
      [`GET ${PRM_URL}`]: { body: { authorization_servers: ['https://accounts.zoho.com'] } },
      'GET https://accounts.zoho.com/.well-known/oauth-authorization-server': { body: { ...ZOHO_AS, code_challenge_methods_supported: ['plain'] } },
    });
    await expect(discoverAuthorization(SERVER, { resourceMetadata: PRM_URL }, impl)).rejects.toMatchObject({ code: 'pkce_unsupported' });
  });

  it('fails cleanly when nothing is published, without the URL in the message', async () => {
    const { impl } = fakeFetch({});
    const err = await discoverAuthorization(SERVER, null, impl).catch((e: unknown) => e as RemoteMcpOAuthError);
    expect(err).toBeInstanceOf(RemoteMcpOAuthError);
    expect((err as Error).message).not.toContain('SECRETKEY');
  });
});

describe('registerClient', () => {
  it('registers a public client for our callback', async () => {
    const { impl, calls } = fakeFetch({ [`POST ${ZOHO_AS.registration_endpoint}`]: { status: 201, body: { client_id: 'cid', token_endpoint_auth_method: 'none' } } });
    expect(await registerClient(ZOHO_AS, CALLBACK, impl)).toEqual({ clientId: 'cid', tokenAuthMethod: 'none', redirectUri: CALLBACK });
    expect(JSON.parse(calls[0].body!)).toMatchObject({ client_name: 'Crewly', redirect_uris: [CALLBACK], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' });
  });

  it('keeps a returned secret', async () => {
    const { impl } = fakeFetch({ [`POST ${ZOHO_AS.registration_endpoint}`]: { status: 201, body: { client_id: 'cid', client_secret: 'sec' } } });
    expect(await registerClient(ZOHO_AS, CALLBACK, impl)).toMatchObject({ clientSecret: 'sec', tokenAuthMethod: 'client_secret_post' });
  });

  it('says when registration is not offered or refused', async () => {
    const { impl } = fakeFetch({ [`POST ${ZOHO_AS.registration_endpoint}`]: { status: 400, body: { error: 'invalid_redirect_uri' } } });
    await expect(registerClient({ ...ZOHO_AS, registration_endpoint: undefined }, CALLBACK, impl)).rejects.toMatchObject({ code: 'registration_unsupported' });
    await expect(registerClient(ZOHO_AS, CALLBACK, impl)).rejects.toMatchObject({ code: 'registration_failed' });
  });
});

describe('PKCE and the authorize URL', () => {
  it('makes an S256 pair', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('builds the authorize URL without state and without the server URL', () => {
    const url = new URL(buildAuthorizeUrl(
      { resource: 'https://crm-600.zohomcp.com', issuer: ZOHO_AS.issuer, scope: 'ZohoMCP.tools.ALL', metadata: ZOHO_AS },
      { clientId: 'cid', tokenAuthMethod: 'none', redirectUri: CALLBACK },
      'chal',
    ));
    expect(url.origin + url.pathname).toBe(ZOHO_AS.authorization_endpoint);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code', client_id: 'cid', redirect_uri: CALLBACK, code_challenge: 'chal', code_challenge_method: 'S256',
      resource: 'https://crm-600.zohomcp.com', scope: 'ZohoMCP.tools.ALL',
    });
    expect(url.searchParams.has('state')).toBe(false);
    expect(url.toString()).not.toContain('SECRETKEY');
  });
});

describe('token endpoint', () => {
  const client = { clientId: 'cid', tokenAuthMethod: 'none' as const, redirectUri: CALLBACK };

  it('exchanges a code with the verifier and resource', async () => {
    const { impl, calls } = fakeFetch({ [`POST ${ZOHO_AS.token_endpoint}`]: { body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'a b', token_type: 'Bearer' } } });
    const t = await exchangeCode({ tokenEndpoint: ZOHO_AS.token_endpoint, client, code: 'c', verifier: 'v', resource: 'https://r' }, impl, () => 1000);
    expect(t).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1000 + 3_600_000, scope: 'a b', tokenType: 'Bearer' });
    const form = new URLSearchParams(calls[0].body);
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'authorization_code', code: 'c', redirect_uri: CALLBACK, code_verifier: 'v', resource: 'https://r', client_id: 'cid' });
  });

  it('authenticates a confidential client with Basic or in the body', async () => {
    const { impl, calls } = fakeFetch({ [`POST ${ZOHO_AS.token_endpoint}`]: { body: { access_token: 'at' } } });
    await refreshTokens({ tokenEndpoint: ZOHO_AS.token_endpoint, client: { ...client, clientSecret: 's', tokenAuthMethod: 'client_secret_basic' }, refreshToken: 'rt', resource: 'https://r' }, impl);
    expect(calls[0].headers['Authorization']).toBe(`Basic ${Buffer.from('cid:s').toString('base64')}`);
    await refreshTokens({ tokenEndpoint: ZOHO_AS.token_endpoint, client: { ...client, clientSecret: 's', tokenAuthMethod: 'client_secret_post' }, refreshToken: 'rt', resource: 'https://r' }, impl);
    expect(new URLSearchParams(calls[1].body).get('client_secret')).toBe('s');
  });

  it('maps Zoho\'s 200 {"error":"invalid_code"} and invalid_grant to invalid_grant, without secrets in the message', async () => {
    const zoho = fakeFetch({ [`POST ${ZOHO_AS.token_endpoint}`]: { status: 200, body: { error: 'invalid_code' } } });
    const err = await refreshTokens({ tokenEndpoint: ZOHO_AS.token_endpoint, client, refreshToken: 'SECRET-RT', resource: 'r' }, zoho.impl).catch((e: unknown) => e as RemoteMcpOAuthError);
    expect(err).toMatchObject({ code: 'invalid_grant' });
    expect((err as Error).message).not.toContain('SECRET-RT');
    const other = fakeFetch({ [`POST ${ZOHO_AS.token_endpoint}`]: { status: 500, body: {} } });
    await expect(exchangeCode({ tokenEndpoint: ZOHO_AS.token_endpoint, client, code: 'c', verifier: 'v', resource: 'r' }, other.impl)).rejects.toMatchObject({ code: 'token_failed' });
  });
});
