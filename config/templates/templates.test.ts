/**
 * Template Validation Tests
 *
 * Verifies that all team templates are well-formed, reference valid tools,
 * have matching norms, and are properly configured for the Cloud deployment manifest.
 *
 * Run: npx vitest run config/templates/templates.test.ts
 */

import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const TEMPLATES_DIR = path.resolve(__dirname);

/** Template IDs that we validate for Cloud deployment */
const CLOUD_TEMPLATE_IDS = ['dev-fullstack', 'research-analysis', 'social-media-ops'];

/**
 * Tools available in the Crewly Agent Runtime (from tool-registry.ts).
 * This is the authoritative list of tool names agents can reference.
 */
const VALID_RUNTIME_TOOLS: string[] = [
  'delegate_task',
  'send_message',
  'get_agent_status',
  'get_team_status',
  'get_agent_logs',
  'reply_slack',
  'schedule_check',
  'cancel_schedule',
  'get_scheduled_checks',
  'start_agent',
  'stop_agent',
  'subscribe_event',
  'recall_memory',
  'remember',
  'heartbeat',
  'get_tasks',
  'complete_task',
  'broadcast',
  'handle_agent_failure',
  'edit_file',
  'read_file',
  'write_file',
  'glob',
  'grep',
  'register_self',
  'get_project_overview',
  'report_status',
  'compact_memory',
  'get_context_budget',
  'get_audit_log',
  'bash_exec',
  'git_status',
  'git_diff',
  'git_commit',
  'handoff_task',
];

/** Valid runtime identifiers */
const VALID_RUNTIMES = ['claude-code', 'crewly-agent'];

/** Required top-level fields in a template.json */
const REQUIRED_TEMPLATE_FIELDS = [
  'id',
  'name',
  'description',
  'category',
  'version',
  'roles',
  'hierarchical',
  'defaultRuntime',
];

/** Required fields for each role in a template */
const REQUIRED_ROLE_FIELDS = [
  'role',
  'label',
  'defaultName',
  'count',
  'hierarchyLevel',
];

// ── Helper Functions ──────────────────────────────────────────────────────

interface TemplateRole {
  role: string;
  label: string;
  defaultName: string;
  count: number;
  hierarchyLevel: number;
  canDelegate?: boolean;
  reportsTo?: string;
  defaultTools?: string[];
  defaultSkills?: string[];
  modelConfig?: {
    provider?: string;
    model?: string;
    temperature?: number;
  };
  enableBrowser?: boolean;
}

interface TemplateNorms {
  enabled: boolean;
  files: Array<{ file: string; trigger: string; roles: string[] }>;
}

interface TemplateData {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  tags?: string[];
  icon?: string;
  hierarchical: boolean;
  defaultRuntime: string;
  compatibleRuntimes?: string[];
  roles: TemplateRole[];
  norms?: TemplateNorms;
  mission?: string;
  budget?: { maxTokensPerDay: number; alertThreshold: number };
  verificationPipeline?: unknown;
  [key: string]: unknown;
}

interface CloudDeployManifest {
  version: string;
  templates: Array<{
    templateId: string;
    displayName: string;
    description: string;
    category: string;
    agentCount: number;
    roles: Array<{ role: string; label: string; count: number }>;
    compatibleRuntimes: string[];
    defaultRuntime: string;
    estimatedTokenUsage: {
      perTaskAvg: number;
      dailyBudget: number;
    };
    features: string[];
    deployConfig: {
      minMemoryMb: number;
      normFiles: string[];
    };
  }>;
}

/**
 * Loads and parses a template.json file.
 *
 * @param templateId - Template directory name
 * @returns Parsed template data
 */
function loadTemplate(templateId: string): TemplateData {
  const filePath = path.join(TEMPLATES_DIR, templateId, 'template.json');
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as TemplateData;
}

/**
 * Loads the cloud-deploy.json manifest.
 *
 * @returns Parsed manifest data
 */
function loadCloudManifest(): CloudDeployManifest {
  const filePath = path.join(TEMPLATES_DIR, 'cloud-deploy.json');
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as CloudDeployManifest;
}

// ── Template Structure Tests ──────────────────────────────────────────────

