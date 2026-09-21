/**
 * Tests for the Slack authorization card — the reply an agent gives when a
 * Google product is not connected.
 */

import { buildConnectCard, postConnectCard, setConnectCardDeps, type ConnectCardDeps } from './google-connect-card.js';

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
  connectUrl: async () => ({ url: 'https://api.crewlyai.com/api/cloud/google/workspace/connect/tk-1', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }),
  postEphemeral: async () => true,
  ...over,
});

describe('buildConnectCard', () => {
  it('names the product, puts the link on the button, and warns it is single-use', () => {
    const card = buildConnectCard('gmail', 'https://x/tk', new Date(Date.now() + 15 * 60_000).toISOString());

    expect(card.text).toContain('Gmail');
    const section = card.blocks[0] as { accessory: { url: string; text: { text: string } } };
    expect(section.accessory.url).toBe('https://x/tk');
    expect(section.accessory.text.text).toBe('Add');
    const context = JSON.stringify(card.blocks[1]);
    // Both facts surprise people, so both are said.
    expect(context).toContain('Only you can see this');
    expect(context).toMatch(/works once/);
  });

  it('falls back to the raw name for a product it has no label for', () => {
    expect(buildConnectCard('sheets', 'u', new Date().toISOString()).text).toContain('sheets');
  });
});

describe('postConnectCard', () => {
  afterEach(() => setConnectCardDeps(null));

  it('posts the card to the asker only, for the product asked about', async () => {
    const posted: unknown[] = [];
    const asked: unknown[] = [];
    setConnectCardDeps(deps({
      connectUrl: async (a) => { asked.push(a); return { url: 'https://x/tk', expiresAt: new Date(Date.now() + 900_000).toISOString() }; },
      postEphemeral: async (...args) => { posted.push(args); return true; },
    }));
    const { res, out } = makeRes();

    await postConnectCard({ body: { product: 'calendar', channelId: 'chat-1' } } as never, res);

    expect(out.status).toBe(200);
    expect(asked[0]).toMatchObject({ products: ['calendar'], slackUserId: 'U1', slackChannelId: 'C1', slackThreadTs: '100.1' });
    expect((posted[0] as unknown[])[0]).toBe('C1');
    expect((posted[0] as unknown[])[1]).toBe('U1');
  });

  it('rejects a product that is not one of ours', async () => {
    setConnectCardDeps(deps());
    const { res, out } = makeRes();
    await postConnectCard({ body: { product: 'dropbox', channelId: 'chat-1' } } as never, res);
    expect(out.status).toBe(400);
  });

  // An agent can be asked this in a chat that never came from Slack; there
  // is no card to show and saying so beats a silent success.
  it('explains when the conversation has no Slack origin', async () => {
    setConnectCardDeps(deps({ originFor: async () => null }));
    const { res, out } = makeRes();
    await postConnectCard({ body: { product: 'gmail', channelId: 'chat-web' } } as never, res);
    expect(out.status).toBe(409);
    expect(JSON.stringify(out.body)).toContain('did not come from Slack');
  });

  it('reports a Slack refusal rather than claiming it posted', async () => {
    setConnectCardDeps(deps({ postEphemeral: async () => false }));
    const { res, out } = makeRes();
    await postConnectCard({ body: { product: 'gmail', channelId: 'chat-1' } } as never, res);
    expect(out.status).toBe(502);
  });

  it('surfaces a Cloud failure instead of posting a broken card', async () => {
    setConnectCardDeps(deps({ connectUrl: async () => { throw new Error('Not signed in to Crewly Cloud.'); } }));
    const { res, out } = makeRes();
    await postConnectCard({ body: { product: 'gmail', channelId: 'chat-1' } } as never, res);
    expect(out.status).toBe(502);
    expect(JSON.stringify(out.body)).toContain('Not signed in');
  });

  it('says Slack is not connected when nothing has been wired', async () => {
    const { res, out } = makeRes();
    await postConnectCard({ body: { product: 'gmail', channelId: 'chat-1' } } as never, res);
    expect(out.status).toBe(503);
  });
});
