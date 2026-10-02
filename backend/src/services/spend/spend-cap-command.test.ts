import type { SlackIncomingMessage } from '../../types/slack.types.js';
import {
  createSpendCapInterceptor,
  orcCappedReply,
  parseSpendCapCommand,
  resolveAgent,
  runSpendCapCommand,
  type SpendCapCommandDeps,
} from './spend-cap-command.js';
import type { SpendStop } from './spend-cap.gate.js';

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿＀-￯]/;
const AGENTS = [
  { session: 'crewly-orc', name: 'Orc' },
  { session: 'crewly-marketing-ella-e6a6b8ea', name: 'Ella' },
];

describe('parseSpendCapCommand', () => {
  it.each([
    ['set daily cap for crewly-orc to $5', { kind: 'set', target: 'crewly-orc', usd: 5 }],
    ['Set daily spend cap for Ella to 3.50.', { kind: 'set', target: 'ella', usd: 3.5 }],
    ['set daily cap to $5', { kind: 'set', target: null, usd: 5 }],
    ['set the daily cap to 5 dollars per day', { kind: 'set', target: null, usd: 5 }],
    ['set daily total cap to $20', { kind: 'set_total', usd: 20 }],
    ['set total cap to 20', { kind: 'set_total', usd: 20 }],
    ['remove daily cap for Ella', { kind: 'remove', target: 'ella' }],
    ['remove daily cap', { kind: 'remove', target: null }],
    ['turn off the total cap', { kind: 'remove_total' }],
    ['raise cap for orc to $10 today', { kind: 'raise', target: 'orc', usd: 10 }],
    ['raise daily cap for crewly-orc to 12 for today', { kind: 'raise', target: 'crewly-orc', usd: 12 }],
    ['raise cap for total to $40 today', { kind: 'raise', target: '*', usd: 40 }],
    ['raise total cap to $40 today', { kind: 'raise', target: '*', usd: 40 }],
    ['<@U123> set daily cap for orc to $5', { kind: 'set', target: 'orc', usd: 5 }],
  ])('%s', (text, expected) => {
    expect(parseSpendCapCommand(text)).toEqual(expected);
  });

  it.each(['what did we spend today?', 'set a reminder for 5', 'raise the budget please', '', undefined])('not a command: %s', (text) => {
    expect(parseSpendCapCommand(text)).toBeNull();
  });
});

describe('resolveAgent', () => {
  it('knows the orc by several names, members by name or session', () => {
    expect(resolveAgent('orc', AGENTS)).toBe('crewly-orc');
    expect(resolveAgent('the orchestrator', AGENTS)).toBe('crewly-orc');
    expect(resolveAgent('ella', AGENTS)).toBe('crewly-marketing-ella-e6a6b8ea');
    expect(resolveAgent('crewly-marketing-ella-e6a6b8ea', AGENTS)).toBe('crewly-marketing-ella-e6a6b8ea');
    expect(resolveAgent('nobody', AGENTS)).toBeNull();
  });

  it('refuses an ambiguous name', () => {
    expect(resolveAgent('ella', [...AGENTS, { session: 'other-ella', name: 'Ella' }])).toBeNull();
  });
});

