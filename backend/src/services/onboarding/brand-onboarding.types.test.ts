/**
 * Tests for Brand Onboarding type definitions and constants.
 *
 * Validates that the ONBOARDING_QUESTIONS constant and DEFAULT_CONTENT_MIX
 * are well-formed and consistent.
 */

import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_QUESTIONS,
  DEFAULT_CONTENT_MIX,
  OnboardingQuestion,
} from './brand-onboarding.types.js';

describe('ONBOARDING_QUESTIONS', () => {
  it('contains exactly 10 questions', () => {
    expect(ONBOARDING_QUESTIONS).toHaveLength(10);
  });

  it('has unique question IDs', () => {
    const ids = ONBOARDING_QUESTIONS.map(q => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has sequential order values from 1 to 10', () => {
    const orders = ONBOARDING_QUESTIONS.map(q => q.order);
    expect(orders).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('all questions have non-empty text', () => {
    for (const q of ONBOARDING_QUESTIONS) {
      expect(q.text.length).toBeGreaterThan(0);
    }
  });

  it('all questions have valid types', () => {
    const validTypes = ['text', 'select', 'multi-select'];
    for (const q of ONBOARDING_QUESTIONS) {
      expect(validTypes).toContain(q.type);
    }
  });

  it('select/multi-select questions have options', () => {
    const selectQuestions = ONBOARDING_QUESTIONS.filter(
      q => q.type === 'select' || q.type === 'multi-select'
    );
    expect(selectQuestions.length).toBeGreaterThan(0);
    for (const q of selectQuestions) {
      expect(q.options).toBeDefined();
      expect(q.options!.length).toBeGreaterThan(0);
    }
  });

  it('optional questions have default values', () => {
    const optionalQuestions = ONBOARDING_QUESTIONS.filter(q => !q.required);
    expect(optionalQuestions.length).toBeGreaterThan(0);
    for (const q of optionalQuestions) {
      expect(q.defaultValue).toBeDefined();
    }
  });

  it('first question asks for business name', () => {
    expect(ONBOARDING_QUESTIONS[0].id).toBe('business_name');
    expect(ONBOARDING_QUESTIONS[0].required).toBe(true);
  });

  it('tone question uses select type', () => {
    const toneQ = ONBOARDING_QUESTIONS.find(q => q.id === 'tone');
    expect(toneQ).toBeDefined();
    expect(toneQ!.type).toBe('select');
    expect(toneQ!.options).toContain('Formal');
    expect(toneQ!.options).toContain('Casual');
    expect(toneQ!.options).toContain('Playful');
    expect(toneQ!.options).toContain('Authoritative');
  });

  it('platforms question uses multi-select type', () => {
    const platformQ = ONBOARDING_QUESTIONS.find(q => q.id === 'platforms');
    expect(platformQ).toBeDefined();
    expect(platformQ!.type).toBe('multi-select');
    expect(platformQ!.options).toContain('X (Twitter)');
    expect(platformQ!.options).toContain('LinkedIn');
    expect(platformQ!.options).toContain('Instagram');
    expect(platformQ!.options).toContain('Facebook');
  });
});

describe('DEFAULT_CONTENT_MIX', () => {
  it('percentages sum to 100', () => {
    const total =
      DEFAULT_CONTENT_MIX.educational +
      DEFAULT_CONTENT_MIX.behindTheScenes +
      DEFAULT_CONTENT_MIX.promotional +
      DEFAULT_CONTENT_MIX.interactive;
    expect(total).toBe(100);
  });

  it('educational has the highest percentage', () => {
    expect(DEFAULT_CONTENT_MIX.educational).toBeGreaterThan(DEFAULT_CONTENT_MIX.promotional);
    expect(DEFAULT_CONTENT_MIX.educational).toBeGreaterThan(DEFAULT_CONTENT_MIX.behindTheScenes);
    expect(DEFAULT_CONTENT_MIX.educational).toBeGreaterThan(DEFAULT_CONTENT_MIX.interactive);
  });

  it('all values are positive', () => {
    expect(DEFAULT_CONTENT_MIX.educational).toBeGreaterThan(0);
    expect(DEFAULT_CONTENT_MIX.behindTheScenes).toBeGreaterThan(0);
    expect(DEFAULT_CONTENT_MIX.promotional).toBeGreaterThan(0);
    expect(DEFAULT_CONTENT_MIX.interactive).toBeGreaterThan(0);
  });
});
