/**
 * Slack file references — turn whatever an agent was handed (a file id, a
 * file permalink, a download URL, a message link) into the ids Slack's API
 * needs.
 *
 * Kept in step with the Cloud copy in
 * `crewly-services/auth/src/slack-file-ref.ts`; both sides parse
 * the same links.
 *
 * @module services/slack/slack-file-ref
 */

/** What a reference names. */
export interface SlackFileRef {
  /** Slack file id (`F…`), when the reference names one. */
  fileId?: string;
  /** Uploader's Slack user id, from `/files/<user>/<file>` permalinks. */
  uploaderUserId?: string;
  /** Slack team id embedded in `files-pri` / `files-tmb` / `slack-files.com` URLs. */
  slackTeamId?: string;
  /** Workspace host of a permalink (`acme.slack.com`). */
  workspaceHost?: string;
  /** Channel of a message link (`/archives/<channel>/p<ts>`). */
  channelId?: string;
  /** Message ts of a message link (`1696771234.567890`). */
  messageTs?: string;
  /** Thread parent ts of a message link (`?thread_ts=`). */
  threadTs?: string;
}

const FILE_ID = /^F[A-Z0-9]{6,20}$/;
const USER_ID = /^[UWB][A-Z0-9]{6,20}$/;
const TEAM_ID = /^[TE][A-Z0-9]{6,20}$/;
const CHANNEL_ID = /^[CDG][A-Z0-9]{6,20}$/;
const TEAM_FILE = /^([TE][A-Z0-9]{6,20})-(F[A-Z0-9]{6,20})(?:-[A-Za-z0-9]+)?$/;

/** Every Slack file / message link inside free text (`<url|label>` and bare). */
const LINK_IN_TEXT =
  /https:\/\/(?:[a-z0-9-]+\.)*(?:slack\.com|slack-files\.com)\/(?:files(?:-pri|-tmb)?|archives)\/[^\s<>|"')\]]+/gi;

/**
 * `p1696771234567890` → `1696771234.567890`.
 *
 * @param segment - The `p…` path segment of a message link
 * @returns The Slack ts, or undefined when the segment is not one
 */
function tsFromPermalinkSegment(segment: string): string | undefined {
  const m = /^p(\d{10})(\d{6})$/.exec(segment);
  return m ? `${m[1]}.${m[2]}` : undefined;
}

/**
 * Parse a file reference.
 *
 * Accepted:
 *   - `F0123ABCD` (a bare file id)
 *   - `https://<ws>.slack.com/files/<user>/<FILE>/<name>` (file permalink)
 *   - `https://files.slack.com/files-pri/<TEAM>-<FILE>/<name>` (+ `/download/`)
 *   - `https://files.slack.com/files-tmb/<TEAM>-<FILE>-<hash>/<name>`
 *   - `https://slack-files.com/<TEAM>-<FILE>-<secret>` (public permalink)
 *   - `https://<ws>.slack.com/archives/<CHANNEL>/p<ts>[?thread_ts=…]` (a message carrying files)
 *   - any of the above wrapped Slack-style as `<url|label>`
 *
 * @param input - What the agent passed
 * @returns The parsed reference, or null when it is not a Slack file reference
 */
export function parseSlackFileRef(input: string): SlackFileRef | null {
  let raw = (input ?? '').trim();
  if (!raw) return null;
  // Slack mrkdwn link: <https://…|label>
  const angle = /^<([^|>]+)(?:\|[^>]*)?>$/.exec(raw);
  if (angle) raw = angle[1].trim();

  if (FILE_ID.test(raw)) return { fileId: raw };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  const isSlackHost = host === 'slack.com' || host.endsWith('.slack.com');
  if (!isSlackHost && host !== 'slack-files.com') return null;
  const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));

  if (host === 'slack-files.com') {
    const m = parts[0] ? TEAM_FILE.exec(parts[0]) : null;
    return m ? { slackTeamId: m[1], fileId: m[2] } : null;
  }

  const workspaceHost = isWorkspaceHost(host) ? host : undefined;

  if (parts[0] === 'files-pri' || parts[0] === 'files-tmb') {
    const m = parts[1] ? TEAM_FILE.exec(parts[1]) : null;
    return m ? { slackTeamId: m[1], fileId: m[2] } : null;
  }

  if (parts[0] === 'files') {
    // /files/<user>/<FILE>[/<name>]
    const user = parts[1];
    const file = parts[2];
    if (file && FILE_ID.test(file)) {
      return {
        fileId: file,
        ...(user && USER_ID.test(user) ? { uploaderUserId: user } : {}),
        ...(workspaceHost ? { workspaceHost } : {}),
        ...(teamFromQuery(url) ? { slackTeamId: teamFromQuery(url) } : {}),
      };
    }
    return null;
  }

  if (parts[0] === 'archives') {
    const channel = parts[1];
    const ts = parts[2] ? tsFromPermalinkSegment(parts[2]) : undefined;
    if (!channel || !CHANNEL_ID.test(channel) || !ts) return null;
    const threadTs = url.searchParams.get('thread_ts') ?? undefined;
    return {
      channelId: channel,
      messageTs: ts,
      ...(threadTs && /^\d{10}\.\d{6}$/.test(threadTs) ? { threadTs } : {}),
      ...(workspaceHost ? { workspaceHost } : {}),
    };
  }

  return null;
}

