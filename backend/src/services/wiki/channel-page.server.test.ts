/**
 * Tests for the server-side channel page hooks.
 */

import type { Team } from '../../types/index.js';

const chat = {
  getChannelForBridge: jest.fn(),
  findRoomByNameForBridge: jest.fn(),
  listRoomsActiveSince: jest.fn(() => []),
  listRoomRows: jest.fn(() => []),
};
const pool = { addToPool: jest.fn(), findWorkItem: jest.fn() };

jest.mock('../chat-v2/chat-v2.singleton.js', () => ({ getChatV2Service: () => chat }));
jest.mock('../task-pool/task-pool.service.js', () => ({ TaskPoolService: { getInstance: () => pool } }));

import { findRoomByRef, sessionDisplayNames, startChannelPagesNightly, stopChannelPagesNightly } from './channel-page.server.js';

describe('channel-page.server', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    stopChannelPagesNightly();
  });

  it('sessionDisplayNames maps sessions to member names and survives unreadable teams', async () => {
    const teams = [{ members: [{ sessionName: 'flopost-pia-1', name: 'Pia' }, { sessionName: '', name: 'Nobody' }] }, { members: undefined }] as unknown as Team[];
    await expect(sessionDisplayNames({ getTeams: async () => teams })).resolves.toEqual(new Map([['flopost-pia-1', 'Pia']]));
    await expect(sessionDisplayNames({ getTeams: async () => { throw new Error('disk'); } })).resolves.toEqual(new Map());
  });

  it('findRoomByRef takes a live room id, else looks the name up', () => {
    chat.getChannelForBridge.mockReturnValueOnce({ id: 'room-1', name: '#necina', type: 'huddle', archivedAt: null });
    expect(findRoomByRef('room-1')).toEqual({ id: 'room-1', name: '#necina' });

    chat.getChannelForBridge.mockReturnValueOnce(null);
    chat.findRoomByNameForBridge.mockReturnValueOnce({ id: 'room-1', name: '#necina', type: 'huddle' });
    expect(findRoomByRef('#necina')).toEqual({ id: 'room-1', name: '#necina' });
    expect(chat.findRoomByNameForBridge).toHaveBeenCalledWith('#necina');

    // A DM id is not a room.
    chat.getChannelForBridge.mockReturnValueOnce({ id: 'dm-1', name: 'Pia', type: 'dm' });
    chat.findRoomByNameForBridge.mockReturnValueOnce(null);
    expect(findRoomByRef('dm-1')).toBeNull();
    expect(findRoomByRef('')).toBeNull();
  });

  it('starts one nightly pass per process', async () => {
    const storage = { getTeams: async () => [] as Team[] };
    const first = await startChannelPagesNightly(storage);
    expect(await startChannelPagesNightly(storage)).toBe(first);
    stopChannelPagesNightly();
    expect(await startChannelPagesNightly(storage)).not.toBe(first);
  });
});
