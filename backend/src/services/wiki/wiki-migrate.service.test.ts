/**
 * Tests for WikiMigrateService.
 *
 * Uses scratch temp dirs for both project + home. Covers detection,
 * scan, idempotent apply, bootstrap, and collision handling.
 *
 * @module services/wiki/wiki-migrate.service.test
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  WikiMigrateService,
  WIKI_MIGRATE_MANIFEST_FILENAME,
  WIKI_OKR_FOLDER,
} from './wiki-migrate.service.js';

let projectRoot: string;
let homeDir: string;
let svc: WikiMigrateService;

async function write(rel: string, content: string, root: string = projectRoot): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-migrate-project-'));
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-migrate-home-'));
  WikiMigrateService.resetInstance();
  svc = WikiMigrateService.getInstance();
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe('WikiMigrateService input validation', () => {
  it('rejects relative projectRoot', async () => {
    const out = await svc.scan({ projectRoot: 'relative/path' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('invalid_input');
  });

  it('returns project_root_missing for non-existent dir', async () => {
    const out = await svc.scan({
      projectRoot: path.join(os.tmpdir(), 'definitely-not-here-migrate'),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('project_root_missing');
  });
});

describe('WikiMigrateService.scan', () => {
  it('reports legacyDetected=false for a virgin project', async () => {
    const out = await svc.scan({ projectRoot, homeDir });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.legacyDetected).toBe(false);
    expect(out.proposedPages).toEqual([]);
    expect(out.bootstrapNeeded.project).toBe(true);
    expect(out.bootstrapNeeded.global).toBe(true);
  });

  it('proposes a decision page from decisions.json', async () => {
    await write(
      '.crewly/knowledge/decisions.json',
      JSON.stringify([
        {
          id: 'd-1',
          title: 'Locked SMB pricing at $799/mo',
          decision: 'After the Anthropic pilot, lock SMB tier at $799 setup + $799/mo.',
          rationale: 'Anthropic pilot data + margin floor.',
          decidedBy: 'crewly-orc',
          decidedAt: '2026-05-22T16:00:00Z',
          status: 'active',
        },
      ]),
    );
    const out = await svc.scan({ projectRoot, homeDir });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.legacyDetected).toBe(true);
    expect(out.summary.decisions).toBe(1);
    expect(out.proposedPages).toHaveLength(1);
    const p = out.proposedPages[0];
    expect(p.sourceType).toBe('decision');
    expect(p.targetRelativePath).toMatch(
      /^llm-curated\/decisions\/2026-05-22-locked-smb-pricing-at-799-mo\.md$/,
    );
    expect(p.title).toBe('Locked SMB pricing at $799/mo');
    expect(p.skipReason).toBeUndefined();
  });

  it('proposes patterns + gotchas into llm-curated/patterns/', async () => {
    await write(
      '.crewly/knowledge/patterns.json',
      JSON.stringify([
        {
          id: 'p-1',
          category: 'other',
          title: 'AsyncIterator backpressure pattern',
          description: 'Pull-only consumers avoid memory growth.',
          discoveredBy: 'crewly-product-leo',
          createdAt: '2026-04-01T00:00:00Z',
        },
      ]),
    );
    await write(
      '.crewly/knowledge/gotchas.json',
      JSON.stringify([
        {
          id: 'g-1',
          title: 'WS keepalive collision',
          problem: 'Connect storm fires when alarm + manual reconnect race.',
          solution: 'Single ConnectionManager state machine.',
          severity: 'high',
          discoveredBy: 'crewly-arch',
          createdAt: '2026-05-23T00:00:00Z',
        },
      ]),
    );
    const out = await svc.scan({ projectRoot, homeDir });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.summary.patterns).toBe(1);
    expect(out.summary.gotchas).toBe(1);
    const paths = out.proposedPages.map((p) => p.targetRelativePath);
    expect(paths.some((p) => p.startsWith('llm-curated/patterns/'))).toBe(true);
  });

  it('proposes a single learnings.md log import', async () => {
    await write(
      '.crewly/knowledge/learnings.md',
      '## 2026-04-01 — note 1\n\n## 2026-04-02 — note 2\n',
    );
    const out = await svc.scan({ projectRoot, homeDir });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.summary.learnings).toBe(1);
    const log = out.proposedPages.find((p) => p.sourceType === 'learning-log');
    expect(log?.targetRelativePath).toBe('llm-curated/log.md');
  });

  it('proposes loose .md files into llm-curated/decisions/', async () => {
    await write('.crewly/knowledge/2026-05-04-runbook.md', '# Runbook\n\nDeploy steps.\n');
    const out = await svc.scan({ projectRoot, homeDir });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.summary.looseMd).toBe(1);
    const md = out.proposedPages.find((p) => p.sourceType === 'loose-md');
    expect(md?.targetRelativePath).toMatch(
      /^llm-curated\/decisions\/2026-05-04-runbook\.md$/,
    );
  });

  it('flags legacyDetected + proposes pages for a docs-only project (retired Knowledge feature)', async () => {
    // A project whose ONLY legacy store is `.crewly/docs/` (the retired
    // Company-Knowledge feature) must still surface the migrate banner —
    // otherwise that data strands silently after the feature is removed.
    await write(
      '.crewly/docs/business-model.md',
      '# Business Model\n\nPricing, GTM, and the cloud-first plan in detail.\n',
    );
    const out = await svc.scan({ projectRoot, homeDir });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.legacyDetected).toBe(true);
    const doc = out.proposedPages.find(
      (p) => p.sourceFile === '.crewly/docs/business-model.md',
    );
    expect(doc?.targetRelativePath).toMatch(/^llm-curated\/docs\//);
  });

  it('proposes agent memory.json roleKnowledge as memory-entry pages', async () => {
    await write(
      `.crewly/agents/crewly-product-leo-xxx/memory.json`,
      JSON.stringify({
        agentId: 'crewly-product-leo-xxx',
        roleKnowledge: [
          {
            id: 'mem-1',
            category: 'best-practice',
            content: 'Atomic writes guard against state-corruption collapse.',
            createdAt: '2026-05-04T00:00:00Z',
            confidence: 0.3,
          },
          {
            id: 'mem-2',
            category: 'gotcha',
            content: 'jest --forceExit needed when LoggerService.startLogFlusher is live.',
            createdAt: '2026-05-04T00:00:00Z',
          },
        ],
      }),
      homeDir,
    );
    const out = await svc.scan({ projectRoot, homeDir });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.summary.memoryEntries).toBe(2);
    expect(
      out.proposedPages.every(
        (p) => p.sourceType !== 'memory-entry' || p.targetRelativePath.startsWith('llm-curated/patterns/'),
      ),
    ).toBe(true);
  });

  /**
   * Issue #732 — memory-entry pages were proposed by scan but could never be
   * APPLIED: `sourceFile` was built with the platform `path.join` (backslashes
   * on Windows) and then re-parsed with a forward-slash-only regex, so every
   * entry threw `memory_source_unparseable`. Scan-only coverage is what let
   * this ship — these tests exercise the write path.
   */
  it('applies memory-entry pages instead of skipping them as unparseable', async () => {
    await write(
      '.crewly/agents/crewly-product-leo-xxx/memory.json',
      JSON.stringify({
        agentId: 'crewly-product-leo-xxx',
        roleKnowledge: [
          {
            id: 'mem-1',
            category: 'best-practice',
            content: 'Atomic writes guard against state-corruption collapse.',
            createdAt: '2026-05-04T00:00:00Z',
          },
        ],
      }),
      homeDir,
    );

    const out = await svc.apply({ projectRoot, homeDir });
    expect(out.ok).toBe(true);
    if (!out.ok || !('applied' in out)) return;

    const memoryPages = out.proposedPages.filter((p) => p.sourceType === 'memory-entry');
    expect(memoryPages).toHaveLength(1);
    expect(memoryPages[0].skipReason).toBeUndefined();
    expect(out.applied).toBeGreaterThan(0);
  });

  it('re-reads memory sources from the injected homeDir, not the process home', async () => {
    // Before the fix the re-read was hardcoded to os.homedir(), so an
    // overridden `~` (tests, CREWLY_HOME installs) silently read the wrong
    // tree — or nothing at all.
    await write(
      '.crewly/agents/agent-a/memory.json',
      JSON.stringify({
        roleKnowledge: [{ id: 'm-home', category: 'pattern', content: 'Scoped to injected home.' }],
      }),
      homeDir,
    );

    const out = await svc.apply({ projectRoot, homeDir });
    expect(out.ok).toBe(true);
    if (!out.ok || !('applied' in out)) return;

    const page = out.proposedPages.find((p) => p.sourceId === 'm-home');
    expect(page).toBeDefined();
    const written = await fs.readFile(
      path.join(page!.targetVaultPath, page!.targetRelativePath),
      'utf8',
    );
    expect(written).toContain('Scoped to injected home.');
  });

  it('parses a Windows-style sourceFile recorded before the fix', async () => {
    // Windows installs already persisted backslash paths; the parse must heal
    // that existing backlog, not just avoid creating new ones.
    await write(
      '.crewly/agents/win-agent/memory.json',
      JSON.stringify({
        roleKnowledge: [{ id: 'm-win', category: 'pattern', content: 'Recorded on Windows.' }],
      }),
      homeDir,
    );

    const render = (
      svc as unknown as {
        renderForPage: (page: unknown, homeDir: string) => Promise<string>;
      }
    ).renderForPage.bind(svc);

    const body = await render(
      {
        sourceType: 'memory-entry',
        sourceFile: '~\\.crewly\\agents\\win-agent\\memory.json',
        sourceId: 'm-win',
        targetVaultPath: path.join(projectRoot, '.crewly', 'wiki'),
        targetRelativePath: 'llm-curated/patterns/x.md',
      },
      homeDir,
    );

    expect(body).toContain('Recorded on Windows.');
  });

  it('respects includeAgentMemory=false', async () => {
    await write(
      `.crewly/agents/x/memory.json`,
      JSON.stringify({ roleKnowledge: [{ id: 'a', content: 'x', category: 'pattern' }] }),
      homeDir,
    );
    const out = await svc.scan({ projectRoot, homeDir, includeAgentMemory: false });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.summary.memoryEntries).toBe(0);
  });

  it('tags routing_uncertain when content mentions cross-project signals', async () => {
    await write(
      '.crewly/knowledge/decisions.json',
      JSON.stringify([
        {
          id: 'd-cp',
          title: 'OKR rewrite Q3',
          decision: 'Re-anchor company-wide OKR to growth metrics.',
          decidedAt: '2026-05-22T00:00:00Z',
        },
      ]),
    );
    const out = await svc.scan({ projectRoot, homeDir });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.proposedPages[0].routingUncertain).toBe(true);
  });
});

