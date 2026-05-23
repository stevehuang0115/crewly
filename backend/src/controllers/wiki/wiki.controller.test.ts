/**
 * Tests for the wiki REST controller.
 *
 * Strategy: spin up a real express app + a real temp vault, exercise the
 * route end-to-end. Mocking the service would bypass exactly the request
 * validation logic we want to cover.
 *
 * @module controllers/wiki/wiki.controller.test
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import express from 'express';
import request from 'supertest';
import { createWikiRouter } from './wiki.routes.js';
import { WikiIngestService } from '../../services/wiki/wiki-ingest.service.js';
import { WikiQueryService } from '../../services/wiki/wiki-query.service.js';
import { WikiQueueService } from '../../services/wiki/wiki-queue.service.js';

const PROJECT_VAULT_YAML = `
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
  canonical: [team-leader]
  proposed_only: [worker]
  schema_writer: [steve]
`;

describe('wiki.controller — /api/wiki/ingest', () => {
  let app: express.Express;
  let vault: string;

  beforeEach(async () => {
    WikiIngestService._resetForTesting();
    WikiQueryService._resetForTesting();
    // Re-init the queue against a fresh per-test root so cross-test
    // state can't leak. We use the global singleton in production, but
    // tests reset to keep each `describe` block independent.
    const queueRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-wiki-queue-root-'));
    (WikiQueueService as unknown as { instance: WikiQueueService | null }).instance =
      new WikiQueueService(queueRoot);
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-wiki-ctrl-test-'));
    await fs.writeFile(path.join(vault, 'SCHEMA.md'), PROJECT_VAULT_YAML, 'utf8');
    app = express();
    app.use(express.json());
    app.use('/api/wiki', createWikiRouter());
  });

  afterEach(async () => {
    await fs.rm(vault, { recursive: true, force: true });
  });

  it('200s on a happy-path ingest and writes log.md', async () => {
    const res = await request(app)
      .post('/api/wiki/ingest')
      .send({
        vaultPath: vault,
        sourceType: 'user_chat',
        sourceRef: 'msg-1',
        sourceBody: 'A decision was made today.',
        callerSession: 'user/steve',
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.result.pagesWritten).toEqual(['llm-curated/log.md']);

    const written = await fs.readFile(path.join(vault, 'llm-curated/log.md'), 'utf8');
    expect(written).toContain('A decision was made today.');
  });

  it('422s on frozen path with structured outcome', async () => {
    const res = await request(app)
      .post('/api/wiki/ingest')
      .send({
        vaultPath: vault,
        sourceType: 'user_chat',
        sourceRef: 'msg-1',
        sourceBody: 'body',
        targetRelativePath: 'memory/sneaky.md',
      });
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('frozen_path');
    expect(res.body.outcome.frozenFolders).toContain('memory/');
  });

  it('404s when vault SCHEMA.md is missing', async () => {
    await fs.unlink(path.join(vault, 'SCHEMA.md'));
    const res = await request(app)
      .post('/api/wiki/ingest')
      .send({
        vaultPath: vault,
        sourceType: 'user_chat',
        sourceRef: 'msg-1',
        sourceBody: 'body',
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('schema_missing');
  });

  describe('400 on validation failures', () => {
    it('rejects missing vaultPath', async () => {
      const res = await request(app)
        .post('/api/wiki/ingest')
        .send({ sourceType: 'user_chat', sourceRef: 'r', sourceBody: 'b' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/vaultPath/);
    });

    it('rejects invalid sourceType', async () => {
      const res = await request(app)
        .post('/api/wiki/ingest')
        .send({ vaultPath: vault, sourceType: 'mystery', sourceRef: 'r', sourceBody: 'b' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/sourceType/);
    });

    it('rejects non-string sourceBody', async () => {
      const res = await request(app)
        .post('/api/wiki/ingest')
        .send({ vaultPath: vault, sourceType: 'user_chat', sourceRef: 'r', sourceBody: 42 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/sourceBody/);
    });

    it('forwards empty-body refusal as 400', async () => {
      const res = await request(app)
        .post('/api/wiki/ingest')
        .send({ vaultPath: vault, sourceType: 'user_chat', sourceRef: 'r', sourceBody: '   ' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('empty_body');
    });
  });

  describe('/api/wiki/query', () => {
    it('200s and returns a system-context payload for an empty vault', async () => {
      const res = await request(app)
        .post('/api/wiki/query')
        .send({ vaultPath: vault, query: 'pricing decision' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.result.context.vault.scope).toBe('project');
      expect(res.body.result.context.candidatePages).toEqual([]);
      expect(res.body.result.context.callerNotes.length).toBeGreaterThan(0);
    });

    it('rejects missing query with 400', async () => {
      const res = await request(app).post('/api/wiki/query').send({ vaultPath: vault });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/query/);
    });

    it('rejects negative topK with 400', async () => {
      const res = await request(app)
        .post('/api/wiki/query')
        .send({ vaultPath: vault, query: 'x', topK: -1 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/topK/);
    });

    it('404s when SCHEMA.md is missing', async () => {
      await fs.unlink(path.join(vault, 'SCHEMA.md'));
      const res = await request(app)
        .post('/api/wiki/query')
        .send({ vaultPath: vault, query: 'x' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('schema_missing');
    });
  });

  describe('/api/wiki/queue lifecycle', () => {
    const addPayload = () => ({
      vaultPath: vault,
      queuedBy: 'crewly-orc',
      sourceType: 'user_chat',
      sourceRef: 'chat:slack-x:msg-1',
      content: 'Anthropic SMB pilot signed at $799/month',
      reason: 'first paid SMB customer + concrete pricing validation',
    });

    it('201 on /queue add returns item with status=pending', async () => {
      const res = await request(app).post('/api/wiki/queue').send(addPayload());
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.item.status).toBe('pending');
      expect(res.body.item.id).toMatch(/[0-9a-f-]{36}/);
    });

    it('400 when reason missing — agent must justify', async () => {
      const res = await request(app)
        .post('/api/wiki/queue')
        .send({ ...addPayload(), reason: '' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reason/);
    });

    it('GET /queue lists items and filters by status', async () => {
      const a = await request(app).post('/api/wiki/queue').send(addPayload());
      await request(app).post(`/api/wiki/queue/${a.body.item.id}/claim`).send({ claimedBy: 'orc' });
      await request(app).post('/api/wiki/queue').send({ ...addPayload(), sourceRef: 'msg-2' });

      const all = await request(app).get('/api/wiki/queue');
      const pending = await request(app).get('/api/wiki/queue?status=pending');
      const claimed = await request(app).get('/api/wiki/queue?status=claimed');
      expect(all.body.count).toBe(2);
      expect(pending.body.count).toBe(1);
      expect(claimed.body.count).toBe(1);
    });

    it('happy path: add → claim → process', async () => {
      const a = await request(app).post('/api/wiki/queue').send(addPayload());
      const id = a.body.item.id;
      const claim = await request(app)
        .post(`/api/wiki/queue/${id}/claim`)
        .send({ claimedBy: 'crewly-orc' });
      expect(claim.status).toBe(200);
      expect(claim.body.item.status).toBe('claimed');

      const proc = await request(app)
        .post(`/api/wiki/queue/${id}/process`)
        .send({
          ingested: true,
          pagesWritten: ['llm-curated/customers/anthropic.md'],
          targetPath: 'llm-curated/customers/anthropic.md',
          summary: 'merged into existing customer page',
        });
      expect(proc.status).toBe(200);
      expect(proc.body.item.status).toBe('processed');
    });

    it('claim → skip with reason', async () => {
      const a = await request(app).post('/api/wiki/queue').send(addPayload());
      await request(app).post(`/api/wiki/queue/${a.body.item.id}/claim`).send({ claimedBy: 'orc' });
      const sk = await request(app)
        .post(`/api/wiki/queue/${a.body.item.id}/skip`)
        .send({ skipReason: 'duplicate of customers/anthropic.md' });
      expect(sk.status).toBe(200);
      expect(sk.body.item.status).toBe('skipped');
    });

    it('409 on double-claim', async () => {
      const a = await request(app).post('/api/wiki/queue').send(addPayload());
      await request(app).post(`/api/wiki/queue/${a.body.item.id}/claim`).send({ claimedBy: 'orc' });
      const second = await request(app)
        .post(`/api/wiki/queue/${a.body.item.id}/claim`)
        .send({ claimedBy: 'another' });
      expect(second.status).toBe(409);
    });

    it('404 on unknown id', async () => {
      const res = await request(app)
        .post(`/api/wiki/queue/00000000-0000-0000-0000-000000000000/claim`)
        .send({ claimedBy: 'orc' });
      expect(res.status).toBe(404);
    });

    it('GET /queue/stats returns counts', async () => {
      const a = await request(app).post('/api/wiki/queue').send(addPayload());
      await request(app).post('/api/wiki/queue').send({ ...addPayload(), sourceRef: 'b' });
      await request(app).post(`/api/wiki/queue/${a.body.item.id}/claim`).send({ claimedBy: 'orc' });

      const res = await request(app).get(`/api/wiki/queue/stats?vaultPath=${encodeURIComponent(vault)}`);
      expect(res.status).toBe(200);
      expect(res.body.stats).toMatchObject({ pending: 1, claimed: 1, total: 2 });
    });
  });

  describe('/api/wiki/tree (file tree for a vault)', () => {
    beforeEach(async () => {
      await fs.mkdir(path.join(vault, 'llm-curated/customers'), { recursive: true });
      await fs.mkdir(path.join(vault, 'memory'), { recursive: true });
      await fs.writeFile(
        path.join(vault, 'llm-curated/customers/anthropic.md'),
        '# Anthropic\nFirst pilot.',
        'utf8',
      );
      await fs.writeFile(path.join(vault, 'llm-curated/log.md'), '# log', 'utf8');
      await fs.writeFile(path.join(vault, 'memory/notes.md'), '# notes', 'utf8');
    });

    it('returns a sorted file tree with frozen flags', async () => {
      const res = await request(app).get(`/api/wiki/tree?vaultPath=${encodeURIComponent(vault)}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const top = res.body.tree as Array<{ name: string; type: string; frozen?: boolean; children?: Array<{ name: string; relativePath: string }> }>;
      // Directories sorted first
      expect(top[0].type).toBe('directory');
      const memDir = top.find((n) => n.name === 'memory');
      const lmDir = top.find((n) => n.name === 'llm-curated');
      expect(memDir?.frozen).toBe(true);
      expect(lmDir?.frozen).toBeUndefined();
      // llm-curated subtree includes customers/anthropic.md
      const customers = lmDir?.children?.find((c) => c.name === 'customers');
      const ant = (customers as { children?: Array<{ relativePath: string }> })?.children?.find(
        (c) => c.relativePath === 'llm-curated/customers/anthropic.md',
      );
      expect(ant).toBeDefined();
    });

    it('400 on missing vaultPath', async () => {
      const res = await request(app).get('/api/wiki/tree');
      expect(res.status).toBe(400);
    });

    it('404 when vault dir is missing', async () => {
      const res = await request(app).get('/api/wiki/tree?vaultPath=/nowhere/at/all');
      expect(res.status).toBe(404);
    });
  });

  describe('/api/wiki/page (read a single page)', () => {
    beforeEach(async () => {
      await fs.mkdir(path.join(vault, 'llm-curated/customers'), { recursive: true });
      await fs.writeFile(
        path.join(vault, 'llm-curated/customers/anthropic.md'),
        '# Anthropic\n\nFirst SMB pilot at $799/mo.',
        'utf8',
      );
    });

    it('returns the raw markdown', async () => {
      const res = await request(app).get(
        `/api/wiki/page?vaultPath=${encodeURIComponent(vault)}&relativePath=llm-curated/customers/anthropic.md`,
      );
      expect(res.status).toBe(200);
      expect(res.body.content).toContain('First SMB pilot');
    });

    it('rejects non-.md paths', async () => {
      const res = await request(app).get(
        `/api/wiki/page?vaultPath=${encodeURIComponent(vault)}&relativePath=foo.txt`,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/only \.md/);
    });

    it('refuses path-traversal attempts', async () => {
      const res = await request(app).get(
        `/api/wiki/page?vaultPath=${encodeURIComponent(vault)}&relativePath=../../etc/passwd.md`,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/escapes vault root/);
    });

    it('404 for missing page', async () => {
      const res = await request(app).get(
        `/api/wiki/page?vaultPath=${encodeURIComponent(vault)}&relativePath=llm-curated/no-such.md`,
      );
      expect(res.status).toBe(404);
    });
  });
});
