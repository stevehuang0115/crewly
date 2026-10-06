/**
 * AppCollaboratorsService — the owner lets another team (or one agent) work in
 * an app (specs/2026-10-06-app-collaborators.md §7).
 *
 * An agent ASKS ({@link request}); the owner's tap on a decision card is the
 * only thing that GRANTS ({@link onSettled}). What a card grants is fixed on
 * this machine when it is asked, from who the caller is, and stored on the
 * decision, so nothing the agent sends later can change it. The grant is a
 * Cloud call made as the owner (no instance, no agent header), which Cloud
 * refuses for any agent. The list lives in Cloud (per app, bound to this
 * instance), so every instance of the account sees it.
 *
 * @module services/apps/app-collaborators.service
 */

import type { AppCollaboratorSubject, DecisionOption, OwnerDecision } from '../../types/decision.types.js';
import type { DecisionKindHandler, PrebuiltAsk } from '../decisions/decision.service.js';
import type { AppsCloudClient } from './apps-cloud.client.js';
import { AppsCloudError } from './apps-cloud.client.js';
import { CREWLY_APPS_CONSTANTS } from '../../constants.js';
import { requireAppId, type AppsDirectory } from './apps.service.js';

const C = CREWLY_APPS_CONSTANTS;
const ALLOW_KEY = 'a';
const DENY_KEY = 'b';
/** How long a request waits for the owner before it lapses (nothing is granted). */
const REQUEST_DEADLINE_MS = 48 * 60 * 60 * 1000;
const MAX_REASON = 300;

/** What Cloud answers for the list. */
export interface CollaboratorList {
  collaborators: Array<{ id: string; kind: 'team' | 'agent'; who: string; name: string; instanceId: string; addedAt: string }>;
  enforced?: boolean;
}

/** The slice of the decision service used here. */
export interface CollaboratorDecisions {
  askPrebuilt(ask: PrebuiltAsk): Promise<OwnerDecision>;
}

/** Collaborators. */
export interface AppCollaboratorsDeps {
  client: AppsCloudClient;
  /** Who is on which team on this machine */
  directory: AppsDirectory;
  /** This instance's Cloud id */
  instanceId: () => Promise<string | null>;
  /** The decision service, once it runs */
  decisions: () => CollaboratorDecisions | null;
  /** Tell an agent something (the answer to its request) */
  notifyAgent: (session: string, text: string, activate: boolean) => Promise<boolean>;
}

function validation(message: string): AppsCloudError {
  return new AppsCloudError(400, C.ERROR_CODES.VALIDATION, message);
}

/** The owner's yes/no card for a collaborator request, and the grant behind the yes. */
export class AppCollaboratorsService implements DecisionKindHandler {
  constructor(private readonly deps: AppCollaboratorsDeps) {}

