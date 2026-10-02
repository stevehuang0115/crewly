/**
 * Tests for the orc-DM token cap / boost commands (English and Chinese).
 */
import type { SlackIncomingMessage } from '../../types/slack.types.js';
import {
  createSpendCapInterceptor,
  orcCappedReply,
  parseSpendCapCommand,
  resolveAgent,
  resolveTeam,
  runSpendCapCommand,
  type SpendCapCommandDeps,
} from './spend-cap-command.js';
import type { SpendStop } from './spend-cap.gate.js';

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿＀-￯]/;
const M = 1_000_000;
const AGENTS = [
  { session: 'crewly-orc', name: 'Orc' },
  { session: 'crewly-marketing-ella-e6a6b8ea', name: 'Ella' },
  { session: 'ce-nova-a2b1f759', name: 'Nova' },
];
const TEAMS = [
  { id: '5ad0642a', name: 'CE' },
  { id: '03bf7d62', name: 'Crewly Marketing' },
];

describe('parseSpendCapCommand', () => {
  it.each([
    ['set daily cap for crewly-orc to 5M', { kind: 'set', target: 'crewly-orc', tokens: 5 * M }],
    ['Set daily token cap for Ella to 3.5m tokens.', { kind: 'set', target: 'ella', tokens: 3.5 * M }],
    ['set daily cap to 500k', { kind: 'set', target: null, tokens: 500_000 }],
    ['set the daily cap to 5000000 per day', { kind: 'set', target: null, tokens: 5 * M }],
    ['set daily total cap to 200M', { kind: 'set_total', tokens: 200 * M }],
    ['set team cap for CE to 50M', { kind: 'set', target: 'ce', team: true, tokens: 50 * M }],
    ['set daily cap for team CE to 50M', { kind: 'set', target: 'ce', team: true, tokens: 50 * M }],
    ['remove daily cap for Ella', { kind: 'remove', target: 'ella' }],
    ['remove team cap for CE', { kind: 'remove', target: 'ce', team: true }],
    ['remove daily cap', { kind: 'remove', target: null }],
    ['turn off the total cap', { kind: 'remove_total' }],
    ['boost CE by 20M today', { kind: 'boost', target: 'ce', tokens: 20 * M }],
    ['boost Ella +5M', { kind: 'boost', target: 'ella', tokens: 5 * M }],
    ['boost everyone by 10m for today', { kind: 'boost', target: 'everyone', tokens: 10 * M }],
    ['give CE 20M more today', { kind: 'boost', target: 'ce', tokens: 20 * M }],
    ['unlimited today for everyone', { kind: 'unlimited', target: 'everyone' }],
    ['Unlimited today for CE!', { kind: 'unlimited', target: 'ce' }],
    ['unlimited today', { kind: 'unlimited', target: 'everyone' }],
    ['no cap for CE today', { kind: 'unlimited', target: 'ce' }],
    ['CE unlimited today', { kind: 'unlimited', target: 'ce' }],
    ['lift the cap for Ella today', { kind: 'unlimited', target: 'ella' }],
    ['<@U123> boost CE by 20M today', { kind: 'boost', target: 'ce', tokens: 20 * M }],
    // Chinese
    ['放开 CE 今天', { kind: 'unlimited', target: 'ce' }],
    ['今天放开 CE', { kind: 'unlimited', target: 'ce' }],
    ['放开CE', { kind: 'unlimited', target: 'ce' }],
    ['今天全部放开', { kind: 'unlimited', target: 'everyone' }],
    ['放开所有人', { kind: 'unlimited', target: 'everyone' }],
    ['CE 今天不限', { kind: 'unlimited', target: 'ce' }],
    ['给 CE 加 20M', { kind: 'boost', target: 'ce', tokens: 20 * M }],
    ['今天给 Ella 加 2000万', { kind: 'boost', target: 'ella', tokens: 20 * M }],
    ['CE 今天加 1亿', { kind: 'boost', target: 'ce', tokens: 100 * M }],
    // The pre-token dollar forms get a hint instead of reaching the orc.
    ['set daily cap for orc to $5', { kind: 'usd_hint' }],
    ['raise cap for orc to $10 today', { kind: 'usd_hint' }],
  ])('%s', (text, expected) => {
    expect(parseSpendCapCommand(text)).toEqual(expected);
  });

  it.each([
    'what did we spend today?',
    'set a reminder for 5',
    'raise the budget please',
    '放开那个文件的权限给我看看',
    'boost the landing page conversion',
    '',
    undefined,
  ])('not a command: %s', (text) => {
    expect(parseSpendCapCommand(text)).toBeNull();
  });
});

