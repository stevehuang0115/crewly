/**
 * DriveService — Google Drive over the owner's Workspace grant.
 *
 * Works within the scopes the grant already carries: `drive.readonly`
 * (search, metadata, download / export of anything the owner can see) and
 * `drive.file` (upload; the created files are then editable by Crewly).
 * Google-native files (Docs / Sheets / Slides) are read through `export`
 * as text / CSV so an agent gets something it can reason about.
 *
 * @module services/google/drive.service
 */

import { randomBytes } from 'crypto';
import { GOOGLE_WORKSPACE_CONSTANTS } from '../../constants.js';
import { GoogleWorkspaceError } from './google-workspace-token.service.js';
import { buildGoogleUrl, googleRequest, type GoogleApiDeps } from './google-api.client.js';
import { clampMax } from './gmail.service.js';

/** Drive file metadata (the fields Crewly asks for). */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: number;
  webViewLink?: string;
  owners?: string[];
  parents?: string[];
}

/** Search input. */
export interface DriveSearchInput {
  /** Free text; matched against name and full text. Empty = most recent files. */
  query?: string;
  /** Restrict to a MIME type (e.g. `application/vnd.google-apps.spreadsheet`). */
  mimeType?: string;
  /** Restrict to a folder id. */
  folderId?: string;
  max?: number;
}

/** What `readContent` returns. */
export interface DriveContent {
  file: DriveFile;
  /** MIME type of `content` (`text/plain`, `text/csv`, or the file's own). */
  contentType: string;
  /** UTF-8 text for text-like files; base64 for binary files. */
  content: string;
  encoding: 'utf8' | 'base64';
  bytes: number;
}

/** Upload input. */
export interface DriveUploadInput {
  name: string;
  mimeType?: string;
  /** UTF-8 text, or base64 when `encoding` is `base64`. */
  content: string;
  encoding?: 'utf8' | 'base64';
  folderId?: string;
  /** Convert to the Google-native type (`application/vnd.google-apps.document` …) on upload. */
  convertTo?: string;
}

interface DriveWireFile {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  owners?: Array<{ emailAddress?: string }>;
  parents?: string[];
}

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,webViewLink,owners(emailAddress),parents';

/**
 * Trim a Drive file resource to {@link DriveFile}.
 *
 * @param wire - Google's file resource
 * @returns The trimmed file
 */
export function toDriveFile(wire: DriveWireFile): DriveFile {
  return {
    id: wire.id ?? '',
    name: wire.name ?? '',
    mimeType: wire.mimeType ?? '',
    ...(wire.modifiedTime ? { modifiedTime: wire.modifiedTime } : {}),
    ...(wire.size ? { size: Number(wire.size) } : {}),
    ...(wire.webViewLink ? { webViewLink: wire.webViewLink } : {}),
    ...(wire.owners?.length ? { owners: wire.owners.map((o) => o.emailAddress ?? '').filter(Boolean) } : {}),
    ...(wire.parents?.length ? { parents: wire.parents } : {}),
  };
}

/**
 * Escape a value for a Drive `q` string literal.
 *
 * @param value - Raw text
 * @returns Escaped text (backslashes and single quotes)
 */
export function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Build the Drive `q` expression for a search.
 *
 * @param input - Search input
 * @returns The `q` string
 */
export function buildDriveQuery(input: DriveSearchInput): string {
  const terms: string[] = ['trashed = false'];
  const text = (input.query ?? '').trim();
  if (text) {
    const escaped = escapeDriveQuery(text);
    terms.push(`(name contains '${escaped}' or fullText contains '${escaped}')`);
  }
  if (input.mimeType?.trim()) terms.push(`mimeType = '${escapeDriveQuery(input.mimeType.trim())}'`);
  if (input.folderId?.trim()) terms.push(`'${escapeDriveQuery(input.folderId.trim())}' in parents`);
  return terms.join(' and ');
}

/**
 * Whether a MIME type is something an agent can read as text.
 *
 * @param mimeType - MIME type
 * @returns True for text/*, JSON, XML, CSV and friends
 */
export function isTextMime(mimeType: string): boolean {
  return /^text\//.test(mimeType) || /\b(json|xml|csv|javascript|yaml|markdown)\b/.test(mimeType);
}

/**
 * Drive: search, metadata, content, upload.
 *
 * @example
 * ```ts
 * const drive = new DriveService({ tokens });
 * const hits = await drive.search({ query: 'Q3 plan' });
 * ```
 */
export class DriveService {
  private readonly deps: GoogleApiDeps;
  private readonly base = GOOGLE_WORKSPACE_CONSTANTS.DRIVE_API_BASE;
  private readonly uploadBase = GOOGLE_WORKSPACE_CONSTANTS.DRIVE_UPLOAD_BASE;

  /**
   * @param deps - Token provider and optional fetch override
   */
  constructor(deps: GoogleApiDeps) {
    this.deps = deps;
  }

  /**
   * `files.list` — most recently modified first.
   *
   * @param input - Query / MIME / folder / cap
   * @returns Matching files
   * @throws GoogleWorkspaceError on auth / Google failures
   */
  async search(input: DriveSearchInput = {}): Promise<DriveFile[]> {
    const max = clampMax(input.max, GOOGLE_WORKSPACE_CONSTANTS.DRIVE_DEFAULT_MAX_RESULTS, GOOGLE_WORKSPACE_CONSTANTS.DRIVE_MAX_RESULTS_CEILING);
    const data = await googleRequest<{ files?: DriveWireFile[] }>(
      this.deps,
      buildGoogleUrl(`${this.base}/files`, {
        q: buildDriveQuery(input),
        pageSize: max,
        orderBy: 'modifiedTime desc',
        fields: `files(${FILE_FIELDS})`,
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      }),
    );
    return (data.files ?? []).map(toDriveFile);
  }

