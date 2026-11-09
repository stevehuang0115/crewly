import { mentionedNames, misdirectedAgentMention, type AgentMentionPostInput } from './agent-mention-post-guard.js';

const ATLAS = 'think-tank-atlas-b4e166f6';
const agents: Record<string, string> = { atlas: ATLAS, lyra: 'mkt-lyra-1', pia: 'flopost-pia-1' };

function input(over: Partial<AgentMentionPostInput> = {}): AgentMentionPostInput {
  return {
    session: 'flopost-pia-1',
    // 2026-10-18 incident text (crewly#1375)
    content: '@Atlas (1) 你的笔记对一半… 83 s is the cold start',
    latest: { kind: 'agent', sender: ATLAS, at: 1 },
    ownerAskedHere: true,
    agentByName: (n) => agents[n.toLowerCase()] ?? null,
    ...over,
  };
}

describe('mentionedNames', () => {
  it('reads @names at word starts, once each', () => {
    expect(mentionedNames('@Atlas (1) note, cc @Lyra. and @Atlas again; mail a@b.com')).toEqual(['Atlas', 'Lyra']);
    expect(mentionedNames('(@Atlas) hi')).toEqual(['Atlas']);
    expect(mentionedNames('no mentions')).toEqual([]);
  });
});

describe('misdirectedAgentMention (crewly#1375)', () => {
  it('refuses an owner-thread post that only @s agents after an agent message, naming send-message', () => {
    const r = misdirectedAgentMention(input());
    expect(r).toEqual(expect.objectContaining({ sender: ATLAS, mentioned: [ATLAS] }));
    expect(r?.message).toContain(`send-message --to ${ATLAS}`);
  });

  // R6 (message-routing audit 2026-10-18): agents never converse inside an
  // owner thread, even when the owner prompted the turn. This used to keep
  // the post; now it is taken out of the thread too.
  it('takes an agents-only post out of the owner thread even when the owner prompted the turn (R6)', () => {
    const fromOwner = misdirectedAgentMention(input({ latest: { kind: 'owner', at: 1 } }));
    expect(fromOwner).toEqual(expect.objectContaining({ mentioned: [ATLAS] }));
    expect(fromOwner?.sender).toBeUndefined();
    expect(fromOwner?.message).toContain(`send-message --to ${ATLAS}`);
    expect(misdirectedAgentMention(input({ latest: null }))?.mentioned).toEqual([ATLAS]);
  });

  it('keeps the post outside an owner thread (an agents\' room)', () => {
    expect(misdirectedAgentMention(input({ ownerAskedHere: false }))).toBeNull();
  });

  it('keeps a post with no @-mention, or one that also @s a non-agent', () => {
    expect(misdirectedAgentMention(input({ content: 'Shaw Brothers cut is ready' }))).toBeNull();
    expect(misdirectedAgentMention(input({ content: '@Steve @Atlas the numbers' }))).toBeNull();
  });

  it('keeps a post that only @s the poster itself', () => {
    expect(misdirectedAgentMention(input({ content: '@Pia note to self' }))).toBeNull();
  });

  it('points at the sender when several agents are @-mentioned', () => {
    const r = misdirectedAgentMention(input({ content: '@Lyra @Atlas numbers' }));
    expect(r?.mentioned).toEqual(['mkt-lyra-1', ATLAS]);
    expect(r?.message).toContain(`send-message --to ${ATLAS}`);
  });
});