describe('WikiMigrateService.apply', () => {
  it('bootstraps missing vaults', async () => {
    await fs.mkdir(path.join(homeDir, '.crewly', 'teams', 'uuid-1'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(homeDir, '.crewly', 'teams', 'uuid-1', 'config.json'),
      JSON.stringify({ name: 'Test Team' }),
      'utf8',
    );
    const out = await svc.apply({ projectRoot, homeDir });
    expect(out.ok).toBe(true);
    if (!out.ok || !('applied' in out)) return;
    expect(out.bootstrapped.length).toBeGreaterThanOrEqual(3); // project + global + team
    // verify schema files actually exist
    const projectSchema = path.join(projectRoot, '.crewly/wiki/SCHEMA.md');
    const globalSchema = path.join(homeDir, '.crewly/global-wiki/SCHEMA.md');
    const teamSchema = path.join(homeDir, '.crewly/teams/uuid-1/wiki/SCHEMA.md');
    for (const p of [projectSchema, globalSchema, teamSchema]) {
      const raw = await fs.readFile(p, 'utf8');
      expect(raw).toContain('vault_scope:');
    }
    const teamMd = await fs.readFile(teamSchema, 'utf8');
    expect(teamMd).toContain('Test Team');
  });

  it('writes a decision page and records it in the manifest', async () => {
    await write(
      '.crewly/knowledge/decisions.json',
      JSON.stringify([
        {
          id: 'd-write-1',
          title: 'Adopt v2.1',
          decision: 'Three-scope vault + hybrid folders + skill-not-agent.',
          decidedAt: '2026-05-22T00:00:00Z',
        },
      ]),
    );
    const out = await svc.apply({ projectRoot, homeDir });
    expect(out.ok).toBe(true);
    if (!out.ok || !('applied' in out)) return;
    expect(out.applied).toBe(1);
    expect(out.skipped).toBe(0);
    const targetAbs = path.join(projectRoot, '.crewly/wiki', out.proposedPages[0].targetRelativePath);
    const body = await fs.readFile(targetAbs, 'utf8');
    expect(body).toContain('# Adopt v2.1');
    expect(body).toContain('migrated_from:');
    expect(body).toContain('Three-scope vault + hybrid folders');
    const manifestRaw = await fs.readFile(
      path.join(projectRoot, '.crewly/wiki', WIKI_MIGRATE_MANIFEST_FILENAME),
      'utf8',
    );
    const manifest = JSON.parse(manifestRaw) as { entries: { sourceId: string }[] };
    expect(manifest.entries.map((e) => e.sourceId)).toContain('d-write-1');
  });

  it('is idempotent — second apply does nothing new', async () => {
    await write(
      '.crewly/knowledge/decisions.json',
      JSON.stringify([
        { id: 'd-idem-1', title: 'X', decision: 'Y.', decidedAt: '2026-05-22T00:00:00Z' },
      ]),
    );
    const first = await svc.apply({ projectRoot, homeDir });
    expect(first.ok).toBe(true);
    if (!first.ok || !('applied' in first)) return;
    expect(first.applied).toBe(1);

    const second = await svc.apply({ projectRoot, homeDir });
    expect(second.ok).toBe(true);
    if (!second.ok || !('applied' in second)) return;
    expect(second.applied).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.proposedPages[0].skipReason).toBe('already migrated');
  });

  it('appends learnings.md to log.md instead of overwriting', async () => {
    await write('.crewly/knowledge/learnings.md', '## learning 1\n');
    // Pre-populate log.md (as if previous wiki activity).
    await write('.crewly/wiki/llm-curated/log.md', '# Activity log\n\nExisting line.\n');
    await write('.crewly/wiki/SCHEMA.md', 'vault_scope: project\nvault_id: x\nhardcoded: []\n');
    const out = await svc.apply({ projectRoot, homeDir });
    expect(out.ok).toBe(true);
    if (!out.ok || !('applied' in out)) return;
    const log = await fs.readFile(
      path.join(projectRoot, '.crewly/wiki/llm-curated/log.md'),
      'utf8',
    );
    expect(log).toContain('Existing line.');
    expect(log).toContain('learning 1');
  });

  it('resolves filename collisions with -<n> suffix', async () => {
    // Existing page with the slug we'd produce.
    await write('.crewly/wiki/SCHEMA.md', 'vault_scope: project\nvault_id: x\nhardcoded: []\n');
    await write(
      '.crewly/wiki/llm-curated/decisions/2026-05-22-existing.md',
      '# existing — different content\n',
    );
    await write(
      '.crewly/knowledge/decisions.json',
      JSON.stringify([
        {
          id: 'd-coll-1',
          title: 'existing',
          decision: 'New different decision body.',
          decidedAt: '2026-05-22T00:00:00Z',
        },
      ]),
    );
    const out = await svc.apply({ projectRoot, homeDir });
    expect(out.ok).toBe(true);
    if (!out.ok || !('applied' in out)) return;
    expect(out.applied).toBe(1);
    const manifestRaw = await fs.readFile(
      path.join(projectRoot, '.crewly/wiki', WIKI_MIGRATE_MANIFEST_FILENAME),
      'utf8',
    );
    const manifest = JSON.parse(manifestRaw) as {
      entries: { targetRelativePath: string }[];
    };
    const target = manifest.entries[0].targetRelativePath;
    expect(target).toMatch(/2026-05-22-existing-1\.md$/);
  });

  it('preserves legacy files (never deletes)', async () => {
    await write(
      '.crewly/knowledge/decisions.json',
      JSON.stringify([
        { id: 'd-keep', title: 'x', decision: 'y.', decidedAt: '2026-05-22T00:00:00Z' },
      ]),
    );
    await svc.apply({ projectRoot, homeDir });
    const legacyStill = await fs.readFile(
      path.join(projectRoot, '.crewly/knowledge/decisions.json'),
      'utf8',
    );
    expect(legacyStill).toContain('d-keep');
  });
});
describe('WikiMigrateService OKR schema (spec okr-cascade.md §5)', () => {
  it('seeds okr/ in a freshly bootstrapped PROJECT vault schema + dir', async () => {
    const out = await svc.apply({ projectRoot, homeDir });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const schema = await fs.readFile(
      path.join(projectRoot, '.crewly/wiki/SCHEMA.md'),
      'utf8',
    );
    expect(schema).toContain(`- path: ${WIKI_OKR_FOLDER}/`);
    expect(schema).toContain('service:okr-cascade.service');
    expect(schema).toContain('agents read-only');
    // okr/ block must precede llm_curated: (lives under hardcoded:).
    expect(schema.indexOf(`- path: ${WIKI_OKR_FOLDER}/`)).toBeLessThan(
      schema.indexOf('llm_curated:'),
    );
    const stat = await fs.stat(path.join(projectRoot, '.crewly/wiki', WIKI_OKR_FOLDER));
    expect(stat.isDirectory()).toBe(true);
  });

  it('seeds okr/ in a freshly bootstrapped TEAM vault schema + dir', async () => {
    await fs.mkdir(path.join(homeDir, '.crewly', 'teams', 'team-okr'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(homeDir, '.crewly', 'teams', 'team-okr', 'config.json'),
      JSON.stringify({ name: 'OKR Team' }),
      'utf8',
    );
    const out = await svc.apply({ projectRoot, homeDir });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const teamVault = path.join(homeDir, '.crewly/teams/team-okr/wiki');
    const schema = await fs.readFile(path.join(teamVault, 'SCHEMA.md'), 'utf8');
    expect(schema).toContain(`- path: ${WIKI_OKR_FOLDER}/`);
    expect(schema).toContain('service:okr-cascade.service');
    const stat = await fs.stat(path.join(teamVault, WIKI_OKR_FOLDER));
    expect(stat.isDirectory()).toBe(true);
  });
});

describe('WikiMigrateService.ensureOkrFolders (backfill existing vaults)', () => {
  /** Write a legacy PROJECT SCHEMA.md WITHOUT an okr/ block. */
  async function seedLegacyProjectVault(): Promise<string> {
    const vault = path.join(projectRoot, '.crewly', 'wiki');
    await fs.mkdir(path.join(vault, 'memory'), { recursive: true });
    await fs.mkdir(path.join(vault, 'sop-overrides'), { recursive: true });
    await fs.mkdir(path.join(vault, 'llm-curated'), { recursive: true });
    await fs.writeFile(
      path.join(vault, 'SCHEMA.md'),
      [
        'vault_scope: project',
        'vault_id: project',
        '',
        'hardcoded:',
        '  - path: memory/',
        '    frozen: true',
        '    description: "facts"',
        '',
        '  - path: sop-overrides/',
        '    frozen: true',
        '    description: "deltas"',
        '',
        'llm_curated:',
        '  - path: llm-curated/',
        '    frozen: false',
        '',
        'write_policy:',
        '  canonical:',
        '    - team-leader',
        '',
      ].join('\n'),
      'utf8',
    );
    return vault;
  }

  /** Write a legacy TEAM SCHEMA.md WITHOUT an okr/ block. */
  async function seedLegacyTeamVault(uuid: string): Promise<string> {
    const vault = path.join(homeDir, '.crewly', 'teams', uuid, 'wiki');
    await fs.mkdir(path.join(vault, 'sop'), { recursive: true });
    await fs.mkdir(path.join(vault, 'team-norm'), { recursive: true });
    await fs.mkdir(path.join(vault, 'llm-curated'), { recursive: true });
    await fs.writeFile(
      path.join(vault, 'SCHEMA.md'),
      [
        'vault_scope: team',
        `vault_id: ${uuid}`,
        '',
        'hardcoded:',
        '  - path: sop/',
        '    frozen: true',
        '    description: "sops"',
        '',
        '  - path: team-norm/',
        '    frozen: true',
        '    description: "norms"',
        '',
        'llm_curated:',
        '  - path: llm-curated/',
        '    frozen: false',
        '',
      ].join('\n'),
      'utf8',
    );
    return vault;
  }

  it('dry-run reports the missing okr/ block without writing', async () => {
    const vault = await seedLegacyProjectVault();
    const out = await svc.ensureOkrFolders({ projectRoot, homeDir, apply: false });
    expect(out.ok).toBe(true);
    expect(out.changedCount).toBe(1);
    const entry = out.vaults.find((v) => v.scope === 'project');
    expect(entry?.changed).toBe(true);
    // Nothing written in dry-run.
    const schema = await fs.readFile(path.join(vault, 'SCHEMA.md'), 'utf8');
    expect(schema).not.toContain(`- path: ${WIKI_OKR_FOLDER}/`);
    await expect(fs.stat(path.join(vault, WIKI_OKR_FOLDER))).rejects.toThrow();
  });

  it('adds okr/ to an existing PROJECT vault missing it', async () => {
    const vault = await seedLegacyProjectVault();
    const out = await svc.ensureOkrFolders({ projectRoot, homeDir, apply: true });
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.changedCount).toBe(1);
    const schema = await fs.readFile(path.join(vault, 'SCHEMA.md'), 'utf8');
    expect(schema).toContain(`- path: ${WIKI_OKR_FOLDER}/`);
    expect(schema).toContain('service:okr-cascade.service');
    // injected under hardcoded:, before llm_curated:
    expect(schema.indexOf(`- path: ${WIKI_OKR_FOLDER}/`)).toBeLessThan(
      schema.indexOf('llm_curated:'),
    );
    const stat = await fs.stat(path.join(vault, WIKI_OKR_FOLDER));
    expect(stat.isDirectory()).toBe(true);
  });

  it('adds okr/ to an existing TEAM vault missing it', async () => {
    const vault = await seedLegacyTeamVault('legacy-team');
    const out = await svc.ensureOkrFolders({ projectRoot, homeDir, apply: true });
    expect(out.ok).toBe(true);
    const teamEntry = out.vaults.find((v) => v.scope === 'team');
    expect(teamEntry?.changed).toBe(true);
    const schema = await fs.readFile(path.join(vault, 'SCHEMA.md'), 'utf8');
    expect(schema).toContain(`- path: ${WIKI_OKR_FOLDER}/`);
    const stat = await fs.stat(path.join(vault, WIKI_OKR_FOLDER));
    expect(stat.isDirectory()).toBe(true);
  });

  it('is idempotent — a vault already declaring okr/ is unchanged', async () => {
    await seedLegacyProjectVault();
    const first = await svc.ensureOkrFolders({ projectRoot, homeDir, apply: true });
    expect(first.changedCount).toBe(1);
    const vault = path.join(projectRoot, '.crewly', 'wiki');
    const afterFirst = await fs.readFile(path.join(vault, 'SCHEMA.md'), 'utf8');

    const second = await svc.ensureOkrFolders({ projectRoot, homeDir, apply: true });
    expect(second.changedCount).toBe(0);
    const projEntry = second.vaults.find((v) => v.scope === 'project');
    expect(projEntry?.changed).toBe(false);
    const afterSecond = await fs.readFile(path.join(vault, 'SCHEMA.md'), 'utf8');
    expect(afterSecond).toBe(afterFirst);
    // Exactly one okr/ block (no duplication).
    const occurrences = afterSecond.split(`- path: ${WIKI_OKR_FOLDER}/`).length - 1;
    expect(occurrences).toBe(1);
  });

  it('skips vaults that have no SCHEMA.md on disk (bootstrap owns those)', async () => {
    // No project vault created at all.
    const out = await svc.ensureOkrFolders({ projectRoot, homeDir, apply: true });
    expect(out.ok).toBe(true);
    expect(out.vaults).toEqual([]);
    expect(out.changedCount).toBe(0);
  });
});
