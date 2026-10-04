/**
 * Tests for DocsCommentsService — Drive comments/replies over a mocked fetch:
 * list paging and filters, reply, resolve, add, and the reauth_required
 * mapping for a grant without the full Drive scope.
 *
 * @module services/google/docs-comments.service.test
 */

import { DocsCommentsService, docIdFrom, toDocComment } from './docs-comments.service.js';
import type { GoogleApiDeps } from './google-api.client.js';

const BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_FULL = 'https://www.googleapis.com/auth/drive';
const NARROW = ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'];

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

const googleError = (status: number, message = 'Insufficient permissions') => response(status, { error: { code: status, message } });

let fetchMock: jest.Mock;
let tokens: { getAccessToken: jest.Mock; clearCache: jest.Mock; grantedScopes: jest.Mock };
let svc: DocsCommentsService;

beforeEach(() => {
  fetchMock = jest.fn();
  tokens = { getAccessToken: jest.fn().mockResolvedValue('ya29.tok'), clearCache: jest.fn(), grantedScopes: jest.fn().mockReturnValue(NARROW) };
  const deps: GoogleApiDeps = { tokens, fetchImpl: fetchMock as unknown as typeof fetch, product: 'drive' };
  svc = new DocsCommentsService(deps);
});

function call(i: number): { url: URL; method: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url: new URL(url), method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined };
}

describe('docIdFrom', () => {
  it('accepts a bare id, a Docs URL and a Drive ?id= URL', () => {
    expect(docIdFrom('1AbC')).toBe('1AbC');
    expect(docIdFrom('https://docs.google.com/document/d/1AbC-_x/edit?tab=t.0')).toBe('1AbC-_x');
    expect(docIdFrom('https://drive.google.com/open?id=1Zz')).toBe('1Zz');
    expect(() => docIdFrom('  ')).toThrow('"id" is required');
  });
});

describe('toDocComment', () => {
  it('keeps author, time, quote, anchor, resolved; drops deleted replies', () => {
    expect(
      toDocComment({
        id: 'c1',
        author: { displayName: 'Steve', emailAddress: 's@x.com' },
        createdTime: '2026-10-01T00:00:00Z',
        content: 'Tighten this',
        quotedFileContent: { mimeType: 'text/html', value: 'the intro' },
        anchor: 'kix.abc',
        resolved: false,
        replies: [
          { id: 'r1', author: { displayName: 'Ella' }, createdTime: 't', content: 'Done' },
          { id: 'r2', deleted: true },
        ],
      }),
    ).toEqual({
      id: 'c1',
      author: 'Steve',
      authorEmail: 's@x.com',
      createdTime: '2026-10-01T00:00:00Z',
      content: 'Tighten this',
      quote: 'the intro',
      anchor: 'kix.abc',
      resolved: false,
      replies: [{ id: 'r1', author: 'Ella', createdTime: 't', content: 'Done' }],
    });
  });
});

describe('list', () => {
  it('GETs comments with fields=*, pages, and drops deleted and resolved by default', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { comments: [{ id: 'a', content: 'open' }, { id: 'b', resolved: true }], nextPageToken: 'p2' }))
      .mockResolvedValueOnce(response(200, { comments: [{ id: 'c', deleted: true }, { id: 'd', content: 'open too' }] }));

    const out = await svc.list('https://docs.google.com/document/d/DOC1/edit');

    expect(out.docId).toBe('DOC1');
    expect(out.comments.map((c) => c.id)).toEqual(['a', 'd']);
    expect(out.truncated).toBe(false);
    const first = call(0);
    expect(first.method).toBe('GET');
    expect(`${first.url.origin}${first.url.pathname}`).toBe(`${BASE}/files/DOC1/comments`);
    expect(first.url.searchParams.get('fields')).toBe('*');
    expect(first.url.searchParams.get('pageSize')).toBe('100');
    expect(call(1).url.searchParams.get('pageToken')).toBe('p2');
  });

  it('keeps resolved comments with includeResolved', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { comments: [{ id: 'b', resolved: true }] }));
    const out = await svc.list('DOC1', { includeResolved: true });
    expect(out.comments).toEqual([expect.objectContaining({ id: 'b', resolved: true })]);
  });

  it('stops after COMMENTS_MAX_PAGES and says it truncated', async () => {
    fetchMock.mockResolvedValue(response(200, { comments: [{ id: 'x' }], nextPageToken: 'more' }));
    const out = await svc.list('DOC1');
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(out.truncated).toBe(true);
  });
});

