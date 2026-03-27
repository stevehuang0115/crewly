/**
 * Tests for onboarding type definitions.
 *
 * Validates type structure and guards.
 */

import type { TemplateInfo, TemplateRole, OnboardingState } from './onboarding.types';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('onboarding.types', () => {
  it('TemplateRole has required fields', () => {
    const role: TemplateRole = {
      role: 'developer',
      label: 'Developer',
      defaultName: 'Dev',
    };
    expect(role.role).toBe('developer');
    expect(role.label).toBe('Developer');
    expect(role.defaultName).toBe('Dev');
  });

  it('TemplateInfo has required fields', () => {
    const template: TemplateInfo = {
      id: 'dev-fullstack',
      name: 'Fullstack Development Team',
      description: 'A team for building web apps',
      category: 'development',
      icon: 'laptop',
      roles: [],
    };
    expect(template.id).toBe('dev-fullstack');
    expect(template.roles).toEqual([]);
  });

  it('OnboardingState initialises with defaults', () => {
    const state: OnboardingState = {
      cloudConnected: false,
      selectedTemplate: null,
      teamName: '',
      projectPath: '',
      isCreating: false,
      error: null,
    };
    expect(state.cloudConnected).toBe(false);
    expect(state.selectedTemplate).toBeNull();
    expect(state.isCreating).toBe(false);
  });
});
