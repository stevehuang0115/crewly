/**
 * Tests for the ChatV2Service singleton.
 *
 * @module services/chat-v2/chat-v2.singleton.test
 */

import {
  getChatV2Service,
  resetChatV2Service,
  setChatV2ServiceForTesting,
} from './chat-v2.singleton.js';
import { ChatV2Service } from './chat-v2.service.js';
import { openChatDatabase } from './sqlite/chat-db.js';
import { loadChatV2Config } from './config.js';

describe('chat-v2 singleton', () => {
  afterEach(() => {
    resetChatV2Service();
  });

  it('returns the same instance on repeated calls', () => {
    const db = openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true });
    const inst = new ChatV2Service({ config: loadChatV2Config({}), db });
    setChatV2ServiceForTesting(inst);
    expect(getChatV2Service()).toBe(inst);
    expect(getChatV2Service()).toBe(inst);
  });

  it('constructs a new instance when no override is set', () => {
    const db = openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true });
    const first = getChatV2Service({ config: loadChatV2Config({}), db });
    const second = getChatV2Service();
    expect(second).toBe(first);
  });

  it('resetChatV2Service closes and clears', () => {
    const db = openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true });
    const inst = new ChatV2Service({ config: loadChatV2Config({}), db });
    const closeSpy = jest.spyOn(inst, 'close');
    setChatV2ServiceForTesting(inst);
    resetChatV2Service();
    expect(closeSpy).toHaveBeenCalled();
    // After reset, calling getChatV2Service makes a new instance.
    const next = getChatV2Service();
    expect(next).not.toBe(inst);
  });

  it('forwards validateTeamMembership override on first construction (F2b #333)', () => {
    // The composition root in api.routes.ts wires the OSS validator via
    // getChatV2Service({ validateTeamMembership: ... }) on the first
    // call. Verify the override actually reaches the constructed
    // service, otherwise the leak guard silently drops to back-compat.
    const db = openChatDatabase({
      dbPath: ':memory:',
      inMemory: true,
      skipIntegrityCheck: true,
    });
    const validator = jest.fn(() => false);
    const inst = getChatV2Service({
      config: loadChatV2Config({}),
      db,
      validateTeamMembership: validator,
    });
    // Probe through createChannel — wired validator returning false
    // must throw forbidden_team for type='channel'. If the override
    // wasn't forwarded, the back-compat path would persist the row.
    expect(() =>
      inst.createChannel({
        name: '#x',
        type: 'channel',
        teamId: 'team-foreign',
        principal: { userId: 'u', source: 'oss' },
      }),
    ).toThrow(/forbidden|tenant|member/i);
    expect(validator).toHaveBeenCalledTimes(1);
  });
});
