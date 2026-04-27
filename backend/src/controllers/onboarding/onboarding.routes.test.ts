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
import { createOnboardingRouter } from './onboarding.routes.js';
import { OnboardingService } from '../../services/onboarding/onboarding.service.js';
import type {
  DiscoveryAnswers,
  OnboardingPrefillData,
} from '../../services/onboarding/onboarding.types.js';

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
});
