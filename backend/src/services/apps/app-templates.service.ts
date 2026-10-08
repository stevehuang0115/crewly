/**
 * AppTemplatesService — Crewly Apps templates on the Crewly Marketplace
 * (specs/2026-10-08-app-templates.md; Cloud: crewly-services apps/SPEC.md §17).
 *
 * - **Publish as a template** ({@link AppTemplatesService.requestPublish}): an
 *   agent asks Cloud to make a draft from its app (Cloud scans it for secrets
 *   and personal data and refuses with what it found), then the owner gets a
 *   decision card "Publish … as a public template on the Crewly Marketplace?"
 *   with a preview link. Only the owner's tap lists it
 *   ({@link AppTemplatesService.onSettled}): the listing call is made as the
 *   owner (no instance, no agent header), which Cloud refuses for any agent.
 * - **Find / use** ({@link AppTemplatesService.find}, {@link AppTemplatesService.use}):
 *   before building a new app an agent searches the Marketplace; using one
 *   makes a new app in this account (fresh data, the agent as its publisher)
 *   and hands back the template's files so the agent writes them into its
 *   project, adapts them and republishes with publish-app.
 *
 * @module services/apps/app-templates.service
 */

import path from 'path';
import type { AppTemplateSubject, DecisionOption, OwnerDecision } from '../../types/decision.types.js';
import type { DecisionKindHandler, PrebuiltAsk } from '../decisions/decision.service.js';
import { AppsCloudError, type AppsCloudClient } from './apps-cloud.client.js';
import type { AppsRegistryService } from './apps-registry.service.js';
import { requireAppId, type AppsCaller, type AppsDirectory, type AppsService } from './apps.service.js';
import { CREWLY_APPS_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

const C = CREWLY_APPS_CONSTANTS;
const T = C.TEMPLATES;
const AS_AUTHOR_KEY = 'a';
const ANONYMOUS_KEY = 'b';
const DECLINE_KEY = 'c';

/** A template as the Marketplace lists it (Cloud's `TemplateListing`). */
export interface TemplateListing {
  templateId: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  capabilities: string[];
  author: string | null;
  installs: number;
  version: number;
  listedAt: string | null;
  thumbnailUrl: string | null;
  previewUrl: string;
}

/** Cloud's draft view (the fields used here). */
interface CloudDraft {
  templateId: string;
  version: number;
  status: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  dataSchema: Array<{ collection: string; fields: Array<{ name: string; type: string }> }>;
  files: number;
  totalBytes: number;
  listedVersion: number | null;
  previewUrl: string;
  excluded: string[];
}

/** One bundle file Cloud returns (base64). */
export interface TemplateFile {
  path: string;
  contentType?: string;
  contentBase64: string;
}

/** The slice of the decision service used here. */
export interface TemplateDecisions {
  askPrebuilt(ask: PrebuiltAsk): Promise<OwnerDecision>;
}

/** Constructor dependencies. */
export interface AppTemplatesDeps {
  client: AppsCloudClient;
  registry: AppsRegistryService;
  /** Publisher checks (who may turn an app into a template / check out its files) */
  apps: Pick<AppsService, 'assertPublisher'>;
  /** Who is on which team on this machine (the asker's display name) */
  directory?: AppsDirectory;
  /** The decision service, once it runs */
  decisions: () => TemplateDecisions | null;
  /** Tell an agent something; `activate` = start it first when it is down */
  notifyAgent: (session: string, text: string, activate: boolean) => Promise<boolean>;
}

/** What publishing as a template returns to the agent. */
export interface TemplateRequestResult {
  requested: true;
  decisionId: string;
  templateId: string;
  version: number;
  previewUrl: string;
  /** The version already on the Marketplace, if this is an update */
  listedVersion: number | null;
  files: number;
  excluded: string[];
  message: string;
}

/** What using a template returns (the files go to the skill, which writes them). */
export interface TemplateUseResult {
  appId: string;
  name: string;
  url: string;
  version: number;
  fromTemplate: { templateId: string; version: number; name: string };
  capabilitiesNeeded: string[];
  dataSchema: Array<{ collection: string; fields: Array<{ name: string; type: string }> }>;
  entry: string;
  files: TemplateFile[];
}

function validation(message: string): AppsCloudError {
  return new AppsCloudError(400, C.ERROR_CODES.VALIDATION, message);
}

/**
 * @param v - Candidate template id
 * @returns The id
 * @throws AppsCloudError validation
 */
export function requireTemplateId(v: unknown): string {
  if (typeof v !== 'string' || !T.ID_PATTERN.test(v)) throw validation('templateId looks like tpl-xxxxxxxxxx (from find-app-template).');
  return v;
}

/**
 * The project directory the skill will write a template's files into (absolute).
 *
 * @param v - From the skill (already resolved and checked to be inside the project)
 * @returns The path, or null when not given
 */
function optSource(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !path.isAbsolute(v) || v.length > 1024) throw validation('source must be an absolute directory path.');
  return v;
}

