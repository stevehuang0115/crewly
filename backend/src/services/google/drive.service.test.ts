/**
 * Tests for DriveService — query building, search/get request shapes,
 * export vs download vs binary reads, multipart upload.
 *
 * @module services/google/drive.service.test
 */

import { DriveService, buildDriveQuery, escapeDriveQuery, isTextMime, requireId, toDriveFile } from './drive.service.js';
import type { GoogleApiDeps } from './google-api.client.js';

const BASE = 'https://www.googleapis.com/drive/v3';

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

let fetchMock: jest.Mock;
let drive: DriveService;

beforeEach(() => {
  fetchMock = jest.fn();
  const deps: GoogleApiDeps = {
    tokens: { getAccessToken: jest.fn().mockResolvedValue('ya29.tok'), clearCache: jest.fn() },
    fetchImpl: fetchMock as unknown as typeof fetch,
  };
  drive = new DriveService(deps);
});

describe('buildDriveQuery', () => {
  it('always excludes trash, matches name or fullText, and escapes quotes', () => {
    expect(buildDriveQuery({})).toBe('trashed = false');
    expect(buildDriveQuery({ query: "Q3 'plan'", mimeType: 'application/vnd.google-apps.spreadsheet', folderId: 'f1' })).toBe(
      "trashed = false and (name contains 'Q3 \\'plan\\'' or fullText contains 'Q3 \\'plan\\'') and mimeType = 'application/vnd.google-apps.spreadsheet' and 'f1' in parents",
    );
    expect(escapeDriveQuery("a\\b'c")).toBe("a\\\\b\\'c");
  });
});

describe('search / get', () => {
  it('lists with the query, modifiedTime ordering, field mask and a clamped page size', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { files: [{ id: '1', name: 'Plan', mimeType: 'application/vnd.google-apps.document', size: '12', owners: [{ emailAddress: 'a@x' }] }] }));
    const files = await drive.search({ query: 'plan', max: 500 });
    expect(files).toEqual([{ id: '1', name: 'Plan', mimeType: 'application/vnd.google-apps.document', size: 12, owners: ['a@x'] }]);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe(`${BASE}/files`);
    expect(url.searchParams.get('q')).toBe("trashed = false and (name contains 'plan' or fullText contains 'plan')");
    expect(url.searchParams.get('pageSize')).toBe('100');
    expect(url.searchParams.get('orderBy')).toBe('modifiedTime desc');
    expect(url.searchParams.get('includeItemsFromAllDrives')).toBe('true');
  });

  it('gets metadata by id and validates the id', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { id: 'x y', name: 'n', mimeType: 'text/plain' }));
    await expect(drive.get('x y')).resolves.toEqual({ id: 'x y', name: 'n', mimeType: 'text/plain' });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/files/x%20y?fields=id%2Cname%2CmimeType%2CmodifiedTime%2Csize%2CwebViewLink%2Cowners%28emailAddress%29%2Cparents&supportsAllDrives=true`);
    await expect(drive.get('  ')).rejects.toMatchObject({ status: 400, code: 'validation' });
    expect(() => requireId(undefined)).toThrow();
  });
});

describe('readContent', () => {
  it('exports a Google Doc as text/plain', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { id: 'd1', name: 'Doc', mimeType: 'application/vnd.google-apps.document' }))
      .mockResolvedValueOnce(response(200, 'hello world'));
    const out = await drive.readContent('d1');
    expect(out).toMatchObject({ contentType: 'text/plain', content: 'hello world', encoding: 'utf8', bytes: 11 });
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/files/d1/export?mimeType=text%2Fplain`);
  });

  it('downloads a text file with alt=media, and base64s a binary one', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { id: 't', name: 'a.md', mimeType: 'text/markdown', size: '3' }))
      .mockResolvedValueOnce(response(200, '# a'));
    await expect(drive.readContent('t')).resolves.toMatchObject({ content: '# a', encoding: 'utf8', contentType: 'text/markdown' });
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/files/t?alt=media&supportsAllDrives=true`);

    fetchMock
      .mockResolvedValueOnce(response(200, { id: 'b', name: 'a.png', mimeType: 'image/png', size: '2' }))
      .mockResolvedValueOnce(response(200, ''));
    await expect(drive.readContent('b')).resolves.toMatchObject({ content: Buffer.from([1, 2]).toString('base64'), encoding: 'base64', bytes: 2 });
    expect(isTextMime('application/json')).toBe(true);
    expect(isTextMime('image/png')).toBe(false);
  });

  it('refuses oversized binaries and non-exportable Google types', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { id: 'big', name: 'v.mp4', mimeType: 'video/mp4', size: String(50 * 1024 * 1024) }));
    await expect(drive.readContent('big')).rejects.toMatchObject({ status: 413 });
    fetchMock.mockResolvedValueOnce(response(200, { id: 'f', name: 'Form', mimeType: 'application/vnd.google-apps.form' }));
    await expect(drive.readContent('f')).rejects.toMatchObject({ status: 400, code: 'validation' });
  });
});

describe('upload', () => {
  it('POSTs a multipart/related body with metadata + content, honouring folder and conversion', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { id: 'n1', name: 'notes.txt', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://v' }));
    const file = await drive.upload({ name: 'notes.txt', content: 'hi', folderId: 'f9', convertTo: 'application/vnd.google-apps.document' });
    expect(file).toEqual({ id: 'n1', name: 'notes.txt', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://v' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { body: Buffer }];
    expect(url).toContain('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart');
    expect((init.headers as Record<string, string>)['Content-Type']).toMatch(/^multipart\/related; boundary=crewly-/);
    const body = init.body.toString('utf8');
    expect(body).toContain('{"name":"notes.txt","mimeType":"application/vnd.google-apps.document","parents":["f9"]}');
    expect(body).toContain('Content-Type: text/plain\r\n\r\nhi\r\n--');
  });

  it('decodes base64 content and validates name / content', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { id: 'p' }));
    await drive.upload({ name: 'a.png', content: Buffer.from([1, 2, 3]).toString('base64'), encoding: 'base64', mimeType: 'image/png' });
    const body = (fetchMock.mock.calls[0][1] as { body: Buffer }).body;
    expect(body.includes(Buffer.from([1, 2, 3]))).toBe(true);
    expect(body.toString('utf8')).toContain('Content-Type: image/png');
    await expect(drive.upload({ name: '', content: 'x' })).rejects.toMatchObject({ code: 'validation' });
    await expect(drive.upload({ name: 'a', content: '' })).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('toDriveFile', () => {
  it('drops empty optional fields', () => {
    expect(toDriveFile({ id: '1', owners: [], parents: [] })).toEqual({ id: '1', name: '', mimeType: '' });
  });
});
