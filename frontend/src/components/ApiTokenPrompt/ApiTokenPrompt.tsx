/**
 * ApiTokenPrompt Component
 *
 * Small modal shown when the backend refuses a request with the API-token
 * challenge (`401 {error:'unauthorized'}`), i.e. the dashboard was opened
 * from a non-loopback address. Asks for the token printed by `crewly token`
 * on the server, stores it (localStorage + cookie) and reloads so every
 * pending request and WebSocket reconnects with it.
 *
 * Listens for the `crewly:api-token-required` window event raised by
 * `services/api-token.service`. Never shown on loopback (no 401 there).
 *
 * @module components/ApiTokenPrompt/ApiTokenPrompt
 */

import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { API_TOKEN_REQUIRED_EVENT } from '../../constants/api-token.constants';
import { getApiToken, setApiToken } from '../../services/api-token.service';

/** Props for ApiTokenPrompt. */
export interface ApiTokenPromptProps {
  /** Reload strategy after saving (defaults to `window.location.reload`). Injectable for tests. */
  onSaved?: () => void;
}

/**
 * Modal asking the user for the server's API token.
 *
 * @param props - Component props
 * @returns The modal, or null while no challenge has been received
 */
export const ApiTokenPrompt: React.FC<ApiTokenPromptProps> = ({ onSaved }) => {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [hadToken, setHadToken] = useState(false);

  useEffect(() => {
    const handler = () => {
      setHadToken(Boolean(getApiToken()));
      setOpen(true);
    };
    window.addEventListener(API_TOKEN_REQUIRED_EVENT, handler);
    return () => window.removeEventListener(API_TOKEN_REQUIRED_EVENT, handler);
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = value.trim();
      if (!trimmed) return;
      setApiToken(trimmed);
      setOpen(false);
      if (onSaved) onSaved();
      else window.location.reload();
    },
    [value, onSaved],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-label="Access token required"
      data-testid="api-token-prompt"
    >
      <div className="bg-surface-dark border border-border-dark rounded-xl shadow-2xl w-full max-w-md mx-4">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-border-dark">
          <KeyRound className="w-4 h-4 text-text-secondary-dark" />
          <h3 className="text-sm font-semibold text-text-primary-dark">Access token required</h3>
        </div>
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          <p className="text-xs text-text-secondary-dark leading-relaxed">
            {hadToken
              ? 'The stored access token was rejected. Paste the current token to continue.'
              : 'This dashboard is being opened from another machine. Paste the access token to continue.'}
            {' '}Run <code className="font-mono">crewly token</code> on the server to print it
            (or <code className="font-mono">crewly token --url</code> for a ready-to-open link).
          </p>
          <div>
            <label htmlFor="api-token-input" className="block text-xs font-medium text-text-secondary-dark mb-1.5">
              Access token
            </label>
            <input
              id="api-token-input"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="paste token"
              autoComplete="off"
              autoFocus
              className="w-full px-3 py-2 text-xs font-mono text-text-primary-dark bg-background-dark border border-border-dark rounded-lg placeholder:text-text-secondary-dark/40 focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50"
              data-testid="api-token-input"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={!value.trim()}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-white disabled:opacity-50"
              data-testid="api-token-submit"
            >
              Save and reload
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ApiTokenPrompt;
