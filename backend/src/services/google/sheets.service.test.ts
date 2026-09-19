/**
 * Tests for SheetsService — info/read request shapes, create + initial
 * rows, append vs update, row validation.
 *
 * @module services/google/sheets.service.test
 */

import { SheetsService, quoteSheet, requireRows } from './sheets.service.js';
import type { GoogleApiDeps } from './google-api.client.js';

const BASE = 'https://sheets.googleapis.com/v4';

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

let fetchMock: jest.Mock;
let sheets: SheetsService;

beforeEach(() => {
  fetchMock = jest.fn();
  const deps: GoogleApiDeps = {
    tokens: { getAccessToken: jest.fn().mockResolvedValue('ya29.tok'), clearCache: jest.fn() },
    fetchImpl: fetchMock as unknown as typeof fetch,
  };
  sheets = new SheetsService(deps);
});

describe('info / read', () => {
  it('reads properties with a field mask and lists the tabs', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { spreadsheetId: 's1', properties: { title: 'Budget' }, spreadsheetUrl: 'https://u', sheets: [{ properties: { title: 'Q3', gridProperties: { rowCount: 100, columnCount: 26 } } }] }));
    await expect(sheets.info('s1')).resolves.toEqual({ id: 's1', title: 'Budget', webViewLink: 'https://u', sheets: [{ title: 'Q3', rowCount: 100, columnCount: 26 }] });
    expect(fetchMock.mock.calls[0][0]).toContain(`${BASE}/spreadsheets/s1?fields=`);
  });

  it('reads a range unformatted, defaulting to A1:Z1000', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { range: 'Q3!A1:B2', values: [['a', 1], ['b', true]] }));
    await expect(sheets.read('s1', 'Q3!A1:B2')).resolves.toEqual({ spreadsheetId: 's1', range: 'Q3!A1:B2', rows: [['a', 1], ['b', true]] });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/spreadsheets/s1/values/Q3!A1%3AB2?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`);
    fetchMock.mockResolvedValueOnce(response(200, {}));
    await expect(sheets.read('s1')).resolves.toEqual({ spreadsheetId: 's1', range: 'A1:Z1000', rows: [] });
    expect(fetchMock.mock.calls[1][0]).toContain('/values/A1%3AZ1000?');
  });
});

describe('create', () => {
  it('creates with the title + first sheet, then writes the initial rows from A1', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { spreadsheetId: 'n1', properties: { title: 'Leads' }, sheets: [{ properties: { title: 'Raw data' } }] }))
      .mockResolvedValueOnce(response(200, { updatedRange: "'Raw data'!A1:B2", updatedRows: 2 }));
    const info = await sheets.create({ title: 'Leads', sheetTitle: 'Raw data', rows: [['name', 'email'], ['Ann', 'a@x']] });
    expect(info).toMatchObject({ id: 'n1', title: 'Leads', sheets: [{ title: 'Raw data' }] });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ properties: { title: 'Leads' }, sheets: [{ properties: { title: 'Raw data' } }] });
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/spreadsheets/n1/values/'Raw%20data'!A1?valueInputOption=USER_ENTERED`);
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('PUT');
  });

  it('validates the title and skips the write without rows', async () => {
    await expect(sheets.create({ title: '' })).rejects.toMatchObject({ code: 'validation' });
    fetchMock.mockResolvedValueOnce(response(200, { spreadsheetId: 'n2', properties: { title: 'x' } }));
    await sheets.create({ title: 'x' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('append / update', () => {
  it('appends with USER_ENTERED + INSERT_ROWS and reports the updated range', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { updates: { updatedRange: 'Sheet1!A3:B3', updatedRows: 1 } }));
    await expect(sheets.append({ spreadsheetId: 's1', rows: [['c', 3]] })).resolves.toEqual({ spreadsheetId: 's1', updatedRange: 'Sheet1!A3:B3', updatedRows: 1 });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/spreadsheets/s1/values/A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ values: [['c', 3]] });
  });

  it('updates in place and normalises null cells', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { updatedRange: 'Q3!B2:C2', updatedRows: 1 }));
    await expect(sheets.update({ spreadsheetId: 's1', range: 'Q3!B2', rows: [[null as never, 'x']] })).resolves.toMatchObject({ updatedRange: 'Q3!B2:C2' });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ values: [['', 'x']] });
  });

  it('requireRows rejects empty, ragged types and oversized input; quoteSheet quotes when needed', () => {
    expect(() => requireRows([])).toThrow();
    expect(() => requireRows(['a'])).toThrow();
    expect(() => requireRows([[{ a: 1 }]])).toThrow();
    expect(() => requireRows(Array.from({ length: 5001 }, () => ['x']))).toThrow();
    expect(requireRows([['a', 1, true]])).toEqual([['a', 1, true]]);
    expect(quoteSheet('Sheet1')).toBe('Sheet1');
    expect(quoteSheet("Q3 'final'")).toBe("'Q3 ''final'''");
  });
});