  /**
   * `files.get` metadata.
   *
   * @param id - File id
   * @returns The file
   * @throws GoogleWorkspaceError(400, validation) without an id; Google 404 passes through
   */
  async get(id: string): Promise<DriveFile> {
    const fileId = requireId(id);
    const wire = await googleRequest<DriveWireFile>(
      this.deps,
      buildGoogleUrl(`${this.base}/files/${encodeURIComponent(fileId)}`, { fields: FILE_FIELDS, supportsAllDrives: 'true' }),
    );
    return toDriveFile(wire);
  }

  /**
   * File content: Google-native types are exported (Docs → text/plain,
   * Sheets → text/csv, Slides → text/plain); other files are downloaded and
   * returned as UTF-8 when text-like, else base64.
   *
   * @param id - File id
   * @returns Content with its type and encoding
   * @throws GoogleWorkspaceError(413, validation) when the file exceeds DRIVE_MAX_CONTENT_BYTES
   */
  async readContent(id: string): Promise<DriveContent> {
    const file = await this.get(id);
    const exportMime = GOOGLE_WORKSPACE_CONSTANTS.DRIVE_EXPORT_MIME[file.mimeType];
    if (exportMime) {
      const text = await googleRequest<string>(
        this.deps,
        buildGoogleUrl(`${this.base}/files/${encodeURIComponent(file.id)}/export`, { mimeType: exportMime }),
        { responseType: 'text' },
      );
      return { file, contentType: exportMime, content: text, encoding: 'utf8', bytes: Buffer.byteLength(text, 'utf8') };
    }
    if (file.mimeType.startsWith('application/vnd.google-apps.')) {
      throw new GoogleWorkspaceError(400, GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.VALIDATION, `Cannot read a ${file.mimeType} as text`);
    }
    if ((file.size ?? 0) > GOOGLE_WORKSPACE_CONSTANTS.DRIVE_MAX_CONTENT_BYTES) {
      throw new GoogleWorkspaceError(413, GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.VALIDATION, `File is larger than ${GOOGLE_WORKSPACE_CONSTANTS.DRIVE_MAX_CONTENT_BYTES} bytes; open it via webViewLink instead`);
    }
    const raw = await googleRequest<string>(
      this.deps,
      buildGoogleUrl(`${this.base}/files/${encodeURIComponent(file.id)}`, { alt: 'media', supportsAllDrives: 'true' }),
      { responseType: 'text' },
    );
    if (isTextMime(file.mimeType)) {
      return { file, contentType: file.mimeType, content: raw, encoding: 'utf8', bytes: Buffer.byteLength(raw, 'utf8') };
    }
    // fetch's text() decoded as UTF-8; re-encode as latin1 to recover the bytes for small binaries.
    const buf = Buffer.from(raw, 'latin1');
    return { file, contentType: file.mimeType, content: buf.toString('base64'), encoding: 'base64', bytes: buf.length };
  }

  /**
   * Multipart `files.create` — a new file in My Drive (or a folder),
   * optionally converted to a Google-native type.
   *
   * @param input - Name, MIME, content, folder, conversion
   * @returns The created file
   * @throws GoogleWorkspaceError(400, validation) for a missing name/content or oversized content
   */
  async upload(input: DriveUploadInput): Promise<DriveFile> {
    const CODES = GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES;
    const name = (input.name ?? '').trim();
    if (!name) throw new GoogleWorkspaceError(400, CODES.VALIDATION, '"name" is required');
    if (typeof input.content !== 'string' || input.content.length === 0) {
      throw new GoogleWorkspaceError(400, CODES.VALIDATION, '"content" is required');
    }
    const bytes = input.encoding === 'base64' ? Buffer.from(input.content, 'base64') : Buffer.from(input.content, 'utf8');
    if (bytes.length > GOOGLE_WORKSPACE_CONSTANTS.DRIVE_MAX_CONTENT_BYTES) {
      throw new GoogleWorkspaceError(400, CODES.VALIDATION, `content exceeds ${GOOGLE_WORKSPACE_CONSTANTS.DRIVE_MAX_CONTENT_BYTES} bytes`);
    }
    const mimeType = input.mimeType?.trim() || (input.encoding === 'base64' ? 'application/octet-stream' : 'text/plain');
    const metadata: Record<string, unknown> = { name };
    if (input.convertTo?.trim()) metadata.mimeType = input.convertTo.trim();
    if (input.folderId?.trim()) metadata.parents = [input.folderId.trim()];

    const boundary = `crewly-${randomBytes(12).toString('hex')}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`, 'utf8'),
      Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, 'utf8'),
      bytes,
      Buffer.from(`\r\n--${boundary}--`, 'utf8'),
    ]);
    const wire = await googleRequest<DriveWireFile>(
      this.deps,
      buildGoogleUrl(`${this.uploadBase}/files`, { uploadType: 'multipart', fields: FILE_FIELDS, supportsAllDrives: 'true' }),
      { method: 'POST', rawBody: body, contentType: `multipart/related; boundary=${boundary}` },
    );
    return toDriveFile(wire);
  }
}

/**
 * Validate a file / document id.
 *
 * @param id - Candidate id
 * @returns The trimmed id
 * @throws GoogleWorkspaceError(400, validation) when empty
 */
export function requireId(id: string | undefined): string {
  const value = (id ?? '').trim();
  if (!value) throw new GoogleWorkspaceError(400, GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.VALIDATION, '"id" is required');
  return value;
}