describe('resolveAgent / resolveTeam', () => {
  it('knows the orc by several names, members by name or session', () => {
    expect(resolveAgent('orc', AGENTS)).toBe('crewly-orc');
    expect(resolveAgent('the orchestrator', AGENTS)).toBe('crewly-orc');
    expect(resolveAgent('ella', AGENTS)).toBe('crewly-marketing-ella-e6a6b8ea');
    expect(resolveAgent('nobody', AGENTS)).toBeNull();
    expect(resolveAgent('ella', [...AGENTS, { session: 'other-ella', name: 'Ella' }])).toBeNull();
  });

  it('knows teams by name or id', () => {
    expect(resolveTeam('ce', TEAMS)?.id).toBe('5ad0642a');
    expect(resolveTeam('team crewly marketing', TEAMS)?.id).toBe('03bf7d62');
    expect(resolveTeam('5ad0642a', TEAMS)?.name).toBe('CE');
    expect(resolveTeam('nope', TEAMS)).toBeNull();
  });
});

describe('runSpendCapCommand', () => {
  const deps = () => ({
    agents: async () => AGENTS,
    teams: async () => TEAMS,
    setCaps: jest.fn().mockResolvedValue({}),
    boost: jest.fn().mockResolvedValue({}),
  });

  it('sets per-agent, per-team, default and total caps, and removes them', async () => {
    const d = deps();
    expect(await runSpendCapCommand({ kind: 'set', target: 'crewly-orc', tokens: 5 * M }, d)).toBe('Daily token cap for Orc set to 5M tokens.');
    expect(await runSpendCapCommand({ kind: 'set', target: 'ce', team: true, tokens: 50 * M }, d)).toBe('Daily token cap for team CE set to 50M tokens (all its members together).');
    expect(await runSpendCapCommand({ kind: 'set', target: null, tokens: 4 * M }, d)).toBe('Daily token cap set to 4M tokens per agent (agents with their own cap keep it).');
    expect(await runSpendCapCommand({ kind: 'set_total', tokens: 200 * M }, d)).toBe('Daily token cap set to 200M tokens for all agents together.');
    expect(await runSpendCapCommand({ kind: 'remove', target: 'ella' }, d)).toBe('Ella has no daily token cap now.');
    expect(await runSpendCapCommand({ kind: 'remove', target: 'ce', team: true }, d)).toBe('Team CE has no daily token cap now.');
    expect(await runSpendCapCommand({ kind: 'remove_total' }, d)).toBe('Daily total token cap removed.');
    expect(d.setCaps.mock.calls).toEqual([
      [{ agents: { 'crewly-orc': 5 * M } }],
      [{ teams: { '5ad0642a': 50 * M } }],
      [{ defaultAgentCapTokens: 4 * M }],
      [{ totalCapTokens: 200 * M }],
      [{ agents: { 'crewly-marketing-ella-e6a6b8ea': null } }],
      [{ teams: { '5ad0642a': null } }],
      [{ totalCapTokens: null }],
    ]);
  });

  it('boosts a team, an agent or everyone; unlimited today', async () => {
    const d = deps();
    expect(await runSpendCapCommand({ kind: 'boost', target: 'ce', tokens: 20 * M }, d)).toBe('Boosted team CE by +20M tokens until midnight. Queued messages are being delivered.');
    expect(await runSpendCapCommand({ kind: 'boost', target: 'nova', tokens: 5 * M }, d)).toBe('Boosted Nova by +5M tokens until midnight. Queued messages are being delivered.');
    expect(await runSpendCapCommand({ kind: 'unlimited', target: 'everyone' }, d)).toBe('No token cap for everyone until midnight. Queued messages are being delivered.');
    expect(await runSpendCapCommand({ kind: 'unlimited', target: '所有人' }, d)).toBe('No token cap for everyone until midnight. Queued messages are being delivered.');
    expect(d.boost.mock.calls).toEqual([
      [{ scope: 'team', id: '5ad0642a', extraTokens: 20 * M, by: 'orc-dm' }],
      [{ scope: 'agent', id: 'ce-nova-a2b1f759', extraTokens: 5 * M, by: 'orc-dm' }],
      [{ scope: 'all', unlimited: true, by: 'orc-dm' }],
      [{ scope: 'all', unlimited: true, by: 'orc-dm' }],
    ]);
  });

  it('a name that is both a team and an agent means the team for boosts', async () => {
    const d = { ...deps(), agents: async () => [...AGENTS, { session: 'ce-bot', name: 'CE' }] };
    await runSpendCapCommand({ kind: 'unlimited', target: 'ce' }, d);
    expect(d.boost).toHaveBeenCalledWith({ scope: 'team', id: '5ad0642a', unlimited: true, by: 'orc-dm' });
  });

  it('says so for an unknown target and for dollar amounts', async () => {
    expect(await runSpendCapCommand({ kind: 'boost', target: 'zed', tokens: 1 }, deps())).toBe(
      'I don\'t know a team or agent called "zed". Use a team name (e.g. CE), an agent\'s name or session name, or "everyone".',
    );
    expect(await runSpendCapCommand({ kind: 'usd_hint' }, deps())).toMatch(/counted in tokens now/);
  });
});

