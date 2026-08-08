/**
 * Tests for the Commitment Approval Guard (2026-06-02 autonomy incident).
 */

import { describe, it, expect } from '@jest/globals';
import {
  isDormantTeam,
  containsApprovalToken,
  evaluateColdLaunch,
  extractScheduleClaim,
  isPreAuthorizedSchedule,
  type GuardTeam,
  type GuardWorkItem,
} from './commitment-approval-guard.js';

const dormant: GuardTeam = {
  members: [{ agentStatus: 'inactive' }, { agentStatus: 'stopped' }],
};
const active: GuardTeam = {
  members: [{ agentStatus: 'inactive' }, { agentStatus: 'active' }],
};

describe('isDormantTeam', () => {
  it('is dormant when no member is active-like', () => {
    expect(isDormantTeam(dormant)).toBe(true);
    expect(isDormantTeam({ members: [{ agentStatus: 'inactive' }] })).toBe(true);
  });

  it('is NOT dormant when any member is active/started/starting/activating', () => {
    expect(isDormantTeam(active)).toBe(false);
    expect(isDormantTeam({ members: [{ agentStatus: 'starting' }] })).toBe(false);
    expect(isDormantTeam({ members: [{ agentStatus: 'started' }] })).toBe(false);
    expect(isDormantTeam({ members: [{ agentStatus: 'activating' }] })).toBe(false);
  });

  it('an empty team is dormant', () => {
    expect(isDormantTeam({ members: [] })).toBe(true);
  });
});

describe('containsApprovalToken', () => {
  it('matches clear owner affirmatives (CJK + EN)', () => {
    expect(containsApprovalToken('好，启动 Phase 1')).toBe(true);
    expect(containsApprovalToken('批准')).toBe(true);
    expect(containsApprovalToken('同意，开干')).toBe(true);
    expect(containsApprovalToken('go ahead')).toBe(true);
    expect(containsApprovalToken('yes, do it')).toBe(true);
    expect(containsApprovalToken('approved')).toBe(true);
    expect(containsApprovalToken("let's go")).toBe(true);
    expect(containsApprovalToken('ship it')).toBe(true);
  });

  it('does NOT treat a QUESTION as approval, even when it contains an approval word', () => {
    // The prompt's rule: a question is never approval. These contain 启动 /
    // "proceed" / "launch" as substrings but are decision REQUESTS, not grants.
    expect(containsApprovalToken('要不要启动 Phase 1？')).toBe(false);
    expect(containsApprovalToken('需不需要启动团队')).toBe(false);
    expect(containsApprovalToken('should we proceed?')).toBe(false);
    expect(containsApprovalToken('是否启动')).toBe(false);
    expect(containsApprovalToken('启动吗？')).toBe(false);
  });

  it('does NOT match stand-downs or ambiguous chatter', () => {
    expect(containsApprovalToken('我做closie最主要的就是穿搭建议')).toBe(false);
    expect(containsApprovalToken('ok')).toBe(false);
    expect(containsApprovalToken('yes')).toBe(false);
    expect(containsApprovalToken('go')).toBe(false); // bare "go" excluded
    expect(containsApprovalToken('可以看看吗')).toBe(false);
    expect(containsApprovalToken('')).toBe(false);
  });
});

