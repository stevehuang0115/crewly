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

    it('decisions/<slug>.md gets a decision-page header (title + source block, NOT activity log)', async () => {
      const r = await service.ingest({
        vaultPath: vault,
        sourceType: 'user_chat',
        sourceRef: 'chat:msg-d1',
        sourceBody: 'Pricing locked at $999 setup + $799/month.',
        callerSession: 'user/steve',
        targetRelativePath: 'llm-curated/decisions/2026-05-22-pricing.md',
      });
      expect(r.ok).toBe(true);
      const page = await fs.readFile(
        path.join(vault, 'llm-curated/decisions/2026-05-22-pricing.md'),
        'utf8',
      );
      // Title from the body.
      expect(page).toMatch(/^# Pricing locked/);
      // Provenance block.
      expect(page).toContain('**source:**');
      expect(page).toContain('**caller:**');
      expect(page).toContain('**recorded:**');
      // The "Activity log" preamble belongs to log.md ONLY.
      expect(page).not.toContain('Activity log');
      expect(page).not.toContain('Append-only log');
    });
  });

});