describe('createSpendCapInterceptor', () => {
  const msg = (text: string): SlackIncomingMessage => ({ text, channelId: 'D1', userId: 'U1' }) as SlackIncomingMessage;
  const flush = () => new Promise((r) => setTimeout(r, 0));

  const build = (over: Partial<SpendCapCommandDeps> = {}) => {
    const replies: string[] = [];
    const deps: SpendCapCommandDeps = {
      ownerDmScope: () => 'orc',
      replyTargetOf: () => ({ channelId: 'D1' }),
      reply: async (t) => {
        replies.push(t);
      },
      agents: async () => AGENTS,
      teams: async () => TEAMS,
      setCaps: jest.fn().mockResolvedValue({}),
      boost: jest.fn().mockResolvedValue({}),
      orcStop: () => null,
      ...over,
    };
    return { intercept: createSpendCapInterceptor(deps), replies, deps };
  };

  it('consumes a command in the owner\'s orc DM and answers in one English line (ZH input too)', async () => {
    const { intercept, replies, deps } = build();
    expect(intercept(msg('放开 CE 今天'))).toBe(true);
    await flush();
    expect(deps.boost).toHaveBeenCalledWith({ scope: 'team', id: '5ad0642a', unlimited: true, by: 'orc-dm' });
    expect(replies).toEqual(['No token cap for team CE until midnight. Queued messages are being delivered.']);
    expect(replies[0]).not.toMatch(CJK);
  });

  it('ignores commands outside the owner\'s orc DM', () => {
    const { intercept, deps } = build({ ownerDmScope: () => null });
    expect(intercept(msg('boost CE by 20M today'))).toBe(false);
    expect(deps.boost).not.toHaveBeenCalled();
  });

  it('while the orc is capped: replies with the cap and how to lift it, and lets the message queue for the orc', async () => {
    const stop: SpendStop = { session: 'crewly-orc', scope: 'agent', capTokens: 5 * M, usedTokens: 5.3 * M };
    const { intercept, replies } = build({ orcStop: () => stop });
    expect(intercept(msg('can you check the deploy?'))).toBe(false);
    await flush();
    expect(replies).toEqual([
      'Orc hit its daily token cap (5M tokens). No new turns start until midnight; your message is queued. To lift it for today, reply `boost orc by 5M today` or `unlimited today for orc` (or the Usage page (/usage)).',
    ]);
  });

  it('a boost command still works while the orc is capped', async () => {
    const stop: SpendStop = { session: 'crewly-orc', scope: 'total', capTokens: 20 * M, usedTokens: 21 * M };
    const { intercept, replies, deps } = build({ orcStop: () => stop });
    expect(intercept(msg('unlimited today for everyone'))).toBe(true);
    await flush();
    expect(deps.boost).toHaveBeenCalledWith({ scope: 'all', unlimited: true, by: 'orc-dm' });
    expect(replies[0]).toBe('No token cap for everyone until midnight. Queued messages are being delivered.');
  });

  it('reports a failed change', async () => {
    const { intercept, replies } = build({ boost: jest.fn().mockRejectedValue(new Error('No team called "x"')) });
    intercept(msg('boost CE by 20M today'));
    await flush();
    await flush();
    expect(replies).toEqual(['Couldn\'t change the cap: No team called "x"']);
  });

  it('the team / total capped replies name the right target', () => {
    const team = orcCappedReply({ session: 'crewly-orc', scope: 'team', capTokens: 50 * M, usedTokens: 51 * M, teamId: 't', teamName: 'CE' });
    expect(team).toContain('team CE hit its daily token cap (50M tokens)');
    expect(team).toContain('`boost CE by 50M today`');
    const total = orcCappedReply({ session: 'crewly-orc', scope: 'total', capTokens: 20 * M, usedTokens: 21 * M });
    expect(total).toContain('`unlimited today for everyone`');
    expect(total).not.toMatch(CJK);
  });
});
