/**
 * SheetsService — Google Sheets over the owner's Workspace grant.
 *
 * Reads any spreadsheet the owner can see (`drive.readonly`), creates new
 * spreadsheets and writes to the ones Crewly created (`drive.file`).
 * Writing to a spreadsheet made elsewhere needs the `spreadsheets` scope
 * the grant does not carry yet; Google answers 403 and the error says so.
 *
 * @module services/google/sheets.service
 */

import { GOOGLE_WORKSPACE_CONSTANTS } from '../../constants.js';
import { GoogleWorkspaceError } from './google-workspace-token.service.js';
import { buildGoogleUrl, googleRequest, type GoogleApiDeps } from './google-api.client.js';
import { requireId } from './drive.service.js';

/** A cell value as the API returns it (strings/numbers/booleans). */
export type SheetCell = string | number | boolean;

/** A rectangular block of values. */
export interface SheetValues {
  spreadsheetId: string;
  range: string;
  rows: SheetCell[][];
}

/** Spreadsheet metadata. */
export interface SpreadsheetInfo {
  id: string;
  title: string;
  sheets: Array<{ title: string; rowCount?: number; columnCount?: number }>;
  webViewLink: string;
}

/** Create input. */
export interface SheetCreateInput {
  title: string;
  /** Name of the first sheet tab (default "Sheet1"). */
  sheetTitle?: string;
  /** Initial rows written from A1. */
  rows?: SheetCell[][];
}

/** Write input (append or overwrite). */
export interface SheetWriteInput {
  spreadsheetId: string;
  /** A1 range; for append the table it belongs to, for update the top-left anchor. */
  range?: string;
  rows: SheetCell[][];
}

interface WireSpreadsheet {
  spreadsheetId?: string;
  properties?: { title?: string };
  sheets?: Array<{ properties?: { title?: string; gridProperties?: { rowCount?: number; columnCount?: number } } }>;
  spreadsheetUrl?: string;
}

/**
 * Validate rows for a write.
 *
 * @param rows - Candidate rows
 * @returns The rows
 * @throws GoogleWorkspaceError(400, validation) when empty, not rectangular-ish, or too many
 */
export function requireRows(rows: unknown): SheetCell[][] {
  const CODES = GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES;
  if (!Array.isArray(rows) || rows.length === 0) throw new GoogleWorkspaceError(400, CODES.VALIDATION, '"rows" must be a non-empty array of arrays');
  if (rows.length > GOOGLE_WORKSPACE_CONSTANTS.SHEETS_MAX_ROWS) {
    throw new GoogleWorkspaceError(400, CODES.VALIDATION, `"rows" exceeds ${GOOGLE_WORKSPACE_CONSTANTS.SHEETS_MAX_ROWS}`);
  }
  for (const row of rows) {
    if (!Array.isArray(row)) throw new GoogleWorkspaceError(400, CODES.VALIDATION, 'each row must be an array');
    for (const cell of row) {
      if (cell !== null && cell !== undefined && !['string', 'number', 'boolean'].includes(typeof cell)) {
        throw new GoogleWorkspaceError(400, CODES.VALIDATION, 'cells must be strings, numbers or booleans');
      }
    }
  }
  return (rows as unknown[][]).map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : (cell as SheetCell))));
}

/**
 * Sheets: read, create, append, update.
 */
export class SheetsService {
  private readonly deps: GoogleApiDeps;
  private readonly base = GOOGLE_WORKSPACE_CONSTANTS.SHEETS_API_BASE;

  /**
   * @param deps - Token provider and optional fetch override
   */
  constructor(deps: GoogleApiDeps) {
    this.deps = deps;
  }

  /**
   * `spreadsheets.get` (properties only) — title and the sheet tabs.
   *
   * @param id - Spreadsheet id
   * @returns Metadata
   */
  async info(id: string): Promise<SpreadsheetInfo> {
    const spreadsheetId = requireId(id);
    const wire = await googleRequest<WireSpreadsheet>(
      this.deps,
      buildGoogleUrl(`${this.base}/spreadsheets/${encodeURIComponent(spreadsheetId)}`, {
        fields: 'spreadsheetId,properties.title,spreadsheetUrl,sheets.properties(title,gridProperties(rowCount,columnCount))',
      }),
    );
    return toInfo(wire);
  }

