/**
 * Tests for the owner DM over the Slack Web API: open + post, edit, reading
 * only the owner's replies, errors without the token. Placeholder values only.
 *
 * @module services/slack/slack-owner-direct-dm.test
 */

import { createOwnerDirectDm, decodeSlackText } from './slack-owner-direct-dm.js';

const TOKEN = 'xoxb-placeholder-token';

/**
 * A JSON Response.
 *
 * @param body - JSON body
 * @param status - HTTP status
 * @returns Response
 */
function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('createOwnerDirectDm', () => {
	it('opens the DM once, posts escaped text and edits it', async () => {
		const fetchImpl = jest.fn(async (url: string) => {
			if (url.endsWith('/conversations.open')) return json({ ok: true, channel: { id: 'D123' } });
			if (url.endsWith('/chat.postMessage')) return json({ ok: true, channel: 'D123', ts: '100.1' });
			if (url.endsWith('/chat.update')) return json({ ok: true });
			return json({ ok: false, error: 'unknown' });
		});
		const dm = createOwnerDirectDm({ botToken: TOKEN, ownerUserId: 'U-OWNER', fetchImpl });

		expect(await dm.send('a < b & c')).toEqual({ channelId: 'D123', ts: '100.1' });
		await dm.send('again');
		await dm.update('D123', '100.1', 'new');

		const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
		expect(calls.filter(([u]) => u.endsWith('/conversations.open'))).toHaveLength(1);
		const post = calls.find(([u]) => u.endsWith('/chat.postMessage'))!;
		expect(JSON.parse(post[1].body as string)).toMatchObject({ channel: 'D123', text: 'a &lt; b &amp; c', unfurl_links: false });
		expect((post[1].headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
		const update = calls.find(([u]) => u.endsWith('/chat.update'))!;
		expect(JSON.parse(update[1].body as string)).toEqual({ channel: 'D123', ts: '100.1', text: 'new' });
	});

	it('returns only the owner’s own messages after the notice, oldest first', async () => {
		const fetchImpl = jest.fn(async () =>
			json({
				ok: true,
				messages: [
					{ ts: '103.0', user: 'U-OWNER', text: 'second &amp; last' },
					{ ts: '102.5', user: 'U-OWNER', text: 'bot echo', bot_id: 'B1' },
					{ ts: '102.0', user: 'U-OTHER', text: 'someone else' },
					{ ts: '101.0', user: 'U-OWNER', text: ' <https://x.test|x.test> first ' },
					{ ts: '100.1', user: 'U-OWNER', text: 'the notice ts itself' },
					{ ts: '101.5', user: 'U-OWNER', text: 'joined', subtype: 'channel_join' },
				],
			}),
		);
		const dm = createOwnerDirectDm({ botToken: TOKEN, ownerUserId: 'U-OWNER', fetchImpl });
		const replies = await dm.readOwnerReplies('D123', '100.1');
		expect(replies).toEqual([
			{ ts: '101.0', text: 'https://x.test first' },
			{ ts: '103.0', text: 'second & last' },
		]);
		const [url, init] = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
		expect(url).toContain('/conversations.history?channel=D123&oldest=100.1&inclusive=false');
		expect(init.method).toBe('GET');
	});

	it('throws Slack’s error code, never the token', async () => {
		const dm = createOwnerDirectDm({ botToken: TOKEN, ownerUserId: 'U', fetchImpl: async () => json({ ok: false, error: 'invalid_auth' }) });
		await expect(dm.send('x')).rejects.toThrow('Slack conversations.open failed: invalid_auth');
		const offline = createOwnerDirectDm({
			botToken: TOKEN,
			ownerUserId: 'U',
			fetchImpl: async () => {
				throw new Error('ENOTFOUND');
			},
		});
		const err = await offline.send('x').catch((e: Error) => e);
		expect(String(err)).toContain('unreachable');
		expect(String(err)).not.toContain(TOKEN);
	});
});

describe('decodeSlackText', () => {
	it('undoes Slack escaping and link wrapping', () => {
		expect(decodeSlackText('&lt;a&gt; &amp; <https://x.test|label> <https://y.test>')).toBe('<a> & https://x.test https://y.test');
	});
});
