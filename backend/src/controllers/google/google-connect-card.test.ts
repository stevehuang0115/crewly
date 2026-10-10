/**
 * Tests for the Slack authorization card — the reply an agent gives when a
 * Google product is not connected.
 */

import { buildConnectCard, buildPortalConnectUrl, postConnectCard, setConnectCardDeps, type ConnectCardDeps } from './google-connect-card.js';

/** A minimal Express response that records what was sent. */
function makeRes() {
  const out: { status: number; body: unknown } = { status: 200, body: null };
  const res = {
    status(code: number) { out.status = code; return res; },
    json(body: unknown) { out.body = body; return res; },
  };
  return { res: res as never, out };
}

const deps = (over: Partial<ConnectCardDeps> = {}): ConnectCardDeps => ({
  originFor: async () => ({ slackChannelId: 'C1', slackUserId: 'U1', threadTs: '100.1' }),
  postEphemeral: async () => true,
  ...over,
});

const PORTAL = 'https://crewlyai.com/portal/integrations/google?products=gmail&auto=1';

describe('buildPortalConnectUrl', () => {
  it('builds the portal deep link with products, optional account and auto=1, and no token', () => {
    expect(buildPortalConnectUrl(['gmail'])).toBe(PORTAL);
    expect(buildPortalConnectUrl(['drive', 'gmail'], 'me@x.com')).toBe(
      'https://crewlyai.com/portal/integrations/google?products=drive%2Cgmail&account=me%40x.com&auto=1',
    );
    expect(buildPortalConnectUrl(['gmail'])).not.toContain('token');
  });
});

describe('buildConnectCard', () => {
  it('names the product, puts the portal link on the button, and does not mention expiry', () => {
    const card = buildConnectCard('gmail', PORTAL);

    expect(card.text).toContain('Gmail');
    const section = card.blocks[0] as { accessory: { url: string; text: { text: string } } };
    expect(section.accessory.url).toBe(PORTAL);
    expect(section.accessory.text.text).toBe('Add');
    const context = JSON.stringify(card.blocks[1]);
    expect(context).toContain('Only you can see this');
    expect(JSON.stringify(card.blocks)).not.toMatch(/expire|works once|minutes/i);
  });

  it('says why a reconnect is needed, for which account, on a Reconnect button', () => {
    const card = buildConnectCard('gmail', PORTAL, {
      message: 'Gmail needs re-authorization to save drafts (missing permission). Tap to reconnect — takes 30 seconds on your phone.',
      account: 'owner@gmail.com',
    });
    expect(card.text).toBe('Gmail needs re-authorization to save drafts (missing permission). Tap to reconnect — takes 30 seconds on your phone.');
    const section = card.blocks[0] as { text: { text: string }; accessory: { url: string; text: { text: string } } };
    expect(section.text.text).toBe(card.text);
    expect(section.accessory).toMatchObject({ url: PORTAL, text: { text: 'Reconnect' } });
    const context = JSON.stringify(card.blocks[1]);
    expect(context).toContain('owner@gmail.com');
    expect(context).not.toMatch(/works once/);
  });

  it('falls back to the raw name for a product it has no label for', () => {
    expect(buildConnectCard('sheets', 'u').text).toContain('sheets');
  });
});

describe('postConnectCard', () => {
  afterEach(() => setConnectCardDeps(null));

  it('posts the card in the asker\'s thread, to the asker only, with the portal link', async () => {
    const posted: unknown[][] = [];
    setConnectCardDeps(deps({ postEphemeral: async (...args) => { posted.push(args); return true; } }));
    const { res, out } = makeRes();

    await postConnectCard({ body: { product: 'calendar', channelId: 'chat-1' }, headers: {} } as never, res);

    expect(out.status).toBe(200);
    expect(posted[0][0]).toBe('C1');
    expect(posted[0][1]).toBe('U1');
    expect(posted[0][5]).toBe('100.1');
    const json = JSON.stringify(posted[0][3]);
    expect(json).toContain('https://crewlyai.com/portal/integrations/google?products=calendar&auto=1');
    expect(json).not.toContain('token=');
  });

  it('rejects a product that is not one of ours', async () => {
    setConnectCardDeps(deps());
    const { res, out } = makeRes();
    await postConnectCard({ body: { product: 'dropbox', channelId: 'chat-1' } } as never, res);
    expect(out.status).toBe(400);
  });

  // 2026-10-10: Ruth, answering the owner in a Slack thread, got a 409 twice
  // and the owner never saw a card. No origin means fall back, not give up.
  it('falls back to the agent\'s work place or the owner DM when the origin is unknown', async () => {
    const fallbackPost = jest.fn().mockResolvedValue(true);
    setConnectCardDeps(deps({ originFor: async () => null, fallbackPost }));
    const { res, out } = makeRes();
    await postConnectCard({ body: { product: 'gmail', channelId: 'chat-web', account: 'me@x.com' }, headers: {} } as never, res);
    expect(out.status).toBe(200);
    expect(fallbackPost).toHaveBeenCalledWith(expect.objectContaining({ product: 'gmail', account: 'me@x.com' }));
  });

  it('works without a channel id at all', async () => {
    const fallbackPost = jest.fn().mockResolvedValue(true);
    const originFor = jest.fn();
    setConnectCardDeps(deps({ originFor, fallbackPost }));
    const { res, out } = makeRes();
    await postConnectCard({ body: { product: 'gmail' }, headers: {} } as never, res);
    expect(out.status).toBe(200);
    expect(originFor).not.toHaveBeenCalled();
  });

  it('falls back when Slack refuses the card in the origin', async () => {
    const fallbackPost = jest.fn().mockResolvedValue(true);
    setConnectCardDeps(deps({ postEphemeral: async () => false, fallbackPost }));
    const { res, out } = makeRes();
    await postConnectCard({ body: { product: 'gmail', channelId: 'chat-1' }, headers: {} } as never, res);
    expect(out.status).toBe(200);
    expect(fallbackPost).toHaveBeenCalled();
  });

  it('reports a Slack refusal everywhere rather than claiming it posted', async () => {
    setConnectCardDeps(deps({ postEphemeral: async () => false, fallbackPost: async () => false }));
    const { res, out } = makeRes();
    await postConnectCard({ body: { product: 'gmail', channelId: 'chat-1' }, headers: {} } as never, res);
    expect(out.status).toBe(502);
  });

  it('says Slack is not connected when nothing has been wired', async () => {
    const { res, out } = makeRes();
    await postConnectCard({ body: { product: 'gmail', channelId: 'chat-1' }, headers: {} } as never, res);
    expect(out.status).toBe(503);
  });
});
