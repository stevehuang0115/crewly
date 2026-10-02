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
  blockedReason,
  decideCompletion,
  describeEvidenceForReviewer,
  resolveEvidenceEnforcementMode,
} from './completion-evidence.service.js';

const CODES = COMPLETION_EVIDENCE_CONSTANTS.CODES;

describe('resolveEvidenceEnforcementMode', () => {
  it('defaults to the constant (warn this release)', () => {
    expect(COMPLETION_EVIDENCE_CONSTANTS.EVIDENCE_ENFORCEMENT_MODE).toBe('warn');
    expect(resolveEvidenceEnforcementMode({})).toBe('warn');
  });

  it('honours CREWLY_EVIDENCE_MODE, case-insensitively', () => {
    expect(resolveEvidenceEnforcementMode({ CREWLY_EVIDENCE_MODE: 'enforce' })).toBe('enforce');
    expect(resolveEvidenceEnforcementMode({ CREWLY_EVIDENCE_MODE: ' ENFORCE ' })).toBe('enforce');
    expect(resolveEvidenceEnforcementMode({ CREWLY_EVIDENCE_MODE: 'warn' })).toBe('warn');
  });

  it('ignores an unknown value', () => {
    expect(resolveEvidenceEnforcementMode({ CREWLY_EVIDENCE_MODE: 'strict' })).toBe('warn');
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

describe('describeEvidenceForReviewer', () => {
  it('counts artifacts and commands', () => {
    expect(describeEvidenceForReviewer({ evidence: [
      { type: 'artifact', path: '/a' },
      { type: 'artifact', path: 'https://x' },
      { type: 'command', command: 'npm test', exitCode: 0 },
    ] })).toMatch(/^Evidence: 2 artifact\(s\), 1 command\(s\)/);
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
    expect(d).toEqual({ action: 'complete', evidence });
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
    const pathExists = jest.fn().mockResolvedValue(false);
    const d = await decideCompletion([
      { type: 'artifact', path: 'https://github.com/o/r/pull/1' },
      { type: 'artifact', path: 'HTTP://example.com/x' },
    ], null, { mode: 'enforce', pathExists });
    expect(d.action).toBe('complete');
    expect(pathExists).not.toHaveBeenCalled();
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
