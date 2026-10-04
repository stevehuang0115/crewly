/**
 * DocsCommentsService — comments on a Google Doc, over the owner's grant.
 *
 * Uses the Drive API v3 `comments` / `replies` endpoints (Docs has no
 * comments API of its own). Listing works with `drive.readonly` on any
 * document the owner can see. Writing (reply, resolve, add) needs `drive`
 * or `drive.file`, and `drive.file` covers only files Crewly created — so on
 * the owner's own documents a write needs the full `drive` scope, which
 * older grants do not carry. That case answers `reauth_required` with what
 * to do, instead of Google's opaque 403.
 *
 * @module services/google/docs-comments.service
 */

import { GOOGLE_WORKSPACE_CONSTANTS } from '../../constants.js';
import { GoogleWorkspaceError } from './google-workspace-token.service.js';
import { buildGoogleUrl, googleRequest, type GoogleApiDeps } from './google-api.client.js';
import { requireId } from './drive.service.js';

/** One reply under a comment. */
export interface DocCommentReply {
  id: string;
  author: string;
  authorEmail?: string;
  createdTime: string;
  modifiedTime?: string;
  content: string;
  /** `resolve` / `reopen` when the reply changed the comment's state. */
  action?: string;
}

/** One comment, flattened for an agent. */
export interface DocComment {
  id: string;
  author: string;
  authorEmail?: string;
  createdTime: string;
  modifiedTime?: string;
  content: string;
  /** The document text the comment was made on, when it was anchored. */
  quote?: string;
  /** Google's opaque anchor (only meaningful to Google's own editors). */
  anchor?: string;
  resolved: boolean;
  replies: DocCommentReply[];
}

/** `list` result. */
export interface DocCommentList {
  docId: string;
  comments: DocComment[];
  /** True when more comments exist than {@link GOOGLE_WORKSPACE_CONSTANTS.COMMENTS_MAX_PAGES} pages hold. */
  truncated: boolean;
}

interface WireUser {
  displayName?: string;
  emailAddress?: string;
  me?: boolean;
}
interface WireReply {
  id?: string;
  author?: WireUser;
  createdTime?: string;
  modifiedTime?: string;
  content?: string;
  action?: string;
  deleted?: boolean;
}
interface WireComment {
  id?: string;
  author?: WireUser;
  createdTime?: string;
  modifiedTime?: string;
  content?: string;
  quotedFileContent?: { mimeType?: string; value?: string };
  anchor?: string;
  resolved?: boolean;
  deleted?: boolean;
  replies?: WireReply[];
}
interface WireCommentList {
  comments?: WireComment[];
  nextPageToken?: string;
}

/**
 * Accept a document id or any Docs/Drive URL that contains one.
 *
 * @param idOrUrl - `1AbC…`, `https://docs.google.com/document/d/1AbC…/edit`, or `…?id=1AbC…`
 * @returns The bare id
 * @throws GoogleWorkspaceError(400, validation) when empty
 */
export function docIdFrom(idOrUrl: string | undefined): string {
  const raw = requireId(idOrUrl);
  const path = raw.match(/\/d\/([A-Za-z0-9_-]+)/);
  if (path) return path[1];
  const query = raw.match(/[?&]id=([A-Za-z0-9_-]+)/);
  return query ? query[1] : raw;
}

function toReply(r: WireReply): DocCommentReply {
  return {
    id: r.id ?? '',
    author: r.author?.displayName ?? '',
    ...(r.author?.emailAddress ? { authorEmail: r.author.emailAddress } : {}),
    createdTime: r.createdTime ?? '',
    ...(r.modifiedTime ? { modifiedTime: r.modifiedTime } : {}),
    content: r.content ?? '',
    ...(r.action ? { action: r.action } : {}),
  };
}

/**
 * Flatten a wire comment; deleted replies are dropped.
 *
 * @param c - Drive comment
 * @returns The agent-facing shape
 */
export function toDocComment(c: WireComment): DocComment {
  return {
    id: c.id ?? '',
    author: c.author?.displayName ?? '',
    ...(c.author?.emailAddress ? { authorEmail: c.author.emailAddress } : {}),
    createdTime: c.createdTime ?? '',
    ...(c.modifiedTime ? { modifiedTime: c.modifiedTime } : {}),
    content: c.content ?? '',
    ...(c.quotedFileContent?.value ? { quote: c.quotedFileContent.value } : {}),
    ...(c.anchor ? { anchor: c.anchor } : {}),
    resolved: c.resolved === true,
    replies: (c.replies ?? []).filter((r) => !r.deleted).map(toReply),
  };
}

function requireText(text: string | undefined, name = 'text'): string {
  const value = (text ?? '').replace(/\r\n/g, '\n').trim();
  if (!value) throw new GoogleWorkspaceError(400, GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.VALIDATION, `"${name}" is required`);
  return value;
}

/**
 * Comments: list, reply, resolve, add.
 */
export class DocsCommentsService {
  private readonly deps: GoogleApiDeps;
  private readonly base = GOOGLE_WORKSPACE_CONSTANTS.DRIVE_API_BASE;

  /**
   * @param deps - Token provider, optional fetch override, product + account binding
   */
  constructor(deps: GoogleApiDeps) {
    this.deps = deps;
  }

