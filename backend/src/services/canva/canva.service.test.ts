/**
 * Tests for CanvaService — list/get/create request shapes, export job
 * polling, asset upload headers, error mapping.
 *
 * @module services/canva/canva.service.test
 */

import { CanvaService, buildExportFormat, toDesign } from './canva.service.js';
import { CanvaError } from './canva-token.service.js';

const BASE = 'https://api.canva.com/rest/v1';

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

let fetchMock: jest.Mock;
let sleep: jest.Mock;
let now: number;
let canva: CanvaService;
let clearCache: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  sleep = jest.fn().mockResolvedValue(undefined);
  now = 1_800_000_000_000;
  clearCache = jest.fn();
  canva = new CanvaService({
    tokens: { getAccessToken: jest.fn().mockResolvedValue('cnv.tok'), clearCache },
    fetchImpl: fetchMock as unknown as typeof fetch,
    sleep,
    now: () => now,
  });
});

describe('listDesigns / getDesign', () => {
  it('lists with query/ownership/sort/limit and trims items (unix → ISO)', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { items: [{ id: 'd1', title: 'Poster', urls: { edit_url: 'https://e', view_url: 'https://v' }, thumbnail: { url: 'https://t' }, page_count: 2, created_at: 1700000000, updated_at: 1700000001 }], continuation: 'next' }));
    const out = await canva.listDesigns({ query: 'poster', ownership: 'owned', sortBy: 'modified_descending', limit: 500 });
    expect(out.continuation).toBe('next');
    expect(out.designs).toEqual([{ id: 'd1', title: 'Poster', editUrl: 'https://e', viewUrl: 'https://v', thumbnailUrl: 'https://t', pageCount: 2, createdAt: '2023-11-14T22:13:20.000Z', updatedAt: '2023-11-14T22:13:21.000Z' }]);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe(`${BASE}/designs`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '100', query: 'poster', ownership: 'owned', sort_by: 'modified_descending' });
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({ Authorization: 'Bearer cnv.tok', Accept: 'application/json' });
  });

  it('gets one design and validates the id', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { design: { id: 'd 1', title: 'x' } }));
    await expect(canva.getDesign('d 1')).resolves.toEqual({ id: 'd 1', title: 'x' });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/designs/d%201`);
    await expect(canva.getDesign(' ')).rejects.toMatchObject({ status: 400, code: 'validation' });
    expect(toDesign({})).toEqual({ id: '', title: '' });
  });
});

describe('createDesign', () => {
  it('POSTs a preset, a custom size, or an asset-based design', async () => {
    fetchMock.mockResolvedValue(response(200, { design: { id: 'n', title: 'T', urls: { edit_url: 'https://e' } } }));
    await expect(canva.createDesign({ title: 'T', preset: 'Presentation' })).resolves.toMatchObject({ id: 'n', editUrl: 'https://e' });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ title: 'T', design_type: { type: 'preset', name: 'presentation' } });
    await canva.createDesign({ width: 1080, height: 1920, assetId: 'a1' });
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({ design_type: { type: 'custom', width: 1080, height: 1920 }, asset_id: 'a1' });
    await canva.createDesign({ assetId: 'a2' });
    expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string)).toEqual({ asset_id: 'a2' });
  });

  it('rejects unknown presets, bad sizes and an empty request', async () => {
    await expect(canva.createDesign({ preset: 'poster' })).rejects.toMatchObject({ code: 'validation' });
    await expect(canva.createDesign({ width: 10, height: 100 })).rejects.toMatchObject({ code: 'validation' });
    await expect(canva.createDesign({ title: 'only' })).rejects.toMatchObject({ code: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('exportDesign', () => {
  it('starts the job, polls until success and returns the URLs', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { job: { id: 'j1', status: 'in_progress' } }))
      .mockResolvedValueOnce(response(200, { job: { id: 'j1', status: 'in_progress' } }))
      .mockResolvedValueOnce(response(200, { job: { id: 'j1', status: 'success', urls: ['https://dl/1.pdf'] } }));
    const out = await canva.exportDesign({ designId: 'd1', format: 'pdf', pages: [1, 2] });
    expect(out).toEqual({ jobId: 'j1', status: 'success', urls: ['https://dl/1.pdf'] });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/exports`);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ design_id: 'd1', format: { type: 'pdf', pages: [1, 2] } });
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/exports/j1`);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('surfaces a failed job and times out a job that never finishes', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { job: { id: 'j2', status: 'failed', error: { code: 'design_too_big', message: 'nope' } } }));
    await expect(canva.exportDesign({ designId: 'd1', format: 'png' })).resolves.toMatchObject({ status: 'failed', error: { code: 'design_too_big' } });

    fetchMock.mockResolvedValue(response(200, { job: { id: 'j3', status: 'in_progress' } }));
    sleep.mockImplementation(async () => { now += 60_000; });
    await expect(canva.exportDesign({ designId: 'd1', format: 'mp4' })).rejects.toMatchObject({ status: 504 });
  });

  it('buildExportFormat: jpg quality, mp4 preset, unknown format', () => {
    expect(buildExportFormat({ designId: 'd', format: 'JPG', quality: 70 })).toEqual({ type: 'jpg', quality: 70 });
    expect(buildExportFormat({ designId: 'd', format: 'mp4' })).toEqual({ type: 'mp4', quality: 'horizontal_1080p' });
    expect(buildExportFormat({ designId: 'd', format: 'pptx', pages: [0, 2, 'x' as never] })).toEqual({ type: 'pptx', pages: [2] });
    expect(() => buildExportFormat({ designId: 'd', format: 'svg' })).toThrow(CanvaError);
    expect(() => buildExportFormat({ designId: 'd', format: 'jpg', quality: 101 })).toThrow(CanvaError);
  });
});

describe('uploadAsset', () => {
  it('POSTs the bytes with the base64 name header and polls the job', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { job: { id: 'u1', status: 'in_progress' } }))
      .mockResolvedValueOnce(response(200, { job: { id: 'u1', status: 'success', asset: { id: 'as1', name: 'logo.png', thumbnail: { url: 'https://t' }, created_at: 1700000000 } } }));
    const asset = await canva.uploadAsset('logo.png', Buffer.from([1, 2, 3]));
    expect(asset).toEqual({ id: 'as1', name: 'logo.png', thumbnailUrl: 'https://t', createdAt: '2023-11-14T22:13:20.000Z' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/asset-uploads`);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
    expect((init.headers as Record<string, string>)['Asset-Upload-Metadata']).toBe(JSON.stringify({ name_base64: Buffer.from('logo.png').toString('base64') }));
    expect(init.body).toEqual(Buffer.from([1, 2, 3]));
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/asset-uploads/u1`);
  });

  it('validates input and maps a failed job to 502', async () => {
    await expect(canva.uploadAsset('', Buffer.from('x'))).rejects.toMatchObject({ code: 'validation' });
    await expect(canva.uploadAsset('a', Buffer.alloc(0))).rejects.toMatchObject({ code: 'validation' });
    fetchMock.mockResolvedValueOnce(response(200, { job: { id: 'u2', status: 'failed', error: { message: 'file_too_big' } } }));
    await expect(canva.uploadAsset('a', Buffer.from('x'))).rejects.toMatchObject({ status: 502, message: expect.stringContaining('file_too_big') });
  });
});

describe('error mapping', () => {
  it('401 clears the token cache; 403/404/429 pass through; others fold to 502; unreachable → network', async () => {
    fetchMock.mockResolvedValueOnce(response(401, { code: 'unauthorized', message: 'expired' }));
    await expect(canva.getDesign('d')).rejects.toMatchObject({ status: 401 });
    expect(clearCache).toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(response(429, { message: 'slow down' }));
    await expect(canva.getDesign('d')).rejects.toMatchObject({ status: 429, message: 'slow down' });
    fetchMock.mockResolvedValueOnce(response(500, 'boom'));
    await expect(canva.getDesign('d')).rejects.toMatchObject({ status: 502, message: 'boom' });
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(canva.getDesign('d')).rejects.toMatchObject({ code: 'network' });
  });
});
