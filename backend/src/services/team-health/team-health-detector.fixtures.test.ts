/**
 * Fixture-based regression tests for the THW pure detector.
 *
 * Replays the seven 2026-04-25 silent-failure incidents:
 *   - Cases #1–#4 from SEALED §E.3–§E.6
 *   - Cases #5–#7 from post-SEALED §B.6 amendment (lost-dispatch)
 *
 * @module services/team-health/team-health-detector.fixtures.test
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectTeamHealth } from './team-health-detector.js';
import type {
  AgentWorkingStatus,
  ArtifactProbeResult,
  TeamHealthSnapshot,
  TeamSummary,
} from './team-health-types.js';
import { DEFAULT_CONFIG } from './team-health-types.js';
import type { WorkItem, Request, Trigger } from '../../types/v2/index.js';
import type { AgentHealth } from '../reconciler/reconcile-rules.js';

interface RawFixture {
  now: string;
  bootedAt: string;
  teams: TeamSummary[];
  agentHealth: (AgentHealth & { workingStatus?: AgentWorkingStatus })[];
  workItems: WorkItem[];
  requests: Request[];
  triggers: Trigger[];
  priorDoneCounts?: { workItemId: string; count: number }[];
  artifactProbes?: { workItemId: string; probes: ArtifactProbeResult[] }[];
}

function loadFixture(name: string): TeamHealthSnapshot {
  const filePath = path.join(__dirname, '__test-fixtures__', name);
  const raw: RawFixture = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const agentHealth = new Map<string, AgentHealth & { workingStatus?: AgentWorkingStatus }>();
  for (const a of raw.agentHealth) agentHealth.set(a.sessionName, a);
  const priorDoneCounts = new Map<string, number>();
  for (const p of raw.priorDoneCounts ?? []) priorDoneCounts.set(p.workItemId, p.count);
  const artifactProbesByWi = new Map<string, ArtifactProbeResult[]>();
  for (const ap of raw.artifactProbes ?? []) artifactProbesByWi.set(ap.workItemId, ap.probes);
  return {
    now: new Date(raw.now),
    bootedAt: new Date(raw.bootedAt),
    teams: raw.teams,
    agentHealth,
    workItems: raw.workItems,
    requests: raw.requests,
    triggers: raw.triggers,
    priorDoneCounts,
    artifactProbes: artifactProbesByWi,
  };
}

describe('Case #1 — Marketing cascade', () => {
  const snapshot = loadFixture('case-1-marketing-cascade.json');
  const detections = detectTeamHealth(snapshot, DEFAULT_CONFIG);

  it('produces one detection per team', () => {
    expect(detections).toHaveLength(snapshot.teams.length);
  });

  it('marks marketing-content and marketing-ops as cascade', () => {
    expect(detections.find((d) => d.teamId === 'marketing-content')?.verdict).toBe('cascade');
    expect(detections.find((d) => d.teamId === 'marketing-ops')?.verdict).toBe('cascade');
  });

  it('the cascade detection lists its sibling team', () => {
    expect(detections.find((d) => d.teamId === 'marketing-content')?.cascadeWith).toContain('marketing-ops');
    expect(detections.find((d) => d.teamId === 'marketing-ops')?.cascadeWith).toContain('marketing-content');
  });

  it('lists pending WorkItem IDs and idle members', () => {
    const mc = detections.find((d) => d.teamId === 'marketing-content');
    expect(mc?.pendingWorkItemIds.length).toBeGreaterThan(0);
    expect(mc?.idleAgentSessions.length).toBeGreaterThan(0);
  });

  it('parent team marketing is NOT cascade (no sibling at parent level)', () => {
    const m = detections.find((d) => d.teamId === 'marketing');
    expect(m?.verdict).not.toBe('cascade');
  });
});

describe('Case #2 — Sam stale relay refire', () => {
  const snapshot = loadFixture('case-2-sam-stale-disable-relay.json');
  const detections = detectTeamHealth(snapshot, DEFAULT_CONFIG);

  it('verdict short-circuits to stale', () => {
    expect(detections.find((d) => d.teamId === 'crewly-product')?.verdict).toBe('stale');
  });

  it('lists wi-stale-relay in staleWorkItemIds', () => {
    expect(detections.find((d) => d.teamId === 'crewly-product')?.staleWorkItemIds).toContain('wi-stale-relay');
  });

  it('does NOT count the stale item as pending (FP-4)', () => {
    expect(detections.find((d) => d.teamId === 'crewly-product')?.pendingWorkItemIds).not.toContain('wi-stale-relay');
  });
});

describe('Case #3 — Arch crewly-web 1.3.33', () => {
  const snapshot = loadFixture('case-3-arch-crewly-web-1.3.33.json');
  const detections = detectTeamHealth(snapshot, DEFAULT_CONFIG);

  it('verdict is stale', () => {
    expect(detections.find((d) => d.teamId === 'crewly-product-arch')?.verdict).toBe('stale');
  });

  it('flags wi-rebuild-1.3.33 as stale', () => {
    expect(detections.find((d) => d.teamId === 'crewly-product-arch')?.staleWorkItemIds).toContain('wi-rebuild-1.3.33');
  });
});

describe('Case #4 — Orphan Request', () => {
  it('single team with one orphan ⇒ stalling', () => {
    const snapshot = loadFixture('case-4-orphan-request.json');
    const detections = detectTeamHealth(snapshot, DEFAULT_CONFIG);
    const m = detections.find((d) => d.teamId === 'marketing');
    expect(m?.verdict).toBe('stalling');
    expect(m?.orphanRequestIds).toContain('req-orphan-1');
  });

  it('≥3 system-wide orphans ⇒ cascade', () => {
    const base = loadFixture('case-4-orphan-request.json');
    const orphans: Request[] = [
      base.requests[0],
      { ...base.requests[0], id: 'req-orphan-2' },
      { ...base.requests[0], id: 'req-orphan-3' },
    ];
    const snapshot: TeamHealthSnapshot = { ...base, requests: orphans };
    const detections = detectTeamHealth(snapshot, DEFAULT_CONFIG);
    expect(detections.find((d) => d.teamId === 'marketing')?.verdict).toBe('cascade');
  });
});

describe('Case #5 — Mia (PM) lost-dispatch-after-restart', () => {
  const snapshot = loadFixture('case-5-mia-lost-dispatch.json');
  const detections = detectTeamHealth(snapshot, DEFAULT_CONFIG);

  it('verdict is stalling', () => {
    expect(detections.find((d) => d.teamId === 'crewly-product-pm')?.verdict).toBe('stalling');
  });

  it('flags wi-mia-pm-dispatch in lostDispatchWorkItemIds', () => {
    expect(detections.find((d) => d.teamId === 'crewly-product-pm')?.lostDispatchWorkItemIds).toContain('wi-mia-pm-dispatch');
  });
});

describe('Case #6 — Ava (UX) lost-dispatch-after-restart', () => {
  const snapshot = loadFixture('case-6-ava-lost-dispatch.json');
  const detections = detectTeamHealth(snapshot, DEFAULT_CONFIG);

  it('verdict is stalling', () => {
    expect(detections.find((d) => d.teamId === 'crewly-product-ux')?.verdict).toBe('stalling');
  });

  it('flags wi-ava-ux-dispatch in lostDispatchWorkItemIds', () => {
    expect(detections.find((d) => d.teamId === 'crewly-product-ux')?.lostDispatchWorkItemIds).toContain('wi-ava-ux-dispatch');
  });
});

describe('Case #7 — Sam restart drops Slack-chat dispatch', () => {
  const snapshot = loadFixture('case-7-sam-restart-slack-chat.json');
  const detections = detectTeamHealth(snapshot, DEFAULT_CONFIG);

  it('verdict is stalling', () => {
    expect(detections.find((d) => d.teamId === 'crewly-product-tl')?.verdict).toBe('stalling');
  });

  it('flags wi-sam-slack-chat in lostDispatchWorkItemIds', () => {
    expect(detections.find((d) => d.teamId === 'crewly-product-tl')?.lostDispatchWorkItemIds).toContain('wi-sam-slack-chat');
  });
});
