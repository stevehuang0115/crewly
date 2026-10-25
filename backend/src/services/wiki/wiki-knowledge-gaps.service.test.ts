/**
 * Tests for WikiKnowledgeGapsService (#914 P1): zero-hit queries → a weekly
 * gap page and one review WorkItem for the team lead.
 *
 * @module services/wiki/wiki-knowledge-gaps.service.test
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { WikiKnowledgeGapsService, gapKey, rollupGaps, vaultKind, vaultLabel, type KnowledgeGapsPool } from './wiki-knowledge-gaps.service.js';
import { WikiIngestService } from './wiki-ingest.service.js';
import { WikiIndexService } from './wiki-index.service.js';
import { WikiUsageService, type WikiUsageEvent } from './wiki-usage.service.js';
import { parsePage } from './wiki-page.js';
import { WIKI_GAPS_CONSTANTS } from '../../constants.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

const SCHEMA = `
vault_scope: project
vault_id: test-project
hardcoded:
  - path: memory/
    frozen: true
    description: "Project memory."
    referenced_by: [skill:remember]
llm_curated:
  - path: llm-curated/
    frozen: false
    seed_subdirs: [decisions]
    llm_can_create_subdirs: true
    lint_may_restructure: true
write_policy:
  canonical: [team-leader, orchestrator]
  proposed_only: [worker]
  schema_writer: [steve]
`;

const NOW = Date.parse('2026-10-21T12:00:00.000Z'); // Wednesday, ISO week 43
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function ev(ageHours: number, query: string, hits: string[], agent = 'kai', via = 'recall'): WikiUsageEvent {
  return { at: new Date(NOW - ageHours * HOUR).toISOString(), via, agent, query, hits, miss: hits.length === 0 };
}

describe('gapKey', () => {
  it('folds case, whitespace and trailing punctuation', () => {
    expect(gapKey('  Refund   Policy? ')).toBe('refund policy');
    expect(gapKey('退款政策。')).toBe('退款政策');
    expect(gapKey('refund policy')).toBe(gapKey('REFUND POLICY!!'));
  });
});

describe('vaultKind', () => {
  it('tells global, team and project vaults apart', () => {
    expect(vaultKind('/Users/x/.crewly/global-wiki')).toBe('global');
    expect(vaultKind('/Users/x/.crewly/teams/team-123/wiki')).toBe('team');
    expect(vaultKind('/Users/x/projects/crewly/.crewly/wiki')).toBe('project');
    expect(vaultKind('/tmp/somewhere')).toBe('project');
  });
});

describe('vaultLabel', () => {
  it('names the project, team or global vault', () => {
    expect(vaultLabel('/Users/x/projects/crewly/.crewly/wiki')).toBe('crewly');
    expect(vaultLabel('/Users/x/.crewly/teams/team-123/wiki')).toBe('team-123');
    expect(vaultLabel('/Users/x/.crewly/global-wiki')).toBe('global');
  });
});

describe('rollupGaps', () => {
  it('groups misses by normalised query, counts, ranks and attributes them', () => {
    const r = rollupGaps([
      ev(30, 'Refund policy', []),
      ev(20, 'refund policy?', [], 'mia'),
      ev(10, 'REFUND POLICY', [], 'kai', 'wiki-query'),
      ev(25, 'who owns the release', [], 'orc'),
      ev(5, 'pricing', ['llm-curated/decisions/pricing.md']),
    ]);
    expect(r).toMatchObject({ queries: 5, misses: 4, distinct: 2, pastedText: 0, answeredLater: 0 });
    expect(r.gaps[0]).toMatchObject({ query: 'Refund policy', count: 3, agents: ['kai', 'mia'], via: ['recall', 'wiki-query'] });
    expect(r.gaps[0].firstAt).toBe(new Date(NOW - 30 * HOUR).toISOString());
    expect(r.gaps[0].lastAt).toBe(new Date(NOW - 10 * HOUR).toISOString());
    expect(r.gaps[1]).toMatchObject({ query: 'who owns the release', count: 1, agents: ['orc'] });
  });

  it('counts only explicit misses: no hits with miss=false means another vault answered', () => {
    const r = rollupGaps([
      { ...ev(5, 'answered elsewhere', []), miss: false },
      ev(4, 'real gap', []),
    ]);
    expect(r).toMatchObject({ queries: 2, misses: 1, distinct: 1 });
    expect(r.gaps[0].query).toBe('real gap');
  });

  it('drops a question the vault answered later, keeps one answered before the miss', () => {
    const r = rollupGaps([
      ev(30, 'relay queue id', []),
      ev(20, 'relay queue id', ['llm-curated/gotchas/relay.md']), // page written after the miss
      ev(30, 'okr cascade', ['llm-curated/docs/okr.md']),
      ev(10, 'okr cascade', []), // the later miss stands
    ]);
    expect(r.answeredLater).toBe(1);
    expect(r.gaps.map((g) => g.query)).toEqual(['okr cascade']);
  });

  it('ignores stray tokens, counts pasted text without listing it, and caps the list', () => {
    const events: WikiUsageEvent[] = [
      ev(1, 'a', []),
      ev(1, 'x'.repeat(WIKI_GAPS_CONSTANTS.QUERY_MAX_CHARS + 1), []),
      ev(1, '', []),
    ];
    for (let i = 0; i < WIKI_GAPS_CONSTANTS.MAX_GAPS_PER_PAGE + 5; i++) events.push(ev(i + 2, `question number ${i}`, []));
    const r = rollupGaps(events);
    expect(r.misses).toBe(events.length);
    expect(r.pastedText).toBe(1);
    expect(r.distinct).toBe(WIKI_GAPS_CONSTANTS.MAX_GAPS_PER_PAGE + 5);
    expect(r.gaps).toHaveLength(WIKI_GAPS_CONSTANTS.MAX_GAPS_PER_PAGE);
    // Equal counts: most recent first.
    expect(r.gaps[0].query).toBe('question number 0');
  });
});

describe('WikiKnowledgeGapsService', () => {
  let vault: string;
  let added: WorkItem[];
  let pool: KnowledgeGapsPool;
  let awake: boolean;

  beforeEach(async () => {
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-gaps-test-'));
    await fs.writeFile(path.join(vault, 'SCHEMA.md'), SCHEMA, 'utf8');
    await fs.mkdir(path.join(vault, 'llm-curated'), { recursive: true });
    added = [];
    pool = { addToPool: async (wi) => { added.push(wi); } };
    awake = true;
  });

  afterEach(async () => {
    await fs.rm(vault, { recursive: true, force: true });
    WikiKnowledgeGapsService._resetForTesting();
  });

  function service(opts: { pool?: KnowledgeGapsPool | null; resolveTarget?: boolean; labelFor?: (v: string) => Promise<string | null> } = {}): WikiKnowledgeGapsService {
    return new WikiKnowledgeGapsService({
      ingest: new WikiIngestService(),
      pool: opts.pool === null ? undefined : opts.pool ?? pool,
      resolveTarget: opts.resolveTarget === false ? undefined : async () => 'crewly-acme-lead-1234',
      isTargetAwake: async () => awake,
      labelFor: opts.labelFor,
    });
  }

  async function writeUsage(events: WikiUsageEvent[], at: string = vault): Promise<void> {
    const usage = new WikiUsageService();
    const file = usage.ledgerPath(at);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }

  /** A sibling vault whose path makes it a global or team vault. */
  async function siblingVault(rel: string): Promise<string> {
    const v = path.join(vault, rel);
    await fs.mkdir(path.join(v, 'llm-curated'), { recursive: true });
    await fs.writeFile(path.join(v, 'SCHEMA.md'), SCHEMA, 'utf8');
    return v;
  }

  it('reports no_queries without a ledger and no_gaps when every query hit, writing nothing', async () => {
    expect(await service().compile(vault, { now: NOW })).toMatchObject({ compiled: false, reason: 'no_queries', week: '2026-W43' });
    await writeUsage([ev(2, 'pricing', ['llm-curated/decisions/pricing.md'])]);
    expect(await service().compile(vault, { now: NOW })).toMatchObject({ compiled: false, reason: 'no_gaps' });
    expect(existsSync(path.join(vault, WIKI_GAPS_CONSTANTS.DIR))).toBe(false);
    expect(existsSync(path.join(vault, WIKI_GAPS_CONSTANTS.STATE_FILE))).toBe(false);
    expect(added).toHaveLength(0);
  });

  it('writes the week page, indexes it, hands the lead one WorkItem, and is quiet for the rest of the week', async () => {
    await writeUsage([
      ev(40, 'refund policy', []),
      ev(20, 'Refund policy', [], 'mia'),
      ev(30, 'who owns the release', [], 'orc', 'wiki-query'),
      ev(10, 'pricing', ['llm-curated/decisions/pricing.md']),
      ev(10 * 24, 'outside the window', []),
    ]);
    const svc = service();
    const r = await svc.compile(vault, { now: NOW });
    expect(r).toMatchObject({ compiled: true, pagePath: 'llm-curated/gaps/2026-W43.md', target: 'crewly-acme-lead-1234' });
    expect(r.rollup).toMatchObject({ queries: 4, misses: 3, distinct: 2 });

    const page = parsePage(await fs.readFile(path.join(vault, r.pagePath!), 'utf8'));
    expect(page.frontmatter.title).toBe('Knowledge gaps 2026-W43');
    expect(page.frontmatter.keep_because).toBe('changes_decision');
    expect(page.frontmatter.summary).toContain('2 questions');
    expect(page.frontmatter.tags).toEqual(['knowledge-gaps', '2026-W43']);
    expect(page.body).toContain('## Compiled 2026-10-21 — 4 queries in 7 days, 3 found nothing, 2 distinct gaps');
    expect(page.body).toContain('- **refund policy** — asked 2× by kai, mia; last 2026-10-20 via recall');
    expect(page.body).toContain('- **who owns the release** — asked once by orc; last 2026-10-20 via wiki-query');
    expect(page.body).not.toContain('outside the window');
    expect(page.body).toContain("never post this list");

    const index = await WikiIndexService.getInstance().read(vault);
    expect(index.entries.map((e) => e.relativePath)).toContain('llm-curated/gaps/2026-W43.md');

    expect(added).toHaveLength(1);
    const wi = added[0];
    expect(r.workItemId).toBe(wi.id);
    expect(wi).toMatchObject({ type: 'delegate', owner: 'team_lead', target: 'crewly-acme-lead-1234', status: 'queued' });
    expect(wi.title).toBe(`Review knowledge gaps 2026-W43 — ${path.basename(vault)} (2 unanswered questions)`);
    expect(wi.briefMarkdown).toContain('- **refund policy**');
    expect(wi.metadata).toMatchObject({ kind: 'wiki-knowledge-gaps', week: '2026-W43', gaps: 2, autoCreated: true, vaultPath: vault });

    const state = JSON.parse(await fs.readFile(path.join(vault, WIKI_GAPS_CONSTANTS.STATE_FILE), 'utf8')) as { lastWeek: string; workItemId: string };
    expect(state).toMatchObject({ lastWeek: '2026-W43', workItemId: wi.id });

    // Same week, next daily pass: nothing.
    expect(await svc.compile(vault, { now: NOW + DAY })).toMatchObject({ compiled: false, reason: 'not_due' });
    expect(added).toHaveLength(1);

    // Forced re-run in the same week replaces the page and raises no second WorkItem.
    await writeUsage([ev(1, 'refund policy', []), ev(1, 'new gap', [], 'leo')]);
    const again = await svc.compile(vault, { now: NOW + DAY, force: true });
    expect(again).toMatchObject({ compiled: true, workItemSkipped: 'already_raised' });
    const replaced = parsePage(await fs.readFile(path.join(vault, again.pagePath!), 'utf8'));
    expect(replaced.body.match(/## Compiled/g)).toHaveLength(1);
    expect(replaced.body).toContain('- **new gap**');
    expect(replaced.body).not.toContain('who owns the release');
    expect(added).toHaveLength(1);
  });

  it('writes the page but raises no WorkItem for a dormant lead, then raises it when the lead is back', async () => {
    await writeUsage([ev(2, 'refund policy', [])]);
    awake = false;
    const svc = service();
    const r = await svc.compile(vault, { now: NOW });
    expect(r).toMatchObject({ compiled: true, workItemSkipped: 'target_dormant' });
    expect(r.workItemId).toBeUndefined();
    expect(added).toHaveLength(0);

    awake = true;
    const later = await svc.compile(vault, { now: NOW + DAY, force: true });
    expect(later.workItemId).toBeDefined();
    expect(added).toHaveLength(1);
  });

  it('only the global vault falls back to the orchestrator; a project vault without a lead gets the page and no WorkItem', async () => {
    const global = await siblingVault('.crewly/global-wiki');
    await writeUsage([ev(2, 'refund policy', [])], global);
    const orc = await service({ resolveTarget: false }).compile(global, { now: NOW });
    expect(orc).toMatchObject({ compiled: true, target: 'crewly-orc' });
    expect(added[0]).toMatchObject({ owner: 'orchestrator', target: 'crewly-orc' });
    expect(added[0].title).toContain('— global (');

    await writeUsage([ev(2, 'refund policy', [])]);
    const noLead = await service({ resolveTarget: false }).compile(vault, { now: NOW });
    expect(noLead).toMatchObject({ compiled: true, workItemSkipped: 'no_lead' });
    expect(noLead.target).toBeUndefined();
    expect(existsSync(path.join(vault, 'llm-curated/gaps/2026-W43.md'))).toBe(true);
    expect(added).toHaveLength(1);

    await fs.rm(path.join(vault, WIKI_GAPS_CONSTANTS.STATE_FILE));
    const noPool = await service({ pool: null }).compile(vault, { now: NOW, force: true });
    expect(noPool).toMatchObject({ compiled: true, workItemSkipped: 'no_pool' });
    expect(added).toHaveLength(1);
  });

  it('a team vault is built from wiki-query rows only: recall echoes of a cross-vault search are not its gaps', async () => {
    const team = await siblingVault('.crewly/teams/team-abc/wiki');
    await writeUsage([
      ev(5, 'who owns the release', [], 'orc', 'recall'),
      ev(4, 'pricing tiers', [], 'orc', 'recall'),
    ], team);
    expect(await service().compile(team, { now: NOW })).toMatchObject({ compiled: false, reason: 'no_queries' });
    expect(existsSync(path.join(team, WIKI_GAPS_CONSTANTS.DIR))).toBe(false);

    await writeUsage([
      ev(5, 'who owns the release', [], 'orc', 'recall'),
      ev(3, 'team onboarding checklist', [], 'kai', 'wiki-query'),
    ], team);
    const r = await service({ labelFor: async () => 'Acme Studio' }).compile(team, { now: NOW });
    expect(r).toMatchObject({ compiled: true });
    expect(r.rollup).toMatchObject({ queries: 1, misses: 1, distinct: 1 });
    expect(r.rollup.gaps[0].query).toBe('team onboarding checklist');
    expect(added[0].title).toBe('Review knowledge gaps 2026-W43 — Acme Studio (1 unanswered question)');

    // A project vault keeps its recall misses.
    await writeUsage([ev(5, 'who owns the release', [], 'orc', 'recall')]);
    expect((await service().compile(vault, { now: NOW })).rollup.distinct).toBe(1);
  });

  it('dry run plans the page and the target but writes nothing', async () => {
    await writeUsage([ev(2, 'refund policy', [])]);
    const r = await service().compile(vault, { now: NOW, dryRun: true });
    expect(r).toMatchObject({ compiled: true, dryRun: true, pagePath: 'llm-curated/gaps/2026-W43.md', target: 'crewly-acme-lead-1234', workItemSkipped: 'dry_run' });
    expect(existsSync(path.join(vault, WIKI_GAPS_CONSTANTS.DIR))).toBe(false);
    expect(existsSync(path.join(vault, WIKI_GAPS_CONSTANTS.STATE_FILE))).toBe(false);
    expect(added).toHaveLength(0);
  });

  it('compileAll keeps going when one vault throws', async () => {
    await writeUsage([ev(2, 'refund policy', [])]);
    const broken = { ingest: async () => { throw new Error('disk'); } } as unknown as WikiIngestService;
    const svc = new WikiKnowledgeGapsService({ ingest: broken, pool });
    const results = await svc.compileAll([vault, path.join(vault, 'missing')], { now: NOW });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ compiled: false, reason: 'no_queries' });
  });
});
