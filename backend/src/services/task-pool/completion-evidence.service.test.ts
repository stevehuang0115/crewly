/**
 * Tests for the completion evidence decision (#873).
 *
 * Uses a real temp directory for artifact existence, so the default
 * filesystem check is exercised too.
 *
 * @module services/task-pool/completion-evidence.service.test
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { COMPLETION_EVIDENCE_CONSTANTS } from '../../constants.js';
import {
  artifactBaseDirs,
  artifactNotBefore,
  blockedReason,
  decideCompletion,
  describeDecisionsForReviewer,
  describeEvidenceForReviewer,
  recheckArtifacts,
  decideReviewAccept,
  resolveEvidenceEnforcementMode,
  evidenceRequiredFor,
} from './completion-evidence.service.js';

const CODES = COMPLETION_EVIDENCE_CONSTANTS.CODES;

describe('resolveEvidenceEnforcementMode', () => {
  it('defaults to the constant (enforce since #1312)', () => {
    expect(COMPLETION_EVIDENCE_CONSTANTS.EVIDENCE_ENFORCEMENT_MODE).toBe('enforce');
    expect(resolveEvidenceEnforcementMode({})).toBe('enforce');
  });

  it('honours CREWLY_EVIDENCE_MODE, case-insensitively', () => {
    expect(resolveEvidenceEnforcementMode({ CREWLY_EVIDENCE_MODE: 'enforce' })).toBe('enforce');
    expect(resolveEvidenceEnforcementMode({ CREWLY_EVIDENCE_MODE: ' ENFORCE ' })).toBe('enforce');
    expect(resolveEvidenceEnforcementMode({ CREWLY_EVIDENCE_MODE: 'warn' })).toBe('warn');
  });

  it('ignores an unknown value', () => {
    expect(resolveEvidenceEnforcementMode({ CREWLY_EVIDENCE_MODE: 'strict' })).toBe('enforce');
  });
});

describe('evidenceRequiredFor (#1312)', () => {
  it('deliverables and untyped items need evidence; bookkeeping types do not', () => {
    for (const t of ['delegate', 'project_task', 'review', undefined, null, '']) expect(evidenceRequiredFor(t)).toBe(true);
    for (const t of ['goal_replan', 'ticket_triage', 'autopilot_retro', 'notify', 'reconcile']) expect(evidenceRequiredFor(t)).toBe(false);
  });
});

describe('artifactBaseDirs', () => {
  it('orders worktree workdir, worktree root, then projectPath, without duplicates', () => {
    expect(artifactBaseDirs({
      metadata: { worktree: { workdir: '/r/wt/app', path: '/r/wt' }, projectPath: '/r' },
    })).toEqual(['/r/wt/app', '/r/wt', '/r']);
    expect(artifactBaseDirs({ metadata: { worktree: { workdir: '/r', path: '/r' } } })).toEqual(['/r']);
  });

  it('ignores relative or non-string values and a missing item', () => {
    expect(artifactBaseDirs({ metadata: { projectPath: 'rel/dir', worktree: 'x' } })).toEqual([]);
    expect(artifactBaseDirs(null)).toEqual([]);
  });
});

describe('blockedReason', () => {
  it('names each step', () => {
    expect(blockedReason([
      { type: 'blocked', step: 'npm test', reason: 'db down' },
      { type: 'blocked', step: 'deploy', reason: 'no creds' },
    ])).toBe('Blocked at "npm test": db down; Blocked at "deploy": no creds');
  });
});

describe('recheckArtifacts (#1315)', () => {
  const present = { isDirectory: false, sizeBytes: 10, mtimeMs: 1 };
  const statOf = (existing: Record<string, { isDirectory: boolean; sizeBytes: number; mtimeMs: number }>) =>
    async (p: string) => existing[p] ?? null;

  it('reports each local artifact that is gone or empty, resolving relative paths against the WorkItem', async () => {
    const wi = {
      metadata: { projectPath: '/proj' },
      output: { evidence: [
        { type: 'artifact', path: '/abs/kept.md' },
        { type: 'artifact', path: '/abs/gone.md' },
        { type: 'artifact', path: 'out/empty.md' },
        { type: 'artifact', path: 'https://example.com/pr/1' },
        { type: 'command', command: 'npm test', exitCode: 0 },
      ] },
    };
    const out = await recheckArtifacts(wi, { statPath: statOf({ '/abs/kept.md': present, '/proj/out/empty.md': { ...present, sizeBytes: 0 } }), homeDir: '/home/x' });
    expect(out.map((d) => d.artifact)).toEqual(['/abs/gone.md', 'out/empty.md']);
    expect(out[0].problem).toContain('does not exist');
    expect(out[1].problem).toContain('empty');
  });

  it('does not apply the age check: an old but present file holds', async () => {
    const out = await recheckArtifacts({ metadata: {}, output: { evidence: [{ type: 'artifact', path: '/abs/old.md' }] } }, { statPath: statOf({ '/abs/old.md': { ...present, mtimeMs: 0 } }), homeDir: '/h' });
    expect(out).toEqual([]);
  });

  it.each([undefined, {}, { evidence: 'nope' }, { evidence: [] }])('is empty for no usable evidence: %j', async (output) => {
    expect(await recheckArtifacts({ metadata: {}, output: output as Record<string, unknown> | undefined }, { statPath: async () => null, homeDir: '/h' })).toEqual([]);
  });
});

describe('describeDecisionsForReviewer (#875)', () => {
  it('lists decisions, roads not taken and assumptions under their headings', () => {
    const d = describeDecisionsForReviewer({
      decisions: ['Kept the v1 schema', 'Used BM25 over embeddings'],
      notTaken: 'A new table — would need a migration the owner has not approved',
      assumptions: ['The relay is on 1.5.24'],
    });
    expect(d).toMatch(/^Worker's record/);
    expect(d).toContain('Decisions:\n  - Kept the v1 schema\n  - Used BM25 over embeddings');
    expect(d).toContain('Not taken:\n  - A new table — would need a migration');
    expect(d).toContain('Assumptions:\n  - The relay is on 1.5.24');
  });

  it('caps each list and trims long entries', () => {
    const d = describeDecisionsForReviewer({ decisions: Array.from({ length: 7 }, (_, i) => `d${i} ${'x'.repeat(400)}`) });
    expect(d).toContain('d4');
    expect(d).not.toContain('d5');
    expect(d).toContain('and 2 more');
    expect(d.split('\n')[1].length).toBeLessThanOrEqual(300 + 4);
  });

  it.each([undefined, {}, { decisions: [] }, { decisions: 7 }, { notTaken: ['', '  '] }, { evidence: [{ type: 'artifact', path: '/a' }] }])(
    'is empty when the worker recorded nothing usable: %j',
    (output) => {
      expect(describeDecisionsForReviewer(output as Record<string, unknown> | undefined)).toBe('');
    },
  );
});

describe('describeEvidenceForReviewer', () => {
  it('counts artifacts and commands', () => {
    expect(describeEvidenceForReviewer({ evidence: [
      { type: 'artifact', path: '/a' },
      { type: 'artifact', path: 'https://x' },
      { type: 'command', command: 'npm test', exitCode: 0 },
    ] })).toMatch(/^Evidence: 2 artifact\(s\), 1 command\(s\)/);
  });

  it('numbers each entry so checks can name it, and caps the list (#1314)', () => {
    const d = describeEvidenceForReviewer({ evidence: [
      { type: 'artifact', path: '/out/report.md' },
      { type: 'command', command: 'npm test', exitCode: 0 },
    ] });
    expect(d).toContain('[0] artifact /out/report.md');
    expect(d).toContain('[1] command `npm test` → exit 0');
    const many = describeEvidenceForReviewer({ evidence: Array.from({ length: 13 }, (_, i) => ({ type: 'artifact', path: `/f${i}` })) });
    expect(many).toContain('[9] artifact /f9');
    expect(many).not.toContain('[10]');
    expect(many).toContain('and 3 more');
  });

  it.each([undefined, {}, { evidence: [] }, { evidence: 'nope' }])('flags no (usable) evidence: %j', (output) => {
    expect(describeEvidenceForReviewer(output as Record<string, unknown> | undefined)).toMatch(/^Evidence: NONE/);
  });
});

describe('decideCompletion', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
    mkdirSync(path.join(dir, 'src'));
    file = path.join(dir, 'src', 'out.ts');
    writeFileSync(file, 'x');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('missing evidence', () => {
    it.each([undefined, null, []])('warn mode: completes with a warning (%j)', async (raw) => {
      const d = await decideCompletion(raw, null, { mode: 'warn' });
      expect(d.action).toBe('complete');
      if (d.action === 'complete') {
        expect(d.warning).toContain('WITHOUT evidence');
        expect(d.warning).toContain('body.result.evidence');
        expect(d.evidence).toBeUndefined();
      }
    });

    it.each([undefined, null, []])('enforce mode: rejects with what to send (%j)', async (raw) => {
      const d = await decideCompletion(raw, null, { mode: 'enforce' });
      expect(d).toEqual(expect.objectContaining({ action: 'reject', status: 400, code: CODES.MISSING }));
      if (d.action === 'reject') expect(d.error).toContain('"type":"artifact"');
    });

    it('an exempt completion (review verdict) needs none, in either mode', async () => {
      expect(await decideCompletion(undefined, null, { mode: 'enforce', exemptFromMissing: true })).toEqual({ action: 'complete' });
      expect(await decideCompletion(undefined, null, { mode: 'warn', exemptFromMissing: true })).toEqual({ action: 'complete' });
    });
  });

  it('rejects malformed evidence in both modes, even when exempt from missing', async () => {
    for (const mode of ['warn', 'enforce'] as const) {
      const d = await decideCompletion([{ type: 'command', command: 'npm test' }], null, { mode, exemptFromMissing: true });
      expect(d).toEqual(expect.objectContaining({ action: 'reject', code: CODES.MALFORMED }));
      if (d.action === 'reject') expect(d.error).toContain('evidence[0]');
    }
  });

  it('a blocked entry blocks, ahead of failing commands and missing artifacts', async () => {
    const d = await decideCompletion([
      { type: 'command', command: 'npm test', exitCode: 1 },
      { type: 'artifact', path: '/definitely/not/here' },
      { type: 'blocked', step: 'npm test', reason: '3 failures in auth.test.ts' },
    ], null, { mode: 'warn' });
    expect(d.action).toBe('block');
    if (d.action === 'block') {
      expect(d.reason).toBe('Blocked at "npm test": 3 failures in auth.test.ts');
      expect(d.evidence).toHaveLength(3);
    }
  });

  it('rejects a command with a non-zero exit code', async () => {
    const d = await decideCompletion([
      { type: 'command', command: 'npm test', exitCode: 0 },
      { type: 'command', command: 'npm run build', exitCode: 2 },
    ], null, { mode: 'warn' });
    expect(d).toEqual(expect.objectContaining({ action: 'reject', status: 400, code: CODES.COMMAND_FAILED }));
    if (d.action === 'reject') {
      expect(d.error).toContain('evidence[1] "npm run build" exited 2');
      expect(d.error).toContain('a failing command is not evidence of done');
    }
  });

  it('accepts an existing absolute artifact and a passing command', async () => {
    const evidence = [
      { type: 'artifact', path: file },
      { type: 'command', command: 'npm test', exitCode: 0, outputTail: '12 passed' },
    ];
    const d = await decideCompletion(evidence, null, { mode: 'enforce' });
    // The checked file carries its size and mtime (#1313).
    expect(d).toEqual({ action: 'complete', evidence: [{ ...evidence[0], sizeBytes: expect.any(Number), mtime: expect.any(String) }, ...evidence.slice(1)] });
  });

  it('rejects an absolute artifact that does not exist, naming it', async () => {
    const missing = path.join(dir, 'nope.md');
    const d = await decideCompletion([{ type: 'artifact', path: file }, { type: 'artifact', path: missing }], null, { mode: 'warn' });
    expect(d).toEqual(expect.objectContaining({ action: 'reject', code: CODES.ARTIFACT_NOT_FOUND }));
    if (d.action === 'reject') expect(d.error).toContain(`evidence[1] artifact "${missing}" does not exist`);
  });

  it('resolves a relative artifact against projectPath', async () => {
    const d = await decideCompletion([{ type: 'artifact', path: 'src/out.ts' }], { metadata: { projectPath: dir } }, { mode: 'warn' });
    expect(d.action).toBe('complete');
  });

  it('resolves a relative artifact against the worktree before projectPath', async () => {
    const wt = path.join(dir, 'wt');
    mkdirSync(wt);
    writeFileSync(path.join(wt, 'only-in-wt.txt'), 'x');
    const wi = { metadata: { worktree: { workdir: wt, path: wt }, projectPath: path.join(dir, 'src') } };
    expect((await decideCompletion([{ type: 'artifact', path: 'only-in-wt.txt' }], wi, { mode: 'warn' })).action).toBe('complete');
  });

  it('rejects a relative artifact that exists in none of the bases, listing them', async () => {
    const d = await decideCompletion([{ type: 'artifact', path: 'src/missing.ts' }], { metadata: { projectPath: dir } }, { mode: 'warn' });
    expect(d).toEqual(expect.objectContaining({ action: 'reject', code: CODES.ARTIFACT_NOT_FOUND }));
    if (d.action === 'reject') expect(d.error).toContain(`looked in ${dir}`);
  });

  it('rejects a relative artifact when the WorkItem records no project or worktree', async () => {
    const d = await decideCompletion([{ type: 'artifact', path: 'src/out.ts' }], { metadata: {} }, { mode: 'warn' });
    expect(d).toEqual(expect.objectContaining({ action: 'reject', code: CODES.ARTIFACT_UNRESOLVABLE }));
    if (d.action === 'reject') expect(d.error).toContain('send an absolute path');
  });

  it('accepts http(s) URLs without checking them', async () => {
    const statPath = jest.fn().mockResolvedValue(null);
    const d = await decideCompletion([
      { type: 'artifact', path: 'https://github.com/o/r/pull/1' },
      { type: 'artifact', path: 'HTTP://example.com/x' },
    ], null, { mode: 'enforce', statPath });
    expect(d.action).toBe('complete');
    expect(statPath).not.toHaveBeenCalled();
  });

  it('accepts file:// URLs that exist and expands ~/', async () => {
    expect((await decideCompletion([{ type: 'artifact', path: pathToFileURL(file).href }], null, { mode: 'warn' })).action).toBe('complete');
    const d = await decideCompletion([{ type: 'artifact', path: '~/src/out.ts' }], null, { mode: 'warn', homeDir: dir });
    expect(d.action).toBe('complete');
  });

  it('rejects other URL schemes', async () => {
    const d = await decideCompletion([{ type: 'artifact', path: 's3://bucket/key' }], null, { mode: 'warn' });
    expect(d).toEqual(expect.objectContaining({ action: 'reject', code: CODES.MALFORMED }));
  });
});

describe('empty and stale artifacts (#1313)', () => {
  const at = (iso: string) => Date.parse(iso);
  const stat = (sizeBytes: number, mtime: string, isDirectory = false) => jest.fn().mockResolvedValue({ isDirectory, sizeBytes, mtimeMs: at(mtime) });
  const wi = { metadata: {}, createdAt: '2026-10-14T13:43:00.000Z' };

  it('rejects an empty file', async () => {
    const d = await decideCompletion([{ type: 'artifact', path: '/out/report.md' }], wi, { mode: 'warn', statPath: stat(0, '2026-10-14T14:00:00Z') });
    expect(d).toEqual(expect.objectContaining({ action: 'reject', code: CODES.ARTIFACT_EMPTY }));
    if (d.action === 'reject') expect(d.error).toContain('is empty (0 bytes)');
  });

  it('rejects a file last changed before the WorkItem existed (past the grace)', async () => {
    const d = await decideCompletion([{ type: 'artifact', path: '/out/old.png' }], wi, { mode: 'warn', statPath: stat(10, '2026-10-13T09:00:00Z') });
    expect(d).toEqual(expect.objectContaining({ action: 'reject', code: CODES.ARTIFACT_STALE }));
    if (d.action === 'reject') expect(d.error).toContain('before this WorkItem existed');
  });

  it('accepts a file saved within the grace before the WorkItem, and records size and mtime', async () => {
    const mtime = new Date(at(wi.createdAt) - COMPLETION_EVIDENCE_CONSTANTS.STALE_GRACE_MS + 1000).toISOString();
    const d = await decideCompletion([{ type: 'artifact', path: '/out/v1.mp4' }, { type: 'artifact', path: 'https://x.test/a' }], wi, { mode: 'warn', statPath: stat(4096, mtime) });
    expect(d.action).toBe('complete');
    if (d.action === 'complete') {
      expect(d.evidence?.[0]).toEqual({ type: 'artifact', path: '/out/v1.mp4', sizeBytes: 4096, mtime });
      expect(d.evidence?.[1]).toEqual({ type: 'artifact', path: 'https://x.test/a' });
    }
  });

  it('a directory only needs to exist; no age check without createdAt', async () => {
    expect((await decideCompletion([{ type: 'artifact', path: '/out/dir' }], wi, { mode: 'warn', statPath: stat(0, '2020-01-01T00:00:00Z', true) })).action).toBe('complete');
    expect((await decideCompletion([{ type: 'artifact', path: '/out/old.md' }], { metadata: {} }, { mode: 'warn', statPath: stat(5, '2020-01-01T00:00:00Z') })).action).toBe('complete');
  });

  it('artifactNotBefore', () => {
    expect(artifactNotBefore(null)).toBeNull();
    expect(artifactNotBefore({ createdAt: 'nope' })).toBeNull();
    expect(artifactNotBefore({ createdAt: wi.createdAt })).toBe(at(wi.createdAt) - COMPLETION_EVIDENCE_CONSTANTS.STALE_GRACE_MS);
  });

  it('a real empty file on disk is rejected by the default check', async () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'ev-empty-'));
    try {
      writeFileSync(path.join(d, 'e.md'), '');
      expect((await decideCompletion([{ type: 'artifact', path: path.join(d, 'e.md') }], null, { mode: 'warn' })).action).toBe('reject');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('decideReviewAccept (#1314)', () => {
  const evidence = [{ type: 'artifact', path: '/out/report.md' }, { type: 'command', command: 'npm test', exitCode: 0 }];
  const pass = (entry: number | null, did = 'opened it: 3 sections, matches the brief') => ({ entry, did, outcome: 'pass' });

  it('accepts checks that name worker evidence, trimmed and with only known fields', () => {
    const d = decideReviewAccept([{ ...pass(0, '  opened it  '), extra: 1 }, pass(null)], evidence, 'enforce');
    expect(d).toEqual({ action: 'accept', checks: [{ entry: 0, did: 'opened it', outcome: 'pass' }, { entry: null, did: 'opened it: 3 sections, matches the brief', outcome: 'pass' }] });
  });

  it.each([undefined, null, []])('enforce: no record is refused (%j)', (raw) => {
    const d = decideReviewAccept(raw, evidence, 'enforce');
    expect(d).toMatchObject({ action: 'reject', status: 400, code: CODES.REVIEW_UNCHECKED });
    expect((d as { error: string }).error).toContain('2 evidence entries');
  });

  it('warn: no record is accepted and flagged unchecked', () => {
    expect(decideReviewAccept(undefined, evidence, 'warn')).toMatchObject({ action: 'accept_unchecked', warning: expect.stringContaining('unchecked') });
  });

  it('with worker evidence, only direct looks are not enough', () => {
    expect(decideReviewAccept([pass(null)], evidence, 'enforce')).toMatchObject({ action: 'reject', code: CODES.REVIEW_UNCHECKED });
  });

  it('without worker evidence, a direct look is enough', () => {
    expect(decideReviewAccept([pass(null)], undefined, 'enforce')).toMatchObject({ action: 'accept' });
  });

  it.each([
    ['not an array', { entry: 0 }],
    ['entry out of range', [pass(2)]],
    ['negative entry', [pass(-1)]],
    ['fractional entry', [{ entry: 0.5, did: 'x', outcome: 'pass' }]],
    ['empty did', [pass(0, '  ')]],
    ['bad outcome', [{ entry: 0, did: 'x', outcome: 'ok' }]],
    ['non-object entry', ['looked']],
  ])('malformed is refused in both modes: %s', (_name, raw) => {
    for (const mode of ['warn', 'enforce'] as const) {
      expect(decideReviewAccept(raw, evidence, mode)).toMatchObject({ action: 'reject', code: CODES.REVIEW_CHECKS_MALFORMED });
    }
  });

  it('a failed check cannot be accepted', () => {
    const d = decideReviewAccept([pass(0), { entry: 1, did: 're-ran npm test: 2 failing', outcome: 'fail' }], evidence, 'enforce');
    expect(d).toMatchObject({ action: 'reject', code: CODES.REVIEW_CHECK_FAILED });
    expect((d as { error: string }).error).toContain('verdict');
  });
});
