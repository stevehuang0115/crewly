/**
 * OAuth Routes Tests
 *
 * Tests for the OAuth API routes (Google start and callback).
 *
 * @module oauth-routes.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockCreateOrUpdateUser = jest.fn();
const mockConnectService = jest.fn();

jest.mock('../../services/user/user-identity.service.js', () => ({
  UserIdentityService: {
    getInstance: jest.fn(() => ({
      createOrUpdateUser: mockCreateOrUpdateUser,
      connectService: mockConnectService,
    })),
  },
}));

jest.mock('../../services/core/logger.service.js', () => ({
  LoggerService: {
    getInstance: jest.fn(() => ({
      createComponentLogger: jest.fn(() => ({
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      })),
    })),
  },
}));

const mockGetAllLoginRequired = jest.fn<() => unknown[]>(() => []);
jest.mock('../../services/agent/oauth-relogin-monitor.service.js', () => ({
  OAuthReloginMonitorService: {
    getInstance: jest.fn(() => ({ getAllLoginRequired: mockGetAllLoginRequired })),
  },
}));

import express from 'express';
import request from 'supertest';
import { createOAuthRouter } from './oauth.routes.js';

describe('OAuth Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should export a createOAuthRouter function', () => {
    expect(typeof createOAuthRouter).toBe('function');
  });

  it('should return a router with google/start and google/callback routes', () => {
    const router = createOAuthRouter();
    const routes = (router as any).stack
      ?.map((layer: any) => ({
        path: layer.route?.path,
        methods: layer.route?.methods,
      }))
      .filter((r: any) => r.path);

    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/google/start' }),
        expect.objectContaining({ path: '/google/callback' }),
        expect.objectContaining({ path: '/pending' }),
      ])
    );
  });

  describe('GET /pending', () => {
    const app = express();
    app.use('/api/oauth', createOAuthRouter());

    it('returns an empty list when no session is waiting on sign-in', async () => {
      mockGetAllLoginRequired.mockReturnValue([]);
      const res = await request(app).get('/api/oauth/pending');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: [], count: 0 });
    });

    it('returns every pending login with url, code and timestamps', async () => {
      mockGetAllLoginRequired.mockReturnValue([
        {
          sessionName: 'crewly-orc',
          runtimeType: 'codex',
          url: 'https://auth.openai.com/device',
          code: 'FBVZ-MJHKK',
          detectedAt: '2026-09-18T10:00:00.000Z',
          notifiedAt: null,
        },
        {
          sessionName: 'crewly-dev-1',
          runtimeType: null,
          url: null,
          code: null,
          detectedAt: '2026-09-18T10:05:00.000Z',
          notifiedAt: '2026-09-18T10:06:00.000Z',
        },
      ]);
      const res = await request(app).get('/api/oauth/pending');
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
      expect(res.body.data[0]).toEqual({
        sessionName: 'crewly-orc',
        runtimeType: 'codex',
        url: 'https://auth.openai.com/device',
        code: 'FBVZ-MJHKK',
        detectedAt: '2026-09-18T10:00:00.000Z',
        notifiedAt: null,
      });
      expect(res.body.data[1].sessionName).toBe('crewly-dev-1');
    });

    it('returns 500 when the monitor throws', async () => {
      mockGetAllLoginRequired.mockImplementation(() => {
        throw new Error('monitor down');
      });
      const res = await request(app).get('/api/oauth/pending');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, error: 'monitor down' });
    });
  });
});