/**
 * Slack file and message links in a piece of text (deduplicated, in order).
 *
 * @param text - Message text
 * @returns Links that {@link parseSlackFileRef} accepts
 */
export function findSlackFileLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of (text ?? '').matchAll(LINK_IN_TEXT)) {
    const link = m[0].replace(/[.,;:!?]+$/, '');
    if (!out.includes(link) && parseSlackFileRef(link)) out.push(link);
  }
  return out;
}

/** `acme.slack.com` is a workspace; `files.slack.com`, `app.slack.com`, `slack.com` are not. */
function isWorkspaceHost(host: string): boolean {
  if (!host.endsWith('.slack.com')) return false;
  const sub = host.slice(0, -'.slack.com'.length);
  return !!sub && !['files', 'app', 'api', 'www', 'edgeapi', 'status'].includes(sub);
}

function teamFromQuery(url: URL): string | undefined {
  const t = url.searchParams.get('origin_team') ?? url.searchParams.get('team');
  return t && TEAM_ID.test(t) ? t : undefined;
}

/** Hosts a Slack file download may be served from (redirects included). */
export function isSlackDownloadHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === 'slack.com' ||
    h.endsWith('.slack.com') ||
    h === 'slack-edge.com' ||
    h.endsWith('.slack-edge.com') ||
    h === 'slack-files.com' ||
    h.endsWith('.slack-files.com')
  );
}

/** Mimetypes / extensions treated as text (returned as text, previewed). */
const TEXT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/x-sh',
  'application/sql',
  'application/csv',
]);
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html', 'htm',
  'js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'sql', 'log', 'ini', 'toml', 'css', 'srt', 'vtt',
]);

/**
 * Whether a file is text (so it can be handed back as a string).
 *
 * @param mimetype - Slack mimetype
 * @param name - File name
 * @returns True for text-like files
 */
export function isTextFile(mimetype: string | undefined, name: string | undefined): boolean {
  const mime = (mimetype ?? '').toLowerCase().split(';')[0].trim();
  if (mime.startsWith('text/')) return true;
  if (TEXT_MIMES.has(mime)) return true;
  const ext = (name ?? '').toLowerCase().split('.').pop() ?? '';
  return !!ext && (name ?? '').includes('.') && TEXT_EXTENSIONS.has(ext);
}

/** Exposed for tests. */
export const SLACK_ID_PATTERNS = { FILE_ID, USER_ID, TEAM_ID, CHANNEL_ID } as const;
