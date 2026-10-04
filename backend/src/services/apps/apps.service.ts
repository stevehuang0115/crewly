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
import { CREWLY_APPS_CONSTANTS } from '../../constants.js';
import { AppsCloudClient, AppsCloudError } from './apps-cloud.client.js';
import type { AppRegistryEntry, AppsRegistryService } from './apps-registry.service.js';

const C = CREWLY_APPS_CONSTANTS;

/** Cloud's view of an app (apps/SPEC.md §3.1). */
export interface CloudAppView {
  appId: string;
  name: string;
  slug: string | null;
  url: string;
  currentVersion: number | null;
  latestVersion: number;
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
}

/** Result of a publish. */
export interface PublishResult {
  appId: string;
  name: string;
  url: string;
  version: number;
  created: boolean;
  notified: boolean;
  notifyError?: string;
}

/** Who is calling: an agent session, or the owner (no session). */
export interface AppsCaller {
  agentSession?: string;
}

/** Posts the "Open app" card where the agent talks with the owner. */
export type AppCardNotifier = (agentSession: string, text: string) => Promise<{ ok: boolean; error?: string }>;

/** Constructor dependencies. */
export interface AppsServiceDeps {
  client: AppsCloudClient;
  registry: AppsRegistryService;
  notifyCard?: AppCardNotifier;
  /** Whether two agent sessions are in the same team (data access for the publisher's team) */
  sameTeam?: (a: string, b: string) => Promise<boolean>;
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

function requireData(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw validation('data must be a JSON object.');
  return data as Record<string, unknown>;
}

function optString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * The "📱 <name> · Open app" card text. Markdown link: the reply path turns
 * it into a Slack link.
 *
 * @param name - App name
 * @param appId - App id
 * @returns Card text
 */
export function appCardText(name: string, appId: string): string {
  const clean = name.replace(/[[\]()\r\n]/g, ' ').replace(/\s+/g, ' ').trim() || 'App';
  return `📱 ${clean} · [Open app](${C.APPS_ORIGIN}/${appId})`;
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
      app = await client.request<CloudAppView>('POST', '/apps', { body: { name: newName.slice(0, 80) || 'App' }, agent: caller.agentSession });
      created = true;
    }

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

    let notified = false;
    let notifyError: string | undefined;
    if (input.notify === true) {
      if (!caller.agentSession) {
        notifyError = 'Only an agent can post the app card (it goes out under the agent’s identity).';
      } else if (!this.deps.notifyCard) {
        notifyError = 'Posting the app card is not available on this instance.';
      } else {
        const r = await this.deps.notifyCard(caller.agentSession, appCardText(app.name, app.appId)).catch((err: unknown) => ({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }));
        notified = r.ok;
        if (!r.ok) notifyError = r.error ?? 'The card could not be delivered.';
      }
    }

    return {
      appId: app.appId,
      name: app.name,
      url: `${C.APPS_ORIGIN}/${app.appId}`,
      version: version.version,
      created,
      notified,
      ...(notifyError ? { notifyError } : {}),
    };
  }

  /**
   * Make an earlier retained version current.
   *
   * @param appId - App id
   * @param version - Version number
   * @param caller - Agent or owner
   * @returns The app after rollback
   */
  async rollback(appId: unknown, version: unknown, caller: AppsCaller): Promise<CloudAppView> {
    const id = requireAppId(appId);
    const v = typeof version === 'string' ? Number(version) : version;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw validation('version must be a positive integer.');
    await this.assertPublisher(id, caller);
    const app = await this.deps.client.request<CloudAppView>('POST', `/apps/${id}/rollback`, { body: { version: v }, agent: caller.agentSession });
    if (await this.deps.registry.get(id)) await this.deps.registry.upsert(id, { currentVersion: app.currentVersion });
    return app;
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
   * Agents may manage (publish, roll back, list versions of) only apps they
   * published. The owner may manage any.
   *
   * @param appId - App id
   * @param caller - Agent or owner
   * @throws AppsCloudError 403 not_your_app
   */
  async assertPublisher(appId: string, caller: AppsCaller): Promise<void> {
    if (!caller.agentSession) return;
    const entry = await this.deps.registry.get(appId);
    if (!entry || entry.agentSession !== caller.agentSession) throw notYourApp();
  }

  /**
   * Agents may read and write the data of apps they published, or that a
   * teammate published. The owner may use any.
   *
   * @param appId - App id
   * @param caller - Agent or owner
   * @throws AppsCloudError 403 not_your_app
   */
  async assertDataAccess(appId: string, caller: AppsCaller): Promise<void> {
    const me = caller.agentSession;
    if (!me) return;
    const entry = await this.deps.registry.get(appId);
    const publisher = entry?.agentSession;
    if (!publisher) throw notYourApp();
    if (publisher === me) return;
    if (this.deps.sameTeam && (await this.deps.sameTeam(me, publisher).catch(() => false))) return;
    throw notYourApp();
  }

  /**
   * Apps this instance published (local registry, not Cloud).
   *
   * @returns Entries without the poller cursor
   */
  async list(caller: AppsCaller = {}): Promise<Array<Omit<AppRegistryEntry, 'cursor' | 'delivered' | 'wakes'>>> {
    return (await this.deps.registry.list())
      .filter((e) => !caller.agentSession || e.agentSession === caller.agentSession)
      .map(({ cursor: _cursor, delivered: _delivered, wakes: _wakes, ...rest }) => rest);
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
    return this.deps.client.request('GET', path, {
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
    return this.deps.client.request('GET', path, { agent: caller.agentSession });
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
    return this.deps.client.request('PUT', path, { body, agent: caller.agentSession });
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
    return this.deps.client.request('PATCH', path, {
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
    return this.deps.client.request('POST', path, {
      body,
      agent: caller.agentSession,
    });
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
    return this.deps.client.request('DELETE', path, { agent: caller.agentSession });
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
