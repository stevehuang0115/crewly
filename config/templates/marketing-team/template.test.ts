/**
 * Tests for Marketing Team Template validation
 *
 * Verifies that template.json passes isValidTeamTemplate() and
 * all role definitions are structurally correct.
 *
 * @module templates/marketing-team/template.test
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  isValidTeamTemplate,
  isValidTemplateRole,
  isValidVerificationPipeline,
  isValidTemplateCategory,
} from '../../../backend/src/types/team-template.types.js';

const TEMPLATE_PATH = resolve(__dirname, 'template.json');

describe('Marketing Team Template', () => {
  let template: Record<string, unknown>;

  beforeAll(() => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
    template = JSON.parse(raw);
  });

  // =========================================================================
  // Core validation
  // =========================================================================

  it('should pass isValidTeamTemplate() validation', () => {
    expect(isValidTeamTemplate(template)).toBe(true);
  });

  it('should have required top-level fields', () => {
    expect(template.id).toBe('marketing-team');
    expect(template.name).toBe('AI Marketing Team');
    expect(typeof template.description).toBe('string');
    expect(template.version).toBe('1.0.0');
    expect(template.hierarchical).toBe(true);
    expect(template.defaultRuntime).toBe('claude-code');
  });

  it('should have a valid category', () => {
    expect(isValidTemplateCategory(template.category)).toBe(true);
  });

  // =========================================================================
  // Roles
  // =========================================================================

  describe('roles', () => {
    it('should have exactly 3 roles', () => {
      expect(Array.isArray(template.roles)).toBe(true);
      expect((template.roles as unknown[]).length).toBe(3);
    });

    it('should have all roles pass isValidTemplateRole()', () => {
      const roles = template.roles as unknown[];
      roles.forEach((role) => {
        expect(isValidTemplateRole(role)).toBe(true);
      });
    });

    it('should define strategist as hierarchy level 1 with canDelegate', () => {
      const roles = template.roles as Record<string, unknown>[];
      const strategist = roles.find((r) => r.role === 'strategist');
      expect(strategist).toBeDefined();
      expect(strategist!.defaultName).toBe('Maya');
      expect(strategist!.hierarchyLevel).toBe(1);
      expect(strategist!.canDelegate).toBe(true);
      expect(strategist!.reportsTo).toBeUndefined();
    });

    it('should define writer as hierarchy level 2 reporting to strategist', () => {
      const roles = template.roles as Record<string, unknown>[];
      const writer = roles.find((r) => r.role === 'writer');
      expect(writer).toBeDefined();
      expect(writer!.defaultName).toBe('Alex');
      expect(writer!.hierarchyLevel).toBe(2);
      expect(writer!.canDelegate).toBe(false);
      expect(writer!.reportsTo).toBe('strategist');
    });

    it('should define analyst as hierarchy level 2 reporting to strategist', () => {
      const roles = template.roles as Record<string, unknown>[];
      const analyst = roles.find((r) => r.role === 'analyst');
      expect(analyst).toBeDefined();
      expect(analyst!.defaultName).toBe('Jordan');
      expect(analyst!.hierarchyLevel).toBe(2);
      expect(analyst!.canDelegate).toBe(false);
      expect(analyst!.reportsTo).toBe('strategist');
    });

    it('should assign correct defaultSkills to each role', () => {
      const roles = template.roles as Record<string, unknown>[];

      const strategist = roles.find((r) => r.role === 'strategist');
      expect(strategist!.defaultSkills).toEqual(
        expect.arrayContaining(['content-calendar', 'competitor-content-tracker']),
      );

      const writer = roles.find((r) => r.role === 'writer');
      expect(writer!.defaultSkills).toEqual(
        expect.arrayContaining(['social-media-post', 'content-writer', 'seo-blog-writer']),
      );

      const analyst = roles.find((r) => r.role === 'analyst');
      expect(analyst!.defaultSkills).toEqual(
        expect.arrayContaining(['daily-standup-report']),
      );
    });
  });

  // =========================================================================
  // Verification Pipeline
  // =========================================================================

  describe('verificationPipeline', () => {
    it('should pass isValidVerificationPipeline()', () => {
      expect(isValidVerificationPipeline(template.verificationPipeline)).toBe(true);
    });

    it('should have at least one verification step', () => {
      const pipeline = template.verificationPipeline as Record<string, unknown>;
      const steps = pipeline.steps as unknown[];
      expect(steps.length).toBeGreaterThanOrEqual(1);
    });

    it('should have passPolicy set to all', () => {
      const pipeline = template.verificationPipeline as Record<string, unknown>;
      expect(pipeline.passPolicy).toBe('all');
    });
  });

  // =========================================================================
  // Skills
  // =========================================================================

  describe('skills configuration', () => {
    it('should list required skills', () => {
      const required = template.requiredSkills as string[];
      expect(required).toEqual(
        expect.arrayContaining(['social-media-post', 'content-calendar']),
      );
    });

    it('should list optional skills', () => {
      const optional = template.optionalSkills as string[];
      expect(optional).toEqual(
        expect.arrayContaining(['daily-standup-report', 'seo-blog-writer']),
      );
    });
  });

  // =========================================================================
  // Budget & Mission
  // =========================================================================

  describe('budget and mission', () => {
    it('should have a budget configuration', () => {
      const budget = template.budget as Record<string, unknown>;
      expect(budget).toBeDefined();
      expect(budget.maxTokensPerDay).toBe(2000000);
      expect(budget.alertThreshold).toBe(80);
    });

    it('should have a mission field', () => {
      expect(typeof template.mission).toBe('string');
      expect((template.mission as string).length).toBeGreaterThan(0);
    });
  });
});