  /**
   * An agent asks the owner to let its team (default) or only itself work in an
   * app. Nothing is granted here: a card goes to the owner. Who is added is
   * decided from the caller's identity, never from the request body.
   *
   * @param appIdIn - The app (from the owner or the app's publisher)
   * @param agentSession - The verified calling agent
   * @param input - `{ scope?: 'team' | 'agent', reason?: string }`
   * @returns The card's decision id
   * @throws AppsCloudError validation / not_found (not this account's app) / unavailable (no decision cards)
   */
  async request(appIdIn: unknown, agentSession: string | undefined, input: { scope?: unknown; reason?: unknown }): Promise<{ requested: true; decisionId: string; for: string }> {
    const appId = requireAppId(appIdIn);
    if (!agentSession) throw validation('Only an agent asks; the owner adds a collaborator directly.');
    const scope = input.scope === undefined || input.scope === '' ? 'team' : input.scope;
    if (scope !== 'team' && scope !== 'agent') throw validation("scope is 'team' (your team, the default) or 'agent' (only you).");
    if (input.reason !== undefined && typeof input.reason !== 'string') throw validation('reason is text.');
    const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, MAX_REASON) : undefined;
    const me = await this.deps.directory.member(agentSession);
    if (!me) throw validation('You are not a member of a team on this machine.');
    if (scope === 'team' && !me.team) throw validation('You have no team; ask for access for yourself with scope "agent".');
    const instanceId = await this.deps.instanceId();
    if (!instanceId) throw new AppsCloudError(409, C.ERROR_CODES.NO_INSTANCE, 'This machine has no Crewly Cloud instance id yet. Try again in a minute.');
    // Cloud answers 404 when the app is not this account's.
    const view = await this.deps.client.request<{ name?: string }>('GET', `/apps/${appId}`, { agent: agentSession });
    const decisions = this.deps.decisions();
    if (!decisions) throw new AppsCloudError(503, 'unavailable', 'Owner approval cards are not running on this machine, so the request cannot be asked.');
    const subject: AppCollaboratorSubject = {
      appId,
      ...(view.name ? { appName: view.name } : {}),
      kind: scope,
      ...(scope === 'team' ? { team: me.team as string } : { session: agentSession }),
      instanceId,
      askerSession: agentSession,
      askerName: me.name,
      ...(reason ? { reason } : {}),
    };
    const forWho = scope === 'team' ? `the ${subject.team} team` : me.name;
    const options: DecisionOption[] = [
      { key: ALLOW_KEY, label: 'Allow', detail: 'they can read and write this app\'s data, not change the app' },
      { key: DENY_KEY, label: 'Do not allow', detail: 'nothing changes' },
    ];
    const decision = await decisions.askPrebuilt({
      kind: 'app_collaborator',
      asker: agentSession,
      question: `Let ${forWho} work in the app "${view.name ?? appId}"? ${me.name} asked.`,
      title: 'Add a collaborator to an app',
      body: reason ? [`Reason: ${reason}`] : [],
      options,
      defaultKey: DENY_KEY,
      yesKey: ALLOW_KEY,
      deadline: new Date(Date.now() + REQUEST_DEADLINE_MS),
      sensitive: 'app_access',
      appCollaborator: subject,
    });
    return { requested: true, decisionId: decision.id, for: forWho };
  }

  /**
   * A collaborator decision settled. Allow → add the collaborator in Cloud as
   * the owner; anything else → nothing changes. Tells the asking agent.
   *
   * @param decision - The settled decision
   * @returns Note for the asking agent, or null
   */
  async onSettled(decision: OwnerDecision): Promise<string | null> {
    const s = decision.appCollaborator;
    if (!s) return null;
    const label = s.kind === 'team' ? `the ${s.team} team` : s.askerName;
    const app = s.appName ?? s.appId;
    if (decision.status !== 'resolved' || decision.chosenKey !== ALLOW_KEY) {
      return `[APP ACCESS] The owner did not add ${label} to "${app}". Nothing changed.`;
    }
    try {
      await this.add(s.appId, s.kind === 'team' ? { kind: 'team', team: s.team, instanceId: s.instanceId } : { kind: 'agent', session: s.session, instanceId: s.instanceId });
      return `[APP ACCESS] The owner added ${label} to "${app}". You can now read and write its data with app-data (app id ${s.appId}). You cannot republish or change the app itself.`;
    } catch (err) {
      const why = err instanceof AppsCloudError ? `${err.code}: ${err.message}` : String(err);
      return `[APP ACCESS] The owner said yes, but adding ${label} to "${app}" failed (${why}). Ask the owner to try again.`;
    }
  }

  /**
   * Add a collaborator as the owner (the route refuses agents).
   *
   * @param appId - App
   * @param body - `{ kind:'team', team }` or `{ kind:'agent', session }`; `instanceId` defaults to this instance
   * @returns Cloud's list
   */
  async add(appId: unknown, body: Record<string, unknown>): Promise<CollaboratorList> {
    const id = requireAppId(appId);
    const instanceId = typeof body['instanceId'] === 'string' && body['instanceId'] ? body['instanceId'] : await this.deps.instanceId();
    if (!instanceId) throw new AppsCloudError(409, C.ERROR_CODES.NO_INSTANCE, 'This machine has no Crewly Cloud instance id yet.');
    return this.deps.client.request<CollaboratorList>('PUT', `/apps/${id}/collaborators`, { body: { ...body, instanceId }, asOwner: true });
  }

  /**
   * Remove a collaborator as the owner. Takes effect on the next call.
   *
   * @param appId - App
   * @param entryId - The entry id from the list
   * @returns Cloud's list
   */
  async remove(appId: unknown, entryId: unknown): Promise<CollaboratorList> {
    const id = requireAppId(appId);
    if (typeof entryId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(entryId)) throw validation('entryId is the id from the list.');
    return this.deps.client.request<CollaboratorList>('DELETE', `/apps/${id}/collaborators/${entryId}`, { asOwner: true });
  }

  /**
   * Who collaborates on an app.
   *
   * @param appId - App
   * @param agentSession - The caller when an agent (omitted for the owner)
   * @returns Cloud's list
   */
  async list(appId: unknown, agentSession?: string): Promise<CollaboratorList> {
    const id = requireAppId(appId);
    return this.deps.client.request<CollaboratorList>('GET', `/apps/${id}/collaborators`, agentSession ? { agent: agentSession } : { asOwner: true });
  }
}
