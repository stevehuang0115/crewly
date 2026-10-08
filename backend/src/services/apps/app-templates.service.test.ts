/**
 * Tests for AppTemplatesService — an agent asks, Cloud drafts (and scans), only
 * the owner's tap lists it (as an owner call to Cloud); find / use / checkout.
 */

import { AppTemplatesService, marketplaceUrl, requireTemplateId } from './app-templates.service.js';
import { AppsCloudError, type AppsCloudClient } from './apps-cloud.client.js';
import type { AppsRegistryService } from './apps-registry.service.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

const APP = '28au74d9cj';
const TPL = 'tpl-abcdefghij';
const ELLA = 'crewly-family-ella-e6a6b8ea';
const DRAFT = {
  templateId: TPL,
  version: 2,
  status: 'pending',
  name: 'Chores',
  description: 'Track chores and points.',
  category: 'family',
  tags: ['chores'],
  dataSchema: [{ collection: 'kids', fields: [{ name: 'name', type: 'string' }] }],
  files: 3,
  totalBytes: 1200,
  listedVersion: null,
  previewUrl: `https://apps.crewlyai.com/_t/${TPL}?d=tok`,
  excluded: ['data records', 'uploaded files', 'comments'],
};

let request: jest.Mock;
let askPrebuilt: jest.Mock;
let notifyAgent: jest.Mock;
let upsert: jest.Mock;
let assertPublisher: jest.Mock;
let svc: AppTemplatesService;

const decisionFor = (subject: unknown, status: OwnerDecision['status'], chosenKey?: string) =>
  ({ id: 'D-7', kind: 'app_template', status, chosenKey, appTemplate: subject }) as unknown as OwnerDecision;

function make(decisions: boolean = true): AppTemplatesService {
  return new AppTemplatesService({
    client: { request } as unknown as AppsCloudClient,
    registry: { upsert } as unknown as AppsRegistryService,
    apps: { assertPublisher },
    directory: { member: async (s) => (s === ELLA ? { session: s, name: 'Ella', team: 'Family' } : null), leadsTeamOf: async () => false },
    decisions: () => (decisions ? { askPrebuilt } : null),
    notifyAgent,
  });
}

beforeEach(() => {
  request = jest.fn(async (method: string, path: string) => {
    if (method === 'POST' && path === `/apps/${APP}/template-drafts`) return DRAFT;
    if (method === 'POST' && path === `/templates/${TPL}/use`) {
      return {
        app: { appId: 'newapp2345', name: 'Our chores', url: 'https://apps.crewlyai.com/newapp2345', currentVersion: 1 },
        fromTemplate: { templateId: TPL, version: 1, name: 'Chores' },
        capabilitiesNeeded: [],
        dataSchema: DRAFT.dataSchema,
      };
    }
    if (method === 'GET' && path === `/templates/${TPL}/bundle`) return { entry: 'index.html', files: [{ path: 'index.html', contentBase64: 'PGgxPg==' }] };
    if (method === 'GET' && path === '/templates') return { templates: [{ templateId: TPL, name: 'Chores' }], total: 1 };
    if (method === 'GET' && path === `/apps/${APP}`) return { appId: APP, name: 'Chores', currentVersion: 3, fromTemplate: { templateId: TPL, version: 1, name: 'Chores' } };
    return {};
  });
  askPrebuilt = jest.fn().mockResolvedValue({ id: 'D-7' });
  notifyAgent = jest.fn().mockResolvedValue(true);
  upsert = jest.fn().mockResolvedValue({});
  assertPublisher = jest.fn().mockResolvedValue(undefined);
  svc = make();
});

