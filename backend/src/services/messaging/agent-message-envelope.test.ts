import {
  describeAgentSender,
  formatAgentMessageHeader,
  hasHarnessEnvelope,
  parseAgentMessageSender,
  wrapAgentMessage,
} from './agent-message-envelope.js';

const ATLAS = { session: 'think-tank-atlas-b4e166f6', name: 'Atlas', team: 'Think Tank' };

describe('agent-message-envelope', () => {
  it('formats a short header naming the sender, team and reply route', () => {
    expect(formatAgentMessageHeader(ATLAS)).toBe(
      '[MESSAGE from Atlas (Think Tank) — a colleague, not the owner. Answer with send-message --to think-tank-atlas-b4e166f6; do not post it in an owner thread.]',
    );
  });

  it('falls back to the session when the name is unknown', () => {
    expect(formatAgentMessageHeader({ session: 'x-1' })).toContain('[MESSAGE from x-1 — a colleague');
  });

  it('wraps a bare message (the 2026-10-18 incident text)', () => {
    const out = wrapAgentMessage('Thanks. Two things. (1) Check the 83 s comparison', ATLAS);
    expect(out.split('\n')[0]).toBe(formatAgentMessageHeader(ATLAS));
    expect(out).toContain('\nThanks. Two things.');
  });

  it.each([
    '[CHAT:abc] <owner@Pia> hi',
    '[GCHAT:abc] hi',
    '[CREWLY-DISPATCH] WorkItem wi-1',
    '[SYSTEM] restart',
    '[TASK] do X',
    '[MESSAGE from Atlas — a colleague, not the owner. Answer with send-message --to a-1; do not post it in an owner thread.]\nhi',
    '[RESULT] From x',
    '[scheduler:daily] run',
  ])('does not double-wrap %s', (text) => {
    expect(hasHarnessEnvelope(text)).toBe(true);
    expect(wrapAgentMessage(text, ATLAS)).toBe(text);
  });

  it('reads the sender back from a delivered header', () => {
    expect(parseAgentMessageSender(wrapAgentMessage('hi', ATLAS))).toBe('think-tank-atlas-b4e166f6');
    expect(parseAgentMessageSender('hi')).toBeUndefined();
    expect(parseAgentMessageSender('quote: [MESSAGE from X … send-message --to y-1;]')).toBeUndefined();
  });

  describe('describeAgentSender', () => {
    const lookup = jest.fn(async (s: string) => (s === ATLAS.session ? { member: { name: 'Atlas' }, team: { name: 'Think Tank' } } : null));

    it('names a team member with its team', async () => {
      await expect(describeAgentSender(ATLAS.session, lookup)).resolves.toEqual(ATLAS);
    });

    it('gives null for a harness service (not a member)', async () => {
      await expect(describeAgentSender('workitem-dispatch', lookup)).resolves.toBeNull();
    });

    it('gives null when the lookup fails', async () => {
      await expect(describeAgentSender('a-1', async () => { throw new Error('x'); })).resolves.toBeNull();
    });
  });
});

describe('agent-message-envelope — the route travels in the header (message-routing audit 2026-10-18)', () => {
  it("names the sender's route as a token the recipient's harness reads back", () => {
    const route = { kind: 'owner' as const, conversationId: 'room-brief', thread: 'C0BRIEF01:1790856242.596149' };
    const wrapped = wrapAgentMessage('Please check the launch figures.', { ...ATLAS, route });
    const header = wrapped.split('\n')[0];
    expect(header).toContain('{route: owner room-brief thread C0BRIEF01:1790856242.596149}');
    expect(header).toContain('Atlas answers the owner on it');
    expect(parseAgentMessageSender(wrapped)).toBe(ATLAS.session);
  });

  it('no route → the header is unchanged', () => {
    expect(formatAgentMessageHeader(ATLAS)).not.toContain('{route:');
  });
});
