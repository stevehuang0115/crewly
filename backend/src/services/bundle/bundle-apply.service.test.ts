/**
 * Tests for the bundle apply engine: every step against fakes, idempotent
 * re-runs, a failing step that does not corrupt the rest (and a re-run that
 * resumes it), Slack-not-connected → pending → resumed, no backend →
 * pending, request errors, job lookup, and first-week delivery.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import type { Team } from '../../types/index.js';
import type { BundleTemplate, LoadedBundle } from '../../types/solution-bundle.types.js';
import {
  BundleApplyService,
  BundleError,
  buildFirstWeekMessage,
  initialSteps,
  overallStatus,
  withFrontmatter,
  type BundleApplyDeps,
} from './bundle-apply.service.js';
import { BundleDeploymentStore } from './bundle-state.store.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    }),
  },
}));

/** 2026-09-25 10:00 in Shanghai. */
const T0 = new Date('2026-09-25T02:00:00.000Z');

/** The fixture bundle. */
function template(overrides: Partial<BundleTemplate['bundle']> = {}): BundleTemplate {
  return {
    id: 'demo-bundle',
    name: 'Demo',
    description: 'Demo team',
    version: '1.2.0',
    hierarchical: true,
    roles: [
      {
        role: 'team-leader',
        label: 'Lead',
        defaultName: 'Ava',
        count: 1,
        hierarchyLevel: 1,
        canDelegate: true,
        defaultSkills: [],
        promptAdditions: '你是 {{lead_name}}，为 {{business_name}} 工作',
      },
      { role: 'content-strategist', label: 'Writer', defaultName: 'Leo', count: 1, hierarchyLevel: 2, canDelegate: false, reportsTo: 'team-leader', defaultSkills: [] },
      { role: 'researcher', label: 'Research', defaultName: 'Max', count: 1, hierarchyLevel: 2, canDelegate: false, reportsTo: 'team-leader', defaultSkills: [] },
    ],
    bundle: {
      schemaVersion: 1,
      label: '演示方案',
      tagline: 't',
      ownerSummary: 's',
      runtime: { recommended: 'crewly-agent' },
      server: { tier: 'entry' },
      timezone: 'Asia/Shanghai',
      teamName: '{{business_name}} 团队',
      questions: [
        { id: 'business_name', label: '名字', type: 'text', required: true },
        { id: 'owner_title', label: '称呼', type: 'text', required: false, default: '老板' },
      ],
      norms: [{ id: 'voice', title: '{{business_name}} 口吻', trigger: 'content,draft', content: '我们是 {{business_name}}，负责人 {{lead_name}}' }],
      sops: [{ id: 'review', title: '发布前审核', category: 'content', content: '先给{{owner_title}}看' }],
      reviewPoints: [{ id: 'publish', what: '公开发布', approver: 'owner', how: '{{lead_name}} 发预览' }],
      skills: { required: ['web-search', 'remote-skill'], optional: ['nice-to-have'] },
      connectors: [
        { id: 'slack', required: true, why: '简报和审批' },
        { id: 'canva', required: false, why: '做图' },
      ],
      slack: { channels: [{ key: 'approvals', name: '{{business_name}}-审批', purpose: '等{{owner_title}}点头', members: ['team-leader', 'content-strategist'] }] },
      schedules: [
        { id: 'daily', title: '每日简报', cron: '0 9 * * 1-6', task: '给{{owner_title}}发简报' },
        { id: 'scan', title: '扫描', cron: '30 8 * * 1-5', target: 'researcher', task: '扫 {{business_name}} 同行' },
      ],
      firstWeek: [
        { id: 'hello', day: 0, title: '认识生意', task: '了解 {{business_name}}' },
        { id: 'drafts', day: 2, time: '10:00', target: 'content-strategist', title: '三篇草稿', task: '写三篇' },
      ],
      ...overrides,
    },
  };
}

