/**
 * Tests for the ticket loop's per-channel glue (specs/ticket-loop.md §2).
 */

import {
  slackConversationRef,
  slackThreadRef,
  chatV2ConversationRef,
  chatV2ThreadRef,
  isOwnerChatMessage,
  ticketOfOutcome,
  ticketDeliveryLine,
  appendTicketLine,
  withTicketMarker,
  ticketLineOf,
  intakeWithin,
  receiptText,
  dismissedReceiptText,
  slackReceiptBlocks,
  createSlackReceiptSink,
  createChatV2ReceiptSink,
  buildChatV2SourceId,
  buildChatV2TicketSourceId,
  isOrchestratorRoutedChatV2Channel,
  chatV2IntakeMessage,
  intakeChatV2OwnerMessage,
  slackIntakeMessage,
  type ReceiptSlackApi,
} from './ticket-channel-hooks.js';
import { createRequest, type Request } from '../../types/v2/request.types.js';
import type { ChatChannelDTO, ChatMessageDTO } from '../chat-v2/types.js';
import type { IntakeMessage, IntakeOutcome } from './ticket-intake.service.js';
import { OWNER_EVIDENCE_METADATA, TICKET_CONSTANTS } from '../../constants.js';

const ID = '11111111-2222-3333-4444-555555555555';

/**
 * A numbered ticket.
 *
 * @param n - Ticket number
 * @returns Request
 */
function ticket(n = 7): Request {
  return { ...createRequest({ sourceConversationItemId: 's', title: 't', description: 'd', ticketNumber: n }), id: ID };
}

/**
 * A chat-v2 message.
 *
 * @param overrides - Fields to change
 * @returns DTO
 */
function chatMsg(overrides: Partial<ChatMessageDTO> = {}): ChatMessageDTO {
  return {
    id: 'm-1',
    channelId: 'c-1',
    seq: 1,
    senderType: 'user',
    senderId: 'dev-user-001',
    content: 'please add a dark mode toggle',
    contentType: 'markdown',
    createdAt: Date.now(),
    attachments: [],
    ...overrides,
  } as ChatMessageDTO;
}

/**
 * A chat-v2 channel.
 *
 * @param overrides - Fields to change
 * @returns DTO
 */
function channel(overrides: Partial<ChatChannelDTO> = {}): ChatChannelDTO {
  return { id: 'c-1', type: 'dm', name: 'Ella', agentSession: 'ella', ...overrides } as ChatChannelDTO;
}

describe('refs', () => {
  it('thread refs are prefixed by their conversation ref', () => {
    expect(slackConversationRef('C1')).toBe('slack:C1');
    expect(slackThreadRef('C1', '1.2')).toBe('slack:C1:1.2');
    expect(chatV2ConversationRef('c')).toBe('chatv2:c');
    expect(chatV2ThreadRef('c', 'm')).toBe('chatv2:c:m');
    expect(slackThreadRef('C1', '1.2').startsWith(`${slackConversationRef('C1')}:`)).toBe(true);
  });

  it('chat-v2 source ids: SLA shape for the orc DM, a separate prefix otherwise', () => {
    expect(buildChatV2SourceId('c', 'm')).toBe('chatv2-c__m');
    expect(buildChatV2TicketSourceId('c', 'm')).toBe('chatv2t-c__m');
    expect(isOrchestratorRoutedChatV2Channel({ type: 'dm', agentSession: 'crewly-orc' })).toBe(true);
    expect(isOrchestratorRoutedChatV2Channel({ type: 'dm', agentSession: 'ella' })).toBe(false);
    expect(isOrchestratorRoutedChatV2Channel({ type: 'huddle', agentSession: 'crewly-orc' })).toBe(false);
  });
});

describe('isOwnerChatMessage (PR #786 authorship markers)', () => {
  it('a plain user row is the owner', () => {
    expect(isOwnerChatMessage(chatMsg())).toBe(true);
  });

  it('agent rows, agent-authored user rows and agent-reply sources are not', () => {
    expect(isOwnerChatMessage(chatMsg({ senderType: 'agent' }))).toBe(false);
    expect(isOwnerChatMessage(chatMsg({ metadata: { [OWNER_EVIDENCE_METADATA.AUTHOR_AGENT_SESSION]: 'dev-1' } }))).toBe(false);
    expect(isOwnerChatMessage(chatMsg({ metadata: { [OWNER_EVIDENCE_METADATA.REMOTE_AGENT_SESSION]: 'atlas' } }))).toBe(false);
    expect(isOwnerChatMessage(chatMsg({ metadata: { source: 'reply-tool' } }))).toBe(false);
  });
});

