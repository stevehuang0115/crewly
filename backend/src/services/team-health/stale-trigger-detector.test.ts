/**
 * Tests for the stale-trigger detector (§B.4 implementation).
 *
 * @module services/team-health/stale-trigger-detector.test
 */

import {
  detectStaleWorkItems,
  isStale,
  describeStaleEvidence,
  type StaleTriggerInput,
} from './stale-trigger-detector.js';
import type {
  ArtifactProbeResult,
  StaleTriggerConfig,
} from './team-health-types.js';
import { DEFAULT_STALE_TRIGGER } from './team-health-types.js';
import { createWorkItem } from '../../types/v2/index.js';
import type { WorkItem } from '../../types/v2/index.js';

const baseWi = (id: string, overrides: Partial<WorkItem> = {}): WorkItem => ({
  ...createWorkItem({ type: 'delegate', owner: 'agent', title: id, target: 'agent-1' }),
  id,
  ...overrides,
});

describe('detectStaleWorkItems', () => {
  it('returns empty when stale-trigger detection is disabled', () => {
    const wis = [baseWi('w1')];
    const cfg: StaleTriggerConfig = { ...DEFAULT_STALE_TRIGGER, enabled: false };
    const probes: ArtifactProbeResult[] = [
      { kind: 'file_state', isStale: true, evidence: 'already-done' },
    ];
    const input: StaleTriggerInput = {
      priorDoneCounts: new Map([['w1', 99]]),
      artifactProbes: new Map([['w1', probes]]),
    };
    expect(detectStaleWorkItems(wis, input, cfg).size).toBe(0);
  });

  it('flags WorkItems whose prior-done count meets threshold', () => {
    const wis = [baseWi('w1'), baseWi('w2')];
    const input: StaleTriggerInput = {
      priorDoneCounts: new Map([['w1', 4], ['w2', 2]]),
    };
    const out = detectStaleWorkItems(wis, input, DEFAULT_STALE_TRIGGER);
    expect(out.has('w1')).toBe(true);
    expect(out.has('w2')).toBe(false);
  });

  it('flags WorkItems whose artifact probe reports isStale=true', () => {
    const wis = [baseWi('w1')];
    const probes: ArtifactProbeResult[] = [
      { kind: 'package_version', isStale: true, evidence: 'no branch contains 1.3.33' },
    ];
    const input: StaleTriggerInput = {
      artifactProbes: new Map([['w1', probes]]),
    };
    expect(detectStaleWorkItems(wis, input, DEFAULT_STALE_TRIGGER).has('w1')).toBe(true);
  });

  it('does NOT flag terminal-status WorkItems even with stale evidence', () => {
    const wis = [
      baseWi('w-done', { status: 'done' }),
      baseWi('w-verified', { status: 'verified' }),
      baseWi('w-cancelled', { status: 'cancelled' }),
    ];
    const probes: ArtifactProbeResult[] = [
      { kind: 'file_state', isStale: true, evidence: 'irrelevant' },
    ];
    const input: StaleTriggerInput = {
      priorDoneCounts: new Map([['w-done', 99], ['w-verified', 99], ['w-cancelled', 99]]),
      artifactProbes: new Map([
        ['w-done', probes], ['w-verified', probes], ['w-cancelled', probes],
      ]),
    };
    expect(detectStaleWorkItems(wis, input, DEFAULT_STALE_TRIGGER).size).toBe(0);
  });

  it('does NOT flag when only NON-stale probes exist', () => {
    const wis = [baseWi('w1')];
    const probes: ArtifactProbeResult[] = [
      { kind: 'route', isStale: false, evidence: 'route exists' },
    ];
    const input: StaleTriggerInput = {
      artifactProbes: new Map([['w1', probes]]),
    };
    expect(detectStaleWorkItems(wis, input, DEFAULT_STALE_TRIGGER).has('w1')).toBe(false);
  });
});

describe('isStale', () => {
  it('exact-threshold prior-done count flags stale', () => {
    expect(
      isStale(baseWi('w'), { priorDoneCounts: new Map([['w', 3]]) }, DEFAULT_STALE_TRIGGER),
    ).toBe(true);
  });

  it('one-below-threshold does NOT flag', () => {
    expect(
      isStale(baseWi('w'), { priorDoneCounts: new Map([['w', 2]]) }, DEFAULT_STALE_TRIGGER),
    ).toBe(false);
  });
});

describe('describeStaleEvidence', () => {
  it('combines redundancy and probe evidence', () => {
    const probes: ArtifactProbeResult[] = [
      { kind: 'package_version', isStale: true, evidence: 'no branch at 1.3.33' },
    ];
    const out = describeStaleEvidence(
      baseWi('w'),
      { priorDoneCounts: new Map([['w', 4]]), artifactProbes: new Map([['w', probes]]) },
      DEFAULT_STALE_TRIGGER,
    );
    expect(out).toContain('4 prior done tasks');
    expect(out).toContain('package.json version mismatch');
    expect(out).toContain('no branch at 1.3.33');
  });

  it('emits empty string when nothing is stale', () => {
    expect(describeStaleEvidence(baseWi('w'), {}, DEFAULT_STALE_TRIGGER)).toBe('');
  });
});
