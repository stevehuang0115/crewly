/**
 * Tests for BrandOnboardingService.
 *
 * Covers session lifecycle, answer validation, brand profile extraction,
 * Brand Voice Guide generation, and persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { BrandOnboardingService } from './brand-onboarding.service.js';
import {
  ONBOARDING_QUESTIONS,
  OnboardingSession,
  BrandProfile,
} from './brand-onboarding.types.js';

// =============================================================================
// Test Helpers
// =============================================================================

const TEST_DIR = join(process.cwd(), '.test-onboarding-' + Date.now());
const TEST_CREWLY_HOME = join(TEST_DIR, '.crewly');
const TEST_KNOWLEDGE_DIR = join(TEST_DIR, 'knowledge', 'docs');

/** Sample answers for a complete onboarding session. */
const SAMPLE_ANSWERS: Record<string, string> = {
  business_name: 'Sunrise Bakery',
  industry: 'Food & Beverage',
  description: 'We make artisan sourdough bread for health-conscious families.',
  target_customer: 'Health-conscious millennials, 25-40, interested in organic food',
  competitors: 'Blue Apron, HelloFresh, Local Bakery XYZ',
  personality: 'Warm, Authentic, Passionate',
  tone: 'casual',
  goals: 'Brand awareness, Community building',
  platforms: 'Instagram, X (Twitter)',
  content_examples: 'https://instagram.com/bakery_example, Wendy\'s snarky tone on Twitter',
};

/**
 * Create a service instance and walk through all questions.
 *
 * @param service - BrandOnboardingService instance
 * @param teamId - Team ID
 * @returns Completed session
 */
function completeQuestionnaire(
  service: BrandOnboardingService,
  teamId: string = 'team-test-001'
): OnboardingSession {
  const session = service.startSession(teamId, 'marketing-team');
  for (const question of ONBOARDING_QUESTIONS) {
    const value = SAMPLE_ANSWERS[question.id] ?? question.defaultValue ?? '';
    service.submitAnswer(session.id, value);
  }
  return service.getSession(session.id)!;
}

// =============================================================================
// Tests
// =============================================================================

