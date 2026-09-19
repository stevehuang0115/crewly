/**
 * DocsService — Google Docs over the owner's Workspace grant.
 *
 * Reads any document the owner can see (`documents.readonly` /
 * `drive.readonly`) and creates or appends to documents Crewly created
 * (`drive.file`). Appending to a document the owner made elsewhere needs
 * the `documents` scope, which the grant does not carry yet; Google then
 * answers 403 and the error says so.
 *
 * @module services/google/docs.service
 */

import { GOOGLE_WORKSPACE_CONSTANTS } from '../../constants.js';
import { GoogleWorkspaceError } from './google-workspace-token.service.js';
import { googleRequest, type GoogleApiDeps } from './google-api.client.js';
import { requireId } from './drive.service.js';

/** A document, flattened. */
export interface DocText {
  id: string;
  title: string;
  /** Plain text: headings prefixed with `#`, table cells joined with ` | `. */
  text: string;
  webViewLink: string;
}

/** Create input. */
export interface DocCreateInput {
  title: string;
  /** Initial body (plain text; blank lines make paragraphs). */
  text?: string;
}

interface WireTextRun {
  content?: string;
}
interface WireParagraph {
  elements?: Array<{ textRun?: WireTextRun; endIndex?: number }>;
  paragraphStyle?: { namedStyleType?: string };
  bullet?: unknown;
}
interface WireStructuralElement {
  endIndex?: number;
  paragraph?: WireParagraph;
  table?: { tableRows?: Array<{ tableCells?: Array<{ content?: WireStructuralElement[] }> }> };
  sectionBreak?: unknown;
}
interface WireDocument {
  documentId?: string;
  title?: string;
  body?: { content?: WireStructuralElement[] };
}

const HEADING_PREFIX: Record<string, string> = {
  TITLE: '# ',
  HEADING_1: '# ',
  HEADING_2: '## ',
  HEADING_3: '### ',
  HEADING_4: '#### ',
  HEADING_5: '##### ',
  HEADING_6: '###### ',
};

/**
 * Flatten a paragraph to one line.
 *
 * @param p - Paragraph
 * @returns Text without the trailing newline
 */
function paragraphText(p: WireParagraph): string {
  const raw = (p.elements ?? []).map((e) => e.textRun?.content ?? '').join('');
  const line = raw.replace(/\n$/, '');
  const prefix = HEADING_PREFIX[p.paragraphStyle?.namedStyleType ?? ''] ?? (p.bullet ? '- ' : '');
  return `${prefix}${line}`;
}

/**
 * Flatten a document body to plain text.
 *
 * @param content - `body.content`
 * @returns Lines joined with `\n`
 */
export function flattenDocBody(content: WireStructuralElement[] | undefined): string {
  const lines: string[] = [];
  for (const el of content ?? []) {
    if (el.paragraph) {
      lines.push(paragraphText(el.paragraph));
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        const cells = (row.tableCells ?? []).map((cell) => flattenDocBody(cell.content).replace(/\n+/g, ' ').trim());
        lines.push(cells.join(' | '));
      }
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The document's end index (where `insertText` appends).
 *
 * @param doc - Document
 * @returns Index just before the final newline (Docs refuses inserts after it)
 */
export function docEndIndex(doc: WireDocument): number {
  const content = doc.body?.content ?? [];
  const last = content[content.length - 1];
  const end = last?.endIndex ?? 1;
  return Math.max(1, end - 1);
}

/**
 * Docs: read, create, append.
 */
export class DocsService {
  private readonly deps: GoogleApiDeps;
  private readonly base = GOOGLE_WORKSPACE_CONSTANTS.DOCS_API_BASE;

  /**
   * @param deps - Token provider and optional fetch override
   */
  constructor(deps: GoogleApiDeps) {
    this.deps = deps;
  }

  /**
   * `documents.get`, flattened to text.
   *
   * @param id - Document id
   * @returns Title + text
   */
  async read(id: string): Promise<DocText> {
    const documentId = requireId(id);
    const doc = await googleRequest<WireDocument>(this.deps, `${this.base}/documents/${encodeURIComponent(documentId)}`);
    return toDocText(doc);
  }

  /**
   * `documents.create` + one `insertText` for the body.
   *
   * @param input - Title and optional body
   * @returns The new document (text as written)
   * @throws GoogleWorkspaceError(400, validation) without a title
   */
  async create(input: DocCreateInput): Promise<DocText> {
    const title = (input.title ?? '').trim();
    if (!title) throw new GoogleWorkspaceError(400, GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.VALIDATION, '"title" is required');
    const created = await googleRequest<WireDocument>(this.deps, `${this.base}/documents`, { method: 'POST', body: { title } });
    const documentId = created.documentId ?? '';
    const text = (input.text ?? '').replace(/\r\n/g, '\n');
    if (text.trim()) {
      await googleRequest(this.deps, `${this.base}/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
        method: 'POST',
        body: { requests: [{ insertText: { location: { index: 1 }, text } }] },
      });
    }
    return { id: documentId, title: created.title ?? title, text, webViewLink: docLink(documentId) };
  }

  /**
   * Append text at the end of a document (`documents.get` for the end
   * index, then `insertText`).
   *
   * @param id - Document id
   * @param text - Text to append (a newline is prepended when the doc is not empty)
   * @returns The updated document, flattened
   * @throws GoogleWorkspaceError(400, validation) without text
   */
  async append(id: string, text: string): Promise<DocText> {
    const documentId = requireId(id);
    const body = (text ?? '').replace(/\r\n/g, '\n');
    if (!body.trim()) throw new GoogleWorkspaceError(400, GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.VALIDATION, '"text" is required');
    const doc = await googleRequest<WireDocument>(this.deps, `${this.base}/documents/${encodeURIComponent(documentId)}`);
    const index = docEndIndex(doc);
    await googleRequest(this.deps, `${this.base}/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
      method: 'POST',
      body: { requests: [{ insertText: { location: { index }, text: index > 1 ? `\n${body}` : body } }] },
    });
    const after = await googleRequest<WireDocument>(this.deps, `${this.base}/documents/${encodeURIComponent(documentId)}`);
    return toDocText(after);
  }
}

function toDocText(doc: WireDocument): DocText {
  const id = doc.documentId ?? '';
  return { id, title: doc.title ?? '', text: flattenDocBody(doc.body?.content), webViewLink: docLink(id) };
}

/**
 * Browser link for a document.
 *
 * @param id - Document id
 * @returns URL
 */
export function docLink(id: string): string {
  return `https://docs.google.com/document/d/${id}/edit`;
}