describe('requestPublish', () => {
  it('Cloud drafts it, the owner gets a publish card with the preview; nothing is listed', async () => {
    const r = await svc.requestPublish(APP, { agentSession: ELLA }, { description: 'Track chores and points.', tags: 'chores', author: 'Steve' });
    expect(r).toMatchObject({ requested: true, decisionId: 'D-7', templateId: TPL, version: 2, previewUrl: DRAFT.previewUrl, listedVersion: null });
    expect(request.mock.calls[0]).toEqual(['POST', `/apps/${APP}/template-drafts`, { body: { description: 'Track chores and points.', tags: 'chores' }, agent: ELLA }]);
    const ask = askPrebuilt.mock.calls[0][0];
    expect(ask).toMatchObject({ kind: 'app_template', asker: ELLA, defaultKey: 'c', yesKey: 'a', sensitive: 'publish', title: 'Publish an app template' });
    expect(ask.question).toBe('Publish “Chores” as a public template on the Crewly Marketplace? Ella asked.');
    expect(ask.options.map((o: { key: string; label: string }) => [o.key, o.label])).toEqual([
      ['a', 'Publish as Steve'],
      ['b', 'Publish anonymously'],
      ['c', "Don't publish"],
    ]);
    expect(ask.body[0]).toBe(`<${DRAFT.previewUrl}|Open the preview> — the app with sample data only.`);
    expect(ask.body.join('\n')).toContain('*Not included:* data records, uploaded files, comments');
    expect(ask.appTemplate).toEqual({ appId: APP, appName: 'Chores', templateId: TPL, version: 2, authorName: 'Steve', askerSession: ELLA, askerName: 'Ella' });
    expect(request.mock.calls.some((c) => String(c[1]).endsWith('/approve'))).toBe(false);
  });

  it('without an author name only "anonymously" is offered as yes', async () => {
    await svc.requestPublish(APP, { agentSession: ELLA }, { description: 'x' });
    const ask = askPrebuilt.mock.calls[0][0];
    expect(ask.options.map((o: { key: string }) => o.key)).toEqual(['b', 'c']);
    expect(ask.yesKey).toBe('b');
  });

  it('refuses the owner, a missing description, an email as author, another team’s app', async () => {
    await expect(svc.requestPublish(APP, {}, { description: 'x' })).rejects.toMatchObject({ code: 'validation' });
    await expect(svc.requestPublish(APP, { agentSession: ELLA }, { description: ' ' })).rejects.toMatchObject({ code: 'validation' });
    await expect(svc.requestPublish(APP, { agentSession: ELLA }, { description: 'x', author: 'me@x.com' })).rejects.toMatchObject({ code: 'validation' });
    assertPublisher.mockRejectedValueOnce(new AppsCloudError(403, 'not_your_app', 'no'));
    await expect(svc.requestPublish(APP, { agentSession: ELLA }, { description: 'x' })).rejects.toMatchObject({ code: 'not_your_app' });
    expect(askPrebuilt).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('a refused scan reaches the agent with Cloud’s findings and no card', async () => {
    request.mockRejectedValueOnce(new AppsCloudError(422, 'unsafe_content', 'Not made into a template: … app.js:3 — Google API key', { findings: [{ path: 'app.js', line: 3, kind: 'secret' }] }));
    const err = await svc.requestPublish(APP, { agentSession: ELLA }, { description: 'x' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'unsafe_content', status: 422, details: { findings: [{ path: 'app.js', line: 3, kind: 'secret' }] } });
    expect(askPrebuilt).not.toHaveBeenCalled();
  });

  it('without decision cards it says so (and makes no draft)', async () => {
    await expect(make(false).requestPublish(APP, { agentSession: ELLA }, { description: 'x' })).rejects.toMatchObject({ status: 503 });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('onSettled (the owner’s answer)', () => {
  const subject = { appId: APP, appName: 'Chores', templateId: TPL, version: 2, authorName: 'Steve', askerSession: ELLA, askerName: 'Ella' };

  it('"Publish as Steve" lists it AS THE OWNER with the author, and tells the agent the link', async () => {
    const note = await svc.onSettled(decisionFor(subject, 'resolved', 'a'));
    expect(request).toHaveBeenCalledWith('POST', `/templates/${TPL}/approve`, { body: { version: 2, authorName: 'Steve' }, asOwner: true });
    expect(note).toContain('published “Chores” on the Crewly Marketplace (by Steve)');
    expect(note).toContain(marketplaceUrl(TPL));
  });

  it('"Publish anonymously" lists it with no author', async () => {
    await svc.onSettled(decisionFor(subject, 'resolved', 'b'));
    expect(request).toHaveBeenCalledWith('POST', `/templates/${TPL}/approve`, { body: { version: 2, authorName: null }, asOwner: true });
  });

  it.each([
    ['resolved', 'c'],
    ['defaulted', 'c'],
    ['parked', undefined],
    ['expired', undefined],
  ] as const)('%s/%s deletes the draft (as the owner) and lists nothing', async (status, key) => {
    const note = await svc.onSettled(decisionFor(subject, status, key));
    expect(request).toHaveBeenCalledWith('POST', `/templates/${TPL}/discard`, { body: { version: 2 }, asOwner: true });
    expect(request.mock.calls.some((c) => String(c[1]).endsWith('/approve'))).toBe(false);
    expect(note).toContain('did not publish');
  });

  it('a failed listing says so instead of claiming success', async () => {
    request.mockRejectedValueOnce(new AppsCloudError(409, 'conflict', 'The draft changed since'));
    expect(await svc.onSettled(decisionFor(subject, 'resolved', 'a'))).toContain('failed (conflict: The draft changed since)');
  });

  it('ignores decisions of other kinds', async () => {
    expect(await svc.onSettled({ id: 'D-1', status: 'resolved' } as unknown as OwnerDecision)).toBeNull();
  });
});

describe('find / use / checkout / unlist', () => {
  it('find searches the Marketplace with a capped limit', async () => {
    const r = await svc.find({ q: '  chore chart ', limit: 99, tag: 'kids' }, { agentSession: ELLA });
    expect(r.total).toBe(1);
    expect(request).toHaveBeenCalledWith('GET', '/templates', { query: { q: 'chore chart', limit: 20, tag: 'kids' }, agent: ELLA });
  });

  it('use: a new app in this account (the agent as publisher, with its source dir) and the template’s files', async () => {
    const r = await svc.use(TPL, { agentSession: ELLA }, { name: 'Our chores', source: '/proj/chores' });
    expect(request).toHaveBeenCalledWith('POST', `/templates/${TPL}/use`, { body: { name: 'Our chores' }, agent: ELLA });
    expect(upsert).toHaveBeenCalledWith('newapp2345', expect.objectContaining({ agentSession: ELLA, source: '/proj/chores', currentVersion: 1, cursor: 0 }));
    expect(request).toHaveBeenCalledWith('GET', `/templates/${TPL}/bundle`, { query: { version: 1 }, agent: ELLA });
    expect(r).toMatchObject({ appId: 'newapp2345', url: 'https://apps.crewlyai.com/newapp2345', fromTemplate: { templateId: TPL, version: 1 }, entry: 'index.html' });
    expect(r.files).toHaveLength(1);
    expect(notifyAgent).not.toHaveBeenCalled();
  });

  it('use by the owner (portal over the relay): the orchestrator looks after it and is told', async () => {
    await svc.use(TPL, {}, {});
    expect(request).toHaveBeenCalledWith('POST', `/templates/${TPL}/use`, { body: {}, agent: ORCHESTRATOR_SESSION_NAME });
    expect(upsert).toHaveBeenCalledWith('newapp2345', expect.objectContaining({ agentSession: ORCHESTRATOR_SESSION_NAME }));
    const [to, text, activate] = notifyAgent.mock.calls[0];
    expect([to, activate]).toEqual([ORCHESTRATOR_SESSION_NAME, true]);
    expect(text).toContain('use-app-template --app newapp2345 --dir ./our-chores');
  });

  it('use validates the id, the name and the source', async () => {
    await expect(svc.use('nope', { agentSession: ELLA }, {})).rejects.toMatchObject({ code: 'validation' });
    await expect(svc.use(TPL, { agentSession: ELLA }, { name: 'x'.repeat(81) })).rejects.toMatchObject({ code: 'validation' });
    await expect(svc.use(TPL, { agentSession: ELLA }, { source: 'relative/dir' })).rejects.toMatchObject({ code: 'validation' });
    expect(request).not.toHaveBeenCalled();
  });

  it('checkout: the files of the template an app came from, for its publisher; records the dir', async () => {
    const r = await svc.checkout(APP, { agentSession: ELLA }, { source: '/proj/chores' });
    expect(assertPublisher).toHaveBeenCalledWith(APP, { agentSession: ELLA });
    expect(r).toMatchObject({ appId: APP, version: 3, fromTemplate: { templateId: TPL, version: 1 } });
    expect(upsert).toHaveBeenCalledWith(APP, { source: '/proj/chores' });
  });

  it('checkout refuses an app not made from a template', async () => {
    request.mockImplementation(async () => ({ appId: APP, name: 'Chores', currentVersion: 1 }));
    await expect(svc.checkout(APP, { agentSession: ELLA }, {})).rejects.toMatchObject({ code: 'validation' });
  });

  it('unlist goes to Cloud with the agent’s attribution', async () => {
    await svc.unlist(TPL, { agentSession: ELLA });
    expect(request).toHaveBeenCalledWith('POST', `/templates/${TPL}/unlist`, { agent: ELLA });
    expect(() => requireTemplateId('tpl-1')).toThrow(AppsCloudError);
  });
});
