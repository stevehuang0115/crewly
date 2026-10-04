/**
 * Tests for DocsService — body flattening (headings, bullets, tables),
 * create + insertText, append at the end index.
 *
 * @module services/google/docs.service.test
 */

import { DocsService, docEndIndex, flattenDocBody } from './docs.service.js';
import type { GoogleApiDeps } from './google-api.client.js';

const BASE = 'https://docs.googleapis.com/v1';

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

const para = (text: string, style?: string, bullet = false) => ({
  paragraph: { elements: [{ textRun: { content: `${text}\n` } }], ...(style ? { paragraphStyle: { namedStyleType: style } } : {}), ...(bullet ? { bullet: {} } : {}) },
});

let fetchMock: jest.Mock;
let docs: DocsService;

beforeEach(() => {
  fetchMock = jest.fn();
  const deps: GoogleApiDeps = {
    tokens: { getAccessToken: jest.fn().mockResolvedValue('ya29.tok'), clearCache: jest.fn() },
    fetchImpl: fetchMock as unknown as typeof fetch,
  };
  docs = new DocsService(deps);
});

describe('flattenDocBody', () => {
  it('prefixes headings and bullets, joins table cells, collapses blank runs', () => {
    const text = flattenDocBody([
      para('Plan', 'HEADING_1'),
      para(''),
      para(''),
      para('Step one', undefined, true),
      { table: { tableRows: [{ tableCells: [{ content: [para('a')] }, { content: [para('b')] }] }] } },
      { sectionBreak: {} },
    ]);
    expect(text).toBe('# Plan\n\n- Step one\na | b');
    expect(docEndIndex({ body: { content: [{ endIndex: 1 }, { endIndex: 42 }] } })).toBe(41);
    expect(docEndIndex({})).toBe(1);
  });
});

describe('read', () => {
  it('GETs the document and flattens it', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { documentId: 'd1', title: 'T', body: { content: [para('hello')] } }));
    await expect(docs.read('d1')).resolves.toEqual({ id: 'd1', title: 'T', text: 'hello', webViewLink: 'https://docs.google.com/document/d/d1/edit' });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/documents/d1`);
  });

  it('turns "must not be an Office file" into a validation error that points at drive-read', async () => {
    fetchMock.mockResolvedValueOnce(response(400, { error: { code: 400, message: 'The document must not be an Office file.' } }));
    const err = await docs.read('docx1').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, code: 'validation' });
    expect((err as Error).message).toMatch(/drive-read --id <id> --out/);
    expect((err as Error).message).toMatch(/docs-comment/);
  });

  it('passes other failures through unchanged', async () => {
    fetchMock.mockResolvedValueOnce(response(404, { error: { code: 404, message: 'Requested entity was not found.' } }));
    await expect(docs.read('nope')).rejects.toMatchObject({ status: 404, code: 'google_error' });
  });
});

describe('create', () => {
  it('creates with the title then inserts the body at index 1', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { documentId: 'n1', title: 'Notes' })).mockResolvedValueOnce(response(200, {}));
    await expect(docs.create({ title: 'Notes', text: 'line1\r\nline2' })).resolves.toEqual({ id: 'n1', title: 'Notes', text: 'line1\nline2', webViewLink: 'https://docs.google.com/document/d/n1/edit' });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ title: 'Notes' });
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/documents/n1:batchUpdate`);
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({ requests: [{ insertText: { location: { index: 1 }, text: 'line1\nline2' } }] });
  });

  it('skips the insert for an empty body and validates the title', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { documentId: 'n2', title: 'Empty' }));
    await docs.create({ title: 'Empty' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(docs.create({ title: ' ' })).rejects.toMatchObject({ status: 400, code: 'validation' });
  });
});

describe('append', () => {
  it('inserts a newline + text at the end index and returns the re-read document', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { documentId: 'd1', body: { content: [{ endIndex: 1 }, { endIndex: 10 }] } }))
      .mockResolvedValueOnce(response(200, {}))
      .mockResolvedValueOnce(response(200, { documentId: 'd1', title: 'T', body: { content: [para('old'), para('new')] } }));
    await expect(docs.append('d1', 'new')).resolves.toMatchObject({ text: 'old\nnew' });
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({ requests: [{ insertText: { location: { index: 9 }, text: '\nnew' } }] });
  });

  it('writes without a leading newline into an empty document, and validates text', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { documentId: 'e', body: { content: [{ endIndex: 2 }] } })).mockResolvedValueOnce(response(200, {})).mockResolvedValueOnce(response(200, { documentId: 'e' }));
    await docs.append('e', 'first');
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string).requests[0].insertText).toEqual({ location: { index: 1 }, text: 'first' });
    await expect(docs.append('e', '  ')).rejects.toMatchObject({ code: 'validation' });
  });
});
