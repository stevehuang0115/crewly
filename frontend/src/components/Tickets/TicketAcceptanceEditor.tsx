/**
 * TicketAcceptanceEditor — the live acceptance criteria of one ticket.
 *
 * Each criterion shows its source (打回 / 拆解 / 我 / Agent), how it is
 * checked (自动 / 人工) and the agent's self-check and evidence. Criteria can
 * be added and removed; every change sends the full list to
 * `PUT /api/tickets/:id/acceptance` through `onSave`.
 *
 * @module components/Tickets/TicketAcceptanceEditor
 */

import React, { useState } from 'react';
import { Trash2, Plus } from 'lucide-react';
import { Badge } from '@crewly/ui/Badge';
import { Button, IconButton } from '@crewly/ui/Button';
import { FormInput, FormSelect } from '@crewly/ui/Form';
import {
  TICKET_ACCEPTANCE_CHECK_LABEL,
  TICKET_ACCEPTANCE_SOURCE_LABEL,
  TICKET_TEXT,
} from '../../constants/tickets.constants';
import type {
  TicketAcceptance,
  TicketAcceptanceCheck,
  TicketAcceptanceInput,
} from '../../types/ticket.types';
import { toAcceptanceInputs } from '../../utils/ticket.utils';

/** Props for {@link TicketAcceptanceEditor}. */
export interface TicketAcceptanceEditorProps {
  acceptance: TicketAcceptance[];
  /** Persist the full new list */
  onSave: (items: TicketAcceptanceInput[]) => Promise<void>;
  /** Disable editing (e.g. while another action runs) */
  disabled?: boolean;
}

/** Default check for a criterion the owner adds. */
const DEFAULT_NEW_CHECK: TicketAcceptanceCheck = 'judgment';

/**
 * Render and edit the acceptance list.
 *
 * @param props - {@link TicketAcceptanceEditorProps}
 * @returns The editor
 */
export const TicketAcceptanceEditor: React.FC<TicketAcceptanceEditorProps> = ({ acceptance, onSave, disabled = false }) => {
  const [draft, setDraft] = useState('');
  const [draftCheck, setDraftCheck] = useState<TicketAcceptanceCheck>(DEFAULT_NEW_CHECK);
  const [saving, setSaving] = useState(false);
  const busy = disabled || saving;

  /**
   * Save a new list, tracking the busy flag.
   *
   * @param items - Full list to save
   * @returns True when saved
   */
  const save = async (items: TicketAcceptanceInput[]): Promise<boolean> => {
    setSaving(true);
    try {
      await onSave(items);
      return true;
    } catch {
      // The parent shows the error inline.
      return false;
    } finally {
      setSaving(false);
    }
  };

  /**
   * Remove one criterion.
   *
   * @param index - Position in the live list
   */
  const handleRemove = async (index: number): Promise<void> => {
    const items = toAcceptanceInputs(acceptance).filter((_, i) => i !== index);
    await save(items);
  };

  /**
   * Add the drafted criterion.
   *
   * @param e - Form submit event
   */
  const handleAdd = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const ok = await save([...toAcceptanceInputs(acceptance), { text, check: draftCheck }]);
    if (ok) {
      setDraft('');
      setDraftCheck(DEFAULT_NEW_CHECK);
    }
  };

  return (
    <div data-testid="ticket-acceptance">
      {acceptance.length === 0 ? (
        <p className="text-sm text-text-secondary-dark">{TICKET_TEXT.NO_ACCEPTANCE}</p>
      ) : (
        <ul className="space-y-2">
          {acceptance.map((a, i) => (
            <li
              key={`${i}-${a.text}`}
              className="flex items-start gap-2 rounded-2xl border border-border-dark bg-background-dark p-3"
              data-testid="ticket-acceptance-item"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm text-text-primary-dark break-words">{a.text}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <Badge size="sm" variant={a.source === 'reject' ? 'error' : 'default'}>
                    {TICKET_ACCEPTANCE_SOURCE_LABEL[a.source ?? 'owner']}
                  </Badge>
                  <Badge size="sm" variant={a.check === 'auto' ? 'info' : 'default'}>
                    {TICKET_ACCEPTANCE_CHECK_LABEL[a.check ?? 'judgment']}
                  </Badge>
                  {a.selfCheck && (
                    <Badge size="sm" variant={a.selfCheck === 'pass' ? 'success' : 'error'}>
                      {a.selfCheck === 'pass' ? TICKET_TEXT.SELF_CHECK_PASS : TICKET_TEXT.SELF_CHECK_FAIL}
                    </Badge>
                  )}
                </div>
                {a.evidence && <p className="mt-1 text-xs text-text-secondary-dark break-words">{a.evidence}</p>}
              </div>
              <IconButton
                icon={Trash2}
                variant="ghost"
                aria-label={`${TICKET_TEXT.ACCEPTANCE_REMOVE} ${a.text}`}
                disabled={busy}
                onClick={() => void handleRemove(i)}
              />
            </li>
          ))}
        </ul>
      )}
      <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => void handleAdd(e)}>
        <div className="flex-1">
          <FormInput
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={TICKET_TEXT.ACCEPTANCE_ADD_PLACEHOLDER}
            aria-label={TICKET_TEXT.ACCEPTANCE_ADD_PLACEHOLDER}
            disabled={busy}
          />
        </div>
        <div className="sm:w-28">
          <FormSelect
            value={draftCheck}
            onChange={(e) => setDraftCheck(e.target.value as TicketAcceptanceCheck)}
            aria-label={TICKET_TEXT.ACCEPTANCE_CHECK_ARIA}
            disabled={busy}
          >
            <option value="judgment">{TICKET_ACCEPTANCE_CHECK_LABEL.judgment}</option>
            <option value="auto">{TICKET_ACCEPTANCE_CHECK_LABEL.auto}</option>
          </FormSelect>
        </div>
        <Button type="submit" variant="secondary" icon={Plus} disabled={busy || !draft.trim()}>
          {TICKET_TEXT.ACCEPTANCE_ADD}
        </Button>
      </form>
    </div>
  );
};
