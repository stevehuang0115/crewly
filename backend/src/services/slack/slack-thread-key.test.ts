/**
 * Tests for the Slack thread key helpers (`[SLACK-THREAD:<channel>:<ts>]`).
 */

import {
  extractSlackThreadKeys,
  formatSlackThreadKey,
  parseSlackThreadKey,
  slackThreadOfMetadata,
  slackThreadTag,
} from './slack-thread-key.js';

describe('slack-thread-key', () => {
  it('formats and parses a key round-trip', () => {
    const key = formatSlackThreadKey('D0C31U6JWBF', '1790392986.498639');
    expect(key).toBe('D0C31U6JWBF:1790392986.498639');
    expect(parseSlackThreadKey(key)).toEqual({ slackChannelId: 'D0C31U6JWBF', threadTs: '1790392986.498639' });
  });

  it('accepts the whole tag, as an agent may copy it with its brackets', () => {
    expect(parseSlackThreadKey('[SLACK-THREAD:C0ABC123:1790000000.000100]')).toEqual({
      slackChannelId: 'C0ABC123',
      threadTs: '1790000000.000100',
    });
    expect(parseSlackThreadKey('  G0PRIV1:1790000000.1 ')).toEqual({ slackChannelId: 'G0PRIV1', threadTs: '1790000000.1' });
  });

  it('rejects anything that is not a key — chat-v2 ids, bare ts, junk', () => {
    expect(parseSlackThreadKey('45afdab8-1282-4d9b-a418-75979b241e9f')).toBeNull();
    expect(parseSlackThreadKey('1790392986.498639')).toBeNull();
    expect(parseSlackThreadKey('D0C31U6JWBF')).toBeNull();
    expect(parseSlackThreadKey('X0ABC:1790000000.1')).toBeNull();
    expect(parseSlackThreadKey('d0abc:1790000000.1')).toBeNull();
    expect(parseSlackThreadKey(undefined)).toBeNull();
    expect(parseSlackThreadKey(42)).toBeNull();
    expect(parseSlackThreadKey('')).toBeNull();
  });

  it('renders the tag the agent sees', () => {
    expect(slackThreadTag('D0C31U6JWBF', '1790392986.498639')).toBe('[SLACK-THREAD:D0C31U6JWBF:1790392986.498639]');
  });

  it('extracts every distinct valid tag from a text, in order', () => {
    const text = [
      '[CHAT:chat-ella] <Steve@Ella>',
      '[SLACK-THREAD:D0C31U6JWBF:1790000500.000200]',
      'earlier: [SLACK-THREAD:D0C31U6JWBF:1790000000.000100] and again [SLACK-THREAD:D0C31U6JWBF:1790000500.000200]',
      '[SLACK-THREAD:not-a-key] [SLACK:C1:1.2]',
    ].join('\n');
    expect(extractSlackThreadKeys(text)).toEqual([
      { slackChannelId: 'D0C31U6JWBF', threadTs: '1790000500.000200' },
      { slackChannelId: 'D0C31U6JWBF', threadTs: '1790000000.000100' },
    ]);
    expect(extractSlackThreadKeys('no tags here')).toEqual([]);
  });

  describe('slackThreadOfMetadata', () => {
    it('prefers the agent-reply key over the inbound correlation fields', () => {
      expect(
        slackThreadOfMetadata({ slackThreadKey: 'D1ABC:1790000000.000100', slackChannelId: 'D1ABC', slackThreadTs: '1790000500.000200' }),
      ).toEqual({ slackChannelId: 'D1ABC', threadTs: '1790000000.000100' });
    });

    it('reads a bridged Slack turn', () => {
      expect(slackThreadOfMetadata({ source: 'slack', slackChannelId: 'D1ABC', slackThreadTs: '1.2' })).toEqual({
        slackChannelId: 'D1ABC',
        threadTs: '1.2',
      });
    });

    it('is null when nothing names a thread', () => {
      expect(slackThreadOfMetadata(undefined)).toBeNull();
      expect(slackThreadOfMetadata({ source: 'reply-tool' })).toBeNull();
      expect(slackThreadOfMetadata({ slackChannelId: 'D1ABC' })).toBeNull();
    });
  });
});
