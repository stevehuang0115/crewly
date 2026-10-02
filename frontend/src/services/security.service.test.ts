/**
 * Tests for the security service client.
 *
 * @module services/security.service.test
 */

import axios from 'axios';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { securityService, SECURITY_API } from './security.service';

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, get: vi.fn() } };
});

const get = vi.mocked(axios.get);

describe('securityService.approvals', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the activity for the window', async () => {
    get.mockResolvedValue({ data: { success: true, data: { days: 30, items: [] } } });
    await expect(securityService.approvals(30)).resolves.toEqual({ days: 30, items: [] });
    expect(get).toHaveBeenCalledWith(SECURITY_API.APPROVALS, { params: { days: 30 } });
  });

  it('surfaces the server error', async () => {
    get.mockResolvedValue({ data: { success: false, error: 'nope' } });
    await expect(securityService.approvals(7)).rejects.toThrow('nope');
  });
});