describe('evaluateColdLaunch', () => {
  it('BLOCKS a cold launch of a dormant team with no owner approval (the incident)', () => {
    const d = evaluateColdLaunch({
      team: dormant,
      // The owner's actual recent messages in the incident — none approving.
      recentOwnerMessages: ['我做closie最主要的就是穿搭建议，同时提高衣橱利用率'],
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('owner approval');
  });

  it('BLOCKS when the only "approval" is the orchestrator asserting it (no owner message)', () => {
    const d = evaluateColdLaunch({ team: dormant, recentOwnerMessages: [] });
    expect(d.allowed).toBe(false);
  });

  it('ALLOWS a cold launch when a genuine owner approval is present, returning evidence', () => {
    const d = evaluateColdLaunch({
      team: dormant,
      recentOwnerMessages: ['先研究一下', '好，启动 Phase 1'],
    });
    expect(d.allowed).toBe(true);
    expect(d.evidence).toBe('好，启动 Phase 1');
  });

  it('ALLOWS continuation/recovery of an already-active team without any approval', () => {
    const d = evaluateColdLaunch({ team: active, recentOwnerMessages: [] });
    expect(d.allowed).toBe(true);
  });

  /**
   * Issue #730 — an owner on a session that never persists chat messages
   * cannot satisfy this gate with ANY wording. The old reason text blamed the
   * phrasing, so orc and owner burned retry cycles hunting for a magic word.
   */
  describe('diagnosis when the channel records nothing (#730)', () => {
    it('names the channel as the cause when zero owner messages were recorded', () => {
      const d = evaluateColdLaunch({ team: dormant, recentOwnerMessages: [] });
      expect(d.allowed).toBe(false);
      expect(d.reason).toContain('channel problem, not a wording problem');
      expect(d.reason).toMatch(/Slack.*Chat UI/s);
    });

    it('still blames wording when owner messages exist but none approve', () => {
      const d = evaluateColdLaunch({
        team: dormant,
        recentOwnerMessages: ['要不要启动?', 'hold off for now'],
      });
      expect(d.allowed).toBe(false);
      expect(d.reason).not.toContain('channel problem');
      expect(d.reason).toContain('No such owner message was found');
    });
  });
});

describe('extractScheduleClaim', () => {
  it('extracts a cron claim from a cron_run WorkItem carrying cronTaskId', () => {
    const wi: GuardWorkItem = { type: 'cron_run', metadata: { source: 'cron', cronTaskId: 'cron-abc123' } };
    expect(extractScheduleClaim(wi)).toEqual({ kind: 'cron', refId: 'cron-abc123' });
  });

  it('extracts a cron claim from metadata.source=cron even if type differs', () => {
    const wi: GuardWorkItem = { type: 'delegate', metadata: { source: 'cron', cronTaskId: 'cron-x' } };
    expect(extractScheduleClaim(wi)).toEqual({ kind: 'cron', refId: 'cron-x' });
  });

  it('extracts a trigger claim from triggerId', () => {
    const wi: GuardWorkItem = { type: 'delegate', triggerId: 'trg-77' };
    expect(extractScheduleClaim(wi)).toEqual({ kind: 'trigger', refId: 'trg-77' });
  });

  it('returns null for a cron_run with NO cronTaskId (nothing to verify)', () => {
    expect(extractScheduleClaim({ type: 'cron_run', metadata: { source: 'cron' } })).toBeNull();
    expect(extractScheduleClaim({ type: 'cron_run' })).toBeNull();
  });

  it('returns null for an ordinary delegate WorkItem', () => {
    expect(extractScheduleClaim({ type: 'delegate', metadata: { source: 'orchestrator' } })).toBeNull();
    expect(extractScheduleClaim({ type: 'delegate' })).toBeNull();
  });
});

describe('isPreAuthorizedSchedule', () => {
  // Registry where only these ids are real (owner-configured).
  const registry = {
    cronTaskExists: async (id: string) => id === 'cron-real',
    triggerExists: (id: string) => id === 'trg-real',
  };

  it('EXEMPTS a cron run whose cronTaskId resolves in the registry', async () => {
    const wi: GuardWorkItem = { type: 'cron_run', metadata: { source: 'cron', cronTaskId: 'cron-real' } };
    expect(await isPreAuthorizedSchedule(wi, registry)).toBe(true);
  });

  it('does NOT exempt a FORGED cron claim whose id is not registered (security)', async () => {
    // The orchestrator can write source:'cron' onto a fabricated WorkItem — but
    // it cannot fabricate a real cron task, so the id does not resolve.
    const wi: GuardWorkItem = { type: 'cron_run', metadata: { source: 'cron', cronTaskId: 'cron-FORGED' } };
    expect(await isPreAuthorizedSchedule(wi, registry)).toBe(false);
  });

  it('EXEMPTS a trigger wake whose triggerId resolves in the registry', async () => {
    expect(await isPreAuthorizedSchedule({ triggerId: 'trg-real' }, registry)).toBe(true);
  });

  it('does NOT exempt a forged/unknown triggerId', async () => {
    expect(await isPreAuthorizedSchedule({ triggerId: 'trg-FORGED' }, registry)).toBe(false);
  });

  it('does NOT exempt a WorkItem with no scheduled-origin claim', async () => {
    expect(await isPreAuthorizedSchedule({ type: 'delegate' }, registry)).toBe(false);
  });

  it('does NOT exempt a null/missing WorkItem', async () => {
    expect(await isPreAuthorizedSchedule(null, registry)).toBe(false);
    expect(await isPreAuthorizedSchedule(undefined, registry)).toBe(false);
  });
});
