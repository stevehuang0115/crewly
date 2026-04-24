/**
 * useCredentials Hook
 *
 * React hook for reading and managing workspace credentials.
 *
 * @module hooks/useCredentials
 */

import { useState, useEffect, useCallback } from 'react';
import { credentialsService } from '../services/credentials.service';
import {
  CredentialSummary,
  AddApiKeyRequest,
  ImportGeminiCliRequest,
  UpdateCredentialRequest,
  StartGoogleOAuthRequest,
  StartGoogleOAuthResponse,
  CompleteGoogleOAuthRequest,
} from '../types/credential.types';

/** Return shape for useCredentials. */
export interface UseCredentialsResult {
  credentials: CredentialSummary[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  addApiKey: (input: AddApiKeyRequest) => Promise<CredentialSummary>;
  importFromGeminiCli: (input: ImportGeminiCliRequest) => Promise<CredentialSummary>;
  clearGeminiCliExtensionFile: () => Promise<void>;
  /** Build a Google sign-in URL for the in-app "Add Google account" flow. */
  startGoogleOAuth: (
    input?: StartGoogleOAuthRequest,
  ) => Promise<StartGoogleOAuthResponse>;
  /** Save the JSON the user pasted from Google's success page as a new credential. */
  completeGoogleOAuth: (
    input: CompleteGoogleOAuthRequest,
  ) => Promise<CredentialSummary>;
  update: (id: string, patch: UpdateCredentialRequest) => Promise<CredentialSummary>;
  remove: (id: string) => Promise<void>;
}

/**
 * Hook exposing the credential list plus CRUD operations. Automatically
 * refreshes after any mutation.
 */
export function useCredentials(): UseCredentialsResult {
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const list = await credentialsService.list();
      setCredentials(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load credentials');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const addApiKey = useCallback(
    async (input: AddApiKeyRequest) => {
      const cred = await credentialsService.addApiKey(input);
      await fetch();
      return cred;
    },
    [fetch],
  );

  const importFromGeminiCli = useCallback(
    async (input: ImportGeminiCliRequest) => {
      const cred = await credentialsService.importFromGeminiCli(input);
      await fetch();
      return cred;
    },
    [fetch],
  );

  const clearGeminiCliExtensionFile = useCallback(async () => {
    await credentialsService.clearGeminiCliExtensionFile();
  }, []);

  const startGoogleOAuth = useCallback(
    async (input: StartGoogleOAuthRequest = {}) => {
      return credentialsService.startGoogleOAuth(input);
    },
    [],
  );

  const completeGoogleOAuth = useCallback(
    async (input: CompleteGoogleOAuthRequest) => {
      const cred = await credentialsService.completeGoogleOAuth(input);
      await fetch();
      return cred;
    },
    [fetch],
  );

  const update = useCallback(
    async (id: string, patch: UpdateCredentialRequest) => {
      const cred = await credentialsService.update(id, patch);
      await fetch();
      return cred;
    },
    [fetch],
  );

  const remove = useCallback(
    async (id: string) => {
      await credentialsService.delete(id);
      await fetch();
    },
    [fetch],
  );

  return {
    credentials,
    isLoading,
    error,
    refresh: fetch,
    addApiKey,
    importFromGeminiCli,
    clearGeminiCliExtensionFile,
    startGoogleOAuth,
    completeGoogleOAuth,
    update,
    remove,
  };
}
