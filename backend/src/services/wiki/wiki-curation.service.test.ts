import * as os from 'os';
import * as path from 'path';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import { WikiCurationService } from './wiki-curation.service.js';
import { WikiIngestService } from './wiki-ingest.service.js';
import { WikiIndexService } from './wiki-index.service.js';
import { parsePage } from './wiki-page.js';

const YAML = `
vault_scope: project
vault_id: t
hardcoded:
  - path: memory/
    frozen: true
    description: "m"
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

let vault: string;
let ingest: WikiIngestService;
let curation: WikiCurationService;
beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-cur-'));
  await fs.writeFile(path.join(vault, 'SCHEMA.md'), YAML);
  WikiIndexService._resetForTesting();
  ingest = new WikiIngestService();
  curation = new WikiCurationService();
});
afterEach(() => fs.rm(vault, { recursive: true, force: true }));

const page = (rel: string, title: string, role?: string, session?: string) =>
  ingest.ingest({ vaultPath: vault, sourceType: 'user_chat', sourceRef: 's', sourceBody: `${title} body`, targetRelativePath: rel, title, summary: `${title} means x`, keepBecause: 'hard_fact', callerRole: role, callerSession: session });

describe('WikiCurationService', () => {
  it('supersede keeps the old page, marks it, hides it in the index line; only canonical roles may', async () => {
    await page('llm-curated/decisions/old.md', 'Old');
    await page('llm-curated/decisions/new.md', 'New');
    expect(await curation.supersede({ vaultPath: vault, oldPath: 'llm-curated/decisions/old.md', newPath: 'llm-curated/decisions/new.md', reason: 'pricing changed', callerRole: 'developer' })).toMatchObject({ ok: false, reason: 'forbidden' });
    const ok = await curation.supersede({ vaultPath: vault, oldPath: 'llm-curated/decisions/old.md', newPath: 'llm-curated/decisions/new.md', reason: 'pricing changed', callerRole: 'team-leader', callerSession: 'tl' });
    expect(ok).toMatchObject({ ok: true });
    const old = parsePage(await fs.readFile(path.join(vault, 'llm-curated/decisions/old.md'), 'utf8'));
    expect(old.frontmatter).toMatchObject({ superseded_by: 'llm-curated/decisions/new.md', superseded_reason: 'pricing changed' });
    expect(old.body).toContain('Old body'); // never deleted
    const index = await fs.readFile(path.join(vault, 'llm-curated/index.md'), 'utf8');
    expect(index).toContain('[Old](llm-curated/decisions/old.md) — Old means x ⟶ superseded by llm-curated/decisions/new.md');
    expect(await curation.supersede({ vaultPath: vault, oldPath: 'llm-curated/decisions/nope.md', newPath: 'llm-curated/decisions/new.md', reason: 'r' })).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('proposals: listed, accepted into place (indexed) or rejected (logged); canonical roles only', async () => {
    await page('llm-curated/decisions/x.md', 'X from worker', 'worker', 'dev-1');
    const list = await curation.listProposals(vault);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ proposedPath: 'llm-curated/_proposed/decisions/x.md', targetPath: 'llm-curated/decisions/x.md', title: 'X from worker', proposedBy: 'dev-1' });
    expect(await curation.acceptProposal({ vaultPath: vault, proposedPath: list[0].proposedPath, callerRole: 'worker' })).toMatchObject({ ok: false, reason: 'forbidden' });

    const accepted = await curation.acceptProposal({ vaultPath: vault, proposedPath: list[0].proposedPath, callerRole: 'team-leader', callerSession: 'tl' });
    expect(accepted).toMatchObject({ ok: true, pagePath: 'llm-curated/decisions/x.md' });
    expect(existsSync(path.join(vault, 'llm-curated/_proposed/decisions/x.md'))).toBe(false);
    const final = parsePage(await fs.readFile(path.join(vault, 'llm-curated/decisions/x.md'), 'utf8'));
    expect(final.frontmatter.proposed_by).toBeUndefined();
    expect(final.frontmatter.title).toBe('X from worker');
    expect(await fs.readFile(path.join(vault, 'llm-curated/index.md'), 'utf8')).toContain('[X from worker](llm-curated/decisions/x.md)');

    await page('llm-curated/decisions/y.md', 'Y', 'worker', 'dev-2');
    const rejected = await curation.rejectProposal({ vaultPath: vault, proposedPath: 'llm-curated/_proposed/decisions/y.md', reason: 'duplicate of x', callerRole: 'orchestrator', callerSession: 'orc' });
    expect(rejected).toEqual({ ok: true });
    expect(await curation.listProposals(vault)).toEqual([]);
    expect(await fs.readFile(path.join(vault, 'llm-curated/log.md'), 'utf8')).toContain('proposal_rejected | orc');
  });

  it('accepting a proposal for an existing page appends to it and snapshots the prior version', async () => {
    await page('llm-curated/decisions/x.md', 'X');
    await page('llm-curated/decisions/x.md', 'X addendum', 'worker', 'dev-1');
    const [p] = await curation.listProposals(vault);
    await curation.acceptProposal({ vaultPath: vault, proposedPath: p.proposedPath, callerRole: 'team-leader' });
    const final = await fs.readFile(path.join(vault, 'llm-curated/decisions/x.md'), 'utf8');
    expect(final).toContain('X body');
    expect(final).toContain('X addendum body');
    const { WikiHistoryService } = await import('./wiki-history.service.js');
    expect((await WikiHistoryService.getInstance().list(vault, 'llm-curated/decisions/x.md')).map((r) => r.action)).toContain('accept_proposal');
  });
});
