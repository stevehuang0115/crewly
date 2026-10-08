/**
 * AppsService — publish, roll back and read/write the data of Crewly Apps
 * on behalf of an agent (or the owner), through {@link AppsCloudClient}.
 *
 * Backs `/api/apps` and the publish-app / app-data skills
 * (specs/2026-10-04-crewly-apps-p2.md).
 *
 * @module services/apps/apps.service
 */

import path from 'path';
import { CREWLY_APPS_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { AppsCloudClient, AppsCloudError, type AppsRequestOptions } from './apps-cloud.client.js';
import type { AppRegistryEntry, AppsRegistryService } from './apps-registry.service.js';
import { toOpenLinkInfos, usableMintedLink, type MintedOpenLink, type OpenLinkInfo } from './app-open-link.js';
import { sanitizeAppData } from './app-wake-message.js';

const C = CREWLY_APPS_CONSTANTS;

/** Cloud's view of an app (apps/SPEC.md §3.1). */
export interface CloudAppView {
  appId: string;
  name: string;
  slug: string | null;
  url: string;
  currentVersion: number | null;
  latestVersion: number;
  /** P3: `private` unless the owner approved a public request in the shell */
  visibility?: AppVisibility;
  /** P3: collections anonymous visitors may read */
  publicRead?: string[];
  /** P3: collections anonymous visitors may add to (append-only) */
  publicSubmit?: string[];
  /** P3: a request waiting for the owner, or null */
  publicRequest?: PublicRequestView | null;
}

/** Who can open an app without signing in (P3 §2). */
export type AppVisibility = 'private' | 'public';

/** A pending request to make an app public, as Cloud shows it. */
export interface PublicRequestView {
  publicRead: string[];
  publicSubmit: string[];
  note: string | null;
  requestedBy: string | null;
  requestedAt: string | null;
}

/** What an agent asks to open to anonymous visitors. */
export interface PublicRequestInput {
  publicRead?: unknown;
  publicSubmit?: unknown;
  note?: unknown;
}

/** Cloud's view of a version. */
export interface CloudVersionView {
  version: number;
  entry: string;
  files: number;
  totalBytes: number;
  note: string | null;
  createdAt: string;
  current: boolean;
}

/** One bundle file as the skill sends it. */
export interface PublishFile {
  path: string;
  contentBase64: string;
  contentType?: string;
}

/** Input of {@link AppsService.publish}. */
export interface PublishInput {
  files: unknown;
  name?: unknown;
  appId?: unknown;
  source?: unknown;
  entry?: unknown;
  note?: unknown;
  notify?: unknown;
  /** P3: also ask the owner to make the app public */
  publicRequest?: unknown;
}

/**
 * What posting the card did. Never the signed URL itself: agents get the
 * plain URL only (P3 §1).
 */
export interface CardResult {
  notified: boolean;
  /** `signed` = the one-tap open-link card in the owner DM; `plain` = the plain URL */
  card?: 'signed' | 'plain';
  /** Where it went: the agent's owner DM, or wherever its conversation with the owner is */
  cardPlace?: 'owner-dm' | 'conversation';
  /** The minted link (for `--revoke-link`); not a secret */
  linkId?: string;
  linkExpiresAt?: string;
  notifyError?: string;
  /** Why the card carries the plain URL instead of a signed link */
  linkError?: string;
}

/** Result of a publish. */
export interface PublishResult extends CardResult {
  appId: string;
  name: string;
  url: string;
  version: number;
  created: boolean;
  /** P3: the public request was recorded (the owner still has to approve it) */
  publicRequested?: boolean;
  publicError?: string;
  /** The app was public; this version made it private until the owner re-approves (crewly-services #33) */
  publicPaused?: boolean;
  publicPausedMessage?: string;
}

/** Result of {@link AppsService.share}. */
export interface ShareResult extends CardResult {
  appId: string;
  name: string;
  url: string;
  visibility: AppVisibility;
  publicRequestPending: boolean;
}

/** Result of a public request. */
export interface PublicRequestResult extends CardResult {
  appId: string;
  url: string;
  visibility: AppVisibility;
  publicRequest: PublicRequestView | null;
  message: string;
}

/** Who is calling: an agent session, or the owner (no session). */
export interface AppsCaller {
  agentSession?: string;
}

/** Outcome of posting a card. */
export interface CardPostResult {
  ok: boolean;
  error?: string;
}

/**
 * Where the "Open app" card can go (P3 §1, destination rule).
 *
 * The signed card goes ONLY to `ownerDm` — the one place that is owner-only
 * by construction. The plain card goes where the agent talks with the owner
 * (the `reply` resolver), as in P2.
 */
export interface AppCardPoster {
  /** The agent's DM with the owner (chat-v2 conversation id), or null when it has none */
  ownerDm(agentSession: string): Promise<string | null>;
  /** Post into exactly that DM conversation; never anywhere else */
  postToOwnerDm(agentSession: string, conversationId: string, text: string): Promise<CardPostResult>;
  /** Post where the agent's conversation with the owner is (P2 path) */
  postReply(agentSession: string, text: string): Promise<CardPostResult>;
}

/** An agent that can publish apps: a member of a team on this machine. */
export interface AppsMember {
  session: string;
  name: string;
  team: string | null;
}

/** Team lookups the transfer needs. */
export interface AppsDirectory {
  /** The member of an existing, non-archived team with this session; null otherwise */
  member(session: string): Promise<AppsMember | null>;
  /** Whether `lead` leads the team that `publisher` is a member of */
  leadsTeamOf(lead: string, publisher: string): Promise<boolean>;
}

/** Result of {@link AppsService.transfer}. */
export interface TransferResult {
  appId: string;
  name: string | null;
  /** The new publisher */
  publisher: string;
  /** The previous publisher (null = the orchestrator / none) */
  previous: string | null;
  /** False when `toSession` already was the publisher: nothing changed */
  changed: boolean;
  /** Which agents were told */
  notified: string[];
}

/** Constructor dependencies. */
export interface AppsServiceDeps {
  client: AppsCloudClient;
  registry: AppsRegistryService;
  cards?: AppCardPoster;
  /** Whether two agent sessions are in the same team (data access for the publisher's team) */
  sameTeam?: (a: string, b: string) => Promise<boolean>;
  /** Who may receive and hand over an app (transfer); absent = transfers are refused */
  directory?: AppsDirectory;
  /** Tell an agent something (transfer notes); `activate` = start it first when it is down */
  notifyAgent?: (session: string, text: string, activate: boolean) => Promise<boolean>;
  /** Captures the portal thumbnail after a publish (background, never fails the publish) */
  thumbnails?: { schedule(appId: string, agent?: string | null): void };
  /** Mirrors an agent's comment reply / resolve / reopen to Slack (never awaited; failures are ignored) */
  commentsSlack?: {
    agentReplied(appId: string, commentId: string, agent: string, text: string): Promise<void>;
    statusChanged(appId: string, commentId: string, agent: string, action: 'resolve' | 'reopen'): Promise<void>;
  };
  /** Pushes this instance's agent roster (who the owner can @mention) after a publish */
  roster?: { pushIfChanged(): Promise<boolean> };
  /** This instance's Cloud id (a mention names the instance its agent runs on) */
  instanceId?: () => Promise<string | null>;
  /** Look up what can own an app on this machine (app owners, SPEC §15) */
  ownerTargets?: OwnerTargets;
}

/** An app's owner as Cloud reports it (crewly-services apps/SPEC.md §15). */
export interface CloudOwnerView {
  kind: 'agent' | 'team' | 'channel';
  explicit: boolean;
  session?: string;
  teamId?: string;
  channelId?: string;
  name: string;
  instanceId: string | null;
  members?: string[];
}

/** What can own an app on this machine. */
export interface OwnerTargets {
  /** An agent by session or member name */
  agent(ref: string): Promise<{ session: string; name: string } | null>;
  /** A team by id or name */
  team(ref: string): Promise<{ id: string; name: string } | null>;
  /** A Crewly channel by id, `#name` or name */
  channel(ref: string): Promise<{ id: string; name: string } | null>;
}

/** A parsed owner spec. */
export type OwnerSpec = { kind: 'agent' | 'team' | 'channel'; ref: string } | { kind: 'default' };

/**
 * Parse an owner spec: `agent:<ref>`, `team:<ref>`, `channel:<ref>` (a bare
 * `#name` is a channel), or `default`. Also accepts `{ owner: '<spec>' }`.
 *
 * @param raw - Spec
 * @returns Parsed spec
 * @throws AppsCloudError validation
 */
export function parseOwnerSpec(raw: unknown): OwnerSpec {
  const value = raw && typeof raw === 'object' ? (raw as { owner?: unknown }).owner : raw;
  if (typeof value !== 'string' || !value.trim()) throw validation("owner is 'agent:<name>', 'team:<name>', 'channel:#<name>' or 'default'.");
  const s = value.trim();
  if (s.toLowerCase() === 'default') return { kind: 'default' };
  if (s.startsWith('#')) return { kind: 'channel', ref: s };
  const m = /^(agent|team|channel):(.+)$/i.exec(s);
  if (!m || !m[2].trim() || m[2].length > 128) throw validation("owner is 'agent:<name>', 'team:<name>', 'channel:#<name>' or 'default'.");
  return { kind: m[1].toLowerCase() as 'agent' | 'team' | 'channel', ref: m[2].trim() };
}

/**
 * Whether a session is the owning agent, or a member of the owning team /
 * channel, on this instance.
 *
 * @param owner - Cloud's owner view
 * @param session - Agent session
 * @param instanceId - This instance
 * @returns True for an owner member
 */
export function isOwnerMember(owner: CloudOwnerView | null, session: string, instanceId: string): boolean {
  if (!owner || (owner.instanceId && owner.instanceId !== instanceId)) return false;
  if (owner.kind === 'agent') return owner.session === session;
  return (owner.members ?? []).includes(session);
}

const APP_ID_RE = /^[a-km-np-z2-9]{10}$/;
const COLLECTION_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DOC_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function validation(message: string): AppsCloudError {
  return new AppsCloudError(400, C.ERROR_CODES.VALIDATION, message);
}

/**
 * Check an app id's shape.
 *
 * @param appId - Candidate
 * @returns The id
 * @throws AppsCloudError validation
 */
export function requireAppId(appId: unknown): string {
  if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) throw validation('appId must be a 10-character Crewly app id.');
  return appId;
}

