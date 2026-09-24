/**
 * TicketDetailDrawer — one ticket's detail, opened from a board card.
 *
 * Shows the editable title, priority and kind; origin and description; the
 * agent's answer and the discussion; the acceptance criteria (editable); and
 * the owner's actions 验过了 / 打回 (reason required) / 不用记. Server
 * refusals are shown inline. Every successful action calls `onChanged` so
 * the board refreshes right away.
 *
 * @module components/Tickets/TicketDetailDrawer
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Check, Undo2, X } from 'lucide-react';
import { Drawer } from '@crewly/ui/Drawer';
import { Alert } from '@crewly/ui/Alert';
import { Badge } from '@crewly/ui/Badge';
import { Button } from '@crewly/ui/Button';
import { FormInput, FormSelect, FormTextarea } from '@crewly/ui/Form';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import {
  TICKET_COLUMN_LABEL,
  TICKET_KINDS,
  TICKET_KIND_LABEL,
  TICKET_PRIORITY_OPTIONS,
  TICKET_TEXT,
} from '../../constants/tickets.constants';
import {
  dismissTicket,
  fetchTicket,
  patchTicket,
  rejectTicket,
  setTicketAcceptance,
  verifyTicket,
} from '../../services/tickets.service';
import type {
  TicketAcceptanceInput,
  TicketDetailResponse,
  TicketKind,
  TicketPatchInput,
  TicketPriority,
} from '../../types/ticket.types';
import { autoAcceptLabel, formatOrigin, formatTicketTime, ticketErrorMessage } from '../../utils/ticket.utils';
import { TicketAcceptanceEditor } from './TicketAcceptanceEditor';

/** Props for {@link TicketDetailDrawer}. */
export interface TicketDetailDrawerProps {
  /** Ticket id to show; null = closed */
  ticketId: string | null;
  onClose: () => void;
  /** Called after any successful change so the board can refresh */
  onChanged: () => void;
  /** Current time in ms (injectable for tests) */
  now?: number;
}

/** Actions that can be in flight (one at a time). */
type BusyAction = 'verify' | 'reject' | 'dismiss' | 'patch' | 'acceptance';

/** Columns where the owner can still act on a ticket. */
const CLOSED_COLUMNS = new Set(['done', 'cancelled']);

/**
 * A titled section of the drawer body.
 *
 * @param props - `title` and children
 * @returns The section
 */
const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="space-y-2">
    <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary-dark">{title}</h3>
    {children}
  </section>
);

/**
 * Render the ticket detail drawer.
 *
 * @param props - {@link TicketDetailDrawerProps}
 * @returns The drawer (renders nothing when `ticketId` is null)
 */
