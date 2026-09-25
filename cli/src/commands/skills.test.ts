/**
 * Tests for `crewly skills setup <id> [--check]`.
 */

jest.mock('chalk', () => ({
  __esModule: true,
  default: new Proxy({}, {
    get: () => {
      const fn = (s: string) => s;
      return new Proxy(fn, { get: () => fn, apply: (_t: unknown, _this: unknown, args: string[]) => args[0] });
    },
  }),
}));

import type { ResolvedSkill } from '../../../backend/src/services/skill-setup/skill-discovery.service.js';
import type { RunSetupInput, SetupResult } from '../../../backend/src/services/skill-setup/skill-setup-runner.service.js';
import { formatProgress, skillsCommand, skillsSetupCommand } from './skills.js';

const manifest = { steps: [{ id: 'ffmpeg', type: 'command' as const, check: { commands: ['ffmpeg'] } }] };

function skill(over: Partial<ResolvedSkill> = {}): ResolvedSkill {
  return {
    id: 'transcribe-audio', name: 'transcribe-audio', description: '', tags: [], triggers: [], source: 'bundled',
    official: true, officialReason: 'bundled with Crewly', installed: true, skillDir: '/pkg/transcribe-audio',
    setup: { declared: true }, score: 0, manifest, ...over,
  };
}

function harness(found: ResolvedSkill | null, result: Partial<SetupResult> = {}) {
  const lines: string[] = [];
  const calls: RunSetupInput[] = [];
  const deps = {
    log: (l: string) => lines.push(l),
    discovery: { resolveLocal: jest.fn(async () => found) },
    runner: {
      runSetup: jest.fn(async (input: RunSetupInput) => {
        calls.push(input);
        input.onProgress?.({ skillId: input.skillId, stepId: 'setup', phase: 'checking', message: 'started' });
        input.onProgress?.({ skillId: input.skillId, stepId: 'ffmpeg', phase: 'installing', message: 'brew install ffmpeg' });
        input.onProgress?.({ skillId: input.skillId, stepId: 'ffmpeg', phase: 'installed', message: 'installed (/opt/homebrew/bin/ffmpeg)' });
        return { skillId: input.skillId, success: true, checkOnly: !!input.checkOnly, steps: [], logFile: '/h/.crewly/logs/skill-setup/transcribe-audio.log', durationMs: 4200, ...result } as SetupResult;
      }),
    },
  };
  return { lines, calls, deps };
}

describe('skillsSetupCommand', () => {
  it('runs the setup of a bundled skill and prints progress, summary and log path', async () => {
    const { lines, calls, deps } = harness(skill());
    expect(await skillsSetupCommand('transcribe-audio', {}, deps)).toBe(0);
    expect(calls[0]).toMatchObject({ skillId: 'transcribe-audio', skillDir: '/pkg/transcribe-audio', checkOnly: false, manifest });
    expect(lines).toEqual([
      'Setting up transcribe-audio (bundled with Crewly)…',
      '  … ffmpeg: brew install ffmpeg',
      '  ✓ ffmpeg — installed (/opt/homebrew/bin/ffmpeg)',
      '',
      'transcribe-audio is set up (4s).',
      'Log: /h/.crewly/logs/skill-setup/transcribe-audio.log',
    ]);
  });

  it('--check only checks and lists what is missing', async () => {
    const { lines, calls, deps } = harness(skill(), {
      success: false, checkOnly: true, logFile: '',
      steps: [{ id: 'whisper-model', type: 'file', status: 'missing', message: 'not downloaded', optional: false }],
    });
    expect(await skillsSetupCommand('transcribe-audio', { check: true }, deps)).toBe(1);
    expect(calls[0].checkOnly).toBe(true);
    expect(lines).toContain('transcribe-audio: missing whisper-model. Run: crewly skills setup transcribe-audio');
  });

  it('exits 1 with the reason when setup fails', async () => {
    const { lines, deps } = harness(skill(), { success: false, error: 'ffmpeg: Homebrew is not installed' });
    expect(await skillsSetupCommand('transcribe-audio', {}, deps)).toBe(1);
    expect(lines).toContain('transcribe-audio setup failed: ffmpeg: Homebrew is not installed');
  });

  it('exits 2 for a skill that is not on this machine', async () => {
    const { lines, deps } = harness(null);
    expect(await skillsSetupCommand('nope', {}, deps)).toBe(2);
    expect(lines[0]).toBe('Skill "nope" is not on this machine.');
  });

  it('handles skills without setup and with an invalid setup block', async () => {
    let h = harness(skill({ manifest: undefined }));
    expect(await skillsSetupCommand('x', {}, h.deps)).toBe(0);
    expect(h.lines).toEqual(['transcribe-audio declares no setup — nothing to install.']);
    h = harness(skill({ manifest: undefined, manifestError: 'bad step' }));
    expect(await skillsSetupCommand('x', {}, h.deps)).toBe(1);
    expect(h.deps.runner.runSetup).not.toHaveBeenCalled();
  });
});

describe('skillsCommand', () => {
  it('dispatches setup and check, and rejects the rest', async () => {
    const { calls, deps } = harness(skill());
    expect(await skillsCommand('check', 'transcribe-audio', {}, deps)).toBe(0);
    expect(calls[0].checkOnly).toBe(true);
    expect(await skillsCommand('setup', 'transcribe-audio', { check: true }, deps)).toBe(0);
    expect(calls[1].checkOnly).toBe(true);
    expect(await skillsCommand('remove', 'x', {}, deps)).toBe(2);
    expect(await skillsCommand('setup', undefined, {}, deps)).toBe(2);
  });
});

describe('formatProgress', () => {
  it('hides checking noise and shows downloads and waits', () => {
    expect(formatProgress({ skillId: 's', stepId: 'm', phase: 'checking', message: 'x' })).toBeNull();
    expect(formatProgress({ skillId: 's', stepId: 'm', phase: 'downloading', message: '40% (219.6 MB)' })).toBe('  … m: 40% (219.6 MB)');
    expect(formatProgress({ skillId: 's', stepId: 'setup', phase: 'waiting', message: 'another setup is running' })).toBe('  … another setup is running');
    expect(formatProgress({ skillId: 's', stepId: 'setup', phase: 'installed', message: 'done' })).toBeNull();
    expect(formatProgress({ skillId: 's', stepId: 'c', phase: 'skipped', message: 'optional' })).toBe('  - c — optional');
  });
});
