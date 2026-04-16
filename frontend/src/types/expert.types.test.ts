/**
 * Expert Types Tests
 *
 * Type guard and structure validation tests for expert types.
 *
 * @module types/expert.types.test
 */

import { describe, it, expect } from 'vitest';
import type { ExpertSummary } from './expert.types';

describe('expert.types', () => {
  describe('ExpertSummary', () => {
    it('accepts a valid ExpertSummary object', () => {
      const expert: ExpertSummary = {
        id: 'empathetic-resolver',
        name: 'Empathetic Resolver',
        category: 'Customer Support',
        tags: ['empathy', 'retention'],
        baseRoles: ['support', 'customer-success'],
      };

      expect(expert.id).toBe('empathetic-resolver');
      expect(expert.name).toBe('Empathetic Resolver');
      expect(expert.category).toBe('Customer Support');
      expect(expert.tags).toHaveLength(2);
      expect(expert.baseRoles).toHaveLength(2);
    });

    it('supports empty arrays for tags and baseRoles', () => {
      const expert: ExpertSummary = {
        id: 'test',
        name: 'Test Expert',
        category: 'Testing',
        tags: [],
        baseRoles: [],
      };

      expect(expert.tags).toHaveLength(0);
      expect(expert.baseRoles).toHaveLength(0);
    });
  });
});
