/**
 * Tests for credentials.service — API client smoke tests with mocked axios.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { credentialsService } from './credentials.service';
import { CredentialSummary, GMAIL_ONLY_SCOPES } from '../types/credential.types';

vi.mock('axios');
const mockedAxios = axios as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  isAxiosError: (v: unknown) => boolean;
};

function makeCred(overrides: Partial<CredentialSummary> = {}): CredentialSummary {
  return {
    id: 'cred-1',
    name: 'test',
    type: 'api-key',
    provider: 'gemini',
    createdAt: '2026-04-23T00:00:00Z',
    updatedAt: '2026-04-23T00:00:00Z',
    status: 'active',
    ...overrides,
  };
}

beforeEach(() => {
  mockedAxios.get = vi.fn();
  mockedAxios.post = vi.fn();
  mockedAxios.patch = vi.fn();
  mockedAxios.delete = vi.fn();
  // Default: nothing is an axios error unless a test overrides
  mockedAxios.isAxiosError = vi.fn(() => false);
});

describe('credentialsService', () => {
  it('list() returns the data array', async () => {
    mockedAxios.get.mockResolvedValue({
      data: { success: true, data: [makeCred()] },
    });
    const result = await credentialsService.list();
    expect(result).toHaveLength(1);
    expect(mockedAxios.get).toHaveBeenCalledWith('/api/credentials');
  });

  it('list() throws when success=false', async () => {
    mockedAxios.get.mockResolvedValue({
      data: { success: false, error: 'boom' },
    });
    await expect(credentialsService.list()).rejects.toThrow('boom');
  });

  it('addApiKey() posts to /api-key endpoint', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { success: true, data: makeCred({ name: 'new-key' }) },
    });
    const result = await credentialsService.addApiKey({
      name: 'new-key',
      provider: 'gemini',
      value: 'secret-v',
    });
    expect(result.name).toBe('new-key');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      '/api/credentials/api-key',
      { name: 'new-key', provider: 'gemini', value: 'secret-v' },
    );
  });

  it('importFromGeminiCli() posts to the oauth import endpoint', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { success: true, data: makeCred({ type: 'google-oauth', provider: 'google' }) },
    });
    await credentialsService.importFromGeminiCli({ name: 'info' });
    expect(mockedAxios.post).toHaveBeenCalledWith(
      '/api/credentials/oauth/import-gemini-cli',
      { name: 'info' },
    );
  });

  it('delete() calls DELETE /:id', async () => {
    mockedAxios.delete.mockResolvedValue({ data: { success: true } });
    await credentialsService.delete('cred-1');
    expect(mockedAxios.delete).toHaveBeenCalledWith('/api/credentials/cred-1');
  });

  it('update() sends PATCH with body', async () => {
    mockedAxios.patch.mockResolvedValue({
      data: { success: true, data: makeCred({ name: 'renamed' }) },
    });
    const result = await credentialsService.update('cred-1', { name: 'renamed' });
    expect(result.name).toBe('renamed');
    expect(mockedAxios.patch).toHaveBeenCalledWith(
      '/api/credentials/cred-1',
      { name: 'renamed' },
    );
  });

  it('clearGeminiCliExtensionFile() posts to the clear endpoint', async () => {
    mockedAxios.post.mockResolvedValue({ data: { success: true } });
    await credentialsService.clearGeminiCliExtensionFile();
    expect(mockedAxios.post).toHaveBeenCalledWith(
      '/api/credentials/oauth/gemini-cli/clear-extension-file',
    );
  });

  // ==========================================================================
  // Headless Google OAuth
  // ==========================================================================

  describe('startGoogleOAuth()', () => {
    it('posts an empty body when no scopes provided (backend uses default)', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { success: true, data: { authUrl: 'https://accounts.google.com/?x=1' } },
      });
      const result = await credentialsService.startGoogleOAuth();
      expect(result.authUrl).toMatch(/^https:\/\/accounts\.google\.com/);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        '/api/credentials/oauth/google/start',
        {},
      );
    });

    it('forwards the scopes array when provided', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { success: true, data: { authUrl: 'https://accounts.google.com/?x=2' } },
      });
      await credentialsService.startGoogleOAuth({ scopes: [...GMAIL_ONLY_SCOPES] });
      expect(mockedAxios.post).toHaveBeenCalledWith(
        '/api/credentials/oauth/google/start',
        { scopes: [...GMAIL_ONLY_SCOPES] },
      );
    });

    it('omits empty scopes arrays so backend falls back to default', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { success: true, data: { authUrl: 'https://accounts.google.com/?x=3' } },
      });
      await credentialsService.startGoogleOAuth({ scopes: [] });
      expect(mockedAxios.post).toHaveBeenCalledWith(
        '/api/credentials/oauth/google/start',
        {},
      );
    });

    it('throws with backend error message on success=false', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { success: false, error: 'scope list invalid' },
      });
      await expect(credentialsService.startGoogleOAuth()).rejects.toThrow(
        'scope list invalid',
      );
    });

    it('unwraps backend error when axios rejects on 4xx/5xx', async () => {
      const axiosErr = {
        isAxiosError: true,
        message: 'Request failed with status code 500',
        response: { data: { success: false, error: 'upstream bad' } },
      };
      mockedAxios.post.mockRejectedValue(axiosErr);
      mockedAxios.isAxiosError = vi.fn((v) => v === axiosErr);
      await expect(credentialsService.startGoogleOAuth()).rejects.toThrow(
        'upstream bad',
      );
    });
  });

  describe('completeGoogleOAuth()', () => {
    it('posts name + credentialsJson to the complete endpoint', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          success: true,
          data: makeCred({ type: 'google-oauth', provider: 'google' }),
        },
      });
      await credentialsService.completeGoogleOAuth({
        name: 'info-gmail',
        credentialsJson: '{"access_token":"a","refresh_token":"b"}',
      });
      expect(mockedAxios.post).toHaveBeenCalledWith(
        '/api/credentials/oauth/google/complete',
        {
          name: 'info-gmail',
          credentialsJson: '{"access_token":"a","refresh_token":"b"}',
        },
      );
    });

    it('accepts a parsed object for credentialsJson', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          success: true,
          data: makeCred({ type: 'google-oauth', provider: 'google' }),
        },
      });
      await credentialsService.completeGoogleOAuth({
        name: 'n',
        credentialsJson: { access_token: 'a', refresh_token: 'b' },
      });
      expect(mockedAxios.post).toHaveBeenCalledWith(
        '/api/credentials/oauth/google/complete',
        {
          name: 'n',
          credentialsJson: { access_token: 'a', refresh_token: 'b' },
        },
      );
    });

    it('surfaces the backend error verbatim on 400', async () => {
      const axiosErr = {
        isAxiosError: true,
        message: 'Request failed with status code 400',
        response: {
          data: {
            success: false,
            error:
              'credentialsJson is missing access_token or refresh_token. Make sure you copied the entire JSON block.',
          },
        },
      };
      mockedAxios.post.mockRejectedValue(axiosErr);
      mockedAxios.isAxiosError = vi.fn((v) => v === axiosErr);
      await expect(
        credentialsService.completeGoogleOAuth({
          name: 'n',
          credentialsJson: '{}',
        }),
      ).rejects.toThrow(/missing access_token/);
    });

    it('falls back to a generic message when no backend error field is present', async () => {
      const axiosErr = {
        isAxiosError: true,
        message: 'Network Error',
        response: undefined,
      };
      mockedAxios.post.mockRejectedValue(axiosErr);
      mockedAxios.isAxiosError = vi.fn((v) => v === axiosErr);
      await expect(
        credentialsService.completeGoogleOAuth({
          name: 'n',
          credentialsJson: '{}',
        }),
      ).rejects.toThrow('Network Error');
    });
  });
});