describe('reply / resolve / add', () => {
  it('reply POSTs { content } to the replies endpoint with fields=*', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { id: 'r9', author: { displayName: 'Owner' }, createdTime: 't', content: 'Fixed' }));
    const out = await svc.reply('DOC1', 'c1', 'Fixed');
    const c = call(0);
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe('/drive/v3/files/DOC1/comments/c1/replies');
    expect(c.url.searchParams.get('fields')).toBe('*');
    expect(c.body).toEqual({ content: 'Fixed' });
    expect(out).toEqual({ docId: 'DOC1', commentId: 'c1', id: 'r9', author: 'Owner', createdTime: 't', content: 'Fixed' });
  });

  it('resolve sends action:"resolve", with the message only when given', async () => {
    fetchMock.mockResolvedValue(response(200, { id: 'r1', action: 'resolve' }));
    await svc.resolve('DOC1', 'c1', 'Done in v2');
    expect(call(0).body).toEqual({ action: 'resolve', content: 'Done in v2' });
    const out = await svc.resolve('DOC1', 'c1');
    expect(call(1).body).toEqual({ action: 'resolve' });
    expect(out).toMatchObject({ commentId: 'c1', action: 'resolve', resolved: true });
  });

  it('add POSTs a comment, with quotedFileContent only when quoted', async () => {
    fetchMock.mockResolvedValue(response(200, { id: 'c7', content: 'Source?' }));
    await svc.add('DOC1', 'Source?', 'grew 40%');
    const c = call(0);
    expect(c.url.pathname).toBe('/drive/v3/files/DOC1/comments');
    expect(c.body).toEqual({ content: 'Source?', quotedFileContent: { mimeType: 'text/plain', value: 'grew 40%' } });
    const out = await svc.add('DOC1', 'General note');
    expect(call(1).body).toEqual({ content: 'General note' });
    expect(out).toMatchObject({ docId: 'DOC1', id: 'c7', resolved: false, replies: [] });
  });

  it('refuses empty text and a missing comment id before calling Google', async () => {
    await expect(svc.reply('DOC1', 'c1', '  ')).rejects.toMatchObject({ status: 400, code: 'validation' });
    await expect(svc.reply('DOC1', '', 'x')).rejects.toMatchObject({ status: 400, code: 'validation' });
    await expect(svc.add('DOC1', '')).rejects.toMatchObject({ status: 400, code: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('reauth_required', () => {
  it('maps a write 403 to reauth_required when the grant lacks drive and the doc is readable', async () => {
    fetchMock.mockResolvedValueOnce(googleError(403)).mockResolvedValueOnce(response(200, { id: 'DOC1' }));
    await expect(svc.reply('DOC1', 'c1', 'hi')).rejects.toMatchObject({
      status: 403,
      code: 'reauth_required',
      message: expect.stringContaining('Google Drive edit access'),
    });
    expect(call(1).url.pathname).toBe('/drive/v3/files/DOC1');
    expect(tokens.clearCache).toHaveBeenCalled();
  });

  it('treats a drive.file 404 the same way', async () => {
    fetchMock.mockResolvedValueOnce(googleError(404, 'File not found')).mockResolvedValueOnce(response(200, { id: 'DOC1' }));
    await expect(svc.resolve('DOC1', 'c1')).rejects.toMatchObject({ code: 'reauth_required' });
  });

  it('passes the error through when the doc itself is not readable (wrong id)', async () => {
    fetchMock.mockResolvedValueOnce(googleError(404, 'File not found')).mockResolvedValueOnce(googleError(404, 'File not found'));
    await expect(svc.add('NOPE', 'x')).rejects.toMatchObject({ status: 404, code: 'google_error' });
    expect(tokens.clearCache).not.toHaveBeenCalled();
  });

  it('passes the error through when the grant already has full drive', async () => {
    tokens.grantedScopes.mockReturnValue([...NARROW, DRIVE_FULL]);
    fetchMock.mockResolvedValueOnce(googleError(403, 'The user does not have sufficient permissions for this file.'));
    await expect(svc.reply('DOC1', 'c1', 'hi')).rejects.toMatchObject({ status: 403, code: 'google_error' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes the error through when the provider cannot report scopes', async () => {
    tokens.grantedScopes.mockReturnValue(undefined);
    fetchMock.mockResolvedValueOnce(googleError(403));
    await expect(svc.reply('DOC1', 'c1', 'hi')).rejects.toMatchObject({ code: 'google_error' });
  });
});
