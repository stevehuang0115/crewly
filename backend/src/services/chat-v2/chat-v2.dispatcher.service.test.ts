/**
 * Unit tests for ChatV2DispatcherService.
 *
 * @module services/chat-v2/chat-v2.dispatcher.service.test
 */

import {
  ChatV2DispatcherService,
  defaultFormatPrompt,
  type AgentMessageSink,
} from './chat-v2.dispatcher.service.js';
import type { ChatChannelDTO, ChatMessageDTO } from './types.js';

function makeChannel(overrides: Partial<ChatChannelDTO> = {}): ChatChannelDTO {
  return {
    id: 'chan-1',
    agentSession: 'crewly-product-sam-dd2b46f7',
    name: 'Chat with Sam',
    createdAt: 0,
    agentPresence: { status: 'online', lastSeenAt: null },
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ChatMessageDTO> = {}): ChatMessageDTO {
  return {
    id: 'msg-1',
    channelId: 'chan-1',
    seq: 1,
    senderType: 'user',
    senderId: 'user-abc',
    content: 'hello there',
    contentType: 'markdown',
    createdAt: 0,
    attachments: [],
    metadata: { clientMessageId: 'cmid-xyz' },
    ...overrides,
  };
}

/** Collector sink that records all calls. */
function makeSink(response: Awaited<ReturnType<AgentMessageSink['sendMessageToAgent']>>) {
  const calls: Array<{ sessionName: string; message: string }> = [];
  const sink: AgentMessageSink = {
    async sendMessageToAgent(sessionName, message) {
      calls.push({ sessionName, message });
      return response;
    },
  };
  return { sink, calls };
}

describe('ChatV2DispatcherService', () => {
  describe('defaultFormatPrompt', () => {
    it('includes the [CHAT:<id>] tag, author, and reply instruction', () => {
      const prompt = defaultFormatPrompt({
        channelId: 'chan-1',
        channelName: 'Chat with Sam',
        agentSession: 'crewly-product-sam-xyz',
        senderId: 'steve',
        content: '  hi, sam  ',
      });
      expect(prompt).toContain('[CHAT:chan-1]');
      expect(prompt).toContain('<steve@Chat with Sam>');
      // trim() stripped the leading/trailing whitespace
      expect(prompt).toContain('\nhi, sam\n');
      expect(prompt).toContain('`reply-channel`');
      expect(prompt).toContain('channelId="chan-1"');
    });

    it('appends [cmid:...] when clientMessageId is present', () => {
      const prompt = defaultFormatPrompt({
        channelId: 'chan-1',
        channelName: 'n',
        agentSession: 's',
        senderId: 'u',
        content: 'x',
        clientMessageId: 'cmid-zzz',
      });
      expect(prompt).toContain('[cmid:cmid-zzz]');
    });

    it('omits [cmid:...] when clientMessageId is missing', () => {
      const prompt = defaultFormatPrompt({
        channelId: 'chan-1',
        channelName: 'n',
        agentSession: 's',
        senderId: 'u',
        content: 'x',
      });
      expect(prompt).not.toContain('[cmid:');
    });
  });

  describe('dispatchToAgent', () => {
    it('calls sendMessageToAgent with the bound session and formatted prompt', async () => {
      const { sink, calls } = makeSink({ success: true });
      const dispatcher = new ChatV2DispatcherService({ agentSink: sink });

      const result = await dispatcher.dispatchToAgent(makeChannel(), makeMessage());

      expect(result.dispatched).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].sessionName).toBe('crewly-product-sam-dd2b46f7');
      expect(calls[0].message).toContain('[CHAT:chan-1]');
      expect(calls[0].message).toContain('hello there');
      expect(calls[0].message).toContain('[cmid:cmid-xyz]');
    });

    it('is a no-op for agent-origin messages (prevents loopback)', async () => {
      const { sink, calls } = makeSink({ success: true });
      const dispatcher = new ChatV2DispatcherService({ agentSink: sink });

      const result = await dispatcher.dispatchToAgent(
        makeChannel(),
        makeMessage({ senderType: 'agent', senderId: 'crewly-product-sam-xyz' }),
      );

      expect(result.dispatched).toBe(false);
      expect(result.error).toMatch(/not a user-origin/);
      expect(calls).toHaveLength(0);
    });

    it('is a no-op when the channel has no bound agent session', async () => {
      const { sink, calls } = makeSink({ success: true });
      const dispatcher = new ChatV2DispatcherService({ agentSink: sink });

      const result = await dispatcher.dispatchToAgent(
        makeChannel({ agentSession: '' }),
        makeMessage(),
      );
      expect(result.dispatched).toBe(false);
      expect(calls).toHaveLength(0);
    });

    it('propagates sink failure as a non-dispatched result', async () => {
      const { sink } = makeSink({ success: false, error: 'no such session' });
      const dispatcher = new ChatV2DispatcherService({ agentSink: sink });

      const result = await dispatcher.dispatchToAgent(makeChannel(), makeMessage());
      expect(result).toEqual({ dispatched: false, error: 'no such session' });
    });

    it('treats thrown errors as a clean, reportable failure', async () => {
      const sink: AgentMessageSink = {
        async sendMessageToAgent() {
          throw new Error('PTY crashed');
        },
      };
      const dispatcher = new ChatV2DispatcherService({ agentSink: sink });
      const result = await dispatcher.dispatchToAgent(makeChannel(), makeMessage());
      expect(result).toEqual({ dispatched: false, error: 'PTY crashed' });
    });

    it('allows formatPrompt override for future customization', async () => {
      const { sink, calls } = makeSink({ success: true });
      const dispatcher = new ChatV2DispatcherService({
        agentSink: sink,
        formatPrompt: ({ content }) => `CUSTOM::${content}`,
      });
      await dispatcher.dispatchToAgent(makeChannel(), makeMessage());
      expect(calls[0].message).toBe('CUSTOM::hello there');
    });

    it('handles missing metadata.clientMessageId gracefully', async () => {
      const { sink, calls } = makeSink({ success: true });
      const dispatcher = new ChatV2DispatcherService({ agentSink: sink });
      await dispatcher.dispatchToAgent(
        makeChannel(),
        makeMessage({ metadata: undefined }),
      );
      expect(calls[0].message).not.toContain('[cmid:');
    });
  });
});