/** Test rig: fakes plus a real store in a temp home. */
function rig(t: BundleTemplate = template()) {
  const home = mkdtempSync(path.join(tmpdir(), 'bundle-apply-'));
  const teams = new Map<string, Team>();
  let now = T0;
  let slackConnected = true;
  let jobs = 0;
  const entry: LoadedBundle = { template: t, dir: home, file: path.join(home, 'template.json') };
  let cronIds = 0;
  const fakes = {
    save: jest.fn(async (team: Team) => {
      teams.set(team.id, JSON.parse(JSON.stringify(team)));
    }),
    isAvailable: jest.fn(async (id: string) => id === 'web-search'),
    install: jest.fn(async (id: string) => ({ ok: true, message: `installed ${id}` })),
    ensureTeamChannel: jest.fn(async (team: Team) => ({ slackChannelId: `C-${team.id}`, slackChannelName: team.name })),
    ensureAgentChannel: jest.fn(async (input: { name: string; existingChannelId?: string }) => ({
      slackChannelId: input.existingChannelId ?? 'C-extra',
      slackChannelName: input.name,
    })),
    createCron: jest.fn(async (_request: unknown) => ({ id: `cron-${++cronIds}` })),
    send: jest.fn(async (_content: string, _metadata: Record<string, unknown>): Promise<{ conversationId: string | null; forwarded: boolean; queued: boolean; error: string | null }> => ({ conversationId: 'conv-1', forwarded: true, queued: false, error: null })),
    check: jest.fn(async (c: { id: string }) => (c.id === 'slack' ? ('connected' as const) : ('not_connected' as const))),
  };
  const deps: BundleApplyDeps = {
    catalog: { get: (id) => (id === t.id ? entry : null) },
    store: new BundleDeploymentStore(home),
    crewlyHome: home,
    teams: { get: async (id) => teams.get(id) ?? null, save: fakes.save },
    skills: { isAvailable: fakes.isAvailable, install: fakes.install },
    slack: {
      isConnected: () => slackConnected,
      ensureTeamChannel: fakes.ensureTeamChannel,
      ensureAgentChannel: fakes.ensureAgentChannel,
    },
    schedules: { create: fakes.createCron },
    orchestrator: { send: fakes.send },
    connectors: { check: fakes.check },
    resolveRuntime: async (_rec, req) => req ?? 'claude-code',
    now: () => now,
    newJobId: () => `job-${++jobs}`,
  };
  return {
    home,
    teams,
    deps,
    fakes,
    service: new BundleApplyService(deps),
    setNow: (d: Date) => {
      now = d;
    },
    setSlack: (v: boolean) => {
      slackConnected = v;
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

const ANSWERS = { business_name: '小周咖啡' };

describe('BundleApplyService', () => {
  let r: ReturnType<typeof rig>;

  beforeEach(() => {
    r = rig();
  });

  afterEach(() => r.cleanup());

  it('applies every step and records the deployment', async () => {
    const d = await r.service.applyAndWait({ templateId: 'demo-bundle', answers: ANSWERS });
    expect(d.steps.map((s) => [s.id, s.status])).toEqual([
      ['team', 'done'],
      ['norms', 'done'],
      ['skills', 'done'],
      ['connectors', 'done'],
      ['slack', 'done'],
      ['schedules', 'done'],
      ['first_week', 'done'],
    ]);
    expect(d.status).toBe('done');
    expect(d.runtime).toBe('claude-code');
    expect(d.answers).toEqual({ business_name: '小周咖啡', owner_title: '老板' });
    expect(d.teams).toEqual([{ key: 'main', teamId: 'demo-bundle', name: '小周咖啡 团队' }]);
    expect(await r.deps.store.read('demo-bundle')).toEqual(d);
  });

  it('creates the team with filled prompts on the chosen runtime', async () => {
    await r.service.applyAndWait({ templateId: 'demo-bundle', answers: ANSWERS, runtime: 'crewly-agent' });
    const team = r.teams.get('demo-bundle')!;
    expect(team.members.map((m) => m.name)).toEqual(['Ava', 'Leo', 'Max']);
    expect(team.members[0].systemPrompt).toBe('你是 Ava，为 小周咖啡 工作');
    expect(team.members.every((m) => m.runtimeType === 'crewly-agent')).toBe(true);
  });

  it('writes norms, the review-points norm and SOPs where get-team-norms / get-sops read them', async () => {
    await r.service.applyAndWait({ templateId: 'demo-bundle', answers: ANSWERS });
    const teamDir = path.join(r.home, 'teams', 'demo-bundle');
    const voice = readFileSync(path.join(teamDir, 'norms', 'voice.md'), 'utf-8');
    expect(voice).toMatch(/^---\ntitle: 小周咖啡 口吻\ntrigger: content,draft\nupdatedBy: bundle:demo-bundle\nupdatedAt: /);
    expect(voice).toContain('我们是 小周咖啡，负责人 Ava');
    const review = readFileSync(path.join(teamDir, 'norms', 'owner-review-points.md'), 'utf-8');
    expect(review).toContain('**公开发布** → 先拿到老板的同意：Ava 发预览');
    const sop = readFileSync(path.join(teamDir, 'sops', 'content', 'review.md'), 'utf-8');
    expect(sop).toMatch(/title: 发布前审核\ncategory: content/);
    expect(sop).toContain('先给老板看');
  });

  it('installs only missing skills; an optional failure does not fail the step', async () => {
    r.fakes.install.mockImplementation(async (id: string) => (id === 'nice-to-have' ? { ok: false, message: 'nope' } : { ok: true, message: 'ok' }));
    const d = await r.service.applyAndWait({ templateId: 'demo-bundle', answers: ANSWERS });
    expect(r.fakes.install.mock.calls.map((c: unknown[]) => c[0])).toEqual(['remote-skill', 'nice-to-have']);
    const skills = d.steps.find((s) => s.id === 'skills')!;
    expect(skills.status).toBe('done');
    expect(skills.message).toMatch(/1 个可选技能没装上/);
  });

  it('reports connectors with /connections links; only required ones make the step pending', async () => {
    let d = await r.service.applyAndWait({ templateId: 'demo-bundle', answers: ANSWERS });
    expect(d.connectors).toEqual([
      { id: 'slack', products: [], required: true, why: '简报和审批', status: 'connected', connectPath: '/connections?platform=slack' },
      { id: 'canva', products: [], required: false, why: '做图', status: 'not_connected', connectPath: '/connections?platform=canva' },
    ]);
    r.cleanup();
    r = rig();
    r.fakes.check.mockResolvedValue('not_connected');
    d = await r.service.applyAndWait({ templateId: 'demo-bundle', answers: ANSWERS });
    const step = d.steps.find((s) => s.id === 'connectors')!;
    expect(step).toMatchObject({ status: 'pending', reason: 'connectors_missing' });
    expect(d.status).toBe('partial');
  });

  it('creates the team channel and extra channels with the right agents', async () => {
    const d = await r.service.applyAndWait({ templateId: 'demo-bundle', answers: ANSWERS });
    expect(r.fakes.ensureTeamChannel).toHaveBeenCalledTimes(1);
    const extra = r.fakes.ensureAgentChannel.mock.calls[0][0] as { name: string; purpose: string; memberSessions: string[] };
    expect(extra.name).toBe('小周咖啡-审批');
    expect(extra.purpose).toBe('等老板点头');
    const team = r.teams.get('demo-bundle')!;
    expect(extra.memberSessions).toEqual([team.members[0].agentId, team.members[1].agentId]);
    expect(d.channels).toEqual({ approvals: 'C-extra' });
  });

  it('creates schedules for the right agents in the bundle timezone', async () => {
    await r.service.applyAndWait({ templateId: 'demo-bundle', answers: ANSWERS });
    const team = r.teams.get('demo-bundle')!;
    expect(r.fakes.createCron.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      {
        cronExpression: '0 9 * * 1-6',
        timezone: 'Asia/Shanghai',
        targetAgent: team.members[0].agentId,
        targetTeamId: 'demo-bundle',
        taskDescription: '【每日简报】\n给老板发简报',
        createdBy: 'user',
      },
      expect.objectContaining({ cronExpression: '30 8 * * 1-5', targetAgent: team.members[2].agentId, taskDescription: '【扫描】\n扫 小周咖啡 同行' }),
    ]);
  });

  it('sends the day-0 task through the orchestrator and schedules the rest', async () => {
    const d = await r.service.applyAndWait({ templateId: 'demo-bundle', answers: ANSWERS });
    expect(r.fakes.send).toHaveBeenCalledTimes(1);
    const [content, metadata] = r.fakes.send.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(content).toContain('[成套方案 · 第一周] 第 1 天 · 认识生意');
    expect(content).toContain('请交给团队「小周咖啡 团队」(team id: demo-bundle) 的 Ava 来做');
    expect(content).toContain('了解 小周咖啡');
    expect(metadata).toEqual({ source: 'bundle_first_week', templateId: 'demo-bundle', teamId: 'demo-bundle', taskId: 'hello' });
    expect(d.firstWeek.map((t) => [t.id, t.status, t.dueAt])).toEqual([
      ['hello', 'sent', T0.toISOString()],
      ['drafts', 'scheduled', '2026-09-27T02:00:00.000Z'],
    ]);
  });

  it('is idempotent: a second run creates nothing twice', async () => {
    const first = await r.service.applyAndWait({ templateId: 'demo-bundle', answers: ANSWERS });
    const second = await r.service.applyAndWait({ templateId: 'demo-bundle', answers: ANSWERS });
    expect(second.jobId).not.toBe(first.jobId);
    expect(r.fakes.save).toHaveBeenCalledTimes(1);
    expect(r.fakes.createCron).toHaveBeenCalledTimes(2);
    expect(r.fakes.send).toHaveBeenCalledTimes(1);
    expect(r.fakes.ensureAgentChannel).toHaveBeenCalledTimes(1);
    expect(second.status).toBe('done');
  });

  it('a failing step leaves the others done and the state intact; a re-run resumes only it', async () => {
    r.fakes.install.mockResolvedValueOnce({ ok: false, message: 'network down' });
    const first = await r.service.applyAndWait({ templateId: 'demo-bundle', answers: ANSWERS });
    const skills = first.steps.find((s) => s.id === 'skills')!;
    expect(skills).toMatchObject({ status: 'failed', error: '1 个必需技能没装上' });
    expect(skills.items?.find((i) => i.id === 'remote-skill')).toMatchObject({ status: 'failed', message: 'network down' });
    expect(first.steps.filter((s) => s.id !== 'skills').every((s) => s.status === 'done')).toBe(true);
    expect(first.status).toBe('partial');
    expect((await r.deps.store.read('demo-bundle'))?.steps.find((s) => s.id === 'skills')?.status).toBe('failed');

    r.fakes.save.mockClear();
    r.fakes.createCron.mockClear();
    const second = await r.service.applyAndWait({ templateId: 'demo-bundle' });
    expect(second.status).toBe('done');
    expect(r.fakes.save).not.toHaveBeenCalled();
    expect(r.fakes.createCron).not.toHaveBeenCalled();
    expect(r.fakes.send).toHaveBeenCalledTimes(1);
  });

  it('an exception in a step is caught and recorded', async () => {
    r.fakes.ensureTeamChannel.mockRejectedValueOnce(new Error('name_taken'));
    const d = await r.service.applyAndWait({ templateId: 'demo-bundle', answers: ANSWERS });
    const slack = d.steps.find((s) => s.id === 'slack')!;
    expect(slack.status).toBe('failed');
    expect(slack.items?.[0]).toMatchObject({ status: 'failed', message: 'name_taken' });
    expect(d.steps.find((s) => s.id === 'schedules')!.status).toBe('done');
  });

  it('when the team cannot be created, team-dependent steps are skipped and the status is failed', async () => {
    r.fakes.save.mockRejectedValueOnce(new Error('disk full'));
    const d = await r.service.applyAndWait({ templateId: 'demo-bundle', answers: ANSWERS });
    expect(d.steps.map((s) => [s.id, s.status, s.reason])).toEqual([
      ['team', 'failed', undefined],
      ['norms', 'skipped', 'team_failed'],
      ['skills', 'done', undefined],
      ['connectors', 'done', undefined],
      ['slack', 'skipped', 'team_failed'],
      ['schedules', 'skipped', 'team_failed'],
      ['first_week', 'skipped', 'team_failed'],
    ]);
    expect(d.steps[0].error).toBe('disk full');
    expect(d.status).toBe('failed');
    expect(existsSync(path.join(r.home, 'teams', 'demo-bundle', 'norms'))).toBe(false);

    const again = await r.service.applyAndWait({ templateId: 'demo-bundle' });
    expect(again.status).toBe('done');
  });

  it('Slack not connected → pending; resumeWaiting finishes it once Slack connects', async () => {
    r.setSlack(false);
    const d = await r.service.applyAndWait({ templateId: 'demo-bundle', answers: ANSWERS });
    expect(d.steps.find((s) => s.id === 'slack')).toMatchObject({ status: 'pending', reason: 'slack_not_connected' });
    expect(r.fakes.ensureTeamChannel).not.toHaveBeenCalled();
    expect(await r.service.resumeWaiting()).toEqual([]);

    r.setSlack(true);
    expect(await r.service.resumeWaiting()).toEqual(['demo-bundle']);
    await new Promise((resolve) => setImmediate(resolve));
    const finished = await r.service.applyAndWait({ templateId: 'demo-bundle' });
    expect(finished.steps.find((s) => s.id === 'slack')!.status).toBe('done');
    expect(r.fakes.ensureTeamChannel).toHaveBeenCalledTimes(1);
  });

  it('without a backend (CLI), Slack, connectors, schedules and hand-offs are pending', async () => {
    const offline = new BundleApplyService({ ...r.deps, slack: null, schedules: null, orchestrator: null, connectors: null });
    const d = await offline.applyAndWait({ templateId: 'demo-bundle', answers: ANSWERS });
    const byId = Object.fromEntries(d.steps.map((s) => [s.id, [s.status, s.reason]]));
    expect(byId).toMatchObject({
      team: ['done', undefined],
      norms: ['done', undefined],
      connectors: ['pending', 'backend_not_running'],
      slack: ['pending', 'backend_not_running'],
      schedules: ['pending', 'backend_not_running'],
      first_week: ['pending', 'backend_not_running'],
    });
    expect(d.connectors.every((c) => c.status === 'unknown')).toBe(true);

    // The backend resumes it.
    expect(await r.service.resumeWaiting()).toEqual(['demo-bundle']);
    const done = await r.service.applyAndWait({ templateId: 'demo-bundle' });
    expect(done.status).toBe('done');
    expect(r.fakes.send).toHaveBeenCalledTimes(1);
  });

  describe('request errors', () => {
    it('unknown bundle', async () => {
      await expect(r.service.start({ templateId: 'nope' })).rejects.toMatchObject({ code: 'unknown_bundle' });
    });

    it('draft bundles need allowDraft', async () => {
      r.cleanup();
      r = rig(template({ status: 'draft' }));
      await expect(r.service.start({ templateId: 'demo-bundle', answers: ANSWERS })).rejects.toMatchObject({ code: 'bundle_not_ready' });
      expect((await r.service.applyAndWait({ templateId: 'demo-bundle', answers: ANSWERS, allowDraft: true })).status).toBe('done');
    });

    it('invalid runtime', async () => {
      await expect(r.service.start({ templateId: 'demo-bundle', answers: ANSWERS, runtime: 'gpt-9' })).rejects.toMatchObject({ code: 'invalid_runtime' });
    });

    it('missing answers name the questions and write nothing', async () => {
      let caught: BundleError | null = null;
      try {
        await r.service.start({ templateId: 'demo-bundle', answers: {} });
      } catch (error) {
        caught = error as BundleError;
      }
      expect(caught).toBeInstanceOf(BundleError);
      expect(caught!.code).toBe('invalid_answers');
      expect(caught!.details?.missing).toEqual([{ id: 'business_name', label: '名字', reason: '必填' }]);
      expect(await r.deps.store.read('demo-bundle')).toBeNull();
      expect(r.fakes.save).not.toHaveBeenCalled();
    });
  });

  it('a second start while running joins the same job', async () => {
    const [a, b] = await Promise.all([
      r.service.start({ templateId: 'demo-bundle', answers: ANSWERS }),
      r.service.start({ templateId: 'demo-bundle', answers: ANSWERS }),
    ]);
    expect(a.jobId).toBe(b.jobId);
    await r.service.applyAndWait({ templateId: 'demo-bundle' });
    expect(r.fakes.save).toHaveBeenCalledTimes(1);
  });

  it('getJob returns the live job, the stored one after a restart, or job_not_found', async () => {
    const started = await r.service.start({ templateId: 'demo-bundle', answers: ANSWERS });
    expect((await r.service.getJob(started.jobId)).jobId).toBe(started.jobId);
    await r.service.applyAndWait({ templateId: 'demo-bundle' }).catch(() => undefined);
    const restarted = new BundleApplyService(r.deps);
    expect((await restarted.getJob(started.jobId)).status).toBe('done');
    await expect(restarted.getJob('nope')).rejects.toMatchObject({ code: 'job_not_found' });
    expect((await restarted.getDeployment('demo-bundle'))?.jobId).toBe(started.jobId);
  });

  it('deliverDue sends later first-week tasks once they are due, and only once', async () => {
    await r.service.applyAndWait({ templateId: 'demo-bundle', answers: ANSWERS });
    expect(await r.service.deliverDue()).toBe(0);
    r.setNow(new Date('2026-09-27T02:00:00.000Z'));
    expect(await r.service.deliverDue()).toBe(1);
    expect(await r.service.deliverDue()).toBe(0);
    const [content] = r.fakes.send.mock.calls[1] as unknown as [string];
    expect(content).toContain('第 3 天 · 三篇草稿');
    expect(content).toContain('的 Leo 来做');
    const stored = await r.deps.store.read('demo-bundle');
    expect(stored?.firstWeek.every((t) => t.status === 'sent')).toBe(true);
    expect(stored?.steps.find((s) => s.id === 'first_week')?.status).toBe('done');
  });

  it('a hand-off the orchestrator refuses is recorded as failed and retried on re-run', async () => {
    r.fakes.send.mockResolvedValueOnce({ conversationId: null, forwarded: false, queued: false, error: 'orchestrator offline' });
    const d = await r.service.applyAndWait({ templateId: 'demo-bundle', answers: ANSWERS });
    expect(d.firstWeek[0]).toMatchObject({ status: 'failed', error: 'orchestrator offline' });
    expect(d.steps.find((s) => s.id === 'first_week')!.status).toBe('failed');
    const again = await r.service.applyAndWait({ templateId: 'demo-bundle' });
    expect(again.firstWeek[0].status).toBe('sent');
  });
});

describe('helpers', () => {
  it('withFrontmatter drops empty fields and flattens newlines', () => {
    expect(withFrontmatter({ title: 'A\nB', trigger: undefined, x: '' }, '\nbody\n')).toBe('---\ntitle: A B\n---\n\nbody\n');
  });

  it('overallStatus', () => {
    const steps = initialSteps();
    expect(overallStatus(steps)).toBe('partial');
    steps.forEach((s) => { s.status = 'done'; });
    expect(overallStatus(steps)).toBe('done');
    steps[3].status = 'skipped';
    steps[3].reason = 'nothing_to_do';
    expect(overallStatus(steps)).toBe('done');
    steps[3].reason = 'team_failed';
    expect(overallStatus(steps)).toBe('partial');
    steps[0].status = 'failed';
    expect(overallStatus(steps)).toBe('failed');
  });

  it('buildFirstWeekMessage', () => {
    const msg = buildFirstWeekMessage(
      { id: 'x', title: '标题', day: 1, dueAt: '', teamId: 't', target: 's', status: 'scheduled' },
      { id: 't', name: '团队' },
      'Leo',
      '  内容  ',
    );
    expect(msg).toBe('[成套方案 · 第一周] 第 2 天 · 标题\n请交给团队「团队」(team id: t) 的 Leo 来做；团队还没启动的话先启动它。\n\n内容');
  });
});
