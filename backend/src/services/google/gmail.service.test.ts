/**
 * Tests for GmailService — exact Gmail request shapes for search / read /
 * send over a fake fetch, the RFC 822 builder, body decoding and the
 * attachment listing.
 *
 * @module services/google/gmail.service.test
 */

import {
  GmailService,
  buildRfc822,
  base64UrlEncode,
  base64UrlDecode,
  encodeHeaderValue,
  stripHtml,
  clampMax,
} from './gmail.service.js';
import type { GoogleApiDeps } from './google-api.client.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

/** base64url of a UTF-8 string, as Gmail returns body data. */
function b64u(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

let fetchMock: jest.Mock;
let deps: GoogleApiDeps;
let gmail: GmailService;

beforeEach(() => {
  fetchMock = jest.fn();
  deps = {
    tokens: { getAccessToken: jest.fn().mockResolvedValue('ya29.tok'), clearCache: jest.fn() },
    fetchImpl: fetchMock as unknown as typeof fetch,
  };
  gmail = new GmailService(deps);
});

function calledUrls(): string[] {
  return fetchMock.mock.calls.map((c) => (c as [string])[0]);
}

describe('search', () => {
  it('lists with q + maxResults, then fetches metadata headers per hit', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }], resultSizeEstimate: 2 }))
      .mockResolvedValueOnce(response(200, {
        id: 'm1', threadId: 't1', snippet: 'hi there', labelIds: ['INBOX', 'UNREAD'],
        payload: { headers: [
          { name: 'From', value: 'Ann <ann@example.com>' },
          { name: 'To', value: 'owner@example.com' },
          { name: 'Subject', value: 'Q3 numbers' },
          { name: 'Date', value: 'Thu, 18 Sep 2026 10:00:00 +0000' },
        ] },
      }))
      .mockResolvedValueOnce(response(200, { id: 'm2', threadId: 't2', payload: { headers: [] } }));

    const hits = await gmail.search({ query: 'is:unread from:ann', max: 2 });

    expect(calledUrls()).toEqual([
      `${BASE}/messages?q=is%3Aunread+from%3Aann&maxResults=2`,
      `${BASE}/messages/m1?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
      `${BASE}/messages/m2?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
    ]);
    for (const call of fetchMock.mock.calls) {
      expect(((call as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBe('Bearer ya29.tok');
    }
    expect(hits).toEqual([
      { id: 'm1', threadId: 't1', from: 'Ann <ann@example.com>', to: 'owner@example.com', subject: 'Q3 numbers', date: 'Thu, 18 Sep 2026 10:00:00 +0000', snippet: 'hi there', labelIds: ['INBOX', 'UNREAD'] },
      { id: 'm2', threadId: 't2', from: '', to: '', subject: '', date: '', snippet: '', labelIds: [] },
    ]);
  });

  it('uses the default cap of 20 and returns [] with no second round-trip on no hits', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { resultSizeEstimate: 0 }));
    await expect(gmail.search({ query: 'nothing' })).resolves.toEqual([]);
    expect(calledUrls()).toEqual([`${BASE}/messages?q=nothing&maxResults=20`]);
  });

  it('clamps max into [1, 100]', async () => {
    fetchMock.mockResolvedValue(response(200, {}));
    await gmail.search({ query: 'a', max: 500 });
    await gmail.search({ query: 'a', max: 0 });
    await gmail.search({ query: 'a', max: Number.NaN });
    expect(calledUrls()).toEqual([
      `${BASE}/messages?q=a&maxResults=100`,
      `${BASE}/messages?q=a&maxResults=1`,
      `${BASE}/messages?q=a&maxResults=20`,
    ]);
  });
});

describe('read', () => {
  it('fetches format=full, prefers the text/plain part and lists attachments without downloading them', async () => {
    fetchMock.mockResolvedValueOnce(response(200, {
      id: 'm1', threadId: 't1', snippet: 'snip', labelIds: ['INBOX'],
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: 'ann@example.com' },
          { name: 'To', value: 'owner@example.com' },
          { name: 'Cc', value: 'bob@example.com' },
          { name: 'Subject', value: '你好' },
          { name: 'Date', value: 'D' },
          { name: 'Message-Id', value: '<abc@mail.example.com>' },
        ],
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [
              { mimeType: 'text/html', body: { data: b64u('<p>Hello <b>world</b></p>') } },
              { mimeType: 'text/plain', body: { data: b64u('Hello world\n— Ann') } },
            ],
          },
          { mimeType: 'application/pdf', filename: 'deck.pdf', body: { attachmentId: 'ATT1', size: 12345 } },
        ],
      },
    }));

    const msg = await gmail.read('m1');

    expect(calledUrls()).toEqual([`${BASE}/messages/m1?format=full`]);
    expect(msg).toEqual({
      id: 'm1', threadId: 't1', from: 'ann@example.com', to: 'owner@example.com', cc: 'bob@example.com',
      subject: '你好', date: 'D', messageId: '<abc@mail.example.com>', snippet: 'snip',
      body: 'Hello world\n— Ann', bodyType: 'text',
      attachments: [{ filename: 'deck.pdf', mimeType: 'application/pdf', size: 12345, attachmentId: 'ATT1' }],
      labelIds: ['INBOX'],
    });
  });

  it('falls back to stripped text/html when there is no text/plain part', async () => {
    fetchMock.mockResolvedValueOnce(response(200, {
      id: 'm2', threadId: 't2',
      payload: { mimeType: 'text/html', headers: [], body: { data: b64u('<div>Line one<br>Line &amp; two</div><style>p{}</style>') } },
    }));
    const msg = await gmail.read('m2');
    expect(msg.bodyType).toBe('html');
    expect(msg.body).toBe('Line one\nLine & two');
    expect(msg.attachments).toEqual([]);
  });

  it('reports bodyType none for a message with no inline text and rejects an empty id', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { id: 'm3', threadId: 't3', payload: { headers: [] } }));
    await expect(gmail.read('m3')).resolves.toMatchObject({ body: '', bodyType: 'none' });
    await expect(gmail.read('')).rejects.toMatchObject({ status: 400, code: 'validation' });
  });

  it('surfaces a Gmail 404 as 404', async () => {
    fetchMock.mockResolvedValueOnce(response(404, { error: { message: 'Requested entity was not found.' } }));
    await expect(gmail.read('nope')).rejects.toMatchObject({ status: 404, code: 'google_error' });
  });
});