export const TicketDetailDrawer: React.FC<TicketDetailDrawerProps> = ({ ticketId, onClose, onChanged, now }) => {
  const [detail, setDetail] = useState<TicketDetailResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectError, setRejectError] = useState<string | null>(null);

  /**
   * (Re)load the ticket.
   *
   * @param id - Ticket id
   */
  const load = useCallback(async (id: string): Promise<void> => {
    try {
      const data = await fetchTicket(id);
      setDetail(data);
      setTitleDraft(data.board.title);
      setLoadError(null);
    } catch (err) {
      setLoadError(ticketErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    setDetail(null);
    setLoadError(null);
    setActionError(null);
    setRejectOpen(false);
    setRejectReason('');
    setRejectError(null);
    if (ticketId) void load(ticketId);
  }, [ticketId, load]);

  /**
   * Run one owner action with shared busy / error / refresh handling.
   *
   * @param action - Which action (for the busy flag)
   * @param fn - The call
   * @param closeAfter - Close the drawer on success instead of reloading
   * @returns True on success
   */
  const run = async (action: BusyAction, fn: () => Promise<unknown>, closeAfter = false): Promise<boolean> => {
    if (!ticketId) return false;
    setBusy(action);
    setActionError(null);
    try {
      await fn();
      onChanged();
      if (closeAfter) onClose();
      else await load(ticketId);
      return true;
    } catch (err) {
      setActionError(ticketErrorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  /**
   * Save a board edit.
   *
   * @param patch - Fields to change
   */
  const handlePatch = (patch: TicketPatchInput): void => {
    if (!ticketId) return;
    void run('patch', () => patchTicket(ticketId, patch));
  };

  /**
   * Persist the acceptance list; throws so the editor keeps its draft on failure.
   *
   * @param items - Full list
   */
  const handleSaveAcceptance = async (items: TicketAcceptanceInput[]): Promise<void> => {
    if (!ticketId) return;
    const ok = await run('acceptance', () => setTicketAcceptance(ticketId, items));
    if (!ok) throw new Error('acceptance save failed');
  };

  /** Submit 打回 — refuses an empty reason without calling the server. */
  const handleConfirmReject = (): void => {
    if (!ticketId) return;
    const reason = rejectReason.trim();
    if (!reason) {
      setRejectError(TICKET_TEXT.REJECT_REASON_REQUIRED);
      return;
    }
    setRejectError(null);
    void run('reject', () => rejectTicket(ticketId, reason)).then((ok) => {
      if (ok) {
        setRejectOpen(false);
        setRejectReason('');
      }
    });
  };

  const board = detail?.board ?? null;
  const open = ticketId !== null;
  const canAct = board !== null && !CLOSED_COLUMNS.has(board.column);
  const inReview = board?.column === 'to_review';
  const titleChanged = board !== null && titleDraft.trim() !== '' && titleDraft.trim() !== board.title;
  const discussion = detail?.ticket.discussion ?? [];
  const description = board?.description || (detail?.ticket.description as string | undefined) || '';
  const countdown = inReview ? autoAcceptLabel(board?.autoAcceptAt, now) : null;

  const footer = board && canAct ? (
    rejectOpen ? (
      <div className="flex w-full flex-col gap-2" data-testid="ticket-reject-form">
        <label htmlFor="ticket-reject-reason" className="text-sm text-text-secondary-dark">
          {TICKET_TEXT.REJECT_REASON_LABEL}
        </label>
        <FormTextarea
          id="ticket-reject-reason"
          rows={3}
          value={rejectReason}
          error={rejectError !== null}
          placeholder={TICKET_TEXT.REJECT_REASON_PLACEHOLDER}
          onChange={(e) => {
            setRejectReason(e.target.value);
            if (rejectError) setRejectError(null);
          }}
        />
        {rejectError && (
          <p className="text-xs text-red-400" role="alert">
            {rejectError}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRejectOpen(false)} disabled={busy !== null}>
            {TICKET_TEXT.CANCEL}
          </Button>
          <Button variant="warning" icon={Undo2} onClick={handleConfirmReject} loading={busy === 'reject'}>
            {TICKET_TEXT.REJECT_CONFIRM}
          </Button>
        </div>
      </div>
    ) : (
      <div className="flex w-full flex-wrap items-center justify-end gap-2">
        <Button
          variant="danger-ghost"
          icon={X}
          onClick={() => void run('dismiss', () => dismissTicket(ticketId as string), true)}
          loading={busy === 'dismiss'}
          disabled={busy !== null && busy !== 'dismiss'}
        >
          {TICKET_TEXT.DISMISS}
        </Button>
        {inReview && (
          <Button variant="warning" icon={Undo2} onClick={() => setRejectOpen(true)} disabled={busy !== null}>
            {TICKET_TEXT.REJECT}
          </Button>
        )}
        <Button
          variant="success"
          icon={Check}
          onClick={() => void run('verify', () => verifyTicket(ticketId as string), true)}
          loading={busy === 'verify'}
          disabled={busy !== null && busy !== 'verify'}
        >
          {TICKET_TEXT.VERIFY}
        </Button>
      </div>
    )
  ) : undefined;

  return (
    <Drawer
      isOpen={open}
      onClose={onClose}
      size="lg"
      title={board?.tkt ?? board?.title ?? TICKET_TEXT.DETAIL_LOADING}
      subtitle={board ? TICKET_COLUMN_LABEL[board.column] ?? board.column : undefined}
      footer={footer}
      data-testid="ticket-detail-drawer"
    >
      {!board && !loadError && (
        <div className="flex justify-center py-8">
          <LoadingSpinner />
        </div>
      )}
      {loadError && (
        <Alert variant="error" size="sm">
          {loadError}
        </Alert>
      )}
      {board && (
        <div className="space-y-6">
          {actionError && (
            <Alert variant="error" size="sm" onClose={() => setActionError(null)} data-testid="ticket-action-error">
              {actionError}
            </Alert>
          )}

          <div className="space-y-3">
            <div>
              <label htmlFor="ticket-title" className="mb-1 block text-sm text-text-secondary-dark">
                {TICKET_TEXT.TITLE_LABEL}
              </label>
              <div className="flex gap-2">
                <FormInput id="ticket-title" value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} />
                {titleChanged && (
                  <Button
                    variant="secondary"
                    onClick={() => handlePatch({ title: titleDraft.trim() })}
                    loading={busy === 'patch'}
                  >
                    {TICKET_TEXT.SAVE}
                  </Button>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="ticket-priority" className="mb-1 block text-sm text-text-secondary-dark">
                  {TICKET_TEXT.PRIORITY_LABEL}
                </label>
                <FormSelect
                  id="ticket-priority"
                  value={board.priority}
                  disabled={busy !== null}
                  onChange={(e) => handlePatch({ priority: e.target.value as TicketPriority })}
                >
                  {TICKET_PRIORITY_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </FormSelect>
              </div>
              <div>
                <label htmlFor="ticket-kind" className="mb-1 block text-sm text-text-secondary-dark">
                  {TICKET_TEXT.KIND_LABEL}
                </label>
                <FormSelect
                  id="ticket-kind"
                  value={board.kind}
                  disabled={busy !== null}
                  onChange={(e) => handlePatch({ kind: e.target.value as TicketKind })}
                >
                  {TICKET_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {TICKET_KIND_LABEL[k]}
                    </option>
                  ))}
                </FormSelect>
              </div>
            </div>
            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-text-secondary-dark">{TICKET_TEXT.ORIGIN_LABEL}</dt>
                <dd className="text-text-primary-dark" data-testid="ticket-origin">
                  {formatOrigin(board.origin) ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="text-text-secondary-dark">{TICKET_TEXT.ASSIGNEE_LABEL}</dt>
                <dd className="text-text-primary-dark">{board.assignee || TICKET_TEXT.UNASSIGNED}</dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-1">
              {(board.rejectCount ?? 0) > 0 && (
                <Badge variant="error" size="sm">
                  {board.rejectCount}
                  {TICKET_TEXT.REJECTED_TIMES}
                </Badge>
              )}
              {(board.submitCount ?? 0) > 0 && (
                <Badge size="sm">
                  {board.submitCount}
                  {TICKET_TEXT.SUBMITTED_TIMES}
                </Badge>
              )}
              {countdown && (
                <Badge variant="primary" size="sm">
                  {countdown}
                </Badge>
              )}
            </div>
          </div>

          {description && (
            <Section title={TICKET_TEXT.DESCRIPTION_LABEL}>
              <p className="whitespace-pre-wrap break-words text-sm text-text-primary-dark">{description}</p>
            </Section>
          )}

          <Section title={TICKET_TEXT.REPLY_LABEL}>
            {board.reply ? (
              <div className="rounded-2xl border border-border-dark bg-background-dark p-3" data-testid="ticket-reply">
                <p className="whitespace-pre-wrap break-words text-sm text-text-primary-dark">{board.reply.excerpt}</p>
                <p className="mt-1 text-xs text-text-secondary-dark">
                  {board.reply.by} · {formatTicketTime(board.reply.at)}
                </p>
              </div>
            ) : (
              <p className="text-sm text-text-secondary-dark">{TICKET_TEXT.NO_REPLY}</p>
            )}
          </Section>

          <Section title={TICKET_TEXT.ACCEPTANCE_LABEL}>
            <TicketAcceptanceEditor
              acceptance={board.acceptance ?? []}
              onSave={handleSaveAcceptance}
              disabled={busy !== null && busy !== 'acceptance'}
            />
          </Section>

          <Section title={TICKET_TEXT.DISCUSSION_LABEL}>
            {discussion.length === 0 ? (
              <p className="text-sm text-text-secondary-dark">{TICKET_TEXT.NO_DISCUSSION}</p>
            ) : (
              <ul className="space-y-2" data-testid="ticket-discussion">
                {discussion.map((d, i) => (
                  <li key={`${d.ref}-${i}`} className="rounded-2xl border border-border-dark p-3">
                    <p className="text-xs text-text-secondary-dark">
                      {d.author} · {formatTicketTime(d.at)}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-text-primary-dark">{d.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </Drawer>
  );
};