function requireCollection(c: unknown): string {
  if (typeof c !== 'string' || !COLLECTION_RE.test(c)) throw validation('collection must be 1-64 of A-Z a-z 0-9 _ -.');
  return c;
}

function requireDocId(id: unknown): string {
  if (typeof id !== 'string' || !DOC_ID_RE.test(id) || id === '.' || id === '..') {
    throw validation('docId must be 1-128 of A-Z a-z 0-9 _ . : - (and not "." or "..").');
  }
  return id;
}

function notYourApp(): AppsCloudError {
  return new AppsCloudError(
    403,
    C.ERROR_CODES.NOT_YOUR_APP,
    'This app was published by another agent. Only its publisher can publish or roll it back, and only the publisher and its team can use its data. Ask the owner if you need it.',
  );
}

function notMentioned(): AppsCloudError {
  return new AppsCloudError(
    403,
    C.ERROR_CODES.NOT_YOUR_APP,
    'This app was published by an agent outside your team, and the owner did not @mention you in this comment. Only the publisher\'s team and agents mentioned in a thread can use it.',
  );
}

/** The parts of a Cloud comment thread the mention check reads. */
interface ThreadMentions {
  mentions?: Array<{ session?: string; instanceId?: string }>;
  replies?: Array<{ mentions?: Array<{ session?: string; instanceId?: string }> }>;
}

/**
 * Whether the owner @mentioned `session` (on this instance) anywhere in a thread.
 *
 * @param t - Thread from Cloud
 * @param session - Agent session
 * @param instanceId - This instance's id (null = unknown: any instance)
 * @returns True when mentioned in the comment or one of its replies
 */
export function threadMentions(t: ThreadMentions | null | undefined, session: string, instanceId: string | null): boolean {
  if (!t) return false;
  const lists = [t.mentions ?? [], ...(t.replies ?? []).map((r) => r.mentions ?? [])];
  return lists.some((l) => Array.isArray(l) && l.some((m) => m?.session === session && (!instanceId || !m.instanceId || m.instanceId === instanceId)));
}

function requireData(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw validation('data must be a JSON object.');
  return data as Record<string, unknown>;
}

function optString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The app's plain URL (what agents see; opens the sign-in page without a session).
 *
 * @param appId - App id
 * @returns URL
 */
export function plainAppUrl(appId: string): string {
  return `${C.APPS_ORIGIN}/${appId}`;
}

/**
 * The "📱 <name> · Open app" card text. Markdown link: the reply path turns
 * it into a Slack link. A pending public request adds one line asking the
 * owner to approve or decline it in the app.
 *
 * @param name - App name
 * @param url - The link (signed or plain)
 * @param pending - The app's pending public request, if any
 * @returns Card text
 */
export function appCardText(name: string, url: string, pending?: PublicRequestView | null): string {
  const clean = name.replace(/[[\]()\r\n]/g, ' ').replace(/\s+/g, ' ').trim() || 'App';
  const card = `📱 ${clean} · [Open app](${url})`;
  if (!pending) return card;
  // Names are validated collection names (P2 regex), safe to print.
  const safe = (xs: string[]) => xs.filter((x) => COLLECTION_RE.test(x)).join(', ');
  const parts = [
    pending.publicRead.length ? `read ${safe(pending.publicRead)}` : '',
    pending.publicSubmit.length ? `submit to ${safe(pending.publicSubmit)}` : '',
  ].filter(Boolean);
  return `${card}\n⚠️ Waiting for you: a request to make this app public (anyone with the link could ${parts.join('; ') || 'open it'}). Open the app to approve or decline it.`;
}

/**
 * Check a list of collection names for a public request.
 *
 * @param v - Candidate (array of names, or a comma-separated string)
 * @param what - Field name for the message
 * @returns Unique names
 * @throws AppsCloudError validation
 */
export function requireCollectionList(v: unknown, what: string): string[] {
  if (v === undefined || v === null || v === '') return [];
  const raw = typeof v === 'string' ? v.split(',') : v;
  if (!Array.isArray(raw)) throw validation(`${what} must be a list of collection names.`);
  const names = [...new Set(raw.map((x) => (typeof x === 'string' ? x.trim() : x)).filter((x) => x !== ''))];
  for (const n of names) {
    if (typeof n !== 'string' || !COLLECTION_RE.test(n)) throw validation(`${what}: "${String(n).slice(0, 70)}" is not a collection name (1-64 of A-Z a-z 0-9 _ -).`);
  }
  if (names.length > C.PUBLIC_REQUEST.MAX_COLLECTIONS) throw validation(`${what} can name at most ${C.PUBLIC_REQUEST.MAX_COLLECTIONS} collections.`);
  return names as string[];
}

/**
 * Check a public request body.
 *
 * @param input - `{ publicRead?, publicSubmit?, note? }`
 * @returns The body Cloud gets
 * @throws AppsCloudError validation
 */
