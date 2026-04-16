/**
 * Tests for onboarding types and constants.
 *
 * @module types/onboarding.types.test
 */

import { describe, it, expect } from 'vitest';
import {
  ANALYSIS_STAGES,
  REVIEW_CARDS,
} from './onboarding.types';
import type {
  PrefillConfidence,
  PrefillExtractionMethod,
  OnboardingStep,
  OnboardingSessionStatus,
  OnboardingPrefill,
  PrefillField,
  ReviewCardConfig,
} from './onboarding.types';

describe('onboarding.types', () => {
  describe('ANALYSIS_STAGES', () => {
    it('should have exactly 4 stages', () => {
      expect(ANALYSIS_STAGES).toHaveLength(4);
    });

    it('should start with "Reading homepage"', () => {
      expect(ANALYSIS_STAGES[0]).toBe('Reading homepage');
    });

    it('should end with "Drafting your Crewly setup"', () => {
      expect(ANALYSIS_STAGES[ANALYSIS_STAGES.length - 1]).toBe(
        'Drafting your Crewly setup'
      );
    });
  });

  describe('REVIEW_CARDS', () => {
    it('should have exactly 4 cards', () => {
      expect(REVIEW_CARDS).toHaveLength(4);
    });

    it('should have Business Snapshot as first card', () => {
      expect(REVIEW_CARDS[0].title).toBe('Business Snapshot');
    });

    it('should have Recommended Crewly Setup as last card', () => {
      expect(REVIEW_CARDS[REVIEW_CARDS.length - 1].title).toBe(
        'Recommended Crewly Setup'
      );
    });

    it('each card should have at least one field', () => {
      for (const card of REVIEW_CARDS) {
        expect(card.fields.length).toBeGreaterThan(0);
      }
    });

    it('each field should have a key, label, and required flag', () => {
      for (const card of REVIEW_CARDS) {
        for (const field of card.fields) {
          expect(field.key).toBeTruthy();
          expect(field.label).toBeTruthy();
          expect(typeof field.required).toBe('boolean');
        }
      }
    });

    it('Business Snapshot should have required fields', () => {
      const businessCard = REVIEW_CARDS[0];
      const requiredFields = businessCard.fields.filter((f) => f.required);
      expect(requiredFields.length).toBeGreaterThan(0);
    });
  });

  describe('type guards (compile-time)', () => {
    it('PrefillConfidence should accept valid values', () => {
      const values: PrefillConfidence[] = ['high', 'medium', 'low'];
      expect(values).toHaveLength(3);
    });

    it('PrefillExtractionMethod should accept valid values', () => {
      const values: PrefillExtractionMethod[] = [
        'llm_text',
        'llm_vision',
        'rule',
        'manual',
      ];
      expect(values).toHaveLength(4);
    });

    it('OnboardingStep should accept valid values', () => {
      const values: OnboardingStep[] = [
        'url-input',
        'analyzing',
        'review',
        'confirm',
      ];
      expect(values).toHaveLength(4);
    });

    it('OnboardingSessionStatus should accept valid values', () => {
      const values: OnboardingSessionStatus[] = [
        'not_started',
        'analyzing',
        'draft_ready',
        'in_progress',
        'completed',
        'failed',
      ];
      expect(values).toHaveLength(6);
    });

    it('PrefillField interface should be constructible', () => {
      const field: PrefillField<string> = {
        value: 'test',
        sourceUrls: ['https://example.com'],
        confidence: 'high',
        extractionMethod: 'rule',
        needsReview: false,
      };
      expect(field.value).toBe('test');
    });

    it('OnboardingPrefill should accept partial data', () => {
      const prefill: OnboardingPrefill = {
        businessName: {
          value: 'Acme',
          sourceUrls: [],
          confidence: 'high',
          extractionMethod: 'rule',
          needsReview: false,
        },
      };
      expect(prefill.businessName?.value).toBe('Acme');
    });
  });
});
