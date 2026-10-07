/**
 * Tests for the Crewly channels API client.
 *
 * @module services/channels.service.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { CHANNELS_API, channelsService } from './channels.service';

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    ...actual,
    default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    isAxiosError: actual.isAxiosError,
  };
});

const mocked = vi.mocked(axios);
const CH = { id: 'huddle-1', name: 'tech-brief', origin: 'crewly', createdAt: 'now', slack: null, members: [] };

describe('channelsService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists and creates channels', async () => {
    mocked.get.mockResolvedValue({ data: { success: true, data: { channels: [CH] } } });
    await expect(channelsService.list()).resolves.toEqual([CH]);
    expect(mocked.get).toHaveBeenCalledWith(CHANNELS_API.LIST);
    mocked.post.mockResolvedValue({ data: { success: true, data: CH } });
    await channelsService.create({ name: 'Tech Brief', memberSessions: ['a', 'b'] });
    expect(mocked.post).toHaveBeenCalledWith('/api/channels', { name: 'Tech Brief', memberSessions: ['a', 'b'] });
  });

  it('renames, changes members and archives by id', async () => {
    mocked.patch.mockResolvedValue({ data: { success: true, data: CH } });
    await channelsService.rename('huddle-1', 'x');
    expect(mocked.patch).toHaveBeenCalledWith('/api/channels/huddle-1', { name: 'x' });
    mocked.post.mockResolvedValue({ data: { success: true, data: { channel: CH, change: {} } } });
    await expect(channelsService.addMember('huddle-1', 'eng-atlas')).resolves.toEqual(CH);
    expect(mocked.post).toHaveBeenCalledWith('/api/channels/huddle-1/members', { sessionName: 'eng-atlas' });
    mocked.delete.mockResolvedValue({ data: { success: true, data: { channel: CH, change: {} } } });
    await channelsService.removeMember('huddle-1', 'eng-atlas');
    expect(mocked.delete).toHaveBeenCalledWith('/api/channels/huddle-1/members/eng-atlas');
    mocked.post.mockResolvedValue({ data: { success: true, data: CH } });
    await channelsService.archive('huddle-1');
    expect(mocked.post).toHaveBeenCalledWith('/api/channels/huddle-1/archive');
  });

  it("surfaces the server's message", async () => {
    const err = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { data: { success: false, error: 'conflict', message: '#tech-brief already exists' } },
    });
    mocked.post.mockRejectedValue(err);
    await expect(channelsService.create({ name: 'tech-brief', memberSessions: ['a'] })).rejects.toThrow('#tech-brief already exists');
  });
});
