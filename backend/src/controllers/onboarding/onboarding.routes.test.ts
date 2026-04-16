/**
 * Onboarding Routes — Unit Tests
 *
 * Tests the REST API endpoints for onboarding session management.
 * Uses mocked BrandOnboardingService to isolate route logic.
 *
 * @module controllers/onboarding/onboarding.routes.test
 */

import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createOnboardingRouter } from './onboarding.routes.js';
import { BrandOnboardingService } from '../../services/onboarding/brand-onboarding.service.js';
import type {
  OnboardingSession,
  OnboardingPrefill,
  BrandProfile,
} from '../../services/onboarding/brand-onboarding.types.js';

// =============================================================================
// Test app setup
// =============================================================================

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/onboarding', createOnboardingRouter());
  return app;
}

// =============================================================================
// Mock data
// =============================================================================

const mockSession: OnboardingSession = {
  id: 'session-001',
  teamId: 'team-abc',
  templateId: 'marketing-v1',
  status: 'in_progress',
  answers: [],
  currentQuestionIndex: 0,
  totalQuestions: 10,
  createdAt: '2026-04-15T00:00:00Z',
  updatedAt: '2026-04-15T00:00:00Z',
};

const mockPrefill: OnboardingPrefill = {
  businessName: {
    value: 'Sunrise Bakery',
    sourceUrls: ['https://sunrisebakery.com'],
    confidence: 'high',
    extractionMethod: 'llm_text',
    needsReview: false,
  },
  industry: {
    value: 'Food & Beverage',
    sourceUrls: ['https://sunrisebakery.com/about'],
    confidence: 'high',
    extractionMethod: 'llm_text',
    needsReview: false,
  },
  targetCustomer: {
    value: 'Health-conscious millennials',
    sourceUrls: ['https://sunrisebakery.com'],
    confidence: 'medium',
    extractionMethod: 'llm_text',
    needsReview: true,
  },
};

const mockProfile: BrandProfile = {
  businessName: 'Sunrise Bakery',
  industry: 'Food & Beverage',
  description: 'Artisan sourdough for health-conscious families.',
  targetCustomer: 'Health-conscious millennials, 25-40',
  competitors: ['Blue Apron', 'HelloFresh'],
  personality: ['Friendly', 'Wholesome', 'Authentic'],
  tone: 'casual',
  goals: ['Brand awareness', 'Community building'],
  platforms: ['Instagram', 'Facebook'],
  contentExamples: [],
};

// =============================================================================
// Tests
// =============================================================================

