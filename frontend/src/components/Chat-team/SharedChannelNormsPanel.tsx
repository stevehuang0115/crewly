/**
 * SharedChannelNormsPanel — the owner's norm for a channel with another
 * company's Crewly account (crewly#1543 slice 6).
 *
 * A one-line summary above the external channel's composer; "Edit norm"
 * opens the editor: free text ("what this partner may be told") and the
 * kinds of content agents may send there without his approval once the
 * link's first 10 messages are approved. Secrets, children's data and other
 * people's private data are never on the list: no norm can allow them.
 *
 * @module components/Chat-team/SharedChannelNormsPanel
 */

import { useEffect, useState } from 'react';
import { Alert } from '@crewly/ui/Alert';
import { Button } from '@crewly/ui/Button';
import {
  sharedChannelNormsService,
  type SharedChannelNorms,
  type SharedChannelNormsApi,
} from '../../services/shared-channel-norms.service';

/** Props of {@link SharedChannelNormsPanel}. */
export interface SharedChannelNormsPanelProps {
  /** Cloud link id */
  linkId: string;
  /** The other company, for wording */
  counterpart: string;
  /** API (injectable in tests) */
  api?: SharedChannelNormsApi;
}

/**
 * One line on what is set.
 *
 * @param norms - Loaded norm
 * @returns Summary text
 */
export function normSummary(norms: Pick<SharedChannelNorms, 'norm' | 'allow'>): string {
  if (!norms.norm && norms.allow.length === 0) return 'No norm yet: anything that may be internal waits for you.';
  const kinds = norms.allow.length === 0 ? 'no kinds allowed without asking' : `${norms.allow.length} kind${norms.allow.length === 1 ? '' : 's'} allowed without asking`;
  return `${norms.norm ? 'Norm set' : 'No norm text'} · ${kinds}`;
}

/**
 * Summary + editor of a link's norm.
 *
 * @param props - {@link SharedChannelNormsPanelProps}
 * @returns The panel
 */
export function SharedChannelNormsPanel({ linkId, counterpart, api = sharedChannelNormsService }: SharedChannelNormsPanelProps): JSX.Element {
  const [norms, setNorms] = useState<SharedChannelNorms | null>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [allow, setAllow] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setNorms(null);
    setOpen(false);
    setError(null);
    api
      .get(linkId)
      .then((n) => {
        if (cancelled) return;
        setNorms(n);
        setText(n.norm);
        setAllow(n.allow);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the norm');
      });
    return () => {
      cancelled = true;
    };
  }, [api, linkId]);

  const toggle = (key: string): void => {
    setSaved(false);
    setAllow((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.save(linkId, { norm: text, allow });
      setNorms(next);
      setText(next.norm);
      setAllow(next.allow);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the norm');
    } finally {
      setBusy(false);
    }
  };

  const changed = !!norms && (text.trim() !== norms.norm || allow.length !== norms.allow.length || allow.some((k) => !norms.allow.includes(k)));

  return (
    <div className="px-4 pt-2 text-[12px] text-text-2" data-testid="shared-norms-panel">
      <div className="flex items-center justify-between gap-2">
        <span data-testid="shared-norms-summary">{norms ? normSummary(norms) : error ? '' : 'Loading norm…'}</span>
        {norms && (
          <button
            type="button"
            className="shrink-0 text-[12px] font-semibold text-text hover:underline"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            data-testid="shared-norms-toggle"
          >
            {open ? 'Close' : 'Edit norm'}
          </button>
        )}
      </div>
      {open && norms && (
        <div className="mt-2 space-y-2 rounded-xl border border-border bg-surface-2 p-3" data-testid="shared-norms-editor">
          <label className="block">
            <span className="mb-1 block font-semibold text-text">{`What ${counterpart} may be told`}</span>
            <textarea
              value={text}
              onChange={(e) => {
                setSaved(false);
                setText(e.target.value);
              }}
              rows={3}
              placeholder={`e.g. ${counterpart} prints our flyers: share order sizes, dates and prices, nothing about other clients.`}
              className="w-full rounded-[var(--crewly-radius-sm)] border border-border bg-surface px-2 py-1 text-[13px] text-text"
              data-testid="shared-norms-text"
            />
          </label>
          <fieldset>
            <legend className="mb-1 font-semibold text-text">Agents may send these without asking you (after the first 10 messages)</legend>
            <ul className="space-y-1">
              {norms.allowances.map((a) => (
                <li key={a.key}>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={allow.includes(a.key)}
                      onChange={() => toggle(a.key)}
                      className="mt-[2px]"
                      data-testid={`shared-norms-allow-${a.key}`}
                    />
                    <span>
                      <span className="text-text">{a.label}</span>
                      <span className="ml-1 text-text-3">{a.detail}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="m-0 mt-1 text-text-3">Secrets, children's data and other people's private data are never sent by an agent, whatever the norm says.</p>
          </fieldset>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" disabled={!changed || busy} onClick={() => void save()} data-testid="shared-norms-save">
              Save
            </Button>
            {saved && !changed && <span role="status" data-testid="shared-norms-saved">Saved</span>}
          </div>
        </div>
      )}
      {error && (
        <div className="mt-2">
          <Alert variant="error">{error}</Alert>
        </div>
      )}
    </div>
  );
}
