/**
 * Tests for the Commitment Approval Guard (2026-06-02 autonomy incident).
 */

import { describe, it, expect } from '@jest/globals';
import {
  isDormantTeam,
  containsApprovalToken,
  evaluateColdLaunch,
  type GuardTeam,
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
});
