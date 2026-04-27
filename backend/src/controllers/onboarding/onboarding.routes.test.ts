/**
 * Onboarding Routes — Integration tests against the new Cloud Portal flow.
 *
 * Exercises every endpoint registered by {@link createOnboardingRouter} with
 * a real {@link OnboardingService} singleton, asserting status codes and
 * response payload shapes. The `/provision` endpoint is asserted at the
 * boundary only — the underlying `provisionFromOnboarding` handoff is covered
 * by its own service-level tests.
 *
 * @module controllers/onboarding/onboarding.routes.test
 */

import express from 'express';
import request from 'supertest';
import { createHmac } from 'crypto';
import { createOnboardingRouter } from './onboarding.routes.js';
import { OnboardingService } from '../../services/onboarding/onboarding.service.js';
import type {
  DiscoveryAnswers,
  OnboardingPrefillData,
} from '../../services/onboarding/onboarding.types.js';

// =============================================================================
// JWT signing helper for cross-tenant tests.
// =============================================================================

/** Test-only JWT secret used by the cross-tenant suite. */
const TEST_JWT_SECRET = 'n1-tenant-scoping-test-secret';

/**
 * Mint an HS256 JWT for a synthetic test user. Mirrors the shape that
 * {@link verifyHs256Token} expects: HS256 header + `{ sub, email }`
 * payload + base64url HMAC-SHA256 signature.
 *
 * @param userId - Subject id (becomes `req.user.userId`)
 * @returns Compact JWS string ready to drop into `Authorization: Bearer ...`
 */