export function validatePublicRequest(input: unknown): { publicRead: string[]; publicSubmit: string[]; note?: string } {
  const o = input && typeof input === 'object' && !Array.isArray(input) ? (input as PublicRequestInput) : null;
  if (!o) throw validation('publicRequest must be an object { publicRead?, publicSubmit?, note? }.');
  const publicRead = requireCollectionList(o.publicRead, 'publicRead');
  const publicSubmit = requireCollectionList(o.publicSubmit, 'publicSubmit');
  if (publicRead.length === 0 && publicSubmit.length === 0) {
    throw validation('A public request names at least one collection in publicRead or publicSubmit.');
  }
  if (o.note !== undefined && o.note !== null && typeof o.note !== 'string') throw validation('note must be text.');
  const note = optString(o.note);
  if (note && note.length > C.PUBLIC_REQUEST.MAX_NOTE_CHARS) throw validation(`note is at most ${C.PUBLIC_REQUEST.MAX_NOTE_CHARS} characters.`);
  return { publicRead, publicSubmit, ...(note ? { note } : {}) };
}

/**
 * Check a link lifetime.
 *
 * @param v - Days (number or numeric string), or empty for Cloud's default
 * @returns Days, or undefined
 * @throws AppsCloudError validation
 */
export function requireTtlDays(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < C.OPEN_LINK.MIN_TTL_DAYS || n > C.OPEN_LINK.MAX_TTL_DAYS) {
    throw validation(`ttlDays is a whole number of days, ${C.OPEN_LINK.MIN_TTL_DAYS}-${C.OPEN_LINK.MAX_TTL_DAYS}.`);
  }
  return n;
}

/**
 * Normalise Cloud's pending request (null when there is none).
 *
 * @param v - Cloud's `publicRequest`
 * @returns The request or null
 */
function pendingOf(v: unknown): PublicRequestView | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((n): n is string => typeof n === 'string') : []);
  const str = (x: unknown) => (typeof x === 'string' ? x : null);
  return { publicRead: list(r.publicRead), publicSubmit: list(r.publicSubmit), note: str(r.note), requestedBy: str(r.requestedBy), requestedAt: str(r.requestedAt) };
}

/** The message every public request answers with: only the owner can approve it. */
export const PUBLIC_REQUEST_MESSAGE = 'Requested: the owner approves it by opening the app. Until then the app stays private; no agent can make it public.';

/**
 * Said when publishing or rolling back a public app took it private again
 * (crewly-services #33: every new current version of a public app needs the
 * owner's re-approval).
 */
export const PUBLIC_PAUSED_MESSAGE =
  'This app was public. Publishing or rolling back a public app makes it private again until the owner re-approves it in the app (they sign in with Google there to approve). Tell the owner; do not say it is public.';

