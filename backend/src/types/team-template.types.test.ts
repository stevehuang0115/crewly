// ExpertProfileModule integration
/**
 * Tests for Team Template Types
 *
 * @module types/team-template.test
 */

import {
  TEMPLATE_CATEGORIES,
  VERIFICATION_METHODS,
  isValidTemplateCategory,
  isValidVerificationMethod,
  isValidVerificationStep,
  isValidVerificationPipeline,
  isValidTemplateRole,
  isValidTeamTemplate,
} from './team-template.types.js';
import type {
  TeamTemplate,
  VerificationPipeline,
  VerificationStep,
  TemplateRole,
} from './team-template.types.js';

// =============================================================================
// Test data helpers
// =============================================================================

function createValidStep(overrides?: Partial<VerificationStep>): VerificationStep {
  return {
    id: 'step-1',
    name: 'Build Check',
    description: 'Verify the project builds',
    method: 'quality_gates',
    critical: true,
    config: { command: 'npm run build' },
    ...overrides,
  };
}

function createValidPipeline(overrides?: Partial<VerificationPipeline>): VerificationPipeline {
  return {
    name: 'Dev Pipeline',
    steps: [createValidStep()],
    passPolicy: 'all',
    maxRetries: 2,
    ...overrides,
  };
}

function createValidRole(overrides?: Partial<TemplateRole>): TemplateRole {
  return {
    role: 'developer',
    label: 'Developer',
    defaultName: 'Dev Worker',
    count: 1,
    hierarchyLevel: 2,
    canDelegate: false,
    defaultSkills: ['complete-task', 'report-status'],
    ...overrides,
  };
}

function createValidTemplate(overrides?: Partial<TeamTemplate>): TeamTemplate {
  return {
    id: 'dev-fullstack',
    name: 'Fullstack Dev Team',
    description: 'TL + 2 developers',
    category: 'development',
    version: '1.0.0',
    hierarchical: true,
    roles: [
      createValidRole({ role: 'team-leader', label: 'TL', defaultName: 'Lead', hierarchyLevel: 1, canDelegate: true }),
      createValidRole(),
    ],
    defaultRuntime: 'claude-code',
    verificationPipeline: createValidPipeline(),
    ...overrides,
  };
}

// =============================================================================
// Constants
// =============================================================================

describe('Team Template Type Constants', () => {
  it('should have all expected template categories', () => {
    expect(TEMPLATE_CATEGORIES).toEqual([
      'development', 'content', 'research', 'operations', 'custom',
    ]);
  });

  it('should have all expected verification methods', () => {
    expect(VERIFICATION_METHODS).toContain('quality_gates');
    expect(VERIFICATION_METHODS).toContain('gemini_vision');
    expect(VERIFICATION_METHODS).toContain('fact_check');
    expect(VERIFICATION_METHODS).toContain('manual_review');
    expect(VERIFICATION_METHODS).toContain('custom_script');
    expect(VERIFICATION_METHODS).toHaveLength(12);
  });
});

// =============================================================================
// isValidTemplateCategory
// =============================================================================

describe('isValidTemplateCategory', () => {
  it('should return true for valid categories', () => {
    expect(isValidTemplateCategory('development')).toBe(true);
    expect(isValidTemplateCategory('content')).toBe(true);
    expect(isValidTemplateCategory('research')).toBe(true);
    expect(isValidTemplateCategory('operations')).toBe(true);
    expect(isValidTemplateCategory('custom')).toBe(true);
  });

  it('should return false for invalid categories', () => {
    expect(isValidTemplateCategory('unknown')).toBe(false);
    expect(isValidTemplateCategory('')).toBe(false);
    expect(isValidTemplateCategory(null)).toBe(false);
    expect(isValidTemplateCategory(123)).toBe(false);
  });
});

// =============================================================================
// isValidVerificationMethod
// =============================================================================

describe('isValidVerificationMethod', () => {
  it('should return true for valid methods', () => {
    expect(isValidVerificationMethod('quality_gates')).toBe(true);
    expect(isValidVerificationMethod('gemini_vision')).toBe(true);
    expect(isValidVerificationMethod('custom_script')).toBe(true);
  });

  it('should return false for invalid methods', () => {
    expect(isValidVerificationMethod('invalid')).toBe(false);
    expect(isValidVerificationMethod(null)).toBe(false);
  });
});

// =============================================================================
// isValidVerificationStep
// =============================================================================

