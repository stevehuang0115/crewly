/**
 * Tests for the remote MCP sign-in card and the Slack notifier: wording,
 * the button carries only the ticket link, the agent's own bot is used for
 * the owner's DM (falling back to the default bot), and nothing is posted
 * without an owner or a token.
 *
 * @module services/connector/remote-mcp-auth-card.test
 */

import { buildRemoteMcpAuthCard, createSlackRemoteMcpNotifier, type CardFetch } from './remote-mcp-auth-card.js';

const LINK = 'https://api.crewlyai.com/api/cloud/mcp-oauth/go/TICKET';

describe('buildRemoteMcpAuthCard', () => {
  it('says what to do and how long the link lives', () => {
    const now = Date.UTC(2026, 9, 8);
    const card = buildRemoteMcpAuthCard('Zoho', LINK, new Date(now + 24 * 3_600_000).toISOString(), now);
    expect(card.text).toBe('Zoho needs you to sign in once. Tap to authorize (works on your phone).');
    const json = JSON.stringify(card.blocks);
    expect(json).toContain('"url":"https://api.crewlyai.com/api/cloud/mcp-oauth/go/TICKET"');
    expect(json).toContain('Authorize');
    expect(json).toContain('about 24 hours');
  });

  it('strips Slack markup from the label', () => {
    expect(buildRemoteMcpAuthCard('<!channel> *Z*', LINK, new Date().toISOString()).text.startsWith('!channel Z needs')).toBe(true);
  });
});

describe('createSlackRemoteMcpNotifier', () => {
  function slack() {
    const calls: Array<{ method: string; token: string; body: Record<string, unknown> }> = [];
    const fetchImpl: CardFetch = async (url, init) => {
      const method = url.split('/').pop()!;
      calls.push({ method, token: String((init?.headers as Record<string, string>)['Authorization']), body: JSON.parse(String(init?.body)) });
      const data = method === 'conversations.open' ? { ok: true, channel: { id: 'D1' } } : { ok: true, ts: '1.0' };
      return new Response(JSON.stringify(data), { status: 200 });
    };
    return { calls, fetchImpl };
  }

  it('posts the card into the owner DM of the agent that needed it', async () => {
    const s = slack();
    const n = createSlackRemoteMcpNotifier({ ownerUserId: () => 'U_OWNER', botTokenFor: (a) => (a === 'dev-1' ? 'xoxb-dev' : 'xoxb-orc'), fetchImpl: s.fetchImpl });
    expect(await n.postAuthCard({ serverLabel: 'Zoho', url: LINK, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), agentSession: 'dev-1' })).toBe(true);
    expect(s.calls.map((c) => c.method)).toEqual(['conversations.open', 'chat.postMessage']);
    expect(s.calls[0]).toMatchObject({ token: 'Bearer xoxb-dev', body: { users: 'U_OWNER' } });
    expect(s.calls[1].body).toMatchObject({ channel: 'D1', unfurl_links: false });
    expect(JSON.stringify(s.calls[1].body.blocks)).toContain(LINK);
  });

  it('falls back to the default bot, and posts nothing without an owner or token', async () => {
    const s = slack();
    const n = createSlackRemoteMcpNotifier({ ownerUserId: () => 'U_OWNER', botTokenFor: (a) => (a ? null : 'xoxb-orc'), fetchImpl: s.fetchImpl });
    await n.postReceipt({ serverLabel: 'Zoho', text: 'Zoho is connected', agentSession: 'dev-1' });
    expect(s.calls[0].token).toBe('Bearer xoxb-orc');
    expect(s.calls[1].body).toMatchObject({ text: 'Zoho is connected' });

    const none = createSlackRemoteMcpNotifier({ ownerUserId: () => null, botTokenFor: () => 'x', fetchImpl: s.fetchImpl });
    expect(await none.postReceipt({ serverLabel: 'Zoho', text: 't' })).toBe(false);
  });
});
