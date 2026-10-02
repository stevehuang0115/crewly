/**
 * TicketBoardCard — one card on the Tickets board: the title, the assignee's
 * name and, only when it matters, one status word (auto-accept countdown,
 * sent back, accepted, backlog). Priority shows only for P0 / P1.
 *
 * @module components/Tickets/TicketBoardCard
 */

import React from 'react';
import type { BoardCard } from './board.utils';
import { TICKET_TEXT } from '../../constants/tickets.constants';

/** Props for {@link TicketBoardCard}. */
export interface TicketBoardCardProps {
  card: BoardCard;
  /** Assignee's display name (null = unassigned) */
  assigneeName: string | null;
  onOpen: (card: BoardCard) => void;
}

/** Text colour per flag tone. */
const FLAG_CLASS: Record<string, string> = {
  attention: 'text-attention',
  danger: 'text-danger',
  success: 'text-success',
  primary: 'text-primary-text',
  neutral: 'text-text-3',
};

/**
 * Render one card. The whole card is a button that opens the ticket.
 *
 * @param props - {@link TicketBoardCardProps}
 * @returns The card
 */
export const TicketBoardCard: React.FC<TicketBoardCardProps> = ({ card, assigneeName, onOpen }) => {
  const urgent = card.priority === 'P0' || card.priority === 'P1';
  return (
    <button
      type="button"
      onClick={() => onOpen(card)}
      aria-label={`${card.ref ?? ''} ${card.fullTitle}`.trim()}
      title={card.fullTitle}
      data-testid={`ticket-card-${card.key}`}
      className="block w-full rounded-[0.5rem] bg-surface px-3.5 py-3 text-left transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
    >
      <span className="line-clamp-2 break-words text-[15px] font-semibold leading-snug text-text">{card.title}</span>
      <span className="mt-1 block truncate text-[13px] leading-snug text-text-2">
        {urgent && (
          <>
            <span className={card.priority === 'P0' ? 'font-bold text-danger' : 'font-bold text-attention'} data-testid="ticket-card-priority">
              {card.priority}
            </span>
            <span className="text-text-3"> · </span>
          </>
        )}
        <span className={assigneeName ? undefined : 'text-text-3'}>{assigneeName ?? TICKET_TEXT.UNASSIGNED}</span>
        {card.flag && (
          <>
            <span className="text-text-3"> · </span>
            <span className={`font-semibold ${FLAG_CLASS[card.flag.tone] ?? 'text-text-2'}`} title={card.flag.title} data-testid="ticket-card-flag">
              {card.flag.text}
            </span>
          </>
        )}
      </span>
    </button>
  );
};
