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
