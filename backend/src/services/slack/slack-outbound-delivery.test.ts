import { awaitSlackDelivery, resetSlackDeliveryTracker, trackSlackDelivery } from './slack-outbound-delivery.js';

describe('slack-outbound-delivery', () => {
  beforeEach(() => resetSlackDeliveryTracker());

  it('returns null for a message with no registered mirror', async () => {
    expect(await awaitSlackDelivery('nope')).toBeNull();
  });

  it('returns the delivery and forgets the attempt', async () => {
    trackSlackDelivery('m1', Promise.resolve({ delivered: true, slackChannelId: 'C1', ts: '1.0' }));
    expect(await awaitSlackDelivery('m1')).toEqual({ delivered: true, slackChannelId: 'C1', ts: '1.0' });
    expect(await awaitSlackDelivery('m1')).toBeNull();
  });

  it('gives up waiting after the timeout: unknown, not failed', async () => {
    trackSlackDelivery('slow', new Promise(() => undefined));
    expect(await awaitSlackDelivery('slow', 10)).toBeNull();
  });

  it('combines several mirrors of one message: any failure wins, then any delivery, else null', async () => {
    trackSlackDelivery('a', Promise.resolve({ delivered: false, slackChannelId: 'C1', error: 'channel_not_found' }));
    trackSlackDelivery('a', Promise.resolve(null));
    expect(await awaitSlackDelivery('a')).toMatchObject({ delivered: false, error: 'channel_not_found' });
    trackSlackDelivery('b', Promise.resolve(null));
    trackSlackDelivery('b', Promise.resolve({ delivered: true, slackChannelId: 'C1', ts: '1.0' }));
    expect(await awaitSlackDelivery('b')).toMatchObject({ delivered: true });
    trackSlackDelivery('c', Promise.resolve(null));
    trackSlackDelivery('c', Promise.resolve(null));
    expect(await awaitSlackDelivery('c')).toBeNull();
  });
});
