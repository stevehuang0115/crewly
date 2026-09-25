/**
 * Template Validation Tests
 *
 * Verifies that all OSS team templates are well-formed and properly configured.
 * Pro/premium templates are validated separately in crewly-pro.
 *
 * Run: npx vitest run config/templates/templates.test.ts
 */

import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const TEMPLATES_DIR = path.resolve(__dirname);

/**
 * Discovers all template directories containing template.json
 * and all legacy JSON template files in the templates directory.
 */
function discoverTemplates(): { id: string; filePath: string; isLegacy: boolean }[] {
  const templates: { id: string; filePath: string; isLegacy: boolean }[] = [];
  const entries = fs.readdirSync(TEMPLATES_DIR);

  for (const entry of entries) {
    const fullPath = path.join(TEMPLATES_DIR, entry);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      const templateJson = path.join(fullPath, 'template.json');
      const teamJson = path.join(fullPath, 'team.json');
      if (fs.existsSync(templateJson)) {
        templates.push({ id: entry, filePath: templateJson, isLegacy: false });
      } else if (fs.existsSync(teamJson)) {
        templates.push({ id: entry, filePath: teamJson, isLegacy: true });
      }
    } else if (
      entry.endsWith('.json') &&
      !entry.startsWith('.') &&
      entry !== 'cloud-deploy.json'
    ) {
      templates.push({ id: entry.replace('.json', ''), filePath: fullPath, isLegacy: true });
    }
  }

  return templates;
}

// ── OSS Template Tests ──────────────────────────────────────────────────

describe('OSS template validation', () => {
  const templates = discoverTemplates();

  it('has at least one template', () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  for (const tmpl of templates) {
    describe(`${tmpl.id}`, () => {
      it('is valid JSON', () => {
        expect(() => {
          JSON.parse(fs.readFileSync(tmpl.filePath, 'utf-8'));
        }).not.toThrow();
      });

      it('has name and description', () => {
        const data = JSON.parse(fs.readFileSync(tmpl.filePath, 'utf-8'));
        expect(data.name || data.id).toBeTruthy();
        expect(data.description).toBeTruthy();
      });

      it('has members or roles defined', () => {
        const data = JSON.parse(fs.readFileSync(tmpl.filePath, 'utf-8'));
        const hasMembers = Array.isArray(data.members) && data.members.length > 0;
        const hasRoles = Array.isArray(data.roles) && data.roles.length > 0;
        expect(hasMembers || hasRoles).toBe(true);
      });

      it('does not have Pro-only features (verification pipelines, quality gates)', () => {
        const data = JSON.parse(fs.readFileSync(tmpl.filePath, 'utf-8'));
        // OSS templates should not have these advanced features
        expect(data.verificationPipeline).toBeUndefined();
        expect(data.qualityGatesFile).toBeUndefined();
        expect(data.norms).toBeUndefined();
      });

      it('does not require a paid tier', () => {
        const data = JSON.parse(fs.readFileSync(tmpl.filePath, 'utf-8'));
        if (data.requiredTier) {
          expect(data.requiredTier).toBe('free');
        }
        if (data.pricing) {
          expect(data.pricing.isFree).toBe(true);
        }
      });
    });
  }
});

// ── Onboarding starters (specs/onboarding-harness-login.md, Phase 3) ────

/** Keys a free onboarding starter may have: a members list and display metadata only. */
const STARTER_ALLOWED_KEYS = ['id', 'name', 'description', 'members', 'onboarding'];

/** Keys each starter member may have: name, basic role and prompt. */
const STARTER_MEMBER_ALLOWED_KEYS = ['name', 'role', 'systemPrompt'];

/**
 * A basic role id. Custom ids are allowed: an id with no config/roles/<id>/
 * directory falls back to the generalist prompt at registration.
 */
const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

describe('onboarding starter templates', () => {
  const starters = discoverTemplates()
    .map((tmpl) => ({ ...tmpl, data: JSON.parse(fs.readFileSync(tmpl.filePath, 'utf-8')) }))
    .filter((tmpl) => tmpl.data.onboarding !== undefined);

  it('are Personal Assistant (first, recommended) and Marketing', () => {
    const ordered = [...starters].sort((a, b) => a.data.onboarding.order - b.data.onboarding.order);
    expect(ordered.map((t) => t.data.id)).toEqual(['personal-assistant-team', 'growth-marketing-team']);
    expect(ordered[0].data.onboarding.recommended).toBe(true);
  });

  it('has exactly one recommended starter', () => {
    expect(starters.filter((t) => t.data.onboarding.recommended === true)).toHaveLength(1);
  });

  it('uses unique order values', () => {
    const orders = starters.map((t) => t.data.onboarding.order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  for (const tmpl of starters) {
    describe(`${tmpl.id}`, () => {
      it('file name matches the id', () => {
        expect(tmpl.data.id).toBe(tmpl.id);
      });

      it('is simple: members list and basic roles only', () => {
        expect(tmpl.isLegacy).toBe(true);
        for (const key of Object.keys(tmpl.data)) {
          expect(STARTER_ALLOWED_KEYS).toContain(key);
        }
        expect(tmpl.data.roles).toBeUndefined();
        for (const member of tmpl.data.members) {
          for (const key of Object.keys(member)) {
            expect(STARTER_MEMBER_ALLOWED_KEYS).toContain(key);
          }
          expect(member.role).toMatch(ROLE_ID_PATTERN);
          expect(typeof member.systemPrompt).toBe('string');
          expect(member.systemPrompt.length).toBeGreaterThan(100);
          // Session names are built from the member name: keep it ASCII.
          expect(member.name).toMatch(/^[A-Za-z][A-Za-z0-9 ]*$/);
        }
      });

      it('has onboarding metadata with a Chinese label, a tagline and 3 suggestions', () => {
        const onboarding = tmpl.data.onboarding;
        expect(typeof onboarding.order).toBe('number');
        expect(typeof onboarding.recommended).toBe('boolean');
        expect(typeof onboarding.label).toBe('string');
        expect(onboarding.label.length).toBeGreaterThan(0);
        expect(typeof onboarding.tagline).toBe('string');
        expect(Array.isArray(onboarding.suggestions)).toBe(true);
        expect(onboarding.suggestions).toHaveLength(3);
        for (const suggestion of onboarding.suggestions) {
          expect(typeof suggestion).toBe('string');
          expect(suggestion.trim().length).toBeGreaterThan(0);
        }
      });
    });
  }

  it('the Personal Assistant drafts first and sends only after the owner confirms', () => {
    const pa = starters.find((t) => t.data.id === 'personal-assistant-team');
    const lead = pa?.data.members[0];
    expect(lead?.name).toBe('Assistant');
    expect(lead?.systemPrompt).toMatch(/only after the owner has confirmed/);
    expect(lead?.systemPrompt).toMatch(/briefing/i);
  });
});
