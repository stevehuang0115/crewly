/**
 * Tests for credential type definitions and error classes.
 */

import {
  MissingCredentialError,
  InsufficientScopeError,
  CredentialRevokedError,
  CredentialNotFoundError,
  CredentialRegistryEntry,
  CredentialRegistry,
  ApiKeyPayload,
  GoogleOAuthPayload,
  CredentialPayload,
} from './credential.types.js';

describe('credential.types', () => {
  describe('MissingCredentialError', () => {
    it('carries slot and provider and sets class name', () => {
      const err = new MissingCredentialError('gemini', 'gemini');
      expect(err.name).toBe('MissingCredentialError');
      expect(err.slot).toBe('gemini');
      expect(err.provider).toBe('gemini');
      expect(err.message).toContain("slot 'gemini'");
      expect(err.message).toContain('gemini');
      expect(err).toBeInstanceOf(Error);
    });

    // Issue #324: caller gets no way to discover available credentials
    // from the bare error. The enriched message lists them so the agent
    // can self-recover with `credentialBindings: { slot: id }`.
    it('lists available credentials of the matching provider when supplied', () => {
      const err = new MissingCredentialError('gmail', 'google', [
        { id: 'cred-aaa', name: "Steve's Gmail", type: 'google-oauth', status: 'active' },
        { id: 'cred-bbb', name: 'Service Account', type: 'google-oauth', status: 'active' },
      ]);
      expect(err.message).toContain('cred-aaa');
      expect(err.message).toContain("name=\"Steve's Gmail\"");
      expect(err.message).toContain('status=active');
      expect(err.message).toContain('credentialBindings');
      expect(err.available).toHaveLength(2);
    });

    it('surfaces a clear no-credentials-registered hint when the provider list is empty', () => {
      const err = new MissingCredentialError('gmail', 'google');
      expect(err.message).toContain('No google credentials registered');
      expect(err.message).toContain('Settings → Credentials');
    });
  });

  describe('InsufficientScopeError', () => {
    it('computes missing scopes and mentions them in message', () => {
      const err = new InsufficientScopeError(
        'google-drive',
        [
          'https://www.googleapis.com/auth/drive.readonly',
          'https://www.googleapis.com/auth/gmail.readonly',
        ],
        ['https://www.googleapis.com/auth/drive.readonly'],
      );
      expect(err.name).toBe('InsufficientScopeError');
      expect(err.missing).toEqual([
        'https://www.googleapis.com/auth/gmail.readonly',
      ]);
      expect(err.message).toContain('gmail.readonly');
    });

    it('handles all-granted case (empty missing list)', () => {
      const err = new InsufficientScopeError('s', ['a'], ['a', 'b']);
      expect(err.missing).toEqual([]);
    });
  });

  describe('CredentialRevokedError', () => {
    it('includes name, id, and remediation in message', () => {
      const err = new CredentialRevokedError(
        'cred-123',
        'personal-gmail',
        'Run `crewly credentials add-google --name personal-gmail`',
      );
      expect(err.name).toBe('CredentialRevokedError');
      expect(err.credentialId).toBe('cred-123');
      expect(err.credentialName).toBe('personal-gmail');
      expect(err.message).toContain('cred-123');
      expect(err.message).toContain('personal-gmail');
      expect(err.message).toContain('add-google');
    });
  });

  describe('CredentialNotFoundError', () => {
    it('carries the credential id', () => {
      const err = new CredentialNotFoundError('cred-xyz');
      expect(err.name).toBe('CredentialNotFoundError');
      expect(err.credentialId).toBe('cred-xyz');
      expect(err.message).toContain('cred-xyz');
    });
  });

  describe('discriminated union narrowing', () => {
    const apiKey: ApiKeyPayload = { type: 'api-key', value: 'k-test' };
    const oauth: GoogleOAuthPayload = {
      type: 'google-oauth',
      accessToken: 'at',
      refreshToken: 'rt',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 3600_000,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      clientId: 'client-id',
    };

    it('narrows api-key payload', () => {
      const p: CredentialPayload = apiKey;
      if (p.type === 'api-key') {
        expect(p.value).toBe('k-test');
      } else {
        fail('type narrowing failed for api-key');
      }
    });

    it('narrows google-oauth payload', () => {
      const p: CredentialPayload = oauth;
      if (p.type === 'google-oauth') {
        expect(p.accessToken).toBe('at');
        expect(p.refreshToken).toBe('rt');
        expect(p.scopes).toHaveLength(1);
      } else {
        fail('type narrowing failed for google-oauth');
      }
    });
  });

  describe('registry shape', () => {
    it('accepts a well-formed registry entry', () => {
      const entry: CredentialRegistryEntry = {
        id: 'cred-1',
        name: 'info-steam-fun',
        type: 'google-oauth',
        provider: 'google',
        helper: 'gemini-cli-workspace',
        scopes: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/calendar.readonly',
        ],
        accountEmail: 'info@steam-fun.com',
        createdAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:00.000Z',
        status: 'active',
        encFile: 'cred-1.enc',
      };
      const reg: CredentialRegistry = {
        schemaVersion: 1,
        credentials: [entry],
      };
      expect(reg.credentials[0].id).toBe('cred-1');
      expect(reg.credentials[0].helper).toBe('gemini-cli-workspace');
    });

    it('accepts an api-key entry without helper or scopes', () => {
      const entry: CredentialRegistryEntry = {
        id: 'cred-2',
        name: 'gemini-main',
        type: 'api-key',
        provider: 'gemini',
        createdAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:00.000Z',
        status: 'active',
        encFile: 'cred-2.enc',
      };
      expect(entry.helper).toBeUndefined();
      expect(entry.scopes).toBeUndefined();
    });
  });
});
