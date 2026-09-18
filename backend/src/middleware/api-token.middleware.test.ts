/**
 * Tests for the API token middleware.
 *
 * Covers the loopback bypass, the proxy rule, every token transport
 * (Bearer / X-Crewly-Token / cookie / query), the 401 envelope, the
 * owner-only guard used by OKR approvals, and the WebSocket / Socket.IO
 * gates.
 *
 * @module middleware/api-token.test
 */

import { EventEmitter } from 'events';
import { createHmac } from 'crypto';
import type { Request, Response } from 'express';
import type { IncomingMessage, Server as HttpServer } from 'http';
import {
  apiTokenMiddleware,
  requireOwnerToken,
  isLoopbackAddress,
  isLoopbackRequest,
  getClientAddress,
  extractPresentedToken,
  isUpgradeAllowed,
  socketIoAllowRequest,
  installWebSocketGate,
} from './api-token.middleware.js';
import { resetApiTokenCache, getApiTokenFingerprint } from '../services/core/api-token.service.js';

jest.mock('../services/core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
    }),
  },
}));

const TOKEN = 'unit-test-token';

/** Build a minimal Express-like request. */
function makeReq(opts: {
  remoteAddress?: string;
  headers?: Record<string, string>;
  url?: string;
  method?: string;
}): Request {
  return {
    headers: { ...(opts.headers ?? {}) },
    socket: { remoteAddress: opts.remoteAddress ?? '10.0.0.5' },
    url: opts.url ?? '/api/teams',
    originalUrl: opts.url ?? '/api/teams',
    method: opts.method ?? 'GET',
  } as unknown as Request;
}

/** Build a mock Express response capturing status/json/headers. */
function makeRes(): Response & { statusCode: number; body: unknown; headers: Record<string, string>; locals: Record<string, unknown> } {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    locals: {} as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
  };
  return res as unknown as ReturnType<typeof makeRes>;
}

/** Build a raw upgrade request. */
function makeUpgradeReq(opts: { remoteAddress?: string; headers?: Record<string, string>; url?: string }): IncomingMessage {
  return {
    headers: { host: 'crewly.local:8787', ...(opts.headers ?? {}) },
    socket: { remoteAddress: opts.remoteAddress ?? '10.0.0.5' },
    url: opts.url ?? '/socket.io/?EIO=4&transport=websocket',
  } as unknown as IncomingMessage;
}