describe('isValidVerificationStep', () => {
  it('should return true for valid step', () => {
    expect(isValidVerificationStep(createValidStep())).toBe(true);
  });

  it('should return false for null/non-object', () => {
    expect(isValidVerificationStep(null)).toBe(false);
    expect(isValidVerificationStep('string')).toBe(false);
  });

  it('should return false for missing fields', () => {
    expect(isValidVerificationStep({ id: 'x' })).toBe(false);
    expect(isValidVerificationStep({ ...createValidStep(), id: '' })).toBe(false);
    expect(isValidVerificationStep({ ...createValidStep(), method: 'invalid' })).toBe(false);
    expect(isValidVerificationStep({ ...createValidStep(), critical: 'yes' })).toBe(false);
  });
});

// =============================================================================
// isValidVerificationPipeline
// =============================================================================

describe('isValidVerificationPipeline', () => {
  it('should return true for valid pipeline', () => {
    expect(isValidVerificationPipeline(createValidPipeline())).toBe(true);
  });

  it('should return false for null/non-object', () => {
    expect(isValidVerificationPipeline(null)).toBe(false);
  });

  it('should return false for empty steps', () => {
    expect(isValidVerificationPipeline({ ...createValidPipeline(), steps: [] })).toBe(false);
  });

  it('should return false for invalid passPolicy', () => {
    expect(isValidVerificationPipeline({ ...createValidPipeline(), passPolicy: 'any' })).toBe(false);
  });

  it('should return false for negative maxRetries', () => {
    expect(isValidVerificationPipeline({ ...createValidPipeline(), maxRetries: -1 })).toBe(false);
  });

  it('should return false for invalid step within pipeline', () => {
    expect(isValidVerificationPipeline({
      ...createValidPipeline(),
      steps: [{ id: 'bad' }],
    })).toBe(false);
  });
});

// =============================================================================
// isValidTemplateRole
// =============================================================================

describe('isValidTemplateRole', () => {
  it('should return true for valid role', () => {
    expect(isValidTemplateRole(createValidRole())).toBe(true);
  });

  it('should return false for null/non-object', () => {
    expect(isValidTemplateRole(null)).toBe(false);
  });

  it('should return false for missing role name', () => {
    expect(isValidTemplateRole({ ...createValidRole(), role: '' })).toBe(false);
  });

  it('should return false for count < 1', () => {
    expect(isValidTemplateRole({ ...createValidRole(), count: 0 })).toBe(false);
  });

  it('should return false for negative hierarchyLevel', () => {
    expect(isValidTemplateRole({ ...createValidRole(), hierarchyLevel: -1 })).toBe(false);
  });

  it('should return false for non-array defaultSkills', () => {
    expect(isValidTemplateRole({ ...createValidRole(), defaultSkills: 'skill1' })).toBe(false);
  });
});

// =============================================================================
// isValidTeamTemplate
// =============================================================================

describe('isValidTeamTemplate', () => {
  it('should return true for valid template', () => {
    expect(isValidTeamTemplate(createValidTemplate())).toBe(true);
  });

  it('should return false for null/non-object', () => {
    expect(isValidTeamTemplate(null)).toBe(false);
    expect(isValidTeamTemplate(undefined)).toBe(false);
  });

  it('should return false for empty id', () => {
    expect(isValidTeamTemplate({ ...createValidTemplate(), id: '' })).toBe(false);
  });

  it('should return false for invalid category', () => {
    expect(isValidTeamTemplate({ ...createValidTemplate(), category: 'invalid' })).toBe(false);
  });

  it('should return false for empty roles', () => {
    expect(isValidTeamTemplate({ ...createValidTemplate(), roles: [] })).toBe(false);
  });

  it('should return false for invalid runtime', () => {
    expect(isValidTeamTemplate({ ...createValidTemplate(), defaultRuntime: 'gpt-cli' })).toBe(false);
  });

  it('should return false for invalid pipeline', () => {
    expect(isValidTeamTemplate({
      ...createValidTemplate(),
      verificationPipeline: { name: '', steps: [], passPolicy: 'all', maxRetries: 0 },
    })).toBe(false);
  });

  it('should return true for template with optional fields', () => {
    expect(isValidTeamTemplate({
      ...createValidTemplate(),
      author: 'Crewly Team',
      tags: ['dev', 'fullstack'],
      icon: '🚀',
      monitoringDefaults: { idleEvent: true, fallbackCheckMinutes: 5 },
      maxWorkersPerLeader: 4,
      autoAssign: false,
    })).toBe(true);
  });
});