describe('BrandOnboardingService', () => {
  let service: BrandOnboardingService;

  beforeEach(() => {
    BrandOnboardingService.resetInstance();
    mkdirSync(TEST_CREWLY_HOME, { recursive: true });
    service = new BrandOnboardingService(TEST_CREWLY_HOME);
  });

  afterEach(() => {
    BrandOnboardingService.resetInstance();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Session Management
  // ---------------------------------------------------------------------------

  describe('startSession', () => {
    it('creates a new session with initial state', () => {
      const session = service.startSession('team-001', 'marketing-team');

      expect(session.id).toBeTruthy();
      expect(session.teamId).toBe('team-001');
      expect(session.templateId).toBe('marketing-team');
      expect(session.status).toBe('in_progress');
      expect(session.answers).toHaveLength(0);
      expect(session.currentQuestionIndex).toBe(0);
      expect(session.totalQuestions).toBe(ONBOARDING_QUESTIONS.length);
      expect(session.createdAt).toBeTruthy();
    });

    it('persists the session to disk', () => {
      const session = service.startSession('team-001', 'marketing-team');
      const filePath = join(TEST_CREWLY_HOME, 'onboarding', `${session.id}.json`);

      expect(existsSync(filePath)).toBe(true);
      const persisted = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(persisted.teamId).toBe('team-001');
    });

    it('generates unique session IDs', () => {
      const s1 = service.startSession('team-001', 'marketing-team');
      const s2 = service.startSession('team-002', 'marketing-team');
      expect(s1.id).not.toBe(s2.id);
    });
  });

  describe('getSession', () => {
    it('returns existing session from memory', () => {
      const session = service.startSession('team-001', 'marketing-team');
      const retrieved = service.getSession(session.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(session.id);
    });

    it('loads session from disk if not in memory', () => {
      const session = service.startSession('team-001', 'marketing-team');
      const sessionId = session.id;

      // Create a new service instance (different memory)
      const newService = new BrandOnboardingService(TEST_CREWLY_HOME);
      const loaded = newService.getSession(sessionId);

      expect(loaded).not.toBeNull();
      expect(loaded!.teamId).toBe('team-001');
    });

    it('returns null for non-existent session', () => {
      expect(service.getSession('non-existent')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Question Flow
  // ---------------------------------------------------------------------------

  describe('getCurrentQuestion', () => {
    it('returns the first question for a new session', () => {
      const session = service.startSession('team-001', 'marketing-team');
      const question = service.getCurrentQuestion(session.id);

      expect(question).not.toBeNull();
      expect(question!.id).toBe('business_name');
      expect(question!.order).toBe(1);
    });

    it('returns null for completed session', () => {
      const session = completeQuestionnaire(service);
      expect(service.getCurrentQuestion(session.id)).toBeNull();
    });

    it('returns null for non-existent session', () => {
      expect(service.getCurrentQuestion('non-existent')).toBeNull();
    });
  });

  describe('submitAnswer', () => {
    it('records answer and advances to next question', () => {
      const session = service.startSession('team-001', 'marketing-team');
      const updated = service.submitAnswer(session.id, 'Sunrise Bakery');

      expect(updated).not.toBeNull();
      expect(updated!.answers).toHaveLength(1);
      expect(updated!.answers[0].questionId).toBe('business_name');
      expect(updated!.answers[0].value).toBe('Sunrise Bakery');
      expect(updated!.currentQuestionIndex).toBe(1);
    });

    it('throws on empty required answer', () => {
      const session = service.startSession('team-001', 'marketing-team');
      expect(() => service.submitAnswer(session.id, '')).toThrow('required');
    });

    it('allows empty optional answer with default', () => {
      const session = service.startSession('team-001', 'marketing-team');

      // Answer first 4 required questions
      for (let i = 0; i < 4; i++) {
        service.submitAnswer(session.id, `Answer ${i + 1}`);
      }

      // Question 5 (competitors) is optional
      const updated = service.submitAnswer(session.id, '');
      expect(updated!.answers[4].value).toBe('Not specified');
    });

    it('marks session as completed after all answers', () => {
      const session = completeQuestionnaire(service);
      expect(session.status).toBe('completed');
      expect(session.answers).toHaveLength(ONBOARDING_QUESTIONS.length);
    });

    it('returns null for non-existent session', () => {
      expect(service.submitAnswer('non-existent', 'value')).toBeNull();
    });

    it('trims whitespace from answers', () => {
      const session = service.startSession('team-001', 'marketing-team');
      const updated = service.submitAnswer(session.id, '  Sunrise Bakery  ');
      expect(updated!.answers[0].value).toBe('Sunrise Bakery');
    });
  });

  describe('submitAllAnswers', () => {
    it('submits all answers at once in batch mode', () => {
      const session = service.startSession('team-001', 'marketing-team');
      const updated = service.submitAllAnswers(session.id, SAMPLE_ANSWERS);

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('completed');
      expect(updated!.answers).toHaveLength(ONBOARDING_QUESTIONS.length);
      expect(updated!.currentQuestionIndex).toBe(ONBOARDING_QUESTIONS.length);
    });

    it('throws when required field is missing', () => {
      const session = service.startSession('team-001', 'marketing-team');
      const incomplete = { ...SAMPLE_ANSWERS };
      delete (incomplete as Record<string, string>)['business_name'];

      expect(() => service.submitAllAnswers(session.id, incomplete)).toThrow('required');
    });
  });

  // ---------------------------------------------------------------------------
  // Brand Profile Extraction
  // ---------------------------------------------------------------------------

  describe('extractBrandProfile', () => {
    it('extracts structured profile from answers', () => {
      const session = completeQuestionnaire(service);
      const profile = service.extractBrandProfile(session);

      expect(profile.businessName).toBe('Sunrise Bakery');
      expect(profile.industry).toBe('Food & Beverage');
      expect(profile.description).toContain('artisan sourdough');
      expect(profile.targetCustomer).toContain('Health-conscious');
      expect(profile.competitors).toContain('Blue Apron');
      expect(profile.competitors).toHaveLength(3);
      expect(profile.personality).toContain('Warm');
      expect(profile.personality).toHaveLength(3);
      expect(profile.tone).toBe('casual');
      expect(profile.goals).toContain('Brand awareness');
      expect(profile.platforms).toContain('Instagram');
      expect(profile.contentExamples).toHaveLength(2);
    });

    it('throws for incomplete session', () => {
      const session = service.startSession('team-001', 'marketing-team');
      expect(() => service.extractBrandProfile(session)).toThrow('incomplete');
    });

    it('defaults to casual tone for unrecognized input', () => {
      const session = service.startSession('team-001', 'marketing-team');
      const answers = { ...SAMPLE_ANSWERS, tone: 'unknown-tone' };
      service.submitAllAnswers(session.id, answers);
      const completed = service.getSession(session.id)!;

      const profile = service.extractBrandProfile(completed);
      expect(profile.tone).toBe('casual');
    });
  });

  // ---------------------------------------------------------------------------
  // Brand Voice Guide Generation
  // ---------------------------------------------------------------------------

  describe('generateBrandVoiceGuide', () => {
    let profile: BrandProfile;

    beforeEach(() => {
      const session = completeQuestionnaire(service);
      profile = service.extractBrandProfile(session);
      mkdirSync(TEST_KNOWLEDGE_DIR, { recursive: true });
    });

    it('generates a markdown file at the specified path', () => {
      const guidePath = service.generateBrandVoiceGuide({
        profile,
        outputDir: TEST_KNOWLEDGE_DIR,
      });

      expect(existsSync(guidePath)).toBe(true);
      expect(guidePath).toContain('brand-voice-guide.md');
    });

    it('includes business name in the guide', () => {
      const guidePath = service.generateBrandVoiceGuide({
        profile,
        outputDir: TEST_KNOWLEDGE_DIR,
      });
      const content = readFileSync(guidePath, 'utf-8');

      expect(content).toContain('Sunrise Bakery');
      expect(content).toContain('Food & Beverage');
    });

    it('includes tone-specific dos and donts', () => {
      const guidePath = service.generateBrandVoiceGuide({
        profile,
        outputDir: TEST_KNOWLEDGE_DIR,
      });
      const content = readFileSync(guidePath, 'utf-8');

      // Casual tone should have casual-specific rules
      expect(content).toContain("Do's");
      expect(content).toContain("Don'ts");
      expect(content).toContain('talking to a friend');
    });

    it('includes platform-specific guidelines', () => {
      const guidePath = service.generateBrandVoiceGuide({
        profile,
        outputDir: TEST_KNOWLEDGE_DIR,
      });
      const content = readFileSync(guidePath, 'utf-8');

      expect(content).toContain('Instagram');
      expect(content).toContain('X (Twitter)');
      expect(content).toContain('Platform Guidelines');
    });

    it('includes content mix ratios', () => {
      const guidePath = service.generateBrandVoiceGuide({
        profile,
        outputDir: TEST_KNOWLEDGE_DIR,
      });
      const content = readFileSync(guidePath, 'utf-8');

      expect(content).toContain('60% Educational');
      expect(content).toContain('20% Behind-the-scenes');
      expect(content).toContain('15% Promotional');
    });

    it('includes writing rules', () => {
      const guidePath = service.generateBrandVoiceGuide({
        profile,
        outputDir: TEST_KNOWLEDGE_DIR,
      });
      const content = readFileSync(guidePath, 'utf-8');

      expect(content).toContain('Writing Rules');
      expect(content).toContain('Never use generic AI cliches');
    });

    it('creates output directory if it does not exist', () => {
      const newDir = join(TEST_DIR, 'new-team', 'knowledge', 'docs');
      expect(existsSync(newDir)).toBe(false);

      service.generateBrandVoiceGuide({
        profile,
        outputDir: newDir,
      });

      expect(existsSync(newDir)).toBe(true);
    });

    it('generates correct dos/donts for formal tone', () => {
      const formalProfile = { ...profile, tone: 'formal' as const };
      const guidePath = service.generateBrandVoiceGuide({
        profile: formalProfile,
        outputDir: TEST_KNOWLEDGE_DIR,
      });
      const content = readFileSync(guidePath, 'utf-8');

      expect(content).toContain('proper grammar');
      expect(content).not.toContain('talking to a friend');
    });

    it('generates correct dos/donts for playful tone', () => {
      const playfulProfile = { ...profile, tone: 'playful' as const };
      const guidePath = service.generateBrandVoiceGuide({
        profile: playfulProfile,
        outputDir: TEST_KNOWLEDGE_DIR,
      });
      const content = readFileSync(guidePath, 'utf-8');

      expect(content).toContain('humor');
      expect(content).toContain('emojis');
    });

    it('generates correct dos/donts for authoritative tone', () => {
      const authProfile = { ...profile, tone: 'authoritative' as const };
      const guidePath = service.generateBrandVoiceGuide({
        profile: authProfile,
        outputDir: TEST_KNOWLEDGE_DIR,
      });
      const content = readFileSync(guidePath, 'utf-8');

      expect(content).toContain('expertise');
      expect(content).toContain('thought leadership');
    });
  });

  // ---------------------------------------------------------------------------
  // Complete Onboarding Flow
  // ---------------------------------------------------------------------------

  describe('completeOnboarding', () => {
    it('generates guide and updates session to done', () => {
      const session = completeQuestionnaire(service);
      mkdirSync(TEST_KNOWLEDGE_DIR, { recursive: true });

      const result = service.completeOnboarding(session.id, TEST_KNOWLEDGE_DIR);

      expect(result).not.toBeNull();
      expect(result!.status).toBe('done');
      expect(result!.guidePath).toContain('brand-voice-guide.md');
      expect(result!.brandVoiceGuide).toContain('Sunrise Bakery');
    });

    it('returns null for non-completed session', () => {
      const session = service.startSession('team-001', 'marketing-team');
      const result = service.completeOnboarding(session.id, TEST_KNOWLEDGE_DIR);
      expect(result).toBeNull();
    });

    it('sets status to failed on error', () => {
      const session = completeQuestionnaire(service);

      // Use an invalid path to trigger an error
      const result = service.completeOnboarding(session.id, '/dev/null/invalid/path');

      expect(result).not.toBeNull();
      expect(result!.status).toBe('failed');
      expect(result!.error).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // Singleton Pattern
  // ---------------------------------------------------------------------------

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = BrandOnboardingService.getInstance(TEST_CREWLY_HOME);
      const b = BrandOnboardingService.getInstance(TEST_CREWLY_HOME);
      expect(a).toBe(b);
    });

    it('resets instance correctly', () => {
      const a = BrandOnboardingService.getInstance(TEST_CREWLY_HOME);
      BrandOnboardingService.resetInstance();
      const b = BrandOnboardingService.getInstance(TEST_CREWLY_HOME);
      expect(a).not.toBe(b);
    });
  });

  // ---------------------------------------------------------------------------
  // Questions
  // ---------------------------------------------------------------------------

  describe('getQuestions', () => {
    it('returns all onboarding questions', () => {
      const questions = service.getQuestions();
      expect(questions).toHaveLength(10);
      expect(questions[0].id).toBe('business_name');
      expect(questions[9].id).toBe('content_examples');
    });

    it('questions are ordered sequentially', () => {
      const questions = service.getQuestions();
      for (let i = 0; i < questions.length; i++) {
        expect(questions[i].order).toBe(i + 1);
      }
    });

    it('returns a copy (not the original)', () => {
      const q1 = service.getQuestions();
      const q2 = service.getQuestions();
      expect(q1).not.toBe(q2);
    });
  });
});
