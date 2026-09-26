/**
 * TicketCard — one ticket on the board.
 *
 * Shows TKT, title, P-label, kind and assignee; for 待验收 also the agent's
 * answer excerpt and the "N天后自动验收" countdown; a "打回 ×N" badge when
 * the ticket has been sent back; for 已完成, whether the owner reviewed it
 * (已验收) or silence accepted it (默认通过 · 未验收, #813).
 *
 * @module components/Tickets/TicketCard
 */

import React from 'react';
import { Card } from '@crewly/ui/Card';
import { Badge } from '@crewly/ui/Badge';
import {
  TICKET_KIND_LABEL,
  TICKET_PRIORITY_VARIANT,
  TICKET_TEXT,
} from '../../constants/tickets.constants';
import type { TicketListItem } from '../../types/ticket.types';
import { autoAcceptLabel } from '../../utils/ticket.utils';

/** Props for {@link TicketCard}. */
export interface TicketCardProps {
  ticket: TicketListItem;
  /** Open the detail drawer */
  onOpen: (ticket: TicketListItem) => void;
  /** Current time in ms (injectable for tests) */
  now?: number;
}

/**
 * Render one board card. The whole card is a keyboard-accessible button.
 *
 * @param props - {@link TicketCardProps}
 * @returns The card
 */
export const TicketCard: React.FC<TicketCardProps> = ({ ticket, onOpen, now }) => {
  const inReview = ticket.column === 'to_review';
  const countdown = inReview ? autoAcceptLabel(ticket.autoAcceptAt, now) : null;
  // #813: a done ticket says whether anyone actually reviewed it.
  const acceptedBy = ticket.column === 'done' ? ticket.acceptedBy ?? null : null;
  const rejectCount = ticket.rejectCount ?? 0;

  /**
   * Open on Enter / Space.
   *
   * @param e - Key event
   */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(ticket);
    }
  };

  return (
    <Card
      padding="sm"
      interactive
      role="button"
      tabIndex={0}
      aria-label={`${ticket.tkt ?? ''} ${ticket.title}`.trim()}
      data-testid={`ticket-card-${ticket.id}`}
      onClick={() => onOpen(ticket)}
      onKeyDown={handleKeyDown}
      className="rounded-2xl focus:outline-none focus:ring-1 focus:ring-primary"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-text-secondary-dark">{ticket.tkt ?? ''}</span>
        <div className="flex items-center gap-1">
          {rejectCount > 0 && (
            <Badge variant="error" size="sm" data-testid="ticket-reject-badge">
              {TICKET_TEXT.REJECT_BADGE} ×{rejectCount}
            </Badge>
          )}
          <Badge variant={TICKET_PRIORITY_VARIANT[ticket.priorityLabel] ?? 'default'} size="sm">
            {ticket.priorityLabel}
          </Badge>
        </div>
      </div>
      <p className="mt-1 text-sm font-medium text-text-primary-dark break-words">{ticket.title}</p>
      {inReview && ticket.reply?.excerpt && (
        <p className="mt-2 text-xs text-text-secondary-dark line-clamp-3 break-words" data-testid="ticket-reply-excerpt">
          {ticket.reply.excerpt}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Badge size="sm">{TICKET_KIND_LABEL[ticket.kind] ?? ticket.kind}</Badge>
        <span className="text-xs text-text-secondary-dark truncate">{ticket.assignee || TICKET_TEXT.UNASSIGNED}</span>
      </div>
      {countdown && (
        <p className="mt-2 text-xs text-primary" data-testid="ticket-auto-accept">
          {countdown}
        </p>
      )}
      {acceptedBy && (
        <div className="mt-2" data-testid="ticket-accepted-by" data-accepted-by={acceptedBy}>
          <Badge
            size="sm"
            variant={acceptedBy === 'owner' ? 'success' : 'warning'}
            title={acceptedBy === 'silence' ? TICKET_TEXT.ACCEPTED_BY_SILENCE_HINT : undefined}
          >
            {acceptedBy === 'owner' ? TICKET_TEXT.ACCEPTED_BY_OWNER : TICKET_TEXT.ACCEPTED_BY_SILENCE}
          </Badge>
        </div>
      )}
    </Card>
  );
};
