/**
 * In-memory mock client used when `ChatAPIProvider mode="mock"` is set.
 *
 * Purpose: lets us iterate on UI / Storybook / demo before Sam's backend
 * is live. Emits WS frames on a small timer so presence + agent-reply
 * flows feel real enough to catch UX bugs.
 *
 * Mock honors the same Week-2 contract the HTTP client implements:
 *  - sendMessage emits an optimistic `pending` event before the
 *    "persistence" delay, then a `sent` event with the same
 *    clientMessageId so reconciliation paths exercise.
 *  - Agent replies arrive on the same channel subscription with
 *    `senderType=agent`.
 *
 * @module api/mock-client
 */

import type {
  ChatApiClient,
  ChannelSubscription,
} from './client';
import type {
  Channel,
  CreateChannelInput,
  Message,
  MessagePage,
  SendMessageInput,
  AgentPresence,
  ChatWebsocketEvent,
} from '../types/chat.types';

const MOCK_USER_ID = 'demo-user';
const MOCK_USER_NAME = 'Steve';
const DEFAULT_AGENT_REPLY_MS = 800;

/**
 * Options for `MockChatApiClient`. Exposed so demo/storybook can pre-seed
 * channels + messages to exercise empty/populated states.
 */
export interface MockClientOptions {
  initialChannels?: Channel[];
  initialMessages?: Record<string, Message[]>;
  agentReplyDelayMs?: number;
}

/** Increment-only id generator scoped to a mock client instance. */
const makeIdFactory = () => {
  let n = 1;
  return (prefix: string) => `${prefix}-${n++}`;
};

export class MockChatApiClient implements ChatApiClient {
  private channels: Channel[];
  private messages: Record<string, Message[]>;
  private subscribers: Record<string, Array<(e: ChatWebsocketEvent) => void>> = {};
  private readonly replyDelay: number;
  private readonly nextId = makeIdFactory();

  constructor(opts: MockClientOptions = {}) {
    this.channels = opts.initialChannels ?? seedChannels();
    this.messages = opts.initialMessages ?? seedMessages(this.channels);
    this.replyDelay = opts.agentReplyDelayMs ?? DEFAULT_AGENT_REPLY_MS;
  }

  async listChannels(): Promise<Channel[]> {
    return [...this.channels];
  }

  async createChannel(input: CreateChannelInput): Promise<Channel> {
    const ch: Channel = {
      id: this.nextId('ch'),
      agentSession: input.agentSession,
      name: input.name,
      purpose: input.purpose,
      createdAt: new Date().toISOString(),
      presence: 'online',
    };
    this.channels = [...this.channels, ch];
    this.messages[ch.id] = [];
    return ch;
  }

  async listMessages(
    channelId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<MessagePage> {
    const all = this.messages[channelId] ?? [];
    const limit = opts.limit ?? 50;
    // Simplified pagination — returns the most recent `limit` messages.
    const messages = all.slice(-limit);
    return { messages, nextCursor: all.length > limit ? 'mock-older' : null };
  }

  async sendMessage(channelId: string, input: SendMessageInput): Promise<Message> {
    const channel = this.channels.find((c) => c.id === channelId);
    if (!channel) throw new Error(`Unknown channel: ${channelId}`);

    const clientMessageId = input.clientMessageId ?? this.nextId('cmid');

    // 1. Optimistic pending — fire before "persistence" so subscribers see
    //    the same lifecycle the HTTP client produces.
    const pending: Message = {
      id: clientMessageId,
      channelId,
      seq: -1,
      author: { role: 'user', id: MOCK_USER_ID, name: MOCK_USER_NAME },
      content: input.content,
      attachments: input.attachments,
      createdAt: new Date().toISOString(),
      clientMessageId,
      deliveryStatus: 'pending',
    };
    this.emit(channelId, { type: 'message', channelId, message: pending });

    // 2. Persistence + confirmation event.
    const confirmed: Message = {
      id: this.nextId('m'),
      channelId,
      seq: (this.messages[channelId]?.length ?? 0) + 1,
      author: { role: 'user', id: MOCK_USER_ID, name: MOCK_USER_NAME },
      content: input.content,
      attachments: input.attachments,
      createdAt: pending.createdAt,
      clientMessageId,
      deliveryStatus: 'sent',
    };
    (this.messages[channelId] ||= []).push(confirmed);
    this.emit(channelId, { type: 'message', channelId, message: confirmed });

    // 3. Fake agent reply — tightens the feedback loop while no backend is up.
    window.setTimeout(() => {
      const reply: Message = {
        id: this.nextId('m'),
        channelId,
        seq: (this.messages[channelId]?.length ?? 0) + 1,
        author: { role: 'agent', id: channel.agentSession, name: channel.name },
        content: `(mock reply) you said: "${input.content}"`,
        createdAt: new Date().toISOString(),
        deliveryStatus: 'sent',
      };
      (this.messages[channelId] ||= []).push(reply);
      this.emit(channelId, { type: 'message', channelId, message: reply });
    }, this.replyDelay);

    return confirmed;
  }

  async getAgentPresence(agentId: string): Promise<AgentPresence> {
    const ch = this.channels.find((c) => c.agentSession === agentId);
    return {
      agentId,
      status: ch?.presence ?? 'offline',
      lastSeen: new Date().toISOString(),
    };
  }

  subscribeToChannel(
    channelId: string,
    onEvent: (event: ChatWebsocketEvent) => void,
  ): ChannelSubscription {
    (this.subscribers[channelId] ||= []).push(onEvent);
    return {
      unsubscribe: () => {
        const list = this.subscribers[channelId];
        if (!list) return;
        this.subscribers[channelId] = list.filter((cb) => cb !== onEvent);
      },
    };
  }

  private emit(channelId: string, event: ChatWebsocketEvent): void {
    const list = this.subscribers[channelId];
    if (!list) return;
    for (const cb of list) {
      try {
        cb(event);
      } catch {
        // A subscriber crashing must not stop the others.
      }
    }
  }
}

// ---- seeds ---------------------------------------------------------------

function seedChannels(): Channel[] {
  const now = new Date().toISOString();
  return [
    {
      id: 'ch-ella',
      agentSession: 'crewly-marketing-ella',
      name: 'Ella · Marketing',
      purpose: 'Marketing strategy + content planning',
      createdAt: now,
      lastMessageAt: now,
      presence: 'online',
    },
    {
      id: 'ch-sam',
      agentSession: 'crewly-product-sam',
      name: 'Sam · Engineering',
      purpose: 'Platform architecture + delivery',
      createdAt: now,
      lastMessageAt: now,
      presence: 'busy',
    },
    {
      id: 'ch-offline',
      agentSession: 'crewly-offline-demo',
      name: 'Dormant Agent',
      purpose: 'Shows the offline state',
      createdAt: now,
      presence: 'offline',
    },
  ];
}

function seedMessages(channels: Channel[]): Record<string, Message[]> {
  const out: Record<string, Message[]> = {};
  for (const ch of channels) {
    out[ch.id] = [
      {
        id: `${ch.id}-welcome`,
        channelId: ch.id,
        seq: 1,
        author: { role: 'agent', id: ch.agentSession, name: ch.name },
        content: `Welcome — I'm **${ch.name.split('·')[0]?.trim() ?? ch.name}**. Ask me anything.`,
        createdAt: ch.createdAt,
      },
    ];
  }
  return out;
}
