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
import { Button } from '@crewly/ui/Button';
import { Input } from '@crewly/ui/Input';
import { Modal } from '@crewly/ui/Modal';
import { API_TOKEN_REQUIRED_EVENT } from '../../constants/api-token.constants';
import { getApiToken, setApiToken } from '../../services/api-token.service';

/** The prompt cannot be dismissed (the dashboard is unusable without a token). */
const noop = (): void => undefined;

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
    // The wrapper lifts the dialog above every other overlay: this prompt is
    // mounted before the router, so a plain z-50 Modal would sit under them.
    <div className="relative z-[100]">
      <Modal
        isOpen
        onClose={noop}
        closable={false}
        title="Access token required"
        size="md"
        data-testid="api-token-prompt"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <p className="text-sm text-text-secondary-dark leading-relaxed">
            {hadToken
              ? 'The stored access token was rejected. Paste the current token to continue.'
              : 'This dashboard is being opened from another machine. Paste the access token to continue.'}
            {' '}Run <code className="font-mono">crewly token</code> on the server to print it
            (or <code className="font-mono">crewly token --url</code> for a ready-to-open link).
          </p>
          <Input
            id="api-token-input"
            label="Access token"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="paste token"
            autoComplete="off"
            autoFocus
            fullWidth
            className="font-mono"
            data-testid="api-token-input"
          />
          <div className="flex justify-end">
            <Button
              type="submit"
              icon={KeyRound}
              disabled={!value.trim()}
              data-testid="api-token-submit"
            >
              Save and reload
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

export default ApiTokenPrompt;