function signTestJwt(userId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    email: `${userId}@test.local`,
    // Far-future expiry so tests never flap on the clock.
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  const sig = createHmac('sha256', TEST_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

// =============================================================================
// Test app setup
// =============================================================================

function createTestApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/onboarding', createOnboardingRouter());
  return app;
}

// =============================================================================
// Mock data
// =============================================================================

const samplePrefill: OnboardingPrefillData = {
  businessName: 'Sunrise Bakery',
  industry: 'Food & Beverage',
  description: 'Artisan sourdough for health-conscious families.',
  targetCustomer: 'Health-conscious millennials, 25-40',
  confidence: 'high',
  extractedAt: '2026-04-27T00:00:00Z',
  missingFields: ['competitors'],
};

const sampleAnswers: DiscoveryAnswers = {
  identity: { name: 'Sunrise Bakery', vertical: 'Content/Marketing', size: 'small' },
  strategy: { goal: 'Scale', budget: 'pro', urgency: 'this_week' },
};

// =============================================================================
// Tests
// =============================================================================

describe('Onboarding Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    OnboardingService.resetInstance();
    app = createTestApp();
  });

  afterEach(() => {
    OnboardingService.resetInstance();
  });

  // ---------------------------------------------------------------------------
  // POST /sessions
  // ---------------------------------------------------------------------------

  describe('POST /api/onboarding/sessions', () => {
    it('creates a session without a websiteUrl', async () => {
      const res = await request(app).post('/api/onboarding/sessions').send({});
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.status).toBe('created');
      expect(res.body.data.websiteUrl).toBeUndefined();
    });

    it('creates a session with the provided websiteUrl', async () => {
      const res = await request(app)
        .post('/api/onboarding/sessions')
        .send({ websiteUrl: 'https://sunrisebakery.com' });
      expect(res.status).toBe(201);
      expect(res.body.data.websiteUrl).toBe('https://sunrisebakery.com');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /sessions
  // ---------------------------------------------------------------------------

  describe('GET /api/onboarding/sessions', () => {
    it('returns an empty array when no sessions exist', async () => {
      const res = await request(app).get('/api/onboarding/sessions');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('returns all sessions previously created', async () => {
      await request(app).post('/api/onboarding/sessions').send({ websiteUrl: 'https://a.com' });
      await request(app).post('/api/onboarding/sessions').send({ websiteUrl: 'https://b.com' });
      const res = await request(app).get('/api/onboarding/sessions');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /sessions/:id
  // ---------------------------------------------------------------------------

  describe('GET /api/onboarding/sessions/:id', () => {
    it('returns the session when it exists', async () => {
      const create = await request(app).post('/api/onboarding/sessions').send({});
      const id = create.body.data.id as string;
      const res = await request(app).get(`/api/onboarding/sessions/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(id);
    });

    it('returns 404 for a missing id', async () => {
      const res = await request(app).get('/api/onboarding/sessions/missing-id');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // PUT /sessions/:id
  // ---------------------------------------------------------------------------

  describe('PUT /api/onboarding/sessions/:id', () => {
    it('updates the websiteUrl on an existing session', async () => {
      const create = await request(app).post('/api/onboarding/sessions').send({});
      const id = create.body.data.id as string;
      const res = await request(app)
        .put(`/api/onboarding/sessions/${id}`)
        .send({ websiteUrl: 'https://updated.com' });
      expect(res.status).toBe(200);
      expect(res.body.data.websiteUrl).toBe('https://updated.com');
    });

    it('returns 404 for a missing id', async () => {
      const res = await request(app)
        .put('/api/onboarding/sessions/missing')
        .send({ websiteUrl: 'https://x.com' });
      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /sessions/:id/prefill
  // ---------------------------------------------------------------------------

  describe('POST /api/onboarding/sessions/:id/prefill', () => {
    it('stores prefill data and advances status to "prefilled"', async () => {
      const create = await request(app).post('/api/onboarding/sessions').send({});
      const id = create.body.data.id as string;
      const res = await request(app)
        .post(`/api/onboarding/sessions/${id}/prefill`)
        .send(samplePrefill);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('prefilled');
      expect(res.body.data.prefillData).toEqual(samplePrefill);
    });

    it('returns 404 for a missing id', async () => {
      const res = await request(app)
        .post('/api/onboarding/sessions/missing/prefill')
        .send(samplePrefill);
      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /sessions/:id/approve
  // ---------------------------------------------------------------------------

  describe('POST /api/onboarding/sessions/:id/approve', () => {
    it('records discovery answers and advances status to "approved"', async () => {
      const create = await request(app).post('/api/onboarding/sessions').send({});
      const id = create.body.data.id as string;
      const res = await request(app)
        .post(`/api/onboarding/sessions/${id}/approve`)
        .send({ answers: sampleAnswers });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('approved');
      expect(res.body.data.discoveryAnswers).toEqual(sampleAnswers);
    });

    it('returns 404 for a missing id', async () => {
      const res = await request(app)
        .post('/api/onboarding/sessions/missing/approve')
        .send({ answers: sampleAnswers });
      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /provision
  // ---------------------------------------------------------------------------

  describe('POST /api/onboarding/provision', () => {
    it('returns 400 with the validation error for an empty body', async () => {
      const res = await request(app).post('/api/onboarding/provision').send({});
      // provisionFromOnboarding fails validation; route must surface as 400 (not 500).
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant scoping (N1 — Phase E pre-beta)
  //
  // Verifies cross-tenant access on every endpoint returns HTTP 404 (no
  // enumeration leak), AND that the legitimate owner can still operate on
  // their own session afterwards. Uses the same JWT verification path as
  // production by signing real HS256 tokens against a known test secret.
  // ---------------------------------------------------------------------------

  describe('Tenant scoping (N1 — Phase E pre-beta)', () => {
    const USER_A = 'user-aaa-tenant';
    const USER_B = 'user-bbb-tenant';
    const tokenA = signTestJwt(USER_A);
    const tokenB = signTestJwt(USER_B);
    const previousJwtSecret = process.env['CREWLY_JWT_SECRET'];
    const previousNodeEnv = process.env['NODE_ENV'];

    beforeAll(() => {
      // Force the auth middleware out of its dev-fallback branch so
      // `req.user.userId` is sourced from the signed tokens we mint here
      // rather than the shared `dev-user-001` placeholder.
      process.env['CREWLY_JWT_SECRET'] = TEST_JWT_SECRET;
      process.env['NODE_ENV'] = 'test';
    });

    afterAll(() => {
      // Restore the env so the parent test process is unchanged.
      if (previousJwtSecret === undefined) {
        delete process.env['CREWLY_JWT_SECRET'];
      } else {
        process.env['CREWLY_JWT_SECRET'] = previousJwtSecret;
      }
      if (previousNodeEnv === undefined) {
        delete process.env['NODE_ENV'];
      } else {
        process.env['NODE_ENV'] = previousNodeEnv;
      }
    });

    it('GET /sessions only returns sessions owned by the caller', async () => {
      // user A creates 2 sessions, user B creates 1
      await request(app).post('/api/onboarding/sessions')
        .set('Authorization', `Bearer ${tokenA}`).send({ websiteUrl: 'https://a1.com' });
      await request(app).post('/api/onboarding/sessions')
        .set('Authorization', `Bearer ${tokenA}`).send({ websiteUrl: 'https://a2.com' });
      await request(app).post('/api/onboarding/sessions')
        .set('Authorization', `Bearer ${tokenB}`).send({ websiteUrl: 'https://b1.com' });

      const aRes = await request(app).get('/api/onboarding/sessions')
        .set('Authorization', `Bearer ${tokenA}`);
      expect(aRes.status).toBe(200);
      expect(aRes.body.data).toHaveLength(2);
      expect(aRes.body.data.every((s: { ownerUserId: string }) => s.ownerUserId === USER_A)).toBe(true);

      const bRes = await request(app).get('/api/onboarding/sessions')
        .set('Authorization', `Bearer ${tokenB}`);
      expect(bRes.status).toBe(200);
      expect(bRes.body.data).toHaveLength(1);
      expect(bRes.body.data[0].ownerUserId).toBe(USER_B);
    });

    it('GET /sessions returns 401 without a valid token (auth gate)', async () => {
      const res = await request(app).get('/api/onboarding/sessions');
      expect(res.status).toBe(401);
    });

    it('GET /sessions/:id from a foreign tenant returns 404 (no enumeration leak)', async () => {
      const create = await request(app).post('/api/onboarding/sessions')
        .set('Authorization', `Bearer ${tokenA}`).send({ websiteUrl: 'https://a.com' });
      const id = create.body.data.id as string;

      // Owner reads OK
      const ownerRes = await request(app).get(`/api/onboarding/sessions/${id}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(ownerRes.status).toBe(200);

      // Foreign tenant gets 404 — same shape as a missing id
      const foreignRes = await request(app).get(`/api/onboarding/sessions/${id}`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(foreignRes.status).toBe(404);
      expect(foreignRes.body.success).toBe(false);
      // Body must NOT leak the existence — same canonical "not found" payload
      expect(foreignRes.body.error).toBe('Session not found');

      // Genuinely-missing id returns the SAME 404 shape
      const missingRes = await request(app).get('/api/onboarding/sessions/some-fake-id')
        .set('Authorization', `Bearer ${tokenB}`);
      expect(missingRes.status).toBe(404);
      expect(missingRes.body.error).toBe('Session not found');
    });

    it('PUT /sessions/:id from a foreign tenant returns 404 and does NOT mutate', async () => {
      const create = await request(app).post('/api/onboarding/sessions')
        .set('Authorization', `Bearer ${tokenA}`).send({ websiteUrl: 'https://a.com' });
      const id = create.body.data.id as string;

      const foreignRes = await request(app).put(`/api/onboarding/sessions/${id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ websiteUrl: 'https://hacked.com' });
      expect(foreignRes.status).toBe(404);

      // Owner still sees the original value — mutation was rejected
      const verify = await request(app).get(`/api/onboarding/sessions/${id}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(verify.body.data.websiteUrl).toBe('https://a.com');
    });

    it('PUT /sessions/:id strips ownerUserId from the body (no re-targeting)', async () => {
      const create = await request(app).post('/api/onboarding/sessions')
        .set('Authorization', `Bearer ${tokenA}`).send({ websiteUrl: 'https://a.com' });
      const id = create.body.data.id as string;

      const res = await request(app).put(`/api/onboarding/sessions/${id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ ownerUserId: USER_B, websiteUrl: 'https://still-mine.com' });
      expect(res.status).toBe(200);
      expect(res.body.data.ownerUserId).toBe(USER_A);
      expect(res.body.data.websiteUrl).toBe('https://still-mine.com');
    });

    it('POST /sessions/:id/prefill from a foreign tenant returns 404 and does NOT mutate', async () => {
      const create = await request(app).post('/api/onboarding/sessions')
        .set('Authorization', `Bearer ${tokenA}`).send({});
      const id = create.body.data.id as string;

      const foreignRes = await request(app).post(`/api/onboarding/sessions/${id}/prefill`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send(samplePrefill);
      expect(foreignRes.status).toBe(404);

      const verify = await request(app).get(`/api/onboarding/sessions/${id}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(verify.body.data.prefillData).toBeUndefined();
      expect(verify.body.data.status).toBe('created');
    });

    it('POST /sessions/:id/approve from a foreign tenant returns 404 and does NOT mutate', async () => {
      const create = await request(app).post('/api/onboarding/sessions')
        .set('Authorization', `Bearer ${tokenA}`).send({});
      const id = create.body.data.id as string;

      const foreignRes = await request(app).post(`/api/onboarding/sessions/${id}/approve`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ answers: sampleAnswers });
      expect(foreignRes.status).toBe(404);

      const verify = await request(app).get(`/api/onboarding/sessions/${id}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(verify.body.data.discoveryAnswers).toBeUndefined();
      expect(verify.body.data.status).toBe('created');
    });

    it('POST /sessions creates sessions stamped with the caller as owner', async () => {
      const aRes = await request(app).post('/api/onboarding/sessions')
        .set('Authorization', `Bearer ${tokenA}`).send({ websiteUrl: 'https://a.com' });
      expect(aRes.status).toBe(201);
      expect(aRes.body.data.ownerUserId).toBe(USER_A);

      const bRes = await request(app).post('/api/onboarding/sessions')
        .set('Authorization', `Bearer ${tokenB}`).send({ websiteUrl: 'https://b.com' });
      expect(bRes.status).toBe(201);
      expect(bRes.body.data.ownerUserId).toBe(USER_B);
    });

    it('owner can still operate on their session after a foreign attempt', async () => {
      const create = await request(app).post('/api/onboarding/sessions')
        .set('Authorization', `Bearer ${tokenA}`).send({});
      const id = create.body.data.id as string;

      // Foreign attempt is rejected silently
      await request(app).put(`/api/onboarding/sessions/${id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ websiteUrl: 'https://hacked.com' });

      // Owner can still mutate
      const ownerRes = await request(app).put(`/api/onboarding/sessions/${id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ websiteUrl: 'https://owner-update.com' });
      expect(ownerRes.status).toBe(200);
      expect(ownerRes.body.data.websiteUrl).toBe('https://owner-update.com');
    });
  });
});