describe('send', () => {
  it('POSTs messages.send with a base64url RFC 822 raw and the threadId when replying', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { id: 's1', threadId: 't1', labelIds: ['SENT'] }));

    const result = await gmail.send({
      to: 'ann@example.com',
      cc: 'bob@example.com',
      subject: 'Re: Q3 numbers',
      text: 'Looks good.\nThanks!',
      threadId: 't1',
      inReplyTo: '<abc@mail.example.com>',
    });

    expect(result).toEqual({ id: 's1', threadId: 't1', labelIds: ['SENT'] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/messages/send`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as { raw: string; threadId?: string };
    expect(body.threadId).toBe('t1');
    expect(body.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(base64UrlDecode(body.raw)).toBe(
      'To: ann@example.com\r\n' +
      'Cc: bob@example.com\r\n' +
      'Subject: Re: Q3 numbers\r\n' +
      'In-Reply-To: <abc@mail.example.com>\r\n' +
      'References: <abc@mail.example.com>\r\n' +
      'MIME-Version: 1.0\r\n' +
      'Content-Type: text/plain; charset="UTF-8"\r\n' +
      'Content-Transfer-Encoding: base64\r\n' +
      '\r\n' +
      Buffer.from('Looks good.\nThanks!', 'utf8').toString('base64'),
    );
  });

  it('omits threadId/Cc/In-Reply-To when not given', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { id: 's2', threadId: 't2' }));
    await gmail.send({ to: 'a@b.c', subject: 'Hi', text: 'x' });
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as { raw: string; threadId?: string };
    expect(body.threadId).toBeUndefined();
    const raw = base64UrlDecode(body.raw);
    expect(raw).not.toMatch(/^Cc:/m);
    expect(raw).not.toMatch(/^In-Reply-To:/m);
    expect(raw.startsWith('To: a@b.c\r\nSubject: Hi\r\n')).toBe(true);
  });

  it('refuses to send without to/subject and never calls Gmail', async () => {
    await expect(gmail.send({ to: '', subject: 'Hi', text: 'x' })).rejects.toMatchObject({ status: 400, code: 'validation' });
    await expect(gmail.send({ to: 'a@b.c', subject: '  ', text: 'x' })).rejects.toMatchObject({ status: 400, code: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('buildRfc822 / encoding helpers', () => {
  it('encodes a non-ASCII subject as an RFC 2047 UTF-8 encoded-word and leaves ASCII alone', () => {
    expect(encodeHeaderValue('Plain subject')).toBe('Plain subject');
    expect(encodeHeaderValue('第三季度数据')).toBe(`=?UTF-8?B?${Buffer.from('第三季度数据', 'utf8').toString('base64')}?=`);
    expect(buildRfc822({ to: 'a@b.c', subject: '第三季度数据', text: '' })).toContain('Subject: =?UTF-8?B?');
  });

  it('wraps the base64 body at 76 columns with CRLF', () => {
    const raw = buildRfc822({ to: 'a@b.c', subject: 'long', text: 'x'.repeat(200) });
    const body = raw.split('\r\n\r\n')[1];
    const lines = body.split('\r\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(76);
    expect(Buffer.from(lines.join(''), 'base64').toString('utf8')).toBe('x'.repeat(200));
  });

  it('round-trips base64url', () => {
    expect(base64UrlDecode(base64UrlEncode('héllo ✓'))).toBe('héllo ✓');
    expect(base64UrlEncode('>>>???')).not.toMatch(/[+/=]/);
  });

  it('stripHtml turns blocks into lines and unescapes entities', () => {
    expect(stripHtml('<p>a&nbsp;b</p><p>c &lt;d&gt;</p><script>x()</script>')).toBe('a b\nc <d>');
  });

  it('clampMax defaults and clamps', () => {
    expect(clampMax(undefined, 20, 100)).toBe(20);
    expect(clampMax(7.9, 20, 100)).toBe(7);
    expect(clampMax(-3, 20, 100)).toBe(1);
    expect(clampMax(1e9, 20, 100)).toBe(100);
  });
});