describe('Onboarding Routes', () => {
  let app: express.Express;
  let service: BrandOnboardingService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-onboard-test-'));
    BrandOnboardingService.resetInstance();
    service = BrandOnboardingService.getInstance(tmpDir);
    app = createTestApp();
  });

  afterEach(() => {
    BrandOnboardingService.resetInstance();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // POST /sessions
  // -------------------------------------------------------------------------

  describe('POST /api/onboarding/sessions', () => {
    it('should create a new session', async () => {
      const res = await request(app)
        .post('/api/onboarding/sessions')
        .send({ teamId: 'team-abc', templateId: 'marketing-v1' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.teamId).toBe('team-abc');
      expect(res.body.data.templateId).toBe('marketing-v1');
      expect(res.body.data.status).toBe('in_progress');
      expect(res.body.data.id).toBeDefined();
    });

    it('should create session with websiteUrl', async () => {
      const res = await request(app)
        .post('/api/onboarding/sessions')
        .send({ teamId: 'team-abc', templateId: 'marketing-v1', websiteUrl: 'https://example.com' });

      expect(res.status).toBe(201);
      expect(res.body.data.websiteUrl).toBe('https://example.com');
    });

    it('should return 400 when teamId missing', async () => {
      const res = await request(app)
        .post('/api/onboarding/sessions')
        .send({ templateId: 'marketing-v1' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 when templateId missing', async () => {
      const res = await request(app)
        .post('/api/onboarding/sessions')
        .send({ teamId: 'team-abc' });

      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // GET /sessions
  // -------------------------------------------------------------------------

  describe('GET /api/onboarding/sessions', () => {
    it('should list all sessions', async () => {
      service.startSession('team-1', 'tpl-1');
      service.startSession('team-2', 'tpl-2');

      const res = await request(app).get('/api/onboarding/sessions');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.count).toBeGreaterThanOrEqual(2);
    });

    it('should return empty array when no sessions', async () => {
      const res = await request(app).get('/api/onboarding/sessions');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.count).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // GET /sessions/:id
  // -------------------------------------------------------------------------

  describe('GET /api/onboarding/sessions/:id', () => {
    it('should return a session by ID', async () => {
      const session = service.startSession('team-abc', 'marketing-v1');

      const res = await request(app).get(`/api/onboarding/sessions/${session.id}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(session.id);
      expect(res.body.data.teamId).toBe('team-abc');
    });

    it('should return 404 for non-existent session', async () => {
      const res = await request(app).get('/api/onboarding/sessions/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // PUT /sessions/:id
  // -------------------------------------------------------------------------

  describe('PUT /api/onboarding/sessions/:id', () => {
    it('should update website URL', async () => {
      const session = service.startSession('team-abc', 'marketing-v1');

      const res = await request(app)
        .put(`/api/onboarding/sessions/${session.id}`)
        .send({ websiteUrl: 'https://sunrisebakery.com' });

      expect(res.status).toBe(200);
      expect(res.body.data.websiteUrl).toBe('https://sunrisebakery.com');
    });

    it('should submit a single answer', async () => {
      const session = service.startSession('team-abc', 'marketing-v1');

      const res = await request(app)
        .put(`/api/onboarding/sessions/${session.id}`)
        .send({ answer: 'Sunrise Bakery' });

      expect(res.status).toBe(200);
      expect(res.body.data.answers).toHaveLength(1);
      expect(res.body.data.currentQuestionIndex).toBe(1);
    });

    it('should return 404 for non-existent session', async () => {
      const res = await request(app)
        .put('/api/onboarding/sessions/nonexistent')
        .send({ websiteUrl: 'https://example.com' });

      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /sessions/:id/prefill
  // -------------------------------------------------------------------------

  describe('POST /api/onboarding/sessions/:id/prefill', () => {
    it('should store prefill data with confidence metadata', async () => {
      const session = service.startSession('team-abc', 'marketing-v1');

      const res = await request(app)
        .post(`/api/onboarding/sessions/${session.id}/prefill`)
        .send(mockPrefill);

      expect(res.status).toBe(200);
      expect(res.body.data.prefill.businessName.value).toBe('Sunrise Bakery');
      expect(res.body.data.prefill.businessName.confidence).toBe('high');
      expect(res.body.data.prefill.targetCustomer.needsReview).toBe(true);
    });

    it('should identify missing fields', async () => {
      const session = service.startSession('team-abc', 'marketing-v1');

      // Only provide 3 of 10 fields
      const res = await request(app)
        .post(`/api/onboarding/sessions/${session.id}/prefill`)
        .send(mockPrefill);

      expect(res.status).toBe(200);
      expect(res.body.data.missingFields).toBeDefined();
      expect(res.body.data.missingFields.length).toBeGreaterThan(0);
      // description, competitors, personality, tone, platforms, goals, contentExamples should be missing
      expect(res.body.data.missingFields).toContain('description');
      expect(res.body.data.missingFields).toContain('tone');
    });

    it('should return 404 for non-existent session', async () => {
      const res = await request(app)
        .post('/api/onboarding/sessions/nonexistent/prefill')
        .send(mockPrefill);

      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /sessions/:id/approve
  // -------------------------------------------------------------------------

  describe('POST /api/onboarding/sessions/:id/approve', () => {
    it('should approve the reviewed profile', async () => {
      const session = service.startSession('team-abc', 'marketing-v1');

      const res = await request(app)
        .post(`/api/onboarding/sessions/${session.id}/approve`)
        .send(mockProfile);

      expect(res.status).toBe(200);
      expect(res.body.data.approvedProfile.businessName).toBe('Sunrise Bakery');
      expect(res.body.data.status).toBe('completed');
      expect(res.body.data.updatedAt).toBeDefined();
    });

    it('should return 400 when profile has no businessName', async () => {
      const session = service.startSession('team-abc', 'marketing-v1');

      const res = await request(app)
        .post(`/api/onboarding/sessions/${session.id}/approve`)
        .send({ industry: 'Tech' });

      expect(res.status).toBe(400);
    });

    it('should return 404 for non-existent session', async () => {
      const res = await request(app)
        .post('/api/onboarding/sessions/nonexistent/approve')
        .send(mockProfile);

      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // GET /questions
  // -------------------------------------------------------------------------

  describe('GET /api/onboarding/questions', () => {
    it('should return all 10 onboarding questions', async () => {
      const res = await request(app).get('/api/onboarding/questions');

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(10);
      expect(res.body.data[0].id).toBe('business_name');
      expect(res.body.data[9].id).toBe('content_examples');
    });
  });
});
