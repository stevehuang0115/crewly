/**
 * Tests for the people service (issue #968).
 *
 * @module services/people.service.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { PeopleApiError, canonicalPersonId, cloudSupportsSharing, peopleService, personName, PEOPLE_API, type Person } from './people.service';

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    ...actual,
    default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
    isAxiosError: actual.isAxiosError,
  };
});

const mocked = vi.mocked(axios);

describe('peopleService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists, edits and removes people', async () => {
    mocked.get.mockResolvedValue({ data: { success: true, data: { people: [], ownerId: 'owner' } } });
    await expect(peopleService.list()).resolves.toEqual({ people: [], ownerId: 'owner' });
    expect(mocked.get).toHaveBeenCalledWith(PEOPLE_API.LIST);
    mocked.put.mockResolvedValue({ data: { success: true, data: { id: 'U1', role: 'guest' } } });
    await peopleService.upsert('U1', { role: 'guest' });
    expect(mocked.put).toHaveBeenCalledWith('/api/people/U1', { role: 'guest' });
    mocked.delete.mockResolvedValue({ data: { success: true, data: { removed: true } } });
    await peopleService.remove('U1');
    expect(mocked.delete).toHaveBeenCalledWith('/api/people/U1');
  });

  it('posts sharing changes to the connector and surfaces the server message', async () => {
    mocked.post.mockResolvedValue({ data: { success: true, data: { authorizedBy: 'U1', sharing: { mode: 'members' } } } });
    await peopleService.setGrantSharing('google-workspace', { email: 'a@x.com', sharing: { mode: 'members' } });
    expect(mocked.post).toHaveBeenCalledWith('/api/google/sharing', { email: 'a@x.com', sharing: { mode: 'members' } });
    await peopleService.setGrantSharing('microsoft-todo', { authorizedBy: 'U1' });
    expect(mocked.post).toHaveBeenLastCalledWith('/api/microsoft-todo/sharing', { authorizedBy: 'U1' });

    mocked.post.mockRejectedValue(Object.assign(new Error('x'), { isAxiosError: true, response: { data: { success: false, error: 'owner_only', message: 'Only the owner can change it.' } } }));
    await expect(peopleService.setGrantSharing('canva', { sharing: { mode: 'owner' } })).rejects.toThrow('Only the owner can change it.');

    // An older Cloud: the error code comes through.
    mocked.post.mockRejectedValue(Object.assign(new Error('x'), { isAxiosError: true, response: { data: { success: false, error: 'cloud_update_required', message: 'Requires a Cloud update' } } }));
    const err = await peopleService.setGrantSharing('canva', { sharing: { mode: 'owner' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PeopleApiError);
    expect(err).toMatchObject({ code: 'cloud_update_required', message: 'Requires a Cloud update' });
  });

  it('tells an older Cloud (no owner/sharing in the status) apart', () => {
    expect(cloudSupportsSharing({})).toBe(false);
    expect(cloudSupportsSharing({ authorizedBy: 'owner' })).toBe(true);
    expect(cloudSupportsSharing({ sharing: { mode: 'owner' } })).toBe(true);
  });

  it("maps the owner's Slack ids to the owner", () => {
    const people: Person[] = [{ id: 'owner', name: 'Ina', role: 'owner', source: 'owner', slackUserIds: ['UOWN1'], createdAt: '', updatedAt: '' }];
    expect(canonicalPersonId('UOWN1', people)).toBe('owner');
    expect(canonicalPersonId('UINFO', people)).toBe('UINFO');
    expect(personName('UOWN1', people)).toBe('Ina');
  });

  it('names people', () => {
    const people: Person[] = [
      { id: 'UOWN', name: 'Ina', role: 'owner', source: 'owner', createdAt: '', updatedAt: '' },
      { id: 'UINFO', name: 'Info', role: 'member', source: 'auto', createdAt: '', updatedAt: '' },
    ];
    expect(personName('UINFO', people)).toBe('Info');
    expect(personName('owner', people)).toBe('Ina');
    expect(personName(undefined, [])).toBe('Owner');
    expect(personName('UNKNOWN', people)).toBe('UNKNOWN');
  });
});
