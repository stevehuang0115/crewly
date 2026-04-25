/**
 * Unit test for the chat-v2 realtime-deps holder.
 *
 * @module services/chat-v2/chat-v2.realtime-holder.test
 */

import {
  getChatV2RealtimeDeps,
  setChatV2RealtimeDeps,
} from './chat-v2.realtime-holder.js';

describe('chat-v2 realtime-deps holder', () => {
  afterEach(() => setChatV2RealtimeDeps(null));

  it('returns an empty object when unset', () => {
    expect(getChatV2RealtimeDeps()).toEqual({});
  });

  it('round-trips the dep object', () => {
    const fakeGateway = { broadcast: () => {} } as unknown as import('../../websocket/chat-v2.gateway.js').ChatV2Gateway;
    const fakeDispatcher = { dispatchToAgent: () => Promise.resolve({ dispatched: true }) } as unknown as import('./chat-v2.dispatcher.service.js').ChatV2DispatcherService;
    setChatV2RealtimeDeps({ gateway: fakeGateway, dispatcher: fakeDispatcher });
    const deps = getChatV2RealtimeDeps();
    expect(deps.gateway).toBe(fakeGateway);
    expect(deps.dispatcher).toBe(fakeDispatcher);
  });

  it('clears to {} on setChatV2RealtimeDeps(null)', () => {
    setChatV2RealtimeDeps({ gateway: {} as unknown as import('../../websocket/chat-v2.gateway.js').ChatV2Gateway });
    setChatV2RealtimeDeps(null);
    expect(getChatV2RealtimeDeps()).toEqual({});
  });
});