describe('delivered-message marker', () => {
  it('ticketOfOutcome returns the ticket for created/appended/duplicate only', () => {
    const t = ticket();
    expect(ticketOfOutcome({ action: 'created', ticket: t })).toBe(t);
    expect(ticketOfOutcome({ action: 'appended', ticket: t })).toBe(t);
    expect(ticketOfOutcome({ action: 'duplicate', ticket: t })).toBe(t);
    expect(ticketOfOutcome({ action: 'dismissed', ticket: t })).toBeNull();
    expect(ticketOfOutcome({ action: 'ignored', reason: 'x' })).toBeNull();
    expect(ticketOfOutcome(null)).toBeNull();
  });

  it('the delivery line carries the marker and the --request-id to use', () => {
    const line = ticketDeliveryLine(ticket());
    expect(line.startsWith(`[TICKET:TKT-007 ${ID}]`)).toBe(true);
    expect(line).toContain(`--request-id ${ID}`);
    expect(ticketDeliveryLine(null)).toBe('');
    expect(ticketDeliveryLine({ id: ID })).toBe('');
  });

  it('appendTicketLine leaves text alone without a ticket', () => {
    expect(appendTicketLine('hi', null)).toBe('hi');
    expect(appendTicketLine('hi', ticket())).toMatch(/^hi\n\n\[TICKET:TKT-007 /);
  });

  it('withTicketMarker copies the message and puts the line in metadata for the dispatcher', () => {
    const m = chatMsg({ metadata: { source: 'slack' } });
    const marked = withTicketMarker(m, ticket());
    expect(marked).not.toBe(m);
    expect(m.metadata).toEqual({ source: 'slack' });
    expect(ticketLineOf(marked)).toContain('[TICKET:TKT-007');
    expect(marked.metadata?.source).toBe('slack');
    expect(withTicketMarker(m, null)).toBe(m);
    expect(ticketLineOf(m)).toBeUndefined();
  });
});

describe('intakeWithin', () => {
  it('returns null when intake is not wired', async () => {
    expect(await intakeWithin(null, {} as IntakeMessage)).toBeNull();
  });

  it('returns the outcome when intake is quick', async () => {
    const outcome: IntakeOutcome = { action: 'ignored', reason: 'x' };
    expect(await intakeWithin({ intakeWithOutcome: async () => outcome }, {} as IntakeMessage)).toBe(outcome);
  });

  it('gives up waiting after the timeout', async () => {
    const never = { intakeWithOutcome: () => new Promise<IntakeOutcome>(() => undefined) };
    expect(await intakeWithin(never, {} as IntakeMessage, 10)).toBeNull();
  });
});

describe('receipt texts', () => {
  it('recorded / dismissed', () => {
    expect(receiptText(ticket())).toBe(`已记成 TKT-007 · ${TICKET_CONSTANTS.RECEIPT.DISMISS_HINT}`);
    expect(receiptText(ticket(), true)).toBe('已记成 TKT-007');
    expect(dismissedReceiptText(ticket())).toBe('TKT-007 已取消记录');
  });

  it('the Slack button carries the ticket id and the dismiss action id', () => {
    const [block] = slackReceiptBlocks(ticket()) as unknown as Array<{ accessory: { action_id: string; value: string } }>;
    expect(block.accessory).toMatchObject({ action_id: TICKET_CONSTANTS.SLACK_DISMISS_ACTION_ID, value: ID });
  });
});

describe('Slack receipt sink', () => {
  /**
   * Recording Slack fake.
   *
   * @param interactive - Whether button clicks reach the process
   * @returns Fake
   */
  function slackFake(interactive: boolean): ReceiptSlackApi & { sent: unknown[]; updated: unknown[][] } {
    const sent: unknown[] = [];
    const updated: unknown[][] = [];
    return {
      sent,
      updated,
      async sendMessage(m) {
        sent.push(m);
        return '999.1';
      },
      async updateMessage(...args) {
        updated.push(args);
      },
      supportsInteractivity: () => interactive,
    };
  }

  it('posts in the thread; asks for a 不用记 reply when buttons cannot reach us', async () => {
    const slack = slackFake(false);
    const sink = createSlackReceiptSink({ slack });
    const receipt = await sink.post(ticket(), { kind: 'slack', slackChannelId: 'C1', threadTs: '1.0' });
    expect(receipt).toEqual({ kind: 'slack', slackChannelId: 'C1', ts: '999.1', threadTs: '1.0' });
    expect(slack.sent[0]).toMatchObject({ channelId: 'C1', threadTs: '1.0', skipChatV2Mirror: true, text: receiptText(ticket()) });
    expect((slack.sent[0] as { blocks?: unknown }).blocks).toBeUndefined();
  });

  it('adds the button in socket mode', async () => {
    const slack = slackFake(true);
    await createSlackReceiptSink({ slack }).post(ticket(), { kind: 'slack', slackChannelId: 'C1', threadTs: '1.0' });
    expect((slack.sent[0] as { blocks?: unknown[] }).blocks).toHaveLength(1);
  });

  it('posts as the agent’s own bot when asked (DMs), records who, and edits with the same bot', async () => {
    const slack = slackFake(true);
    const sink = createSlackReceiptSink({ slack, botTokenFor: (s) => (s === 'ella' ? 'xoxb-ella' : undefined) });
    const receipt = await sink.post(ticket(), { kind: 'slack', slackChannelId: 'D1', threadTs: '1.0', postAs: 'ella' });
    expect(slack.sent[0]).toMatchObject({ botToken: 'xoxb-ella' });
    // No button under an agent bot: its clicks go to Cloud, not here.
    expect((slack.sent[0] as { blocks?: unknown }).blocks).toBeUndefined();
    expect(receipt).toMatchObject({ postedAs: 'ella' });
    expect(JSON.stringify(receipt)).not.toContain('xoxb');
    await sink.markDismissed(ticket(), receipt!);
    expect(slack.updated[0]).toEqual(['D1', '999.1', 'TKT-007 已取消记录', [], 'xoxb-ella']);
  });

  it('returns null when Slack deduplicated the post, and ignores chat-v2 targets', async () => {
    const slack = { ...slackFake(false), sendMessage: async () => '' };
    const sink = createSlackReceiptSink({ slack });
    expect(await sink.post(ticket(), { kind: 'slack', slackChannelId: 'C1', threadTs: '1' })).toBeNull();
    expect(await sink.post(ticket(), { kind: 'chat-v2', chatChannelId: 'c' })).toBeNull();
  });
});

describe('chat-v2 receipt sink', () => {
  it('records a system note under the owner’s message and edits it on dismiss', async () => {
    const recorded: unknown[] = [];
    const updates: unknown[][] = [];
    const broadcast = jest.fn();
    const sink = createChatV2ReceiptSink({
      chat: {
        recordTurn: (input) => {
          recorded.push(input);
          return { message: chatMsg({ id: 'r-1', senderType: 'system', content: input.content }) };
        },
        updateSystemMessage: (...args) => {
          updates.push(args);
          return chatMsg({ id: 'r-1', senderType: 'system', content: String(args[1]) });
        },
      },
      broadcast,
    });
    const receipt = await sink.post(ticket(), { kind: 'chat-v2', chatChannelId: 'c-1', threadId: 'm-1' });
    expect(receipt).toEqual({ kind: 'chat-v2', chatChannelId: 'c-1', messageId: 'r-1' });
    expect(recorded[0]).toMatchObject({
      channelId: 'c-1',
      senderType: 'system',
      contentType: 'system_note',
      threadId: 'm-1',
      metadata: { source: 'system', ticketReceipt: { ticketId: ID, tkt: 'TKT-007', status: 'recorded' } },
    });
    await sink.markDismissed(ticket(), receipt!);
    expect(updates[0]).toEqual(['r-1', 'TKT-007 已取消记录', { ticketReceipt: { ticketId: ID, tkt: 'TKT-007', status: 'dismissed' } }]);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });
});

describe('chatV2IntakeMessage', () => {
  it('orc DM: keeps the SLA source id + chat-v2 tag, assigns the orc', () => {
    const m = chatV2IntakeMessage(channel({ agentSession: 'crewly-orc' }), chatMsg(), 'chat');
    expect(m).toMatchObject({
      isOwner: true,
      targetAgent: 'crewly-orc',
      tags: ['chat-v2'],
      origin: { channel: 'chat', ref: 'chatv2-c-1__m-1', threadRef: 'chatv2:c-1:m-1' },
      conversationRef: 'chatv2:c-1',
      receipt: { kind: 'chat-v2', chatChannelId: 'c-1', threadId: 'm-1' },
    });
  });

  it('agent DM: ticket prefix, no SLA tag, assigned to the agent; a reply threads under its root', () => {
    const m = chatV2IntakeMessage(channel(), chatMsg({ id: 'm-2', threadId: 'm-1' }), 'portal');
    expect(m).toMatchObject({ targetAgent: 'ella', origin: { channel: 'portal', ref: 'chatv2t-c-1__m-2', threadRef: 'chatv2:c-1:m-1' } });
    expect(m?.tags).toBeUndefined();
  });

  it('huddles have no single assignee; agent rows are not intake', () => {
    expect(chatV2IntakeMessage(channel({ type: 'huddle', agentSession: undefined }), chatMsg(), 'chat')?.targetAgent).toBeUndefined();
    expect(chatV2IntakeMessage(channel(), chatMsg({ senderType: 'agent' }), 'chat')).toBeNull();
  });

  it('intakeChatV2OwnerMessage returns a marked copy, or the message untouched', async () => {
    const t = ticket();
    const intake = { intakeWithOutcome: jest.fn(async (): Promise<IntakeOutcome> => ({ action: 'created', ticket: t })) };
    const marked = await intakeChatV2OwnerMessage(intake, channel(), chatMsg(), 'chat');
    expect(ticketLineOf(marked)).toContain('TKT-007');
    const agentRow = chatMsg({ senderType: 'agent' });
    expect(await intakeChatV2OwnerMessage(intake, channel(), agentRow, 'chat')).toBe(agentRow);
    expect(intake.intakeWithOutcome).toHaveBeenCalledTimes(1);
    const broken = { intakeWithOutcome: async (): Promise<IntakeOutcome> => { throw new Error('x'); } };
    const plain = chatMsg();
    expect(await intakeChatV2OwnerMessage(broken, channel(), plain, 'chat')).toBe(plain);
  });
});

describe('slackIntakeMessage', () => {
  const base = { text: 'fix the build please', slackChannelId: 'C1', ts: '2.0', userId: 'U1' };

  it('legacy bridge keeps the 2026-05-13 source-id shape and the SLA tag for the orc', () => {
    const top = slackIntakeMessage(base, 'legacy-bridge', { targetAgent: 'crewly-orc' });
    expect(top.origin.ref).toBe('slack-C1-2.0');
    expect(top.tags).toEqual(['slack']);
    const reply = slackIntakeMessage({ ...base, threadTs: '1.0' }, 'legacy-bridge');
    expect(reply.origin).toMatchObject({ ref: 'slack-C1-1.0-msg-2.0', threadRef: 'slack:C1:1.0' });
    expect(reply.legacyThreadParentRef).toBe('slack-C1-1.0');
    expect(reply.receipt).toEqual({ kind: 'slack', slackChannelId: 'C1', threadTs: '1.0' });
  });

  it('legacy bridge @agent route gets no SLA tag (the orc is not the one answering)', () => {
    expect(slackIntakeMessage(base, 'legacy-bridge', { targetAgent: 'dev-1' }).tags).toBeUndefined();
  });

  it('team channels and agent DMs use their own prefixes and channels', () => {
    const ch = slackIntakeMessage(base, 'team-channel', { targetAgent: 'dev-1', receiptPostAs: 'dev-1' });
    expect(ch).toMatchObject({ origin: { channel: 'slack-channel', ref: 'slackch-C1-2.0' }, targetAgent: 'dev-1', receipt: { postAs: 'dev-1' } });
    const dm = slackIntakeMessage({ ...base, slackChannelId: 'D1' }, 'agent-dm', { targetAgent: 'ella', receiptPostAs: 'ella' });
    expect(dm.origin).toMatchObject({ channel: 'slack-dm', ref: 'slackdm-D1-2.0' });
    expect(ch.tags).toBeUndefined();
  });

  it('only the owner files tickets: agents never, other people not when the owner is known', () => {
    expect(slackIntakeMessage({ ...base, authorAgentSession: 'atlas' }, 'team-channel').isOwner).toBe(false);
    expect(slackIntakeMessage({ ...base, ownerUserId: 'U-owner' }, 'team-channel').isOwner).toBe(false);
    expect(slackIntakeMessage({ ...base, userId: 'U-owner', ownerUserId: 'U-owner' }, 'team-channel').isOwner).toBe(true);
    expect(slackIntakeMessage({ ...base, ownerUserId: null }, 'team-channel').isOwner).toBe(true);
  });

  it('marks messages with files so file-only messages can be suppressed', () => {
    expect(slackIntakeMessage({ ...base, hasFiles: true }, 'agent-dm').attachments).toHaveLength(1);
  });
});
