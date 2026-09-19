/**
 * Tests for WikiIngestService.
 *
 * Strategy: each test stands up a real temp vault (with SCHEMA.md), runs
 * the ingest, and asserts both the JSON outcome and the on-disk file
 * content. Filesystem coverage is intentional — Phase A's whole purpose
 * is to verify the chat→md flow works end-to-end.
 *
 * @module services/wiki/wiki-ingest.service.test
 */

import * as path from 'path';
import * as fsSync from 'fs';
import * as os from 'os';
import * as fs from 'fs/promises';
import { WikiIngestService } from './wiki-ingest.service.js';

const PROJECT_VAULT_YAML = `
vault_scope: project
vault_id: test-project
hardcoded:
  - path: memory/
    frozen: true
    description: "Project memory."
    referenced_by: [skill:remember, skill:recall]
  - path: sop-overrides/
    frozen: true
    description: "Project SOP deltas."
    referenced_by: [skill:get-sops]
llm_curated:
  - path: llm-curated/
    frozen: false
    seed_subdirs: [decisions, people]
    llm_can_create_subdirs: true
    lint_may_restructure: true
write_policy:
  canonical: [team-leader, orchestrator]
  proposed_only: [worker]
  schema_writer: [steve]
`;

describe('WikiIngestService', () => {
  let vault: string;
  let service: WikiIngestService;

  beforeEach(async () => {
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-ingest-test-'));
    await fs.writeFile(path.join(vault, 'SCHEMA.md'), PROJECT_VAULT_YAML, 'utf8');
    service = new WikiIngestService();
  });

  afterEach(async () => {
    await fs.rm(vault, { recursive: true, force: true });
  });

  describe('happy path: append to log.md', () => {
    it('creates llm-curated/log.md on first ingest', async () => {
      const result = await service.ingest({
        vaultPath: vault,
        sourceType: 'user_chat',
        sourceRef: 'chat:msg-1',
        sourceBody: 'Anthropic SMB pricing locked at $999 setup + $799/month.',
        callerSession: 'user/steve',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.pagesWritten).toEqual(['llm-curated/log.md']);

      const written = await fs.readFile(
        path.join(vault, 'llm-curated/log.md'),
        'utf8',
      );
      expect(written).toMatch(/^# Activity log/);
      expect(written).toContain('user_chat | user/steve');
      expect(written).toContain('Anthropic SMB pricing');
      expect(written).toContain('ref: chat:msg-1');
    });

    it('appends subsequent entries without rewriting the header', async () => {
      await service.ingest({
        vaultPath: vault,
        sourceType: 'user_chat',
        sourceRef: 'msg-1',
        sourceBody: 'First message',
        callerSession: 'user/steve',
      });
      await service.ingest({
        vaultPath: vault,
        sourceType: 'user_chat',
        sourceRef: 'msg-2',
        sourceBody: 'Second message',
        callerSession: 'user/steve',
      });

      const written = await fs.readFile(path.join(vault, 'llm-curated/log.md'), 'utf8');
      const headers = written.match(/^# Activity log/gm) ?? [];
      expect(headers).toHaveLength(1);
      expect(written).toContain('First message');
      expect(written).toContain('Second message');
    });

    it('flattens newlines in the source ref + caller, but preserves body newlines', async () => {
      const result = await service.ingest({
        vaultPath: vault,
        sourceType: 'spec_file',
        sourceRef: 'path/with\nnewline.md',
        sourceBody: 'line one\nline two\nline three',
        callerSession: 'caller\nwith\nbreaks',
      });
      expect(result.ok).toBe(true);
      const written = await fs.readFile(path.join(vault, 'llm-curated/log.md'), 'utf8');
      // Header (sourceRef/caller) flattened.
      expect(written).toMatch(/spec_file \| caller with breaks/);
      expect(written).toContain('ref: path/with newline.md');
      // Body multi-line preserved.
      expect(written).toContain('line one\nline two\nline three');
    });

    it('defuses CHAT/NOTIFY/EVENT/ESCALATION markers in body so the wiki log cannot be re-routed', async () => {
      const result = await service.ingest({
        vaultPath: vault,
        sourceType: 'user_chat',
        sourceRef: 'msg-1',
        sourceBody: 'Saw [CHAT] and [NOTIFY] and [EVENT] and [ESCALATION] markers.',
        callerSession: 'user/steve',
      });
      expect(result.ok).toBe(true);
      const written = await fs.readFile(path.join(vault, 'llm-curated/log.md'), 'utf8');
      // Zero-width-space inserted after `[`.
      expect(written).not.toMatch(/(?<!​)\[CHAT\]/);
      expect(written).toContain('[​CHAT]');
      expect(written).toContain('[​ESCALATION]');
    });
  });

  describe('frozen-path refusal', () => {
    it('refuses to write into memory/ (frozen)', async () => {
      const result = await service.ingest({
        vaultPath: vault,
        sourceType: 'user_chat',
        sourceRef: 'msg-1',
        sourceBody: 'attempt to write into frozen folder',
        targetRelativePath: 'memory/sneaky.md',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('frozen_path');
      if (result.reason !== 'frozen_path') return;
      expect(result.attemptedPath).toBe('memory/sneaky.md');
      expect(result.frozenFolders).toContain('memory/');
    });

    it('refuses to write into sop-overrides/ (frozen)', async () => {
      const result = await service.ingest({
        vaultPath: vault,
        sourceType: 'user_chat',
        sourceRef: 'msg-1',
        sourceBody: 'attempt',
        targetRelativePath: 'sop-overrides/foo.md',
      });
      expect(result.ok).toBe(false);
      if (result.ok || result.reason !== 'frozen_path') return;
      expect(result.attemptedPath).toBe('sop-overrides/foo.md');
    });

    it('writes successfully to llm-curated subdirs that are not seed_subdirs', async () => {
      const result = await service.ingest({
        vaultPath: vault,
        sourceType: 'user_chat',
        sourceRef: 'msg-1',
        sourceBody: 'into a fresh sub-folder',
        targetRelativePath: 'llm-curated/fresh/today.md',
        title: 'Fresh',
        summary: 'Fresh folders are fine',
        keepBecause: 'reusable_method',
      });
      expect(result.ok).toBe(true);
      const written = await fs.readFile(
        path.join(vault, 'llm-curated/fresh/today.md'),
        'utf8',
      );
      expect(written).toContain('into a fresh sub-folder');
    });
  });

  describe('input validation', () => {
    it('rejects relative vaultPath', async () => {
      const result = await service.ingest({
        vaultPath: 'relative/path',
        sourceType: 'user_chat',
        sourceRef: 'msg-1',
        sourceBody: 'body',
      });
      expect(result.ok).toBe(false);
      if (result.ok || result.reason !== 'invalid_input') return;
      expect(result.message).toMatch(/absolute/);
    });

    it('rejects empty sourceBody', async () => {
      const result = await service.ingest({
        vaultPath: vault,
        sourceType: 'user_chat',
        sourceRef: 'msg-1',
        sourceBody: '   \n\n  ',
      });
      expect(result.ok).toBe(false);
      if (result.ok || result.reason !== 'empty_body') return;
      expect(result.message).toMatch(/empty/);
    });

    it('rejects oversized body', async () => {
      const big = 'x'.repeat(65 * 1024);
      const result = await service.ingest({
        vaultPath: vault,
        sourceType: 'user_chat',
        sourceRef: 'msg-1',
        sourceBody: big,
      });
      expect(result.ok).toBe(false);
      if (result.ok || result.reason !== 'invalid_input') return;
      expect(result.message).toMatch(/exceeds/);
    });

    it('returns schema_missing when SCHEMA.md is absent', async () => {
      await fs.unlink(path.join(vault, 'SCHEMA.md'));
      const result = await service.ingest({
        vaultPath: vault,
        sourceType: 'user_chat',
        sourceRef: 'msg-1',
        sourceBody: 'body',
      });
      expect(result.ok).toBe(false);
      if (result.ok || result.reason !== 'schema_missing') return;
      expect(result.message).toMatch(/SCHEMA\.md not found/);
    });

    it('rejects missing sourceRef', async () => {
      const result = await service.ingest({
        vaultPath: vault,
        sourceType: 'user_chat',
        sourceRef: '',
        sourceBody: 'body',
      });
      expect(result.ok).toBe(false);
      if (result.ok || result.reason !== 'invalid_input') return;
      expect(result.message).toMatch(/sourceRef/);
    });
  });

  // Note: the earlier detectMessageShape / buildDecisionSlug / ingestDecision
  // keyword-heuristic tests were REMOVED in the 2026-05-22 redesign.
  // Routing into llm-curated/<folder>/<page>.md is now agent-driven via
  // the wiki queue — see WikiQueueService tests for that flow.

  describe('page headers (log.md vs decisions/)', () => {
    it('log.md gets the "Activity log" preamble on first ingest', async () => {
      const r = await service.ingest({
        vaultPath: vault,
        sourceType: 'user_chat',
        sourceRef: 'msg-1',
        sourceBody: 'first entry',
        callerSession: 'user/steve',
      });
      expect(r.ok).toBe(true);
      const log = await fs.readFile(path.join(vault, 'llm-curated/log.md'), 'utf8');
      expect(log).toMatch(/^# Activity log/);
      expect(log).toContain('Append-only log');
    });

    it('a page gets YAML frontmatter (title/summary/keep_because/provenance), an H1, an index line — NOT the activity-log preamble', async () => {
      const r = await service.ingest({
        vaultPath: vault,
        sourceType: 'user_chat',
        sourceRef: 'chat:msg-d1',
        sourceBody: 'Pricing locked at $999 setup + $799/month.',
        callerSession: 'user/steve',
        targetRelativePath: 'llm-curated/decisions/2026-05-22-pricing.md',
        title: 'Pricing locked',
        summary: 'Setup $999 + $799/mo is final for 2026',
        keepBecause: 'changes_decision',
        tags: ['pricing'],
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.proposed).toBe(false);
      expect(r.indexUpdated).toBe(true);
      const page = await fs.readFile(path.join(vault, 'llm-curated/decisions/2026-05-22-pricing.md'), 'utf8');
      expect(page.startsWith('---\ntitle: Pricing locked\nsummary: Setup $999 + $799/mo is final for 2026\nkeep_because: changes_decision\n')).toBe(true);
      expect(page).toContain('source: chat:msg-d1');
      expect(page).toContain('caller: user/steve');
      expect(page).toMatch(/recorded: \d{4}-/);
      expect(page).toContain('\n# Pricing locked\n');
      expect(page).toContain('Pricing locked at $999');
      expect(page).not.toContain('Activity log');
      const index = await fs.readFile(path.join(vault, 'llm-curated/index.md'), 'utf8');
      expect(index).toContain('- [Pricing locked](llm-curated/decisions/2026-05-22-pricing.md) — Setup $999 + $799/mo is final for 2026');
    });
  });

  describe('retention gate (default is to NOT keep)', () => {
    it('refuses a page without summary/keep_because and points at log.md', async () => {
      const r = await service.ingest({
        vaultPath: vault,
        sourceType: 'record_learning',
        sourceRef: 'mem:1',
        sourceBody: 'Ran tests today',
        targetRelativePath: 'llm-curated/patterns/today.md',
      });
      expect(r.ok).toBe(false);
      if (r.ok || r.reason !== 'retention_gate') return;
      expect(r.details).toEqual(['summary', expect.stringContaining('keep_because')]);
      expect(r.message).toContain('log.md');
      expect(fsSync.existsSync(path.join(vault, 'llm-curated/patterns/today.md'))).toBe(false);
    });

    it('log.md never needs the gate', async () => {
      const r = await service.ingest({ vaultPath: vault, sourceType: 'record_learning', sourceRef: 'mem:2', sourceBody: 'maybe useful' });
      expect(r.ok).toBe(true);
    });

    it('appending to an existing page inherits its frontmatter; replace rewrites the body', async () => {
      const base = { vaultPath: vault, sourceType: 'user_chat' as const, targetRelativePath: 'llm-curated/decisions/p.md' };
      await service.ingest({ ...base, sourceRef: 's1', sourceBody: 'first', title: 'P', summary: 'sum', keepBecause: 'hard_fact' });
      const appended = await service.ingest({ ...base, sourceRef: 's2', sourceBody: 'second' });
      expect(appended.ok).toBe(true);
      let page = await fs.readFile(path.join(vault, base.targetRelativePath), 'utf8');
      expect(page).toContain('first');
      expect(page).toContain('second');
      const replaced = await service.ingest({ ...base, sourceRef: 's3', sourceBody: 'only this', summary: 'new sum', replace: true });
      expect(replaced.ok).toBe(true);
      page = await fs.readFile(path.join(vault, base.targetRelativePath), 'utf8');
      expect(page).not.toContain('first');
      expect(page).toContain('summary: new sum');
      // History kept the prior versions with author + action.
      const { WikiHistoryService } = await import('./wiki-history.service.js');
      const revs = await WikiHistoryService.getInstance().list(vault, base.targetRelativePath);
      expect(revs.map((x) => x.action)).toEqual(['write', 'write']);
    });
  });

  describe('confidentiality gate', () => {
    it('refuses a body carrying a credential, naming the pattern only', async () => {
      const r = await service.ingest({ vaultPath: vault, sourceType: 'slack_message', sourceRef: 's', sourceBody: `token is xoxb-${'1234567890-9876543210-abcdefghijkl'}` });
      expect(r).toMatchObject({ ok: false, reason: 'secret_detected', details: ['slack_token'] });
      expect(fsSync.existsSync(path.join(vault, 'llm-curated/log.md'))).toBe(false);
    });

    it('applies the vault privacy policy to PII (refuse / mask)', async () => {
      await fs.writeFile(path.join(vault, 'SCHEMA.md'), PROJECT_VAULT_YAML + '\nprivacy:\n  pii: mask\n', 'utf8');
      const r = await service.ingest({ vaultPath: vault, sourceType: 'slack_message', sourceRef: 's', sourceBody: 'parent mail a@b.co' });
      expect(r).toMatchObject({ ok: true, masked: ['email'] });
      expect(await fs.readFile(path.join(vault, 'llm-curated/log.md'), 'utf8')).toContain('parent mail [email]');
      await fs.writeFile(path.join(vault, 'SCHEMA.md'), PROJECT_VAULT_YAML + '\nprivacy:\n  pii: refuse\n', 'utf8');
      const refused = await service.ingest({ vaultPath: vault, sourceType: 'slack_message', sourceRef: 's', sourceBody: 'call 415-555-1234' });
      expect(refused).toMatchObject({ ok: false, reason: 'pii_refused' });
    });
  });

  describe('write policy', () => {
    it('a proposed_only role lands in _proposed/ (no index line); a canonical role writes directly', async () => {
      const base = { vaultPath: vault, sourceType: 'user_chat' as const, sourceRef: 's', sourceBody: 'b', title: 'T', summary: 'S', keepBecause: 'hard_fact' as const, targetRelativePath: 'llm-curated/decisions/x.md' };
      const worker = await service.ingest({ ...base, callerRole: 'developer', callerSession: 'dev-1' });
      expect(worker).toMatchObject({ ok: true, proposed: true, pagesWritten: ['llm-curated/_proposed/decisions/x.md'], indexUpdated: false });
      const proposedPage = await fs.readFile(path.join(vault, 'llm-curated/_proposed/decisions/x.md'), 'utf8');
      expect(proposedPage).toContain('proposed_by: dev-1');
      const tl = await service.ingest({ ...base, callerRole: 'team-leader' });
      expect(tl).toMatchObject({ ok: true, proposed: false, pagesWritten: ['llm-curated/decisions/x.md'] });
      expect(fsSync.existsSync(path.join(vault, 'llm-curated/decisions/x.md'))).toBe(true);
    });
  });

});