function createTestJwt(payload: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

describe('api-token.middleware', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CREWLY_API_TOKEN = TOKEN;
    delete process.env.CREWLY_TRUST_PROXY;
    delete process.env.CREWLY_JWT_SECRET;
    resetApiTokenCache();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetApiTokenCache();
  });

  describe('loopback classification', () => {
    it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('treats %s as loopback', (addr) => {
      expect(isLoopbackAddress(addr)).toBe(true);
    });

    it.each(['10.0.0.5', '192.168.1.20', '::ffff:10.0.0.5', '', 'localhost'])('does not treat %s as loopback', (addr) => {
      expect(isLoopbackAddress(addr)).toBe(false);
    });

    it('ignores X-Forwarded-For unless CREWLY_TRUST_PROXY=1', () => {
      const spoofed = makeReq({ remoteAddress: '10.0.0.5', headers: { 'x-forwarded-for': '127.0.0.1' } });
      expect(isLoopbackRequest(spoofed)).toBe(false);
      expect(getClientAddress(spoofed)).toBe('10.0.0.5');

      process.env.CREWLY_TRUST_PROXY = '1';
      expect(getClientAddress(spoofed)).toBe('127.0.0.1');
      expect(isLoopbackRequest(spoofed)).toBe(true);
    });

    it('uses the first hop of a multi-entry X-Forwarded-For when trusted', () => {
      process.env.CREWLY_TRUST_PROXY = '1';
      const req = makeReq({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } });
      expect(getClientAddress(req)).toBe('203.0.113.9');
      expect(isLoopbackRequest(req)).toBe(false);
    });
  });

  describe('extractPresentedToken', () => {
    it('reads Authorization: Bearer', () => {
      expect(extractPresentedToken(makeReq({ headers: { authorization: `Bearer ${TOKEN}` } }), false)).toBe(TOKEN);
    });
    it('reads X-Crewly-Token', () => {
      expect(extractPresentedToken(makeReq({ headers: { 'x-crewly-token': ` ${TOKEN} ` } }), false)).toBe(TOKEN);
    });
    it('reads the crewly_token cookie (URL-decoded)', () => {
      const req = makeReq({ headers: { cookie: `foo=bar; crewly_token=${encodeURIComponent('a b')}; x=y` } });
      expect(extractPresentedToken(req, false)).toBe('a b');
    });
    it('reads ?token= only when allowed', () => {
      const req = makeReq({ url: `/socket.io/?token=${TOKEN}`, headers: { host: 'h' } });
      expect(extractPresentedToken(req, false)).toBeNull();
      expect(extractPresentedToken(req, true)).toBe(TOKEN);
    });
    it('returns null when nothing is presented', () => {
      expect(extractPresentedToken(makeReq({}), true)).toBeNull();
    });
  });

  describe('apiTokenMiddleware', () => {
    it('lets loopback through without a token', () => {
      const next = jest.fn();
      const res = makeRes();
      apiTokenMiddleware(makeReq({ remoteAddress: '127.0.0.1' }), res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
    });

    it('rejects a non-loopback caller without a token with the 401 envelope', () => {
      const next = jest.fn();
      const res = makeRes();
      apiTokenMiddleware(makeReq({ remoteAddress: '10.0.0.5' }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({
        success: false,
        error: 'unauthorized',
        hint: expect.stringContaining('crewly token'),
      });
      expect(res.headers['WWW-Authenticate']).toBe('Crewly-Token');
    });

    it('rejects a wrong token', () => {
      const next = jest.fn();
      const res = makeRes();
      apiTokenMiddleware(makeReq({ headers: { 'x-crewly-token': 'nope' } }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });

    it.each([
      ['Bearer', { authorization: `Bearer ${TOKEN}` }],
      ['X-Crewly-Token', { 'x-crewly-token': TOKEN }],
      ['cookie', { cookie: `crewly_token=${TOKEN}` }],
    ])('accepts a non-loopback caller presenting the token via %s', (_label, headers) => {
      const next = jest.fn();
      const res = makeRes();
      apiTokenMiddleware(makeReq({ headers }), res, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('does NOT accept ?token= on plain API requests', () => {
      const next = jest.fn();
      const res = makeRes();
      apiTokenMiddleware(makeReq({ url: `/api/teams?token=${TOKEN}`, headers: { host: 'h' } }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });
  });

  describe('requireOwnerToken', () => {
    it('refuses agent sessions with 403 even when they present the token', () => {
      const next = jest.fn();
      const res = makeRes();
      requireOwnerToken(
        makeReq({ remoteAddress: '127.0.0.1', headers: { 'x-agent-session': 'crewly-orc', 'x-crewly-token': TOKEN } }),
        res,
        next,
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatchObject({ success: false, error: 'owner_approval_required' });
    });

    it('requires the token even from loopback', () => {
      const next = jest.fn();
      const res = makeRes();
      requireOwnerToken(makeReq({ remoteAddress: '127.0.0.1' }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res.body).toMatchObject({ error: 'unauthorized' });
    });

    it('passes with the token and records its fingerprint', () => {
      const next = jest.fn();
      const res = makeRes();
      requireOwnerToken(makeReq({ remoteAddress: '127.0.0.1', headers: { cookie: `crewly_token=${TOKEN}` } }), res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.locals.ownerTokenFingerprint).toBe(getApiTokenFingerprint(TOKEN));
      expect(String(res.locals.ownerTokenFingerprint)).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  describe('isUpgradeAllowed / socketIoAllowRequest', () => {
    it('allows loopback upgrades', () => {
      expect(isUpgradeAllowed(makeUpgradeReq({ remoteAddress: '::1' }))).toBe(true);
    });

    it('allows non-loopback upgrades carrying ?token=', () => {
      expect(isUpgradeAllowed(makeUpgradeReq({ url: `/socket.io/?EIO=4&token=${TOKEN}` }))).toBe(true);
    });

    it('allows non-loopback upgrades carrying the cookie', () => {
      expect(isUpgradeAllowed(makeUpgradeReq({ headers: { cookie: `crewly_token=${TOKEN}` } }))).toBe(true);
    });

    it('rejects non-loopback upgrades without a token', () => {
      expect(isUpgradeAllowed(makeUpgradeReq({}))).toBe(false);
      const cb = jest.fn();
      socketIoAllowRequest(makeUpgradeReq({}), cb);
      expect(cb).toHaveBeenCalledWith('unauthorized', false);
    });

    it('socketIoAllowRequest passes an authorised handshake', () => {
      const cb = jest.fn();
      socketIoAllowRequest(makeUpgradeReq({ url: `/socket.io/?token=${TOKEN}` }), cb);
      expect(cb).toHaveBeenCalledWith(null, true);
    });

    it('lets /ws/chat through with a valid chat JWT when CREWLY_JWT_SECRET is set', () => {
      process.env.CREWLY_JWT_SECRET = 'jwt-secret';
      const jwt = createTestJwt({ sub: 'user-1' }, 'jwt-secret');
      expect(isUpgradeAllowed(makeUpgradeReq({ url: `/ws/chat?channelId=c1&token=${jwt}` }))).toBe(true);
      // A JWT is not a substitute for the API token on other paths.
      expect(isUpgradeAllowed(makeUpgradeReq({ url: `/socket.io/?token=${jwt}` }))).toBe(false);
      // And a forged JWT is rejected.
      const forged = createTestJwt({ sub: 'user-1' }, 'wrong');
      expect(isUpgradeAllowed(makeUpgradeReq({ url: `/ws/chat?token=${forged}` }))).toBe(false);
    });
  });

  describe('installWebSocketGate', () => {
    it('answers unauthorised upgrades with 401 and never reaches downstream listeners', () => {
      const server = new EventEmitter() as unknown as HttpServer;
      const downstream = jest.fn();
      server.on('upgrade', downstream);
      installWebSocketGate(server);

      const socket = { write: jest.fn(), destroy: jest.fn() };
      server.emit('upgrade', makeUpgradeReq({}), socket, Buffer.alloc(0));

      expect(downstream).not.toHaveBeenCalled();
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 401 Unauthorized'));
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('can be installed twice (re-armed after addons attach) without double-answering', () => {
      const server = new EventEmitter() as unknown as HttpServer;
      const downstream = jest.fn();
      server.on('upgrade', downstream);
      installWebSocketGate(server);
      installWebSocketGate(server);

      const denied = { write: jest.fn(), destroy: jest.fn() };
      server.emit('upgrade', makeUpgradeReq({}), denied, Buffer.alloc(0));
      expect(denied.write).toHaveBeenCalledTimes(1);
      expect(downstream).not.toHaveBeenCalled();

      const allowed = { write: jest.fn(), destroy: jest.fn() };
      server.emit('upgrade', makeUpgradeReq({ remoteAddress: '127.0.0.1' }), allowed, Buffer.alloc(0));
      expect(downstream).toHaveBeenCalledTimes(1);
      expect(allowed.destroy).not.toHaveBeenCalled();
    });

    it('forwards authorised upgrades and unrelated events untouched', () => {
      const server = new EventEmitter() as unknown as HttpServer;
      const downstream = jest.fn();
      const other = jest.fn();
      server.on('upgrade', downstream);
      server.on('request', other);
      installWebSocketGate(server);

      const socket = { write: jest.fn(), destroy: jest.fn() };
      server.emit('upgrade', makeUpgradeReq({ remoteAddress: '127.0.0.1' }), socket, Buffer.alloc(0));
      server.emit('request', {}, {});

      expect(downstream).toHaveBeenCalledTimes(1);
      expect(other).toHaveBeenCalledTimes(1);
      expect(socket.destroy).not.toHaveBeenCalled();
    });
  });
});