  /**
   * Comments with their replies, oldest first, paged up to
   * `COMMENTS_MAX_PAGES`. Deleted comments are never returned; resolved ones
   * only when asked.
   *
   * @param idOrUrl - Document id or URL
   * @param options - `includeResolved` to keep resolved comments
   * @returns The comments
   */
  async list(idOrUrl: string, options: { includeResolved?: boolean } = {}): Promise<DocCommentList> {
    const docId = docIdFrom(idOrUrl);
    const comments: DocComment[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const page = await googleRequest<WireCommentList>(
        this.deps,
        buildGoogleUrl(this.commentsUrl(docId), {
          fields: '*',
          pageSize: GOOGLE_WORKSPACE_CONSTANTS.COMMENTS_PAGE_SIZE,
          includeDeleted: 'false',
          pageToken,
        }),
      );
      for (const c of page.comments ?? []) {
        if (c.deleted) continue;
        if (c.resolved && !options.includeResolved) continue;
        comments.push(toDocComment(c));
      }
      pageToken = page.nextPageToken || undefined;
      pages += 1;
    } while (pageToken && pages < GOOGLE_WORKSPACE_CONSTANTS.COMMENTS_MAX_PAGES);
    return { docId, comments, truncated: Boolean(pageToken) };
  }

  /**
   * Reply to a comment.
   *
   * @param idOrUrl - Document id or URL
   * @param commentId - Comment to answer
   * @param text - Reply text
   * @returns The new reply
   */
  async reply(idOrUrl: string, commentId: string, text: string): Promise<DocCommentReply & { docId: string; commentId: string }> {
    const docId = docIdFrom(idOrUrl);
    const cid = requireId(commentId);
    const content = requireText(text);
    const reply = await this.write<WireReply>(docId, this.repliesUrl(docId, cid), { content });
    return { docId, commentId: cid, ...toReply(reply) };
  }

  /**
   * Resolve a comment: a reply with `action: "resolve"` and an optional message.
   *
   * @param idOrUrl - Document id or URL
   * @param commentId - Comment to resolve
   * @param text - Optional closing message
   * @returns The resolving reply
   */
  async resolve(idOrUrl: string, commentId: string, text?: string): Promise<DocCommentReply & { docId: string; commentId: string; resolved: true }> {
    const docId = docIdFrom(idOrUrl);
    const cid = requireId(commentId);
    const content = (text ?? '').replace(/\r\n/g, '\n').trim();
    const reply = await this.write<WireReply>(docId, this.repliesUrl(docId, cid), {
      action: 'resolve',
      ...(content ? { content } : {}),
    });
    return { docId, commentId: cid, ...toReply(reply), resolved: true };
  }

  /**
   * Add a comment. With `quote`, the quoted text is sent as
   * `quotedFileContent` — but Google Docs shows API-made comments as
   * unanchored, so it may still appear as a general comment.
   *
   * @param idOrUrl - Document id or URL
   * @param text - Comment text
   * @param quote - Exact document text the comment is about
   * @returns The new comment
   */
  async add(idOrUrl: string, text: string, quote?: string): Promise<DocComment & { docId: string }> {
    const docId = docIdFrom(idOrUrl);
    const content = requireText(text);
    const quoted = (quote ?? '').trim();
    const comment = await this.write<WireComment>(docId, this.commentsUrl(docId), {
      content,
      ...(quoted ? { quotedFileContent: { mimeType: 'text/plain', value: quoted } } : {}),
    });
    return { docId, ...toDocComment(comment) };
  }

  private commentsUrl(docId: string): string {
    return `${this.base}/files/${encodeURIComponent(docId)}/comments`;
  }

  private repliesUrl(docId: string, commentId: string): string {
    return `${this.commentsUrl(docId)}/${encodeURIComponent(commentId)}/replies`;
  }

  /**
   * POST a comment or reply, turning a scope refusal into `reauth_required`.
   *
   * Google answers 403 (or 404, for `drive.file`) when the token may not
   * write to this file. That only means "reconnect Drive" when the grant
   * lacks the full `drive` scope *and* the document is readable — otherwise
   * it is a real permission problem or a wrong id, and passes through.
   *
   * @param docId - Document id
   * @param url - Endpoint (without query)
   * @param body - JSON body
   * @returns Google's answer
   */
  private async write<T>(docId: string, url: string, body: unknown): Promise<T> {
    try {
      return await googleRequest<T>(this.deps, buildGoogleUrl(url, { fields: '*' }), { method: 'POST', body });
    } catch (err) {
      if (await this.isScopeRefusal(err, docId)) {
        // The owner is about to widen the grant; the next call must not
        // reuse the narrow token cached for the next hour.
        this.deps.tokens.clearCache(this.deps.account);
        throw new GoogleWorkspaceError(
          403,
          GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.REAUTH_REQUIRED,
          'Replying to or adding comments on this document needs Google Drive edit access, which this Google account has not granted yet.',
        );
      }
      throw err;
    }
  }

  private async isScopeRefusal(err: unknown, docId: string): Promise<boolean> {
    if (!(err instanceof GoogleWorkspaceError) || (err.status !== 403 && err.status !== 404)) return false;
    if (err.code !== GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.GOOGLE_ERROR) return false;
    const scopes = this.deps.tokens.grantedScopes?.(this.deps.account ? { account: this.deps.account } : {});
    if (!scopes || scopes.includes(GOOGLE_WORKSPACE_CONSTANTS.DRIVE_FULL_SCOPE)) return false;
    try {
      await googleRequest(this.deps, buildGoogleUrl(`${this.base}/files/${encodeURIComponent(docId)}`, { fields: 'id', supportsAllDrives: 'true' }));
      return true;
    } catch {
      return false;
    }
  }
}