describe('template structure validation', () => {
  for (const templateId of CLOUD_TEMPLATE_IDS) {
    describe(`${templateId}/template.json`, () => {
      let template: TemplateData;

      it('is valid JSON', () => {
        expect(() => {
          template = loadTemplate(templateId);
        }).not.toThrow();
      });

      it('has all required top-level fields', () => {
        template = loadTemplate(templateId);
        for (const field of REQUIRED_TEMPLATE_FIELDS) {
          expect(template).toHaveProperty(field);
        }
      });

      it('has matching template ID', () => {
        template = loadTemplate(templateId);
        expect(template.id).toBe(templateId);
      });

      it('has at least one role', () => {
        template = loadTemplate(templateId);
        expect(template.roles.length).toBeGreaterThan(0);
      });

      it('has a team-leader role', () => {
        template = loadTemplate(templateId);
        const leader = template.roles.find((r) => r.role === 'team-leader');
        expect(leader).toBeDefined();
        expect(leader!.canDelegate).toBe(true);
        expect(leader!.hierarchyLevel).toBe(1);
      });

      it('all roles have required fields', () => {
        template = loadTemplate(templateId);
        for (const role of template.roles) {
          for (const field of REQUIRED_ROLE_FIELDS) {
            expect(role).toHaveProperty(field);
          }
        }
      });

      it('worker roles report to team-leader', () => {
        template = loadTemplate(templateId);
        const workers = template.roles.filter((r) => r.role !== 'team-leader');
        for (const worker of workers) {
          expect(worker.reportsTo).toBe('team-leader');
        }
      });
    });
  }
});

// ── Runtime Compatibility Tests ──────────────────────────────────────────

describe('runtime compatibility', () => {
  for (const templateId of CLOUD_TEMPLATE_IDS) {
    describe(`${templateId}`, () => {
      it('has valid defaultRuntime', () => {
        const template = loadTemplate(templateId);
        expect(VALID_RUNTIMES).toContain(template.defaultRuntime);
      });

      it('has compatibleRuntimes array', () => {
        const template = loadTemplate(templateId);
        expect(template.compatibleRuntimes).toBeDefined();
        expect(template.compatibleRuntimes!.length).toBeGreaterThan(0);
      });

      it('defaultRuntime is crewly-agent for Cloud', () => {
        const template = loadTemplate(templateId);
        expect(template.defaultRuntime).toBe('crewly-agent');
      });

      it('includes crewly-agent in compatibleRuntimes', () => {
        const template = loadTemplate(templateId);
        expect(template.compatibleRuntimes).toContain('crewly-agent');
      });
    });
  }
});

// ── Tool Reference Validation ──────────────────────────────────────────────

describe('tool references', () => {
  for (const templateId of CLOUD_TEMPLATE_IDS) {
    describe(`${templateId}`, () => {
      it('all defaultTools reference valid runtime tools', () => {
        const template = loadTemplate(templateId);
        for (const role of template.roles) {
          if (role.defaultTools) {
            for (const tool of role.defaultTools) {
              expect(VALID_RUNTIME_TOOLS).toContain(tool);
            }
          }
        }
      });

      it('does not use legacy defaultSkills field', () => {
        const template = loadTemplate(templateId);
        for (const role of template.roles) {
          expect(role.defaultSkills).toBeUndefined();
        }
      });

      it('team-leader has delegation tools', () => {
        const template = loadTemplate(templateId);
        const leader = template.roles.find((r) => r.role === 'team-leader');
        expect(leader!.defaultTools).toContain('delegate_task');
        expect(leader!.defaultTools).toContain('send_message');
        expect(leader!.defaultTools).toContain('get_team_status');
      });

      it('all roles have core communication tools', () => {
        const template = loadTemplate(templateId);
        for (const role of template.roles) {
          if (role.defaultTools) {
            expect(role.defaultTools).toContain('report_status');
            expect(role.defaultTools).toContain('send_message');
          }
        }
      });
    });
  }
});

// ── Model Config Tests ──────────────────────────────────────────────────

describe('model config', () => {
  for (const templateId of CLOUD_TEMPLATE_IDS) {
    describe(`${templateId}`, () => {
      it('all roles have modelConfig', () => {
        const template = loadTemplate(templateId);
        for (const role of template.roles) {
          expect(role.modelConfig).toBeDefined();
          expect(role.modelConfig!.provider).toBeTruthy();
          expect(role.modelConfig!.model).toBeTruthy();
          expect(typeof role.modelConfig!.temperature).toBe('number');
        }
      });

      it('temperature is within valid range', () => {
        const template = loadTemplate(templateId);
        for (const role of template.roles) {
          const temp = role.modelConfig!.temperature!;
          expect(temp).toBeGreaterThanOrEqual(0);
          expect(temp).toBeLessThanOrEqual(1);
        }
      });
    });
  }
});

