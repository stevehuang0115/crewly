/**
 * Credentials Service
 *
 * API client for the workspace credential store. Wraps `/api/credentials/*`
 * endpoints. Secret values are never returned by the backend; this client
 * works exclusively with metadata.
 *
 * @module services/credentials.service
 */

import axios from 'axios';
import {
  CredentialSummary,
  AddApiKeyRequest,
  ImportGeminiCliRequest,
  UpdateCredentialRequest,
  StartGoogleOAuthRequest,
  StartGoogleOAuthResponse,
  CompleteGoogleOAuthRequest,
} from '../types/credential.types';
import { ApiResponse } from '../types';

const CREDENTIALS_API_BASE = '/api/credentials';

/**
 * Normalize thrown axios errors into a plain `Error` whose `.message` is the
 * backend-supplied `error` string when present. Axios rejects by default on
 * 4xx / 5xx responses, and the useful user-facing message lives on
 * `err.response.data.error` (the backend convention).
 *
 * @param err - The unknown value caught from an axios call.
 * @param fallback - Message to use when no backend error is available.
 * @returns A regular `Error` instance suitable for re-throwing.
 */
function unwrapError(err: unknown, fallback: string): Error {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string } | undefined;
    if (data && typeof data.error === 'string' && data.error.length > 0) {
      return new Error(data.error);
    }
    return new Error(err.message || fallback);
  }
  if (err instanceof Error) return err;
  return new Error(fallback);
}

/**
 * API client for credential management.
 */
class CredentialsService {
  /** List all credentials (metadata only). */
  async list(): Promise<CredentialSummary[]> {
    const res = await axios.get<ApiResponse<CredentialSummary[]>>(CREDENTIALS_API_BASE);
    if (!res.data.success || !res.data.data) {
      throw new Error(res.data.error || 'Failed to list credentials');
    }
    return res.data.data;
  }

  /** Get a single credential by id. */
  async get(id: string): Promise<CredentialSummary> {
    const res = await axios.get<ApiResponse<CredentialSummary>>(`${CREDENTIALS_API_BASE}/${id}`);
    if (!res.data.success || !res.data.data) {
      throw new Error(res.data.error || 'Failed to get credential');
    }
    return res.data.data;
  }

  /** Add an API key credential. */
  async addApiKey(input: AddApiKeyRequest): Promise<CredentialSummary> {
    const res = await axios.post<ApiResponse<CredentialSummary>>(
      `${CREDENTIALS_API_BASE}/api-key`,
      input,
    );
    if (!res.data.success || !res.data.data) {
      throw new Error(res.data.error || 'Failed to add API key');
    }
    return res.data.data;
  }

  /** Import an OAuth credential from the gemini-cli workspace extension. */
  async importFromGeminiCli(input: ImportGeminiCliRequest): Promise<CredentialSummary> {
    const res = await axios.post<ApiResponse<CredentialSummary>>(
      `${CREDENTIALS_API_BASE}/oauth/import-gemini-cli`,
      input,
    );
    if (!res.data.success || !res.data.data) {
      throw new Error(res.data.error || 'Failed to import from gemini-cli');
    }
    return res.data.data;
  }

  /** Clear the gemini-cli extension's cached token file (for next-account onboarding). */
  async clearGeminiCliExtensionFile(): Promise<void> {
    const res = await axios.post<ApiResponse<void>>(
      `${CREDENTIALS_API_BASE}/oauth/gemini-cli/clear-extension-file`,
    );
    if (!res.data.success) {
      throw new Error(res.data.error || 'Failed to clear extension file');
    }
  }

  /**
   * Start a headless Google OAuth flow. Returns a Google sign-in URL that the
   * user opens on any device (scan QR or click link). After signing in, the
   * user copies the JSON blob shown on the success page and pastes it back.
   *
   * When `scopes` is omitted the backend uses its broad Workspace default.
   *
   * @param input - Optional scopes override. Pass `GMAIL_ONLY_SCOPES` for the
   *                low-risk preset.
   * @returns The `authUrl` to display as QR + clickable link.
   * @throws Error with a user-friendly message on network / server failure.
   */
  async startGoogleOAuth(
    input: StartGoogleOAuthRequest = {},
  ): Promise<StartGoogleOAuthResponse> {
    const body: StartGoogleOAuthRequest = {};
    if (input.scopes && input.scopes.length > 0) {
      body.scopes = input.scopes;
    }
    try {
      const res = await axios.post<ApiResponse<StartGoogleOAuthResponse>>(
        `${CREDENTIALS_API_BASE}/oauth/google/start`,
        body,
      );
      if (!res.data.success || !res.data.data) {
        throw new Error(res.data.error || 'Failed to start Google OAuth');
      }
      return res.data.data;
    } catch (err) {
      throw unwrapError(err, 'Failed to start Google OAuth');
    }
  }

  /**
   * Complete a headless Google OAuth flow by saving the pasted credentials
   * JSON as a new Crewly credential. Backend validates the JSON, fetches the
   * account email from Google userinfo, and stores an encrypted copy.
   *
   * On validation failure the backend responds 400 with a specific error
   * message (e.g. "credentialsJson is missing access_token or refresh_token").
   * We surface that message unchanged so the UI can present it verbatim.
   *
   * @param input - `{ name, credentialsJson }`. `credentialsJson` may be a raw
   *                JSON string (what the user pasted) or a parsed object.
   * @returns The newly-created credential summary.
   * @throws Error with the backend's user-friendly error message on failure.
   */
  async completeGoogleOAuth(
    input: CompleteGoogleOAuthRequest,
  ): Promise<CredentialSummary> {
    try {
      const res = await axios.post<ApiResponse<CredentialSummary>>(
        `${CREDENTIALS_API_BASE}/oauth/google/complete`,
        input,
      );
      if (!res.data.success || !res.data.data) {
        throw new Error(res.data.error || 'Failed to save Google credential');
      }
      return res.data.data;
    } catch (err) {
      throw unwrapError(err, 'Failed to save Google credential');
    }
  }

  /** Update credential metadata (rename, mark revoked). */
  async update(id: string, patch: UpdateCredentialRequest): Promise<CredentialSummary> {
    const res = await axios.patch<ApiResponse<CredentialSummary>>(
      `${CREDENTIALS_API_BASE}/${id}`,
      patch,
    );
    if (!res.data.success || !res.data.data) {
      throw new Error(res.data.error || 'Failed to update credential');
    }
    return res.data.data;
  }

  /** Delete a credential permanently. */
  async delete(id: string): Promise<void> {
    const res = await axios.delete<ApiResponse<void>>(`${CREDENTIALS_API_BASE}/${id}`);
    if (!res.data.success) {
      throw new Error(res.data.error || 'Failed to delete credential');
    }
  }
}

/** Singleton instance. */
export const credentialsService = new CredentialsService();
