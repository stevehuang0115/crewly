/**
 * Tests for listChannelMembersWithToken — no real Slack call (fetch is a fake).
 *
 * @module services/slack/slack-channel-members.test
 */

import { listChannelMembersWithToken } from './slack-channel-members.js';

function reply(body: unknown, status = 200) {
  return { status, json: async () => body } as unknown as Response;
}

describe('listChannelMembersWithToken', () => {
  it('pages through the members with the given bot token', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(reply({ ok: true, members: ['U1', 'U2'], response_metadata: { next_cursor: 'c2' } }))
      .mockResolvedValueOnce(reply({ ok: true, members: ['U3'], response_metadata: { next_cursor: '' } }));
    const out = await listChannelMembersWithToken('C1', 'xoxb-ella', fetchImpl as unknown as typeof fetch);
    expect(out).toEqual({ ok: true, members: ['U1', 'U2', 'U3'] });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer xoxb-ella');
    expect(String(fetchImpl.mock.calls[1][0])).toContain('cursor=c2');
  });

  it('returns Slack\'s error (the bot is not in the channel) and never throws', async () => {
    const notIn = jest.fn().mockResolvedValue(reply({ ok: false, error: 'not_in_channel' }));
    expect(await listChannelMembersWithToken('C1', 't', notIn as unknown as typeof fetch)).toEqual({ ok: false, error: 'not_in_channel' });
    const limited = jest.fn().mockResolvedValue(reply({}, 429));
    expect(await listChannelMembersWithToken('C1', 't', limited as unknown as typeof fetch)).toEqual({ ok: false, error: 'rate_limited' });
    const broken = jest.fn().mockRejectedValue(new Error('offline'));
    expect(await listChannelMembersWithToken('C1', 't', broken as unknown as typeof fetch)).toEqual({ ok: false, error: 'offline' });
  });
});