describe('runSpendCapCommand', () => {
  const deps = () => ({
    agents: async () => AGENTS,
    setCaps: jest.fn().mockResolvedValue({}),
    raiseToday: jest.fn().mockImplementation(async (_t: string, usd: number) => usd),
  });

  it('sets a per-agent cap', async () => {
    const d = deps();
    expect(await runSpendCapCommand({ kind: 'set', target: 'crewly-orc', usd: 5 }, d)).toBe('Daily spend cap for Orc set to $5.00.');
    expect(d.setCaps).toHaveBeenCalledWith({ agents: { 'crewly-orc': 5 } });
  });

  it('sets the default and the total, and removes them', async () => {
    const d = deps();
    expect(await runSpendCapCommand({ kind: 'set', target: null, usd: 4 }, d)).toBe('Daily spend cap set to $4.00 per agent (agents with their own cap keep it).');
    expect(await runSpendCapCommand({ kind: 'set_total', usd: 20 }, d)).toBe('Daily total spend cap set to $20.00 for all agents together.');
    expect(await runSpendCapCommand({ kind: 'remove', target: 'ella' }, d)).toBe('Ella has no daily spend cap now.');
    expect(await runSpendCapCommand({ kind: 'remove_total' }, d)).toBe('Daily total spend cap removed.');
    expect(d.setCaps.mock.calls).toEqual([
      [{ defaultAgentCapUsd: 4 }],
      [{ totalCapUsd: 20 }],
      [{ agents: { 'crewly-marketing-ella-e6a6b8ea': null } }],
      [{ totalCapUsd: null }],
    ]);
  });

  it('raises for today', async () => {
    const d = deps();
    expect(await runSpendCapCommand({ kind: 'raise', target: 'orc', usd: 10 }, d)).toBe("Orc's daily spend cap raised to $10.00 for today. Queued messages are being delivered.");
    expect(d.raiseToday).toHaveBeenCalledWith('crewly-orc', 10);
    expect(await runSpendCapCommand({ kind: 'raise', target: '*', usd: 40 }, d)).toBe('Daily total spend cap raised to $40.00 for today.');
  });

  it('says so for an unknown agent', async () => {
    expect(await runSpendCapCommand({ kind: 'set', target: 'zed', usd: 1 }, deps())).toBe(
      'I don\'t know an agent called "zed". Use its name or session name (e.g. crewly-orc).',
    );
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
      setCaps: jest.fn().mockResolvedValue({}),
      raiseToday: jest.fn().mockResolvedValue(10),
      orcStop: () => null,
      ...over,
    };
    return { intercept: createSpendCapInterceptor(deps), replies, deps };
  };

  it('consumes a cap command in the owner\'s orc DM and answers in one line', async () => {
    const { intercept, replies, deps } = build();
    expect(intercept(msg('set daily cap for crewly-orc to $5'))).toBe(true);
    await flush();
    expect(deps.setCaps).toHaveBeenCalledWith({ agents: { 'crewly-orc': 5 } });
    expect(replies).toEqual(['Daily spend cap for Orc set to $5.00.']);
  });

  it('ignores commands outside the owner\'s orc DM', () => {
    const { intercept, deps } = build({ ownerDmScope: () => null });
    expect(intercept(msg('set daily cap for crewly-orc to $5'))).toBe(false);
    expect(deps.setCaps).not.toHaveBeenCalled();
  });

  it('while the orc is capped: replies with the cap and how to raise it, and lets the message queue for the orc', async () => {
    const stop: SpendStop = { session: 'crewly-orc', scope: 'agent', capUsd: 5, spentUsd: 5.3 };
    const { intercept, replies } = build({ orcStop: () => stop });
    expect(intercept(msg('can you check the deploy?'))).toBe(false);
    await flush();
    expect(replies).toEqual([
      'Orc hit its daily spend cap ($5.00). No new turns start until midnight; your message is queued. To raise it for today, reply `raise cap for orc to $10 today` (or Settings → System → Spend).',
    ]);
  });

  it('a raise command still works while the orc is capped', async () => {
    const stop: SpendStop = { session: 'crewly-orc', scope: 'agent', capUsd: 5, spentUsd: 5.3 };
    const { intercept, replies, deps } = build({ orcStop: () => stop });
    expect(intercept(msg('raise cap for orc to $10 today'))).toBe(true);
    await flush();
    expect(deps.raiseToday).toHaveBeenCalledWith('crewly-orc', 10);
    expect(replies[0]).toContain("Orc's daily spend cap raised to $10.00 for today");
  });

  it('reports a failed change', async () => {
    const { intercept, replies } = build({ raiseToday: jest.fn().mockRejectedValue(new Error('$3.00 is not above what Orc already spent today ($8.00)')) });
    intercept(msg('raise cap for orc to $3 today'));
    await flush();
    await flush();
    expect(replies).toEqual(["Couldn't change the cap: $3.00 is not above what Orc already spent today ($8.00)"]);
  });

  it('the total-cap reply names the total', () => {
    const text = orcCappedReply({ session: 'crewly-orc', scope: 'total', capUsd: 20, spentUsd: 21 });
    expect(text).toBe(
      'Orc is stopped: all agents together hit the daily total spend cap ($20.00). No new turns start until midnight; your message is queued. To raise it for today, reply `raise cap for total to $40 today` (or Settings → System → Spend).',
    );
    expect(text).not.toMatch(CJK);
    expect(parseSpendCapCommand('raise cap for total to $40 today')).toEqual({ kind: 'raise', target: '*', usd: 40 });
  });
});
