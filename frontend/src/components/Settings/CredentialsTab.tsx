/**
 * CredentialsTab Component
 *
 * Settings tab for managing workspace credentials: Google OAuth accounts and
 * static API keys. Distinct from the existing "API Keys" tab, which is for AI
 * runtime provider keys.
 *
 * The primary path for adding a Google account is an in-app headless OAuth
 * flow (scan a QR code or click a sign-in link on any device, then paste the
 * resulting JSON back into the modal). The legacy Gemini CLI import flow is
 * still exposed under an "Advanced" option for developers who already run
 * `gemini` locally.
 *
 * @module components/Settings/CredentialsTab
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Key,
  Link2,
  Plus,
  Trash2,
  AlertCircle,
  Info,
  CheckCircle2,
  RefreshCw,
  ExternalLink,
  Copy,
  Check,
  Terminal,
} from 'lucide-react';
import { useCredentials } from '../../hooks/useCredentials';
import {
  CredentialSummary,
  AddApiKeyRequest,
  GoogleScopePreset,
  GMAIL_ONLY_SCOPES,
} from '../../types/credential.types';
import { Alert } from '../UI/Alert';
import { Button } from '../UI/Button';
import { Card } from '../UI/Card';
import { Modal } from '../UI/Modal';
import { FormInput, FormLabel } from '../UI/Form';
import { ConfirmDialog } from '../UI/ConfirmDialog';

// ============================================================================
// Types
// ============================================================================

type ModalKind =
  | null
  | 'addApiKey'
  | 'addGoogleOAuth'
  | 'importGeminiCli'
  | 'deleteConfirm';

const API_KEY_PROVIDER_OPTIONS = [
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'other', label: 'Other (custom)' },
];

// ============================================================================
// Component
// ============================================================================

export const CredentialsTab: React.FC = () => {
  const {
    credentials,
    isLoading,
    error,
    refresh,
    addApiKey,
    importFromGeminiCli,
    clearGeminiCliExtensionFile,
    startGoogleOAuth,
    completeGoogleOAuth,
    remove,
  } = useCredentials();

  const [openModal, setOpenModal] = useState<ModalKind>(null);
  const [deletingCred, setDeletingCred] = useState<CredentialSummary | null>(null);
  const [flash, setFlash] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  const showFlash = useCallback((kind: 'success' | 'error', message: string) => {
    setFlash({ kind, message });
    setTimeout(() => setFlash(null), 4000);
  }, []);

  // Grouping
  const oauthCreds = credentials.filter((c) => c.type === 'google-oauth');
  const apiKeyCreds = credentials.filter((c) => c.type === 'api-key');

  // ---- delete ----
  const handleDeleteClick = (cred: CredentialSummary) => {
    setDeletingCred(cred);
    setOpenModal('deleteConfirm');
  };

  const confirmDelete = async () => {
    if (!deletingCred) return;
    try {
      await remove(deletingCred.id);
      showFlash('success', `Deleted "${deletingCred.name}"`);
    } catch (err) {
      showFlash('error', err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeletingCred(null);
      setOpenModal(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header + disambiguation notice */}
      <div>
        <div className="flex items-start gap-2 p-4 bg-surface-dark rounded-lg border border-border-dark">
          <Info className="w-4 h-4 text-text-secondary-dark mt-0.5 flex-shrink-0" />
          <div className="text-sm text-text-secondary-dark">
            <p className="font-medium text-text-primary-dark mb-1">
              Credentials for third-party services your agents call
            </p>
            <p>
              Add Google accounts (Gmail, Drive, Calendar, etc.) and service API keys that
              skills use to act on your behalf. For the AI model powering your agents
              themselves, use the <strong>API Keys</strong> tab instead.
            </p>
          </div>
        </div>
      </div>

      {/* Flash */}
      {flash && (
        <Alert variant={flash.kind === 'success' ? 'success' : 'error'}>
          {flash.message}
        </Alert>
      )}

      {/* Load error */}
      {error && !isLoading && (
        <Alert variant="error">
          <div className="flex items-center justify-between">
            <span>Failed to load credentials: {error}</span>
            <Button variant="secondary" size="sm" onClick={() => refresh()}>
              <RefreshCw className="w-3 h-3 mr-1" /> Retry
            </Button>
          </div>
        </Alert>
      )}

      {/* Google accounts section */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Link2 className="w-5 h-5" />
            Google Accounts
            <span className="text-sm font-normal text-text-secondary-dark">
              ({oauthCreds.length})
            </span>
          </h3>
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={() => setOpenModal('addGoogleOAuth')}>
              <Plus className="w-3 h-3 mr-1" /> Add Google Account
            </Button>
          </div>
        </div>

        {oauthCreds.length === 0 && !isLoading && (
          <Card className="p-6 text-center text-sm text-text-secondary-dark">
            No Google accounts added yet. Click <strong>Add Google Account</strong> above
            to sign in and link one — no CLI install required.
          </Card>
        )}

        {oauthCreds.length > 0 && (
          <div className="space-y-2">
            {oauthCreds.map((cred) => (
              <CredentialRow
                key={cred.id}
                cred={cred}
                onDelete={() => handleDeleteClick(cred)}
              />
            ))}
          </div>
        )}

        {/* Advanced: Gemini CLI import — kept for developers */}
        <div className="mt-3 flex items-center gap-2 text-xs text-text-secondary-dark">
          <Terminal className="w-3 h-3" />
          <span>Developer option:</span>
          <button
            type="button"
            onClick={() => setOpenModal('importGeminiCli')}
            className="text-primary hover:underline"
          >
            Import from Gemini CLI
          </button>
        </div>
      </section>

      {/* API keys section */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Key className="w-5 h-5" />
            Service API Keys
            <span className="text-sm font-normal text-text-secondary-dark">
              ({apiKeyCreds.length})
            </span>
          </h3>
          <Button variant="primary" size="sm" onClick={() => setOpenModal('addApiKey')}>
            <Plus className="w-3 h-3 mr-1" /> Add API Key
          </Button>
        </div>

        {apiKeyCreds.length === 0 && !isLoading && (
          <Card className="p-6 text-center text-sm text-text-secondary-dark">
            No service API keys added yet. These are for skills that call third-party
            services (e.g., Gemini API for image generation).
          </Card>
        )}

        {apiKeyCreds.length > 0 && (
          <div className="space-y-2">
            {apiKeyCreds.map((cred) => (
              <CredentialRow
                key={cred.id}
                cred={cred}
                onDelete={() => handleDeleteClick(cred)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Modals */}
      {openModal === 'addApiKey' && (
        <AddApiKeyModal
          onClose={() => setOpenModal(null)}
          onSubmit={async (input) => {
            await addApiKey(input);
            showFlash('success', `Added "${input.name}"`);
            setOpenModal(null);
          }}
        />
      )}

      {openModal === 'addGoogleOAuth' && (
        <AddGoogleOAuthModal
          onClose={() => setOpenModal(null)}
          onStart={startGoogleOAuth}
          onComplete={async (name, credentialsJson) => {
            const cred = await completeGoogleOAuth({ name, credentialsJson });
            const descriptor = cred.accountEmail
              ? `${cred.name} (${cred.accountEmail})`
              : cred.name;
            showFlash('success', `Added Google account ${descriptor}`);
            setOpenModal(null);
          }}
        />
      )}

      {openModal === 'importGeminiCli' && (
        <ImportGeminiCliModal
          onClose={() => setOpenModal(null)}
          onImport={async (name) => {
            await importFromGeminiCli({ name });
            showFlash('success', `Added Google account "${name}"`);
          }}
          onClearExtensionFile={clearGeminiCliExtensionFile}
        />
      )}

      {openModal === 'deleteConfirm' && deletingCred && (
        <ConfirmDialog
          isOpen
          title="Delete credential?"
          message={`Delete "${deletingCred.name}"? This cannot be undone. Skills using this credential will fail until you add a replacement.`}
          confirmLabel="Delete"
          confirmVariant="danger"
          onConfirm={confirmDelete}
          onCancel={() => {
            setOpenModal(null);
            setDeletingCred(null);
          }}
        />
      )}
    </div>
  );
};

// ============================================================================
// Credential row
// ============================================================================

interface CredentialRowProps {
  cred: CredentialSummary;
  onDelete: () => void;
}

const CredentialRow: React.FC<CredentialRowProps> = ({ cred, onDelete }) => {
  const isOAuth = cred.type === 'google-oauth';
  const isRevoked = cred.status === 'revoked';

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium">{cred.name}</span>
            {isRevoked && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-red-500/10 text-red-400">
                <AlertCircle className="w-3 h-3" />
                Revoked
              </span>
            )}
            {!isRevoked && isOAuth && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-green-500/10 text-green-400">
                <CheckCircle2 className="w-3 h-3" />
                Active
              </span>
            )}
          </div>

          <div className="text-xs text-text-secondary-dark space-y-0.5">
            <div>
              Provider: <span className="font-mono">{cred.provider}</span>
              {isOAuth && cred.helper && (
                <>
                  {' · '}Helper: <span className="font-mono">{cred.helper}</span>
                </>
              )}
            </div>
            {cred.accountEmail && (
              <div>
                Account: <span className="font-mono">{cred.accountEmail}</span>
              </div>
            )}
            {cred.scopes && cred.scopes.length > 0 && (
              <div className="truncate" title={cred.scopes.join(' ')}>
                Scopes ({cred.scopes.length}):{' '}
                <span className="font-mono">
                  {cred.scopes
                    .map((s) => s.replace('https://www.googleapis.com/auth/', ''))
                    .join(', ')}
                </span>
              </div>
            )}
            <div>
              Added {new Date(cred.createdAt).toLocaleDateString()}
              {cred.lastUsedAt &&
                ` · Last used ${new Date(cred.lastUsedAt).toLocaleDateString()}`}
            </div>
          </div>
        </div>

        <Button variant="secondary" size="sm" onClick={onDelete} aria-label="Delete credential">
          <Trash2 className="w-3 h-3" />
        </Button>
      </div>
    </Card>
  );
};

// ============================================================================
// Add API Key modal
// ============================================================================

interface AddApiKeyModalProps {
  onClose: () => void;
  onSubmit: (input: AddApiKeyRequest) => Promise<void>;
}

const AddApiKeyModal: React.FC<AddApiKeyModalProps> = ({ onClose, onSubmit }) => {
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('gemini');
  const [customProvider, setCustomProvider] = useState('');
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const effectiveProvider =
      provider === 'other' ? customProvider.trim() : provider;
    if (!name.trim() || !effectiveProvider || !value.trim()) {
      setError('All fields are required');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({ name: name.trim(), provider: effectiveProvider, value: value.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add API key');
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Add API Key" size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <FormLabel htmlFor="cred-apikey-name">Name</FormLabel>
          <FormInput
            id="cred-apikey-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. gemini-main, openai-personal"
            required
          />
        </div>

        <div>
          <FormLabel htmlFor="cred-apikey-provider">Provider</FormLabel>
          <select
            id="cred-apikey-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full px-3 py-2 bg-surface-dark border border-border-dark rounded text-sm"
          >
            {API_KEY_PROVIDER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {provider === 'other' && (
          <div>
            <FormLabel htmlFor="cred-apikey-custom-provider">Custom provider identifier</FormLabel>
            <FormInput
              id="cred-apikey-custom-provider"
              type="text"
              value={customProvider}
              onChange={(e) => setCustomProvider(e.target.value)}
              placeholder="lowercase, e.g. 'groq', 'mistral'"
              required
            />
          </div>
        )}

        <div>
          <FormLabel htmlFor="cred-apikey-value">API Key</FormLabel>
          <FormInput
            id="cred-apikey-value"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="paste your API key"
            required
          />
        </div>

        {error && <Alert variant="error">{error}</Alert>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? 'Adding…' : 'Add'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

// ============================================================================
// Add Google Account modal — headless OAuth flow (primary path)
// ============================================================================

/**
 * UI-facing translation of backend errors into actionable, non-technical
 * messages. Keeps the original text as a fallback so we never swallow
 * diagnostic detail, but prepends a human-friendly explanation when we
 * recognize a known failure mode.
 *
 * @param raw - The error message surfaced from the backend.
 * @returns User-friendly error text for inline display.
 */
export function friendlyOAuthError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('access_token') || lower.includes('refresh_token')) {
    return "The sign-in info you pasted is incomplete. Open the success page again and copy the entire JSON block (from the opening { to the closing }).";
  }
  if (lower.includes('not valid json')) {
    return "That doesn't look like the JSON from the success page. Copy the whole block — don't edit it.";
  }
  if (lower.includes('app') && (lower.includes('block') || lower.includes('denied'))) {
    return "This Google account doesn't allow sign-in with this app. Try the \"Gmail only\" scope, or use a different Google / Workspace account.";
  }
  if (lower.includes('already') && lower.includes('exist')) {
    return "This Google account is already linked. Check the list above — it's already there.";
  }
  return raw;
}

interface AddGoogleOAuthModalProps {
  onClose: () => void;
  onStart: (input?: { scopes?: string[] }) => Promise<{ authUrl: string }>;
  onComplete: (name: string, credentialsJson: string) => Promise<void>;
}

type OAuthStage = 'configure' | 'signin' | 'saving';

const AddGoogleOAuthModal: React.FC<AddGoogleOAuthModalProps> = ({
  onClose,
  onStart,
  onComplete,
}) => {
  const [stage, setStage] = useState<OAuthStage>('configure');
  const [name, setName] = useState('');
  const [scopePreset, setScopePreset] = useState<GoogleScopePreset>('gmail-only');
  const [customScopesText, setCustomScopesText] = useState(
    GMAIL_ONLY_SCOPES.join('\n'),
  );
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [pastedJson, setPastedJson] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [generating, setGenerating] = useState(false);

  // Clear "copied" indicator after a short moment
  useEffect(() => {
    if (!linkCopied) return;
    const t = setTimeout(() => setLinkCopied(false), 1500);
    return () => clearTimeout(t);
  }, [linkCopied]);

  const effectiveScopes = useMemo<string[] | undefined>(() => {
    if (scopePreset === 'gmail-only') return [...GMAIL_ONLY_SCOPES];
    if (scopePreset === 'full-workspace') return undefined; // backend default
    // custom — one scope per line, whitespace-trimmed
    return customScopesText
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }, [scopePreset, customScopesText]);

  const handleGenerate = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Please give this account a name (e.g. "personal-gmail").');
      return;
    }
    if (scopePreset === 'custom' && (!effectiveScopes || effectiveScopes.length === 0)) {
      setError('Custom scopes list is empty. Add at least one scope URL.');
      return;
    }
    setGenerating(true);
    try {
      const res = await onStart(
        effectiveScopes ? { scopes: effectiveScopes } : undefined,
      );
      setAuthUrl(res.authUrl);
      setStage('signin');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate sign-in link');
    } finally {
      setGenerating(false);
    }
  };

  const handleCopyLink = async () => {
    if (!authUrl) return;
    try {
      await navigator.clipboard.writeText(authUrl);
      setLinkCopied(true);
    } catch {
      // Fallback for older browsers / iframes without clipboard permission
      const el = document.createElement('textarea');
      el.value = authUrl;
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand('copy');
        setLinkCopied(true);
      } catch {
        setError('Could not copy to clipboard. Copy the link manually.');
      } finally {
        document.body.removeChild(el);
      }
    }
  };

  const handleSave = async () => {
    setError(null);
    if (!pastedJson.trim()) {
      setError('Paste the JSON block from the success page below.');
      return;
    }
    setStage('saving');
    try {
      await onComplete(name.trim(), pastedJson.trim());
      // Parent closes the modal on success.
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Failed to save account';
      setError(friendlyOAuthError(raw));
      setStage('signin');
    }
  };

  const title =
    stage === 'configure' ? 'Add Google account' : 'Sign in on any device';

  return (
    <Modal isOpen onClose={onClose} title={title} size="lg">
      {stage === 'configure' && (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary-dark">
            Link a Google account so your agents can use it for Gmail, Drive,
            Calendar, etc. You'll sign in on your phone or another device — no
            terminal needed.
          </p>

          <div>
            <FormLabel htmlFor="cred-goog-name">Name (internal)</FormLabel>
            <FormInput
              id="cred-goog-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. personal-gmail, info-steam-fun"
              autoFocus
            />
            <p className="text-xs text-text-secondary-dark mt-1">
              You'll use this name to tell agents which account to use.
            </p>
          </div>

          <div>
            <FormLabel htmlFor="cred-goog-scope">Access scope</FormLabel>
            <select
              id="cred-goog-scope"
              value={scopePreset}
              onChange={(e) => setScopePreset(e.target.value as GoogleScopePreset)}
              className="w-full px-3 py-2 bg-surface-dark border border-border-dark rounded text-sm"
            >
              <option value="gmail-only">Gmail only (recommended for personal accounts)</option>
              <option value="full-workspace">Full Workspace (Gmail, Drive, Calendar, Photos)</option>
              <option value="custom">Custom — pick scopes manually</option>
            </select>
            <p className="text-xs text-text-secondary-dark mt-1">
              If Google blocks the sign-in page, try <strong>Gmail only</strong>{' '}
              first — broader scopes require a Workspace account.
            </p>
          </div>

          {scopePreset === 'custom' && (
            <div>
              <FormLabel htmlFor="cred-goog-custom-scopes">
                Scopes (one per line)
              </FormLabel>
              <textarea
                id="cred-goog-custom-scopes"
                value={customScopesText}
                onChange={(e) => setCustomScopesText(e.target.value)}
                rows={5}
                className="w-full px-3 py-2 bg-surface-dark border border-border-dark rounded text-xs font-mono"
                spellCheck={false}
              />
              <p className="text-xs text-text-secondary-dark mt-1">
                Paste full OAuth scope URLs (one per line). Advanced.
              </p>
            </div>
          )}

          {error && <Alert variant="error">{error}</Alert>}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={onClose} disabled={generating}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleGenerate} disabled={generating}>
              {generating ? 'Generating…' : 'Generate sign-in link'}
            </Button>
          </div>
        </div>
      )}

      {stage === 'signin' && authUrl && (
        <div className="space-y-4">
          <Alert variant="info">
            Sign in as the Google account you want to link. After signing in,
            Google will show a success page with a JSON block — copy it and
            paste below.
          </Alert>

          <div className="flex flex-col items-center gap-3 py-2">
            <div className="bg-white p-3 rounded-lg">
              <QRCodeSVG value={authUrl} size={256} level="M" includeMargin={false} />
            </div>
            <div className="text-xs text-text-secondary-dark text-center">
              Scan with your phone camera
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-2">
            <a
              href={authUrl}
              target="_blank"
              rel="noreferrer"
              className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 bg-primary text-white rounded-md text-sm hover:opacity-90"
            >
              <ExternalLink className="w-4 h-4" /> Open sign-in page
            </a>
            <Button variant="secondary" onClick={handleCopyLink} type="button">
              {linkCopied ? (
                <>
                  <Check className="w-4 h-4 mr-1" /> Copied
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4 mr-1" /> Copy link
                </>
              )}
            </Button>
          </div>

          <div>
            <FormLabel htmlFor="cred-goog-json">
              After signing in, paste the JSON from the success page here:
            </FormLabel>
            <textarea
              id="cred-goog-json"
              value={pastedJson}
              onChange={(e) => setPastedJson(e.target.value)}
              rows={8}
              placeholder={'{\n  "access_token": "...",\n  "refresh_token": "...",\n  ...\n}'}
              className="w-full px-3 py-2 bg-surface-dark border border-border-dark rounded text-xs font-mono"
              spellCheck={false}
            />
            <p className="text-xs text-text-secondary-dark mt-1">
              Copy the entire block from the opening <code>{'{'}</code> to the
              closing <code>{'}'}</code>.
            </p>
          </div>

          {error && <Alert variant="error">{error}</Alert>}

          <div className="flex justify-between items-center pt-2">
            <button
              type="button"
              onClick={() => {
                setStage('configure');
                setPastedJson('');
                setError(null);
                setAuthUrl(null);
              }}
              className="text-xs text-text-secondary-dark hover:underline"
            >
              ← Back (change scope)
            </button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
              <Button variant="primary" onClick={handleSave}>
                Save credential
              </Button>
            </div>
          </div>
        </div>
      )}

      {stage === 'saving' && (
        <div className="flex items-center gap-3 py-8 justify-center">
          <RefreshCw className="w-4 h-4 animate-spin" />
          <span className="text-sm">Saving credential…</span>
        </div>
      )}
    </Modal>
  );
};

// ============================================================================
// Import from Gemini CLI modal — legacy/developer path
// ============================================================================

interface ImportGeminiCliModalProps {
  onClose: () => void;
  onImport: (name: string) => Promise<void>;
  onClearExtensionFile: () => Promise<void>;
}

type GeminiFlowStage = 'name' | 'instructions' | 'importing' | 'done';

const ImportGeminiCliModal: React.FC<ImportGeminiCliModalProps> = ({
  onClose,
  onImport,
  onClearExtensionFile,
}) => {
  const [stage, setStage] = useState<GeminiFlowStage>('name');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [importedEmail] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const proceedToInstructions = () => {
    if (!name.trim()) {
      setError('Please provide a name (e.g. "info-steam-fun", "personal-gmail")');
      return;
    }
    setError(null);
    setStage('instructions');
  };

  const handleImport = async () => {
    setError(null);
    setStage('importing');
    try {
      await onImport(name.trim());
      setStage('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
      setStage('instructions');
    }
  };

  const handleClearAndAddAnother = async () => {
    setClearing(true);
    try {
      await onClearExtensionFile();
      // Reset for the next account
      setStage('name');
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear extension file');
    } finally {
      setClearing(false);
    }
  };

  const title =
    stage === 'done' ? 'Google account added' : 'Import from Gemini CLI';

  return (
    <Modal isOpen onClose={onClose} title={title} size="lg">
      {stage === 'name' && (
        <div className="space-y-4">
          <Alert variant="info">
            This option is for developers who already run the Gemini CLI
            workspace extension locally. For the regular flow, close this and
            click <strong>Add Google Account</strong>.
          </Alert>
          <p className="text-sm text-text-secondary-dark">
            Pick a name for this Google account. You'll use this name to tell
            agents which account to use for a task.
          </p>
          <div>
            <FormLabel htmlFor="cred-gemcli-name">Name</FormLabel>
            <FormInput
              id="cred-gemcli-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. info-steam-fun, personal-gmail"
              autoFocus
            />
          </div>
          {error && <Alert variant="error">{error}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={proceedToInstructions}>Next</Button>
          </div>
        </div>
      )}

      {stage === 'instructions' && (
        <div className="space-y-4">
          <Alert variant="info">
            You'll sign in via the Gemini CLI Workspace extension. Crewly will then
            copy the resulting tokens into its own encrypted store.
          </Alert>

          <div className="space-y-3">
            <div>
              <div className="text-sm font-medium mb-1">1. Open a terminal and run:</div>
              <pre className="bg-surface-dark border border-border-dark rounded p-3 text-xs font-mono overflow-x-auto">
{`GEMINI_CLI_WORKSPACE_FORCE_FILE_STORAGE=true gemini`}
              </pre>
            </div>

            <div>
              <div className="text-sm font-medium mb-1">2. Inside gemini, type:</div>
              <pre className="bg-surface-dark border border-border-dark rounded p-3 text-xs font-mono overflow-x-auto">
{`list my calendar events for today`}
              </pre>
              <p className="text-xs text-text-secondary-dark mt-1">
                This triggers the workspace extension to open a browser for Google sign-in.
              </p>
            </div>

            <div>
              <div className="text-sm font-medium mb-1">
                3. In the browser: sign in as <span className="font-mono">{name}</span>
              </div>
              <p className="text-xs text-text-secondary-dark">
                Grant the requested scopes. You can close the browser after the
                success page appears.
              </p>
            </div>

            <div>
              <div className="text-sm font-medium mb-1">4. Come back here and click Import.</div>
              <p className="text-xs text-text-secondary-dark">
                Crewly will read the extension's token file and save an encrypted copy.
              </p>
            </div>
          </div>

          <a
            href="https://github.com/gemini-cli-extensions/workspace"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-primary inline-flex items-center gap-1 hover:underline"
          >
            About the workspace extension <ExternalLink className="w-3 h-3" />
          </a>

          {error && <Alert variant="error">{error}</Alert>}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={handleImport}>Import</Button>
          </div>
        </div>
      )}

      {stage === 'importing' && (
        <div className="flex items-center gap-3 py-4">
          <RefreshCw className="w-4 h-4 animate-spin" />
          <span className="text-sm">Reading the extension's token file…</span>
        </div>
      )}

      {stage === 'done' && (
        <div className="space-y-4">
          <Alert variant="success">
            Google account <strong>{name}</strong> added.
            {importedEmail && <> ({importedEmail})</>}
          </Alert>

          <div className="text-sm text-text-secondary-dark">
            To add another Google account, Crewly needs to clear the extension's
            cached token so your next sign-in captures a different account.
          </div>

          {error && <Alert variant="error">{error}</Alert>}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Done</Button>
            <Button
              variant="primary"
              onClick={handleClearAndAddAnother}
              disabled={clearing}
            >
              {clearing ? 'Clearing…' : 'Add another account'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
};
