/**
 * Tests for useCredentials hook — smoke tests with mocked service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useCredentials } from './useCredentials';

const mockList = vi.fn();
const mockAddApiKey = vi.fn();
const mockImportFromGeminiCli = vi.fn();
const mockClear = vi.fn();
const mockStartGoogleOAuth = vi.fn();
const mockCompleteGoogleOAuth = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

vi.mock('../services/credentials.service', () => ({
  credentialsService: {
    list: () => mockList(),
    addApiKey: (i: unknown) => mockAddApiKey(i),
    importFromGeminiCli: (i: unknown) => mockImportFromGeminiCli(i),
    clearGeminiCliExtensionFile: () => mockClear(),
    startGoogleOAuth: (i: unknown) => mockStartGoogleOAuth(i),
    completeGoogleOAuth: (i: unknown) => mockCompleteGoogleOAuth(i),
    update: (id: string, p: unknown) => mockUpdate(id, p),
    delete: (id: string) => mockDelete(id),
  },
}));

beforeEach(() => {
  mockList.mockReset();
  mockAddApiKey.mockReset();
  mockImportFromGeminiCli.mockReset();
  mockClear.mockReset();
  mockStartGoogleOAuth.mockReset();
  mockCompleteGoogleOAuth.mockReset();
  mockUpdate.mockReset();
  mockDelete.mockReset();
});

describe('useCredentials', () => {
  it('loads credentials on mount', async () => {
    mockList.mockResolvedValue([
      { id: 'c-1', name: 'one', type: 'api-key', provider: 'gemini', createdAt: '', updatedAt: '', status: 'active' },
    ]);

    const { result } = renderHook(() => useCredentials());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.credentials).toHaveLength(1);
    expect(result.current.error).toBe(null);
  });

  it('sets error state when list fails', async () => {
    mockList.mockRejectedValue(new Error('network'));

    const { result } = renderHook(() => useCredentials());
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.error).toBe('network');
  });

  it('refreshes credentials after addApiKey', async () => {
    mockList.mockResolvedValueOnce([]);
    mockAddApiKey.mockResolvedValue({ id: 'c-new', name: 'n', type: 'api-key', provider: 'gemini', createdAt: '', updatedAt: '', status: 'active' });
    mockList.mockResolvedValueOnce([
      { id: 'c-new', name: 'n', type: 'api-key', provider: 'gemini', createdAt: '', updatedAt: '', status: 'active' },
    ]);

    const { result } = renderHook(() => useCredentials());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.addApiKey({ name: 'n', provider: 'gemini', value: 'v' });
    });

    expect(mockAddApiKey).toHaveBeenCalled();
    expect(result.current.credentials).toHaveLength(1);
  });

  it('startGoogleOAuth passes input through without refresh', async () => {
    mockList.mockResolvedValue([]);
    mockStartGoogleOAuth.mockResolvedValue({ authUrl: 'https://accounts.google.com/?x' });

    const { result } = renderHook(() => useCredentials());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let res: { authUrl: string } | undefined;
    await act(async () => {
      res = await result.current.startGoogleOAuth({ scopes: ['openid'] });
    });

    expect(mockStartGoogleOAuth).toHaveBeenCalledWith({ scopes: ['openid'] });
    expect(res?.authUrl).toContain('accounts.google.com');
    // startGoogleOAuth must NOT trigger a list refresh (nothing changed yet)
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it('completeGoogleOAuth refreshes credentials after save', async () => {
    mockList.mockResolvedValueOnce([]);
    const newCred = {
      id: 'c-goog',
      name: 'info',
      type: 'google-oauth',
      provider: 'google',
      accountEmail: 'info@x.com',
      createdAt: '',
      updatedAt: '',
      status: 'active' as const,
    };
    mockCompleteGoogleOAuth.mockResolvedValue(newCred);
    mockList.mockResolvedValueOnce([newCred]);

    const { result } = renderHook(() => useCredentials());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.completeGoogleOAuth({
        name: 'info',
        credentialsJson: '{"access_token":"a","refresh_token":"b"}',
      });
    });

    expect(mockCompleteGoogleOAuth).toHaveBeenCalledWith({
      name: 'info',
      credentialsJson: '{"access_token":"a","refresh_token":"b"}',
    });
    expect(result.current.credentials).toHaveLength(1);
    expect(result.current.credentials[0]?.accountEmail).toBe('info@x.com');
  });

  it('propagates errors from completeGoogleOAuth without refreshing', async () => {
    mockList.mockResolvedValue([]);
    mockCompleteGoogleOAuth.mockRejectedValue(new Error('bad json'));

    const { result } = renderHook(() => useCredentials());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(
      act(async () => {
        await result.current.completeGoogleOAuth({
          name: 'x',
          credentialsJson: '{}',
        });
      }),
    ).rejects.toThrow('bad json');
    // Only the initial list call — no refresh after failure
    expect(mockList).toHaveBeenCalledTimes(1);
  });
});