/** One blocked word: its display form and the pattern that finds it. */
const BLOCKED_NAME_PATTERNS: Array<{ word: string; re: RegExp }> = C.PUBLIC_REQUEST.BLOCKED_NAME_WORDS.map((word) => {
  const parts = word.split(/[\s-]+/);
  if (parts.length === 1) return { word, re: new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') };
  // "sign in" / "sign-in" / "log in": whole words, any of space, hyphen, underscore or nothing between.
  return { word, re: new RegExp(`\\b${parts.join('[\\s_-]*')}\\b`, 'i') };
});

/**
 * The first word Cloud refuses in a public app's name, if any
 * (crewly-services #33; {@link CREWLY_APPS_CONSTANTS.PUBLIC_REQUEST}.BLOCKED_NAME_WORDS).
 *
 * @param name - App name
 * @returns The blocked word found, or null
 */
export function blockedPublicNameWord(name: string): string | null {
  for (const { word, re } of BLOCKED_NAME_PATTERNS) if (re.test(name)) return word;
  return null;
}

/**
 * Refuse a public request for an app whose name Cloud would refuse at approval.
 *
 * @param name - App name
 * @throws AppsCloudError validation naming the word
 */
export function assertPublicName(name: string): void {
  const word = blockedPublicNameWord(name);
  if (word) {
    throw validation(
      `A public app's name may not contain "${word}" (nor any of: ${C.PUBLIC_REQUEST.BLOCKED_NAME_WORDS.join(', ')}); the owner could not approve it. Rename the app (--name) and ask again.`,
    );
  }
}

/**
 * Publishing and data access for Crewly Apps.
 */
export class AppsService {
  constructor(private readonly deps: AppsServiceDeps) {}

  /**
   * Publish a bundle: find the caller's app (or create one), upload a new
   * version, record it locally, and optionally post the Slack card.
   *
   * @param input - Files and options from the skill
   * @param caller - Agent session or owner
   * @returns appId, url, version, whether it was created / notified
   * @throws AppsCloudError on validation or a Cloud failure
   */
  async publish(input: PublishInput, caller: AppsCaller): Promise<PublishResult> {
    const files = this.validateFiles(input.files);
    const explicitId = input.appId !== undefined && input.appId !== null && input.appId !== '' ? requireAppId(input.appId) : undefined;
    const source = optString(input.source) ?? null;
    const name = optString(input.name);
    const agentSession = caller.agentSession ?? null;
    if (name && name.length > 80) throw validation('name is at most 80 characters.');
    const publicBody = input.publicRequest === undefined || input.publicRequest === null ? null : validatePublicRequest(input.publicRequest);
    if (publicBody && name) assertPublicName(name);

    const { registry, client } = this.deps;
    let entry: AppRegistryEntry | null = await registry.find({ appId: explicitId, agentSession, source, name });
    // An agent publishes only to its own apps; adopting an app made elsewhere is the owner's call.
    if (explicitId && agentSession && (!entry || entry.agentSession !== agentSession)) throw notYourApp();
    let app: CloudAppView | null = null;
    let created = false;
    if (entry && !explicitId) {
      // Found by source/name: if the owner deleted it, publish a new app instead.
      try {
        app = await client.request<CloudAppView>('GET', `/apps/${entry.appId}`, { agent: caller.agentSession });
      } catch (err) {
        if (!(err instanceof AppsCloudError) || err.status !== 404) throw err;
        await registry.markDeleted(entry.appId);
        entry = null;
      }
    } else if (entry) {
      app = await client.request<CloudAppView>('GET', `/apps/${entry.appId}`, { agent: caller.agentSession });
    }
    if (entry && app) {
      if (name && name !== app.name) {
        app = await client.request<CloudAppView>('PATCH', `/apps/${app.appId}`, { body: { name }, agent: caller.agentSession });
      }
    } else if (explicitId) {
      // An app made elsewhere (another machine, the portal): adopt it.
      app = await client.request<CloudAppView>('GET', `/apps/${explicitId}`, { agent: caller.agentSession });
    } else {
      const newName = name ?? (source ? path.basename(source).replace(/\.[^.]+$/, '') : '');
      // Checked before the app is created, so a refused name leaves nothing behind.
      if (publicBody) assertPublicName(newName.slice(0, 80) || 'App');
      app = await client.request<CloudAppView>('POST', '/apps', { body: { name: newName.slice(0, 80) || 'App' }, agent: caller.agentSession });
      created = true;
    }
    if (publicBody) assertPublicName(app.name);
    const wasPublic = app.visibility === 'public';

    const entryFile = optString(input.entry);
    const note = optString(input.note);
    const version = await client.request<CloudVersionView>('POST', `/apps/${app.appId}/versions`, {
      body: {
        files,
        ...(entryFile ? { entry: entryFile } : {}),
        ...(note ? { note: note.slice(0, 200) } : {}),
      },
      agent: caller.agentSession,
    });

    entry = await registry.upsert(app.appId, {
      name: app.name,
      url: app.url,
      // The last agent to publish owns the wake; an owner publish keeps it.
      ...(agentSession ? { agentSession } : {}),
      ...(source ? { source } : {}),
      currentVersion: version.version,
      // A brand-new app has no history: start right before its first change,
      // so an owner edit made before the first poll is not skipped.
      ...(created ? { cursor: 0 } : {}),
      deleted: false,
    });

    // The portal's thumbnail follows the new version (background; never fails or slows the publish).
    try {
      this.deps.thumbnails?.schedule(app.appId, caller.agentSession);
    } catch {
      /* best effort */
    }
    // Who the owner can @mention in this app's comments (background; only sent when it changed).
    void this.deps.roster?.pushIfChanged().catch(() => false);

    // crewly-services #33: a new version of a public app takes it private
    // with a pending re-approval. Re-read the app (one GET, only when it was public).
    let publicPaused = false;
    if (wasPublic) {
      const after = await client.request<CloudAppView>('GET', `/apps/${app.appId}`, { agent: caller.agentSession }).catch(() => null);
      if (after) {
        publicPaused = after.visibility === 'private' && !!pendingOf(after.publicRequest);
        app = { ...app, visibility: after.visibility, publicRequest: after.publicRequest };
      }
    }

    // P3: ask the owner to make it public. The version is already up, so a
    // failure here is reported, not thrown.
    let pending = pendingOf(app.publicRequest);
    let publicRequested: boolean | undefined;
    let publicError: string | undefined;
    if (publicBody) {
      try {
        const v = await client.request<{ visibility?: AppVisibility; publicRequest?: unknown }>('POST', `/apps/${app.appId}/visibility-request`, {
          body: publicBody,
          agent: caller.agentSession,
        });
        pending = pendingOf(v?.publicRequest) ?? { ...publicBody, note: publicBody.note ?? null, requestedBy: caller.agentSession ?? null, requestedAt: null };
        publicRequested = true;
      } catch (err) {
        publicRequested = false;
        publicError = errorText(err);
      }
    }

    // An agent's public request always tells the owner, so the card goes out with it.
    const card: CardResult =
      input.notify === true || (publicRequested === true && !!caller.agentSession)
        ? await this.sendCard({ appId: app.appId, name: app.name, pending }, caller, entry.agentSession ?? null)
        : { notified: false };

    return {
      appId: app.appId,
      name: app.name,
      url: plainAppUrl(app.appId),
      version: version.version,
      created,
      ...card,
      ...(publicRequested !== undefined ? { publicRequested } : {}),
      ...(publicError ? { publicError } : {}),
      ...(publicPaused ? { publicPaused: true, publicPausedMessage: PUBLIC_PAUSED_MESSAGE } : {}),
    };
  }

  /**
   * Post the "Open app" card for the owner.
   *
   * Destination rule (P3 §1): when the agent has a DM with the owner, a
   * fresh signed link is minted and the card goes to that DM only — never
   * to a room, a team channel or a shared room, wherever the conversation
   * happens to be. Without a DM, or when minting or the DM post fails, the
   * card carries the plain URL and goes where the agent talks with the owner
   * (P2). The signed URL is never returned.
   *
   * @param app - App id, name and its pending public request
   * @param caller - Agent or owner
   * @param publisher - The app's recorded agent (posts the card for an owner call)
   * @param ttlDays - Link lifetime (Cloud's default when omitted)
   * @returns What was posted, without the URL
   */
  private async sendCard(
    app: { appId: string; name: string; pending: PublicRequestView | null },
    caller: AppsCaller,
    publisher: string | null,
    ttlDays?: number,
  ): Promise<CardResult> {
    const poster = caller.agentSession ?? publisher;
    if (!poster) return { notified: false, notifyError: 'Only an agent can post the app card (it goes out under the agent’s identity), and this app has no recorded agent.' };
    const cards = this.deps.cards;
    if (!cards) return { notified: false, notifyError: 'Posting the app card is not available on this instance.' };

    let linkError: string | undefined;
    const dm = await cards.ownerDm(poster).catch(() => null);
    if (dm) {
      let link: MintedOpenLink | null = null;
      try {
        link = usableMintedLink(
          app.appId,
          await this.deps.client.request<unknown>('POST', `/apps/${app.appId}/open-links`, { body: ttlDays ? { ttlDays } : {}, agent: caller.agentSession }),
        );
        if (!link) linkError = 'Crewly Cloud did not return a usable open-link; the card has the plain URL (the owner may have to sign in).';
      } catch (err) {
        linkError = `Could not mint a signed link (${errorText(err)}); the card has the plain URL (the owner may have to sign in).`;
      }
      if (link) {
        const r = await cards.postToOwnerDm(poster, dm, appCardText(app.name, link.url, app.pending)).catch((err: unknown) => ({ ok: false, error: errorText(err) }));
        if (r.ok) {
          return { notified: true, card: 'signed', cardPlace: 'owner-dm', linkId: link.linkId, ...(link.expiresAt ? { linkExpiresAt: link.expiresAt } : {}) };
        }
        // Never leave a live link nobody received.
        await this.deps.client.request('DELETE', `/apps/${app.appId}/open-links/${link.linkId}`, { agent: caller.agentSession }).catch(() => undefined);
        linkError = `The signed card could not be posted to the DM with the owner (${r.error ?? 'not delivered'}); sent the plain URL instead.`;
      }
    } else {
      linkError = 'No DM with the owner to put a signed link in; the card has the plain URL (the owner may have to sign in).';
    }

    const r = await cards.postReply(poster, appCardText(app.name, plainAppUrl(app.appId), app.pending)).catch((err: unknown) => ({ ok: false, error: errorText(err) }));
    return {
      notified: r.ok,
      ...(r.ok ? { card: 'plain' as const, cardPlace: 'conversation' as const } : { notifyError: r.error ?? 'The card could not be delivered.' }),
      ...(linkError ? { linkError } : {}),
    };
  }

  /**
   * Post the card again with a fresh signed link, without publishing (P3 §1, re-share).
   *
   * @param appId - App id
   * @param opts - `ttlDays` (1-30, Cloud's default 7)
   * @param caller - Agent (its own apps) or owner (any; posts as the recorded agent)
   * @returns What was posted; never the signed URL
   */
  async share(appId: unknown, opts: { ttlDays?: unknown }, caller: AppsCaller): Promise<ShareResult> {
    const id = requireAppId(appId);
    const ttlDays = requireTtlDays(opts.ttlDays);
    await this.assertPublisher(id, caller);
    const app = await this.deps.client.request<CloudAppView>('GET', `/apps/${id}`, { agent: caller.agentSession });
    const pending = pendingOf(app.publicRequest);
    const entry = await this.deps.registry.get(id);
    const card = await this.sendCard({ appId: id, name: app.name, pending }, caller, entry?.agentSession ?? null, ttlDays);
    return { appId: id, name: app.name, url: plainAppUrl(id), visibility: app.visibility ?? 'private', publicRequestPending: !!pending, ...card };
  }

  /**
   * The app's open-links (no tokens).
   *
   * @param appId - App id
   * @param caller - Agent (its own apps) or owner
   * @returns Links, newest as Cloud orders them
   */
  async links(appId: unknown, caller: AppsCaller): Promise<OpenLinkInfo[]> {
    const id = requireAppId(appId);
    await this.assertPublisher(id, caller);
    return toOpenLinkInfos(await this.deps.client.request<unknown>('GET', `/apps/${id}/open-links`, { agent: caller.agentSession }));
  }

  /**
   * Revoke one open-link.
   *
   * @param appId - App id
   * @param linkId - Link id
   * @param caller - Agent (its own apps) or owner
   * @returns `{ revoked: true }`; 404 not_found for an unknown link
   */
  async revokeLink(appId: unknown, linkId: unknown, caller: AppsCaller): Promise<{ revoked: boolean }> {
    const id = requireAppId(appId);
    if (typeof linkId !== 'string' || !C.OPEN_LINK.LINK_ID_PATTERN.test(linkId)) throw validation('linkId must be 1-64 of A-Z a-z 0-9 _ -.');
    await this.assertPublisher(id, caller);
    const r = await this.deps.client.request<{ revoked?: unknown }>('DELETE', `/apps/${id}/open-links/${linkId}`, { agent: caller.agentSession });
    return { revoked: r?.revoked === true };
  }

  /**
   * Revoke every open-link of an app.
   *
   * @param appId - App id
   * @param caller - Agent (its own apps) or owner
   * @returns `{ revoked: <count> }`
   */
  async revokeLinks(appId: unknown, caller: AppsCaller): Promise<{ revoked: number }> {
    const id = requireAppId(appId);
    await this.assertPublisher(id, caller);
    const r = await this.deps.client.request<{ revoked?: unknown }>('DELETE', `/apps/${id}/open-links`, { agent: caller.agentSession });
    return { revoked: typeof r?.revoked === 'number' ? r.revoked : 0 };
  }

  /**
   * Ask the owner to make an app public (P3 §2). Only records the request:
   * Cloud flips visibility only from the owner's own session in the apps
   * shell, so nothing here can make an app public. An agent's request also
   * posts the card, which tells the owner to approve or decline it.
   *
   * @param appId - App id
   * @param input - Collections to open for reading / anonymous submissions, and a note
   * @param caller - Agent (its own apps) or owner
   * @returns The recorded request and the card result
   */
  async requestPublic(appId: unknown, input: unknown, caller: AppsCaller): Promise<PublicRequestResult> {
    const id = requireAppId(appId);
    const body = validatePublicRequest(input);
    await this.assertPublisher(id, caller);
    const current = await this.deps.client.request<CloudAppView>('GET', `/apps/${id}`, { agent: caller.agentSession });
    assertPublicName(current.name);
    const v = await this.deps.client.request<{ visibility?: AppVisibility; publicRequest?: unknown }>('POST', `/apps/${id}/visibility-request`, {
      body,
      agent: caller.agentSession,
    });
    const pending = pendingOf(v?.publicRequest);
    let card: CardResult = { notified: false };
    if (caller.agentSession) {
      const entry = await this.deps.registry.get(id);
      card = await this.sendCard(
        { appId: id, name: current.name || entry?.name || 'App', pending: pending ?? { ...body, note: body.note ?? null, requestedBy: caller.agentSession, requestedAt: null } },
        caller,
        entry?.agentSession ?? null,
      );
    }
    return { appId: id, url: plainAppUrl(id), visibility: v?.visibility ?? 'private', publicRequest: pending, message: PUBLIC_REQUEST_MESSAGE, ...card };
  }

  /**
   * Withdraw a pending public request.
   *
   * @param appId - App id
   * @param caller - Agent (its own apps) or owner
   * @returns Cloud's answer
   */
  async cancelPublicRequest(appId: unknown, caller: AppsCaller): Promise<{ appId: string; cancelled: true; visibility: AppVisibility }> {
    const id = requireAppId(appId);
    await this.assertPublisher(id, caller);
    const r = await this.deps.client.request<{ visibility?: AppVisibility }>('DELETE', `/apps/${id}/visibility-request`, { agent: caller.agentSession });
    return { appId: id, cancelled: true, visibility: r?.visibility ?? 'private' };
  }

  /**
   * Make an app private again (instant; always allowed).
   *
   * @param appId - App id
   * @param caller - Agent (its own apps) or owner
   * @returns `{ visibility: 'private' }`
   */
  async makePrivate(appId: unknown, caller: AppsCaller): Promise<{ appId: string; visibility: AppVisibility }> {
    const id = requireAppId(appId);
    await this.assertPublisher(id, caller);
    const r = await this.deps.client.request<{ visibility?: AppVisibility }>('POST', `/apps/${id}/make-private`, { agent: caller.agentSession });
    return { appId: id, visibility: r?.visibility ?? 'private' };
  }

  /**
   * Make an earlier retained version current.
   *
   * @param appId - App id
   * @param version - Version number
   * @param caller - Agent or owner
   * @returns The app after rollback
   */
  async rollback(appId: unknown, version: unknown, caller: AppsCaller): Promise<CloudAppView & { publicPaused?: boolean; publicPausedMessage?: string }> {
    const id = requireAppId(appId);
    const v = typeof version === 'string' ? Number(version) : version;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw validation('version must be a positive integer.');
    await this.assertPublisher(id, caller);
    // Was it public? A rollback of a public app takes it private (crewly-services #33).
    const before = await this.deps.client.request<CloudAppView>('GET', `/apps/${id}`, { agent: caller.agentSession }).catch(() => null);
    const app = await this.deps.client.request<CloudAppView>('POST', `/apps/${id}/rollback`, { body: { version: v }, agent: caller.agentSession });
    if (await this.deps.registry.get(id)) await this.deps.registry.upsert(id, { currentVersion: app.currentVersion });
    try {
      this.deps.thumbnails?.schedule(id, caller.agentSession);
    } catch {
      /* best effort */
    }
    let after: CloudAppView | null = app;
    if (before?.visibility === 'public' && app.visibility === undefined) {
      after = await this.deps.client.request<CloudAppView>('GET', `/apps/${id}`, { agent: caller.agentSession }).catch(() => null);
    }
    const paused = before?.visibility === 'public' && after?.visibility === 'private' && !!pendingOf(after.publicRequest);
    return paused ? { ...app, publicPaused: true, publicPausedMessage: PUBLIC_PAUSED_MESSAGE } : app;
  }

  /**
   * Versions of an app, newest first.
   *
   * @param appId - App id
   * @param caller - Agent or owner
   * @returns Versions
   */
  async versions(appId: unknown, caller: AppsCaller): Promise<CloudVersionView[]> {
    const id = requireAppId(appId);
    await this.assertPublisher(id, caller);
    return this.deps.client.request<CloudVersionView[]>('GET', `/apps/${id}/versions`, { agent: caller.agentSession });
  }

  /**
   * Transfer an app to another agent, so a new team can publish it.
   *
   * Allowed: the owner, the orchestrator, the current publisher, or a lead of
   * the publisher's team. The target must be a member of an existing,
   * non-archived team on this machine. Cloud is updated first (the portal's
   * publisher), then the local registry, which wake deliveries, team ownership
   * checks and thumbnails all read. The old and new publisher are told.
   *
   * @param appId - App id
   * @param toSession - New publisher's session
   * @param caller - Agent or owner
   * @returns What changed
   * @throws AppsCloudError validation / 403 not_your_app / 404 not_found
   */
  async transfer(appId: unknown, toSession: unknown, caller: AppsCaller): Promise<TransferResult> {
    const id = requireAppId(appId);
    if (typeof toSession !== 'string' || !/^[A-Za-z0-9_.@:-]{1,128}$/.test(toSession)) {
      throw validation('toSession must be the session name of the agent that takes the app over.');
    }
    const entry = await this.deps.registry.get(id);
    if (!entry || entry.deleted) throw new AppsCloudError(404, 'not_found', 'No such app on this machine.');
    const me = caller.agentSession;
    const current = entry.agentSession ?? null;
    if (me && me !== ORCHESTRATOR_SESSION_NAME && me !== current) {
      const lead = !!current && !!this.deps.directory && (await this.deps.directory.leadsTeamOf(me, current).catch(() => false));
      if (!lead) {
        throw new AppsCloudError(
          403,
          C.ERROR_CODES.NOT_YOUR_APP,
          'Only the owner, the orchestrator, the app\'s publisher or the lead of the publisher\'s team can transfer an app.',
        );
      }
    }
    const target = this.deps.directory ? await this.deps.directory.member(toSession) : null;
    if (!target) throw validation(`${toSession} is not a member of an active team on this machine, so it cannot take over an app.`);
    if (current === toSession) return { appId: id, name: entry.name, publisher: toSession, previous: current, changed: false, notified: [] };

    await this.deps.client.request('PUT', `/apps/${id}/publisher`, { body: { session: toSession }, agent: me });
    const moved = await this.deps.registry.setPublisher(id, toSession);
    const previous = moved?.previous ?? current;

    const notified: string[] = [];
    const tell = async (session: string | null, text: string, activate: boolean): Promise<void> => {
      if (!session || session === me || !this.deps.notifyAgent) return;
      if (await this.deps.notifyAgent(session, text, activate).catch(() => false)) notified.push(session);
    };
    const label = entry.name ? `"${entry.name}" (${id})` : id;
    const who = me ? `${me}` : 'the owner';
    await tell(
      toSession,
      `[Crewly Apps] ${who} transferred the app ${label} to you. You are now its publisher: new versions, rollbacks, data and comments are yours. ` +
        `Publish with: publish-app --app ${id} --dir <your project directory>${entry.source ? ` (it was last published from ${entry.source})` : ''}.`,
      true,
    );
    await tell(
      previous,
      `[Crewly Apps] The app ${label} was transferred to ${toSession} by ${who}. You can no longer publish, roll back or use its data; its comments and changes now go to ${toSession}.`,
      false,
    );
    return { appId: id, name: entry.name, publisher: toSession, previous, changed: true, notified };
  }

  /**
   * Agents may manage (publish, roll back, list versions of) apps they or a
   * teammate published — so a lead can hand app work to a member (owner
   * 2026-10-05: Kai could not update Atlas's app and published a duplicate).
   * The owner may manage any. Collaborators do NOT pass here: they get data
   * and comments only, never the bundle (specs/2026-10-06-app-collaborators.md).
   *
   * @param appId - App id
   * @param caller - Agent or owner
   * @throws AppsCloudError 403 not_your_app
   */
  async assertPublisher(appId: string, caller: AppsCaller): Promise<void> {
    if (!(await this.isPublisherSide(appId, caller))) throw notYourApp();
  }

  /**
   * Agents may read and write the data of apps they published, or that a
   * teammate published, or that the owner added them (or their team) to as
   * a collaborator. The owner may use any.
   *
   * @param appId - App id
   * @param caller - Agent or owner
   * @throws AppsCloudError 403 not_your_app
   */
  async assertDataAccess(appId: string, caller: AppsCaller): Promise<void> {
    if (await this.isPublisherSide(appId, caller)) return;
    if (caller.agentSession && (await this.isCollaborator(appId, caller.agentSession))) return;
    throw notYourApp();
  }

  /** The owner, the publisher, or a teammate of the publisher (local registry). */
  private async isPublisherSide(appId: string, caller: AppsCaller): Promise<boolean> {
    const me = caller.agentSession;
    if (!me) return true;
    const entry = await this.deps.registry.get(appId);
    const publisher = entry?.agentSession;
    if (!publisher) return false;
    if (publisher === me) return true;
    return !!this.deps.sameTeam && (await this.deps.sameTeam(me, publisher).catch(() => false));
  }

  /**
   * Whether the owner added this agent, or its team, to the app. Asks Cloud on
   * every call (no cache) so a removal applies at once; any failure, a 404 (the
   * app is not this account's) or an unreachable Cloud counts as no.
   *
   * @param appId - App id
   * @param session - The agent
   * @returns True when listed for this instance
   */
  async isCollaborator(appId: string, session: string): Promise<boolean> {
    if (!this.deps.instanceId) return false;
    try {
      const [instanceId, list] = await Promise.all([
        this.deps.instanceId(),
        this.deps.client.request<{ collaborators?: Array<{ kind?: string; who?: string; instanceId?: string }>; owner?: CloudOwnerView | null }>('GET', `/apps/${appId}/collaborators`, { agent: session }),
      ]);
      // Members of the owning team / channel (and the owning agent) are collaborators without an entry.
      if (instanceId && isOwnerMember(list.owner ?? null, session, instanceId)) return true;
      const mine = (list.collaborators ?? []).filter((c) => !!instanceId && c.instanceId === instanceId);
      if (mine.some((c) => c.kind === 'agent' && c.who === session)) return true;
      const teams = mine.filter((c) => c.kind === 'team').map((c) => c.who);
      if (teams.length === 0 || !this.deps.directory) return false;
      const team = (await this.deps.directory.member(session))?.team;
      return !!team && teams.includes(team);
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Owner (crewly-services apps/SPEC.md §15): who the app's comments go to —
  // one agent, a team or a Crewly channel of this machine. Cloud decides who
  // may change it (the owner, or the app's current owner agents).
  // -------------------------------------------------------------------------

  /**
   * The app's owner.
   *
   * @param appId - App id
   * @param caller - Agent or owner
   * @returns `{ appId, owner }` from Cloud
   */
  async getOwner(appId: unknown, caller: AppsCaller): Promise<{ appId: string; owner: CloudOwnerView | null }> {
    const id = requireAppId(appId);
    return this.deps.client.request('GET', `/apps/${id}/owner`, caller.agentSession ? { agent: caller.agentSession } : { asOwner: true });
  }

  /**
   * Set who owns the app's comments, from a spec: `agent:<session or name>`,
   * `team:<name or id>`, `channel:#<name>` (or its id), or `default` (back to
   * the publishing agent). The team / channel / agent is looked up on this
   * machine and bound to this instance. The roster is pushed first so Cloud
   * knows a channel made a moment ago. An agent caller must be one of the
   * app's owner agents (Cloud refuses others with 403 `forbidden`).
   *
   * @param appId - App id
   * @param spec - Owner spec (string) or `{ owner: string }`
   * @param caller - Agent or owner
   * @returns `{ appId, owner, previous }` from Cloud
   * @throws AppsCloudError validation (unknown team / channel / agent, bad spec)
   */
  async setOwner(appId: unknown, spec: unknown, caller: AppsCaller): Promise<{ appId: string; owner: CloudOwnerView | null; previous: CloudOwnerView | null }> {
    const id = requireAppId(appId);
    const parsed = parseOwnerSpec(spec);
    let body: Record<string, unknown> = { kind: 'default' };
    if (parsed.kind !== 'default') {
      const targets = this.deps.ownerTargets;
      if (!targets) throw new AppsCloudError(503, 'unavailable', 'App owners are not available on this machine.');
      if (parsed.kind === 'agent') {
        const a = await targets.agent(parsed.ref);
        if (!a) throw validation(`No agent "${parsed.ref}" on this machine.`);
        body = { kind: 'agent', session: a.session };
      } else if (parsed.kind === 'team') {
        const t = await targets.team(parsed.ref);
        if (!t) throw validation(`No team "${parsed.ref}" on this machine.`);
        body = { kind: 'team', teamId: t.id };
      } else {
        const c = await targets.channel(parsed.ref);
        if (!c) throw validation(`No channel "${parsed.ref}" on this machine. List them with list-channels.`);
        body = { kind: 'channel', channelId: c.id };
      }
      const instanceId = this.deps.instanceId ? await this.deps.instanceId() : null;
      if (!instanceId) throw new AppsCloudError(409, C.ERROR_CODES.NO_INSTANCE, 'This machine has no Crewly Cloud instance id yet. Try again in a minute.');
      body['instanceId'] = instanceId;
      // Cloud checks the owner against this machine's roster: make sure it is current.
      await this.deps.roster?.pushIfChanged().catch(() => false);
    }
    return this.deps.client.request('PUT', `/apps/${id}/owner`, { body, ...(caller.agentSession ? { agent: caller.agentSession } : { asOwner: true }) });
  }

  /**
   * An owner agent adds another agent as a collaborator (it may then read and
   * write the app's data and comments). The agent may run on any machine of
   * the account: `who` is a name or session (`Rex`), or `<name>@<machine>`
   * (`Rex@iriss-air`). Cloud resolves it across every machine's roster and
   * refuses a bare name that is on several machines, listing the choices.
   * Cloud also refuses an agent that is not one of the app's owner agents; that
   * agent can ask the owner with `request-access` instead. The owner may add
   * anyone. A Cloud that cannot look across machines yet (older crewly-apps)
   * falls back to this machine's agents, as before.
   *
   * @param appId - App id
   * @param who - Agent name or session, optionally `@machine`
   * @param caller - Agent or owner
   * @returns Cloud's collaborator list, plus who was added and on which machine
   */
  async addAgentCollaborator(appId: unknown, who: unknown, caller: AppsCaller): Promise<unknown> {
    const id = requireAppId(appId);
    if (typeof who !== 'string' || !who.trim()) throw validation('agent is the name or session of the agent to add; for another machine use name@machine (e.g. Rex@iriss-air).');
    const ref = who.trim();
    const instanceId = this.deps.instanceId ? await this.deps.instanceId() : null;
    if (!instanceId) throw new AppsCloudError(409, C.ERROR_CODES.NO_INSTANCE, 'This machine has no Crewly Cloud instance id yet. Try again in a minute.');
    // Cloud looks the name up in every machine's roster: make sure this one's is current.
    await this.deps.roster?.pushIfChanged().catch(() => false);
    const as = caller.agentSession ? { agent: caller.agentSession } : { asOwner: true as const };
    const target = await this.resolveCollaborator(id, ref, instanceId, as);
    const list = await this.deps.client.request<Record<string, unknown>>('PUT', `/apps/${id}/collaborators`, {
      body: { kind: 'agent', session: target.session, instanceId: target.instanceId },
      ...as,
    });
    return { ...list, added: target };
  }

  /**
   * Who `ref` is: Cloud's lookup across the account's machines, else (a Cloud
   * without the lookup, or no match there) this machine's agents.
   */
  private async resolveCollaborator(
    appId: string,
    ref: string,
    localInstance: string,
    as: { agent: string } | { asOwner: true },
  ): Promise<{ session: string; name?: string; instanceId: string; machine?: string }> {
    let cloudError: AppsCloudError | null = null;
    try {
      const res = await this.deps.client.request<{ agent?: { session?: unknown; name?: unknown; instanceId?: unknown; machine?: unknown } }>(
        'GET',
        `/apps/${appId}/collaborators/resolve`,
        { query: { agent: ref }, ...as },
      );
      const a = res?.agent;
      if (a && typeof a.session === 'string' && typeof a.instanceId === 'string') {
        return { session: a.session, instanceId: a.instanceId, ...(typeof a.name === 'string' ? { name: a.name } : {}), ...(typeof a.machine === 'string' ? { machine: a.machine } : {}) };
      }
    } catch (err) {
      // 409: the name is on several machines (the message lists them) — the caller must choose.
      // 404 "Not found": a Cloud without the lookup. 400: no match there. Both → this machine.
      const oldCloud = err instanceof AppsCloudError && err.status === 404 && err.message === 'Not found';
      const noMatch = err instanceof AppsCloudError && err.status === 400;
      if (!oldCloud && !noMatch) throw err;
      cloudError = noMatch ? (err as AppsCloudError) : null;
    }
    const local = ref.includes('@') ? null : this.deps.ownerTargets ? await this.deps.ownerTargets.agent(ref) : null;
    if (local) return { session: local.session, name: local.name, instanceId: localInstance };
    throw cloudError ?? validation(`No agent "${ref}" on this machine. (Crewly Cloud cannot look up your other machines yet.)`);
  }

  /**
   * Apps this instance published (local registry, not Cloud).
   *
   * @returns Entries without the poller cursor
   */
  async list(caller: AppsCaller = {}): Promise<Array<Omit<AppRegistryEntry, 'cursor' | 'delivered' | 'wakes' | 'visitorWakes'>>> {
    const me = caller.agentSession;
    const entries = await this.deps.registry.list();
    const mine = await Promise.all(
      entries.map(async (e) => !me || e.agentSession === me || (!!this.deps.sameTeam && !!e.agentSession && (await this.deps.sameTeam(me, e.agentSession).catch(() => false)))),
    );
    return entries
      .filter((_e, i) => mine[i])
      .map(({ cursor: _cursor, delivered: _delivered, wakes: _wakes, visitorWakes: _visitorWakes, ...rest }) => rest);
  }

  /**
   * One page of a collection.
   *
   * @param appId - App id
   * @param collection - Collection
   * @param opts - limit / after
   * @param caller - Agent or owner
   * @returns `{ docs, next }`
   */
  async listDocs(appId: unknown, collection: unknown, opts: { limit?: unknown; after?: unknown }, caller: AppsCaller): Promise<unknown> {
    const limit = opts.limit !== undefined && opts.limit !== '' ? Number(opts.limit) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) throw validation('limit is 1-500.');
    const after = opts.after !== undefined && opts.after !== '' ? requireDocId(opts.after) : undefined;
    const path = `/apps/${requireAppId(appId)}/data/${requireCollection(collection)}`;
    await this.assertDataAccess(appId as string, caller);
    return this.dataRequest('GET', path, {
      query: { limit, after },
      agent: caller.agentSession,
    });
  }

  /**
   * One document (`{ id, data, rev, … }`); a missing one throws 404 not_found.
   *
   * @param appId - App id
   * @param collection - Collection
   * @param docId - Document id
   * @param caller - Agent or owner
   * @returns The document
   */
  async getDoc(appId: unknown, collection: unknown, docId: unknown, caller: AppsCaller): Promise<unknown> {
    const path = this.docPath(appId, collection, docId);
    await this.assertDataAccess(appId as string, caller);
    return this.dataRequest('GET', path, { agent: caller.agentSession });
  }

  /**
   * Replace (or create) a document.
   *
   * @param appId - App id
   * @param collection - Collection
   * @param docId - Document id
   * @param data - New content
   * @param caller - Agent or owner
   * @returns The stored document
   */
  async setDoc(appId: unknown, collection: unknown, docId: unknown, data: unknown, caller: AppsCaller): Promise<unknown> {
    const path = this.docPath(appId, collection, docId);
    const body = { data: requireData(data) };
    await this.assertDataAccess(appId as string, caller);
    return this.dataRequest('PUT', path, { body, agent: caller.agentSession });
  }

  /**
   * Shallow-merge into a document; `ifRev` makes it conditional (409 conflict).
   *
   * @param appId - App id
   * @param collection - Collection
   * @param docId - Document id
   * @param data - Fields to merge
   * @param ifRev - Expected current rev (optional)
   * @param caller - Agent or owner
   * @returns The stored document
   */
  async updateDoc(appId: unknown, collection: unknown, docId: unknown, data: unknown, ifRev: unknown, caller: AppsCaller): Promise<unknown> {
    const rev = ifRev === undefined || ifRev === null || ifRev === '' ? undefined : Number(ifRev);
    if (rev !== undefined && (!Number.isInteger(rev) || rev < 0)) throw validation('ifRev must be a non-negative integer.');
    const path = this.docPath(appId, collection, docId);
    const body = { data: requireData(data), ...(rev !== undefined ? { ifRev: rev } : {}) };
    await this.assertDataAccess(appId as string, caller);
    return this.dataRequest('PATCH', path, {
      body,
      agent: caller.agentSession,
    });
  }

  /**
   * Add a document with a generated id.
   *
   * @param appId - App id
   * @param collection - Collection
   * @param data - Content
   * @param caller - Agent or owner
   * @returns The stored document
   */
  async addDoc(appId: unknown, collection: unknown, data: unknown, caller: AppsCaller): Promise<unknown> {
    const path = `/apps/${requireAppId(appId)}/data/${requireCollection(collection)}`;
    const body = { data: requireData(data) };
    await this.assertDataAccess(appId as string, caller);
    return this.dataRequest('POST', path, {
      body,
      agent: caller.agentSession,
    });
  }

  /**
   * Upload a file (an image for a post) into an app and get its URL. Same
   * access as the app's data: the publisher side, a teammate, or a
   * collaborator the owner allowed; anyone else is refused (403 not_your_app).
   * Cloud applies its own size cap and quota and its answer is passed through.
   *
   * @param appId - App id
   * @param file - Bytes, content type and the original file name
   * @param caller - Agent or owner
   * @returns Cloud's `{ fileId, name, size, contentType, url }`
   * @throws AppsCloudError validation (empty body), not_your_app, Cloud's own errors
   */
  async uploadFile(appId: unknown, file: { data: Buffer; contentType: string; name?: string }, caller: AppsCaller): Promise<unknown> {
    const path = `/apps/${requireAppId(appId)}/files`;
    if (!Buffer.isBuffer(file.data) || file.data.length === 0) throw validation('The file is empty.');
    await this.assertDataAccess(appId as string, caller);
    // The file name is echoed into agents' terminals, so the answer is sanitized like the data routes.
    return sanitizeAppData(
      await this.deps.client.request<unknown>('POST', path, {
        raw: { data: file.data, contentType: file.contentType },
        ...(file.name ? { headers: { 'X-File-Name': encodeURIComponent(file.name) } } : {}),
        agent: caller.agentSession,
      }),
    );
  }

  /**
   * Delete a document.
   *
   * @param appId - App id
   * @param collection - Collection
   * @param docId - Document id
   * @param caller - Agent or owner
   * @returns `{ deleted: true }`
   */
  async deleteDoc(appId: unknown, collection: unknown, docId: unknown, caller: AppsCaller): Promise<unknown> {
    const path = this.docPath(appId, collection, docId);
    await this.assertDataAccess(appId as string, caller);
    return this.dataRequest('DELETE', path, { agent: caller.agentSession });
  }

  // -------------------------------------------------------------------------
  // Comments (crewly#1056): the owner comments on an element in the app; the
  // publisher (or its team) lists, replies and resolves; an agent the owner
  // @mentioned in a thread may get, reply to and resolve that thread. Only the owner can
  // start a comment (in the app). Answers are sanitised like app data: the
  // comment text is the owner's, the anchor comes from the app's page.
  // -------------------------------------------------------------------------

  /**
   * The app's comment threads, oldest first.
   *
   * @param appId - App id
   * @param status - 'open' | 'resolved' | 'all' (default 'open')
   * @param caller - Agent or owner
   * @returns `{ comments: [{ id, number, version, anchor, body, author, replies, status, … }] }`
   */
  async listComments(appId: unknown, status: unknown, caller: AppsCaller): Promise<unknown> {
    const id = requireAppId(appId);
    const s = status === undefined || status === '' ? 'open' : status;
    if (s !== 'open' && s !== 'resolved' && s !== 'all') throw validation('status is open, resolved or all.');
    await this.assertDataAccess(id, caller);
    return this.dataRequest('GET', `/apps/${id}/comments`, { query: { status: s }, agent: caller.agentSession });
  }

  /**
   * One thread.
   *
   * @param appId - App id
   * @param commentId - Comment id
   * @param caller - Agent or owner
   * @returns The thread
   */
  async getComment(appId: unknown, commentId: unknown, caller: AppsCaller): Promise<unknown> {
    const path = this.commentPath(appId, commentId);
    const thread = await this.assertCommentAccess(appId as string, path, caller);
    return thread !== undefined ? sanitizeAppData(thread) : this.dataRequest('GET', path, { agent: caller.agentSession });
  }

  /**
   * Who may read, reply to and resolve one thread: the publisher's team (as
   * for the app's data), or an agent the owner @mentioned in that thread on
   * this instance (crewly-services apps/SPEC.md §12.1), even outside the
   * team. Listing all comments and managing the app stay team-only.
   *
   * @param appId - App id
   * @param path - Cloud path of the thread
   * @param caller - Agent or owner
   * @returns The thread when it had to be fetched for the check, else undefined
   * @throws AppsCloudError 403 not_your_app
   */
  private async assertCommentAccess(appId: string, path: string, caller: AppsCaller): Promise<unknown> {
    try {
      await this.assertDataAccess(appId, caller);
      return undefined;
    } catch (err) {
      if (!(err instanceof AppsCloudError) || err.code !== C.ERROR_CODES.NOT_YOUR_APP || !caller.agentSession) throw err;
    }
    const thread = await this.deps.client.request<ThreadMentions>('GET', path, { agent: caller.agentSession });
    const instanceId = this.deps.instanceId ? await this.deps.instanceId().catch(() => null) : null;
    if (!threadMentions(thread, caller.agentSession, instanceId)) throw notMentioned();
    return thread;
  }

  /**
   * Reply in a thread (shown to the owner in the app's comments).
   *
   * @param appId - App id
   * @param commentId - Comment id
   * @param text - Reply text
   * @param caller - Agent or owner
   * @returns The thread after
   */
  async replyComment(appId: unknown, commentId: unknown, text: unknown, caller: AppsCaller): Promise<unknown> {
    const path = this.commentPath(appId, commentId);
    if (typeof text !== 'string' || !text.trim()) throw validation('text is required.');
    if (text.length > C.COMMENTS.MAX_BODY_CHARS) throw validation(`A reply is at most ${C.COMMENTS.MAX_BODY_CHARS} characters.`);
    await this.assertCommentAccess(appId as string, path, caller);
    const out = await this.dataRequest('POST', `${path}/replies`, { body: { body: text.trim() }, agent: caller.agentSession });
    if (caller.agentSession) void this.deps.commentsSlack?.agentReplied(appId as string, commentId as string, caller.agentSession, text.trim()).catch(() => undefined);
    return out;
  }

  /**
   * Resolve or reopen a thread.
   *
   * @param appId - App id
   * @param commentId - Comment id
   * @param action - 'resolve' | 'reopen'
   * @param caller - Agent or owner
   * @returns The thread after
   */
  async setCommentStatus(appId: unknown, commentId: unknown, action: 'resolve' | 'reopen', caller: AppsCaller): Promise<unknown> {
    const path = this.commentPath(appId, commentId);
    await this.assertCommentAccess(appId as string, path, caller);
    const out = await this.dataRequest('POST', `${path}/${action}`, { agent: caller.agentSession });
    if (caller.agentSession) void this.deps.commentsSlack?.statusChanged(appId as string, commentId as string, caller.agentSession, action).catch(() => undefined);
    return out;
  }

  private commentPath(appId: unknown, commentId: unknown): string {
    const id = requireAppId(appId);
    if (typeof commentId !== 'string' || !C.COMMENTS.ID_PATTERN.test(commentId)) throw validation('commentId must be the id from app-comments --list.');
    return `/apps/${id}/comments/${commentId}`;
  }

  /**
   * A Cloud data call whose answer is sanitised before it leaves the backend
   * (P3 §4): documents were written by the owner, other agents or anonymous
   * visitors, and an agent prints them into its terminal, where harness
   * markers (`[CHAT_RESPONSE]`, `[DONE]`, fenced blocks), ANSI escapes or
   * bidi characters would act. Every string value and key is cleaned; the
   * structure is kept. Done here, not in the skill, so no caller bypasses it.
   *
   * @param method - HTTP method
   * @param path - Cloud path
   * @param opts - Request options
   * @returns The display-safe answer
   */
  private async dataRequest(method: string, path: string, opts: AppsRequestOptions): Promise<unknown> {
    return sanitizeAppData(await this.deps.client.request<unknown>(method, path, opts));
  }

  private docPath(appId: unknown, collection: unknown, docId: unknown): string {
    return `/apps/${requireAppId(appId)}/data/${requireCollection(collection)}/${encodeURIComponent(requireDocId(docId))}`;
  }

  private validateFiles(files: unknown): PublishFile[] {
    if (!Array.isArray(files) || files.length === 0) throw validation('files must be a non-empty array of { path, contentBase64 }.');
    return files.map((f, i) => {
      const o = (f ?? {}) as Record<string, unknown>;
      if (typeof o.path !== 'string' || !o.path || o.path.startsWith('/') || o.path.split('/').includes('..')) {
        throw validation(`files[${i}].path must be a relative path inside the bundle.`);
      }
      if (typeof o.contentBase64 !== 'string') throw validation(`files[${i}].contentBase64 is required.`);
      return {
        path: o.path,
        contentBase64: o.contentBase64,
        ...(typeof o.contentType === 'string' && o.contentType ? { contentType: o.contentType } : {}),
      };
    });
  }
}