  /**
   * `spreadsheets.values.get`.
   *
   * @param id - Spreadsheet id
   * @param range - A1 range (default `A1:Z1000` on the first sheet)
   * @returns The values (rows may be ragged)
   */
  async read(id: string, range?: string): Promise<SheetValues> {
    const spreadsheetId = requireId(id);
    const a1 = (range ?? '').trim() || GOOGLE_WORKSPACE_CONSTANTS.SHEETS_DEFAULT_RANGE;
    const data = await googleRequest<{ range?: string; values?: SheetCell[][] }>(
      this.deps,
      buildGoogleUrl(`${this.base}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1)}`, {
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING',
      }),
    );
    return { spreadsheetId, range: data.range ?? a1, rows: data.values ?? [] };
  }

  /**
   * `spreadsheets.create`, then `values.update` from A1 when rows are given.
   *
   * @param input - Title, first-sheet name, initial rows
   * @returns The new spreadsheet
   * @throws GoogleWorkspaceError(400, validation) without a title
   */
  async create(input: SheetCreateInput): Promise<SpreadsheetInfo> {
    const title = (input.title ?? '').trim();
    if (!title) throw new GoogleWorkspaceError(400, GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.VALIDATION, '"title" is required');
    const sheetTitle = (input.sheetTitle ?? '').trim() || 'Sheet1';
    const created = await googleRequest<WireSpreadsheet>(this.deps, `${this.base}/spreadsheets`, {
      method: 'POST',
      body: { properties: { title }, sheets: [{ properties: { title: sheetTitle } }] },
    });
    const id = created.spreadsheetId ?? '';
    if (input.rows && input.rows.length > 0) {
      await this.update({ spreadsheetId: id, range: `${quoteSheet(sheetTitle)}!A1`, rows: input.rows });
    }
    return toInfo(created);
  }

  /**
   * `spreadsheets.values.append` — rows go below the last row of the
   * table that contains `range` (default: the first sheet).
   *
   * @param input - Spreadsheet, range, rows
   * @returns Updated range and counts
   */
  async append(input: SheetWriteInput): Promise<{ spreadsheetId: string; updatedRange: string; updatedRows: number }> {
    const spreadsheetId = requireId(input.spreadsheetId);
    const rows = requireRows(input.rows);
    const a1 = (input.range ?? '').trim() || 'A1';
    const data = await googleRequest<{ updates?: { updatedRange?: string; updatedRows?: number } }>(
      this.deps,
      buildGoogleUrl(`${this.base}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1)}:append`, {
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
      }),
      { method: 'POST', body: { values: rows } },
    );
    return { spreadsheetId, updatedRange: data.updates?.updatedRange ?? a1, updatedRows: data.updates?.updatedRows ?? rows.length };
  }

  /**
   * `spreadsheets.values.update` — overwrite starting at `range`.
   *
   * @param input - Spreadsheet, anchor range, rows
   * @returns Updated range and counts
   */
  async update(input: SheetWriteInput): Promise<{ spreadsheetId: string; updatedRange: string; updatedRows: number }> {
    const spreadsheetId = requireId(input.spreadsheetId);
    const rows = requireRows(input.rows);
    const a1 = (input.range ?? '').trim() || 'A1';
    const data = await googleRequest<{ updatedRange?: string; updatedRows?: number }>(
      this.deps,
      buildGoogleUrl(`${this.base}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1)}`, {
        valueInputOption: 'USER_ENTERED',
      }),
      { method: 'PUT', body: { values: rows } },
    );
    return { spreadsheetId, updatedRange: data.updatedRange ?? a1, updatedRows: data.updatedRows ?? rows.length };
  }
}

function toInfo(wire: WireSpreadsheet): SpreadsheetInfo {
  const id = wire.spreadsheetId ?? '';
  return {
    id,
    title: wire.properties?.title ?? '',
    sheets: (wire.sheets ?? []).map((s) => ({
      title: s.properties?.title ?? '',
      ...(s.properties?.gridProperties?.rowCount !== undefined ? { rowCount: s.properties.gridProperties.rowCount } : {}),
      ...(s.properties?.gridProperties?.columnCount !== undefined ? { columnCount: s.properties.gridProperties.columnCount } : {}),
    })),
    webViewLink: wire.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${id}/edit`,
  };
}

/**
 * Quote a sheet name for an A1 range when it needs it.
 *
 * @param name - Sheet title
 * @returns `'My Sheet'` or `Sheet1`
 */
export function quoteSheet(name: string): string {
  return /^[A-Za-z0-9_]+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}