/** A Marketplace link for a template. */
export function marketplaceUrl(templateId: string): string {
  return `${T.MARKETPLACE_URL}${T.MARKETPLACE_URL.includes('?') ? '&' : '?'}template=${encodeURIComponent(templateId)}`;
}

/** Text shown on a card: one line, no markup that could pose as Slack formatting. */
function cardText(s: string, max: number): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/[<>|*_`~]/g, '').trim().slice(0, max);
}

/** The owner's card for a template request, and the listing behind the yes. */
export class AppTemplatesService implements DecisionKindHandler {
  constructor(private readonly deps: AppTemplatesDeps) {}

  /**
   * An agent asks to publish one of its apps as a public Marketplace template.
   * Cloud makes a draft (refusing anything that looks like a secret or
   * personal data, with what it found); the owner gets a card. Nothing is
   * listed here.
   *
   * @param appIdIn - The app (published by the caller or its team)
   * @param caller - The calling agent (the owner lists from the portal instead)
   * @param input - `{ description, name?, category?, tags?, author?, sampleData? }`
   * @returns The card's decision id, the draft and its preview link
   * @throws AppsCloudError unsafe_content (with Cloud's findings) / validation / not_your_app / unavailable
   */
  async requestPublish(
    appIdIn: unknown,
    caller: AppsCaller,
    input: { description?: unknown; name?: unknown; category?: unknown; tags?: unknown; author?: unknown; sampleData?: unknown },
  ): Promise<TemplateRequestResult> {
    const appId = requireAppId(appIdIn);
    const agent = caller.agentSession;
    if (!agent) throw validation('Only an agent asks; the owner publishes a template from the Crewly portal (Apps → the app).');
    await this.deps.apps.assertPublisher(appId, caller);
    if (typeof input.description !== 'string' || !input.description.trim()) throw validation('--description is required: one or two sentences on what the app does, for people browsing the Marketplace.');
    if (input.description.length > T.MAX_DESCRIPTION_CHARS) throw validation(`--description is at most ${T.MAX_DESCRIPTION_CHARS} characters.`);
    let author: string | undefined;
    if (input.author !== undefined && input.author !== null && input.author !== '') {
      if (typeof input.author !== 'string' || input.author.trim().length > T.MAX_AUTHOR_CHARS || /[@<>]/.test(input.author)) {
        throw validation(`--author is the owner's display name (at most ${T.MAX_AUTHOR_CHARS} characters, no email address).`);
      }
      author = input.author.trim();
    }
    const decisions = this.deps.decisions();
    if (!decisions) throw new AppsCloudError(503, 'unavailable', 'Owner approval cards are not running on this machine, so the template cannot be asked for. Try again after a restart.');

    const draft = await this.deps.client.request<CloudDraft>('POST', `/apps/${appId}/template-drafts`, {
      body: {
        description: input.description.trim(),
        ...(input.name !== undefined && input.name !== '' ? { name: input.name } : {}),
        ...(input.category !== undefined && input.category !== '' ? { category: input.category } : {}),
        ...(input.tags !== undefined && input.tags !== '' ? { tags: input.tags } : {}),
        ...(input.sampleData !== undefined && input.sampleData !== null ? { sampleData: input.sampleData } : {}),
      },
      agent,
    });

    const me = await this.deps.directory?.member(agent).catch(() => null);
    const askerName = me?.name ?? agent;
    const subject: AppTemplateSubject = {
      appId,
      appName: draft.name,
      templateId: draft.templateId,
      version: draft.version,
      ...(author ? { authorName: author } : {}),
      askerSession: agent,
      askerName,
    };
    const options: DecisionOption[] = [
      ...(author ? [{ key: AS_AUTHOR_KEY, label: `Publish as ${cardText(author, T.MAX_AUTHOR_CHARS)}`, detail: `the card says "by ${cardText(author, T.MAX_AUTHOR_CHARS)}"` }] : []),
      { key: ANONYMOUS_KEY, label: 'Publish anonymously', detail: 'the card says "by a Crewly user"' },
      { key: DECLINE_KEY, label: "Don't publish", detail: 'the draft is deleted; nothing is listed' },
    ];
    const update = draft.listedVersion !== null ? ` (an update of the one already listed)` : '';
    const schema = draft.dataSchema.map((c) => c.collection).slice(0, 8).join(', ');
    const decision = await decisions.askPrebuilt({
      kind: 'app_template',
      asker: agent,
      question: `Publish “${cardText(draft.name, 80)}” as a public template on the Crewly Marketplace${update}? ${cardText(askerName, 60)} asked.`,
      title: 'Publish an app template',
      body: [
        `<${draft.previewUrl}|Open the preview> — the app with sample data only.`,
        `*Included:* the app's code (${draft.files} files)${schema ? ` and the names of its data collections (${cardText(schema, 200)})` : ''}. *Not included:* ${draft.excluded.join(', ')}.`,
        `*Description (written by ${cardText(askerName, 60)}):* ${cardText(draft.description, 300)}`,
        ...(draft.tags.length ? [`*Tags:* ${draft.tags.join(', ')} · *Category:* ${draft.category}`] : [`*Category:* ${draft.category}`]),
        'Anyone can then copy it into their own account. You can unlist it any time in the Crewly portal (Marketplace → Apps → My templates).',
      ],
      options,
      defaultKey: DECLINE_KEY,
      yesKey: author ? AS_AUTHOR_KEY : ANONYMOUS_KEY,
      deadline: new Date(Date.now() + T.DECISION_DEADLINE_MS),
      sensitive: 'publish',
      appTemplate: subject,
    });
    return {
      requested: true,
      decisionId: decision.id,
      templateId: draft.templateId,
      version: draft.version,
      previewUrl: draft.previewUrl,
      listedVersion: draft.listedVersion,
      files: draft.files,
      excluded: draft.excluded,
      message: 'Asked the owner (a decision card with a preview link). Nothing is on the Marketplace until they say yes; you will get a [APP TEMPLATE] note either way.',
    };
  }

  /**
   * The owner answered a template card. A publish option → list it in Cloud as
   * the owner; anything else → delete the draft. Tells the asking agent.
   *
   * @param decision - The settled decision
   * @returns Note for the asking agent, or null
   */
  async onSettled(decision: OwnerDecision): Promise<string | null> {
    const s = decision.appTemplate;
    if (!s) return null;
    const yes = decision.status === 'resolved' && (decision.chosenKey === AS_AUTHOR_KEY || decision.chosenKey === ANONYMOUS_KEY);
    if (!yes) {
      await this.deps.client.request('POST', `/templates/${s.templateId}/discard`, { body: { version: s.version }, asOwner: true }).catch(() => undefined);
      return `[APP TEMPLATE] The owner did not publish “${s.appName}” as a template. The draft was deleted; nothing is on the Marketplace. Do not ask again unless the owner brings it up.`;
    }
    const authorName = decision.chosenKey === AS_AUTHOR_KEY ? (s.authorName ?? null) : null;
    try {
      await this.deps.client.request('POST', `/templates/${s.templateId}/approve`, { body: { version: s.version, authorName }, asOwner: true });
      const by = authorName ? `by ${authorName}` : 'anonymously';
      return `[APP TEMPLATE] The owner published “${s.appName}” on the Crewly Marketplace (${by}): ${marketplaceUrl(s.templateId)} (template id ${s.templateId}). Tell them in one line. Republishing the app does not change the template; ask again with publish-app --as-template to update it.`;
    } catch (err) {
      const why = err instanceof AppsCloudError ? `${err.code}: ${err.message}` : String(err);
      return `[APP TEMPLATE] The owner said yes, but listing “${s.appName}” failed (${why}). Tell the owner; they can list it from the Crewly portal (Marketplace → Apps → My templates).`;
    }
  }

  /**
   * Search the Marketplace (public templates of everyone).
   *
   * @param input - `{ q, tag?, category?, limit? }`
   * @param caller - Agent (attribution) or owner
   * @returns Listings, best match first
   */
  async find(input: { q?: unknown; tag?: unknown; category?: unknown; limit?: unknown }, caller: AppsCaller): Promise<{ templates: TemplateListing[]; total: number }> {
    const q = typeof input.q === 'string' ? input.q.trim().slice(0, 100) : '';
    const limitN = Number(input.limit ?? T.FIND_DEFAULT_LIMIT);
    const limit = Number.isFinite(limitN) ? Math.min(Math.max(Math.floor(limitN), 1), T.FIND_MAX_LIMIT) : T.FIND_DEFAULT_LIMIT;
    const data = await this.deps.client.request<{ templates?: TemplateListing[]; total?: number }>('GET', '/templates', {
      query: {
        q,
        limit,
        ...(typeof input.tag === 'string' && input.tag ? { tag: input.tag } : {}),
        ...(typeof input.category === 'string' && input.category ? { category: input.category } : {}),
      },
      ...(caller.agentSession ? { agent: caller.agentSession } : {}),
    });
    return { templates: data?.templates ?? [], total: data?.total ?? 0 };
  }

  /**
   * Make a new app in this account from a listed template and return its
   * files. The calling agent becomes the app's publisher here (the owner's
   * call from the portal makes the orchestrator the publisher and tells it).
   *
   * @param templateIdIn - Template
   * @param caller - Agent or owner
   * @param input - `{ name?, source? }`: `source` = the absolute directory the skill writes the files into
   * @returns The new app, provenance and the files
   */
  async use(templateIdIn: unknown, caller: AppsCaller, input: { name?: unknown; source?: unknown }): Promise<TemplateUseResult> {
    const templateId = requireTemplateId(templateIdIn);
    const source = optSource(input.source);
    if (input.name !== undefined && input.name !== null && input.name !== '' && (typeof input.name !== 'string' || input.name.trim().length > 80)) {
      throw validation('--name is at most 80 characters.');
    }
    const agent = caller.agentSession ?? ORCHESTRATOR_SESSION_NAME;
    const used = await this.deps.client.request<{
      app: { appId: string; name: string; url: string; currentVersion: number | null };
      fromTemplate: { templateId: string; version: number; name: string };
      capabilitiesNeeded: string[];
      dataSchema: TemplateUseResult['dataSchema'];
    }>('POST', `/templates/${templateId}/use`, { body: typeof input.name === 'string' && input.name.trim() ? { name: input.name.trim() } : {}, agent });
    await this.deps.registry.upsert(used.app.appId, {
      name: used.app.name,
      url: used.app.url,
      agentSession: agent,
      ...(source ? { source } : {}),
      currentVersion: used.app.currentVersion ?? 1,
      // A brand-new app: start right before its first change.
      cursor: 0,
      deleted: false,
    });
    const bundle = await this.deps.client.request<{ entry: string; files: TemplateFile[] }>('GET', `/templates/${templateId}/bundle`, {
      query: { version: used.fromTemplate.version },
      agent,
    });
    if (!caller.agentSession) {
      const dir = `./${used.app.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app'}`;
      await this.deps
        .notifyAgent(
          ORCHESTRATOR_SESSION_NAME,
          `[APP TEMPLATE] The owner started a new app “${used.app.name}” (app id ${used.app.appId}) from the Marketplace template “${used.fromTemplate.name}”. ` +
            `It is yours to look after. Get its files with \`use-app-template --app ${used.app.appId} --dir ${dir}\`, ask the owner in one line what to change for them, ` +
            `then edit and republish with \`publish-app --app ${used.app.appId} --dir ${dir} --notify\` (or hand it to a team with publish-app --transfer-to).`,
          true,
        )
        .catch(() => false);
    }
    return {
      appId: used.app.appId,
      name: used.app.name,
      url: `${C.APPS_ORIGIN}/${used.app.appId}`,
      version: used.app.currentVersion ?? 1,
      fromTemplate: used.fromTemplate,
      capabilitiesNeeded: used.capabilitiesNeeded ?? [],
      dataSchema: used.dataSchema ?? [],
      entry: bundle.entry,
      files: bundle.files,
    };
  }

  /**
   * The template files of an app that was made from a template (e.g. by the
   * owner from the portal), so its publisher can adapt them. Records the
   * directory as the app's source, so the next `publish-app --dir` lands on it.
   *
   * @param appIdIn - App
   * @param caller - Its publisher (or a teammate), or the owner
   * @param input - `{ source? }`
   * @returns The files and provenance
   */
  async checkout(appIdIn: unknown, caller: AppsCaller, input: { source?: unknown }): Promise<Omit<TemplateUseResult, 'capabilitiesNeeded' | 'dataSchema'>> {
    const appId = requireAppId(appIdIn);
    const source = optSource(input.source);
    await this.deps.apps.assertPublisher(appId, caller);
    const app = await this.deps.client.request<{ appId: string; name: string; currentVersion: number | null; fromTemplate?: { templateId: string; version: number; name: string } }>(
      'GET',
      `/apps/${appId}`,
      caller.agentSession ? { agent: caller.agentSession } : {},
    );
    if (!app.fromTemplate) throw validation('This app was not made from a template. Edit its own files and publish with publish-app.');
    const bundle = await this.deps.client
      .request<{ entry: string; files: TemplateFile[] }>('GET', `/templates/${app.fromTemplate.templateId}/bundle`, {
        query: { version: app.fromTemplate.version },
        ...(caller.agentSession ? { agent: caller.agentSession } : {}),
      })
      .catch((err: unknown) => {
        if (err instanceof AppsCloudError && err.status === 404) {
          throw new AppsCloudError(404, 'not_found', 'The template this app came from is no longer on the Marketplace (or was updated). Build on the app as it is.');
        }
        throw err;
      });
    if (source) await this.deps.registry.upsert(appId, { source });
    return {
      appId,
      name: app.name,
      url: `${C.APPS_ORIGIN}/${appId}`,
      version: app.currentVersion ?? 1,
      fromTemplate: app.fromTemplate,
      entry: bundle.entry,
      files: bundle.files,
    };
  }

  /**
   * Take one of this account's templates off the Marketplace (reducing
   * exposure needs no approval). Apps made from it are not affected.
   *
   * @param templateIdIn - Template
   * @param caller - Agent or owner
   * @returns Cloud's owner view
   */
  async unlist(templateIdIn: unknown, caller: AppsCaller): Promise<unknown> {
    const templateId = requireTemplateId(templateIdIn);
    return this.deps.client.request('POST', `/templates/${templateId}/unlist`, caller.agentSession ? { agent: caller.agentSession } : {});
  }

  /**
   * This account's own templates (any status).
   *
   * @param caller - Agent or owner
   * @returns Cloud's owner views
   */
  async mine(caller: AppsCaller): Promise<unknown> {
    return this.deps.client.request('GET', '/my/templates', caller.agentSession ? { agent: caller.agentSession } : {});
  }
}