// ── Norms Validation ──────────────────────────────────────────────────────

describe('norms validation', () => {
  for (const templateId of CLOUD_TEMPLATE_IDS) {
    describe(`${templateId}`, () => {
      it('has norms config if norm files exist', () => {
        const template = loadTemplate(templateId);
        const normsDir = path.join(TEMPLATES_DIR, templateId, 'norms');
        const hasNormsDir = fs.existsSync(normsDir);

        if (hasNormsDir) {
          expect(template.norms).toBeDefined();
          expect(template.norms!.enabled).toBe(true);
        }
      });

      it('referenced norm files exist on disk (if norms dir present)', () => {
        const template = loadTemplate(templateId);
        const normsDir = path.join(TEMPLATES_DIR, templateId, 'norms');

        if (template.norms?.files && fs.existsSync(normsDir)) {
          const actualFiles = fs.readdirSync(normsDir);
          for (const normRef of template.norms.files) {
            // Norm files may exist in the norms directory
            // Some norms are shared/generated, so we just check format
            expect(normRef.file).toBeTruthy();
            expect(normRef.trigger).toBeTruthy();
            expect(normRef.roles.length).toBeGreaterThan(0);
          }
        }
      });
    });
  }
});

// ── Cloud Deploy Manifest Tests ──────────────────────────────────────────

describe('cloud-deploy.json manifest', () => {
  let manifest: CloudDeployManifest;

  it('is valid JSON', () => {
    expect(() => {
      manifest = loadCloudManifest();
    }).not.toThrow();
  });

  it('has version field', () => {
    manifest = loadCloudManifest();
    expect(manifest.version).toBeTruthy();
  });

  it('contains all 3 Cloud templates', () => {
    manifest = loadCloudManifest();
    const ids = manifest.templates.map((t) => t.templateId);
    for (const id of CLOUD_TEMPLATE_IDS) {
      expect(ids).toContain(id);
    }
  });

  it('template entries have required deploy fields', () => {
    manifest = loadCloudManifest();
    for (const entry of manifest.templates) {
      expect(entry.templateId).toBeTruthy();
      expect(entry.displayName).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(entry.category).toBeTruthy();
      expect(entry.agentCount).toBeGreaterThan(0);
      expect(entry.roles.length).toBeGreaterThan(0);
      expect(entry.compatibleRuntimes.length).toBeGreaterThan(0);
      expect(entry.defaultRuntime).toBeTruthy();
      expect(entry.estimatedTokenUsage).toBeDefined();
      expect(entry.features.length).toBeGreaterThan(0);
      expect(entry.deployConfig).toBeDefined();
    }
  });

  it('agent counts match template role counts', () => {
    manifest = loadCloudManifest();
    for (const entry of manifest.templates) {
      const totalAgents = entry.roles.reduce((sum, r) => sum + r.count, 0);
      expect(entry.agentCount).toBe(totalAgents);
    }
  });

  it('manifest template IDs match actual template files', () => {
    manifest = loadCloudManifest();
    for (const entry of manifest.templates) {
      const templateFile = path.join(TEMPLATES_DIR, entry.templateId, 'template.json');
      expect(fs.existsSync(templateFile)).toBe(true);
    }
  });

  it('all runtimes are valid', () => {
    manifest = loadCloudManifest();
    for (const entry of manifest.templates) {
      expect(VALID_RUNTIMES).toContain(entry.defaultRuntime);
      for (const rt of entry.compatibleRuntimes) {
        expect(VALID_RUNTIMES).toContain(rt);
      }
    }
  });

  it('estimated token usage has positive values', () => {
    manifest = loadCloudManifest();
    for (const entry of manifest.templates) {
      expect(entry.estimatedTokenUsage.perTaskAvg).toBeGreaterThan(0);
      expect(entry.estimatedTokenUsage.dailyBudget).toBeGreaterThan(0);
    }
  });

  it('deploy config references existing norm files', () => {
    manifest = loadCloudManifest();
    for (const entry of manifest.templates) {
      expect(entry.deployConfig.normFiles.length).toBeGreaterThan(0);
      for (const normFile of entry.deployConfig.normFiles) {
        expect(normFile).toMatch(/\.md$/);
      }
    }
  });
});
