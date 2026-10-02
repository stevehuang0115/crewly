/**
 * Tickets › Board (specs/2026-10-02-ui-redesign.md §Tickets).
 *
 * The board itself is {@link TicketBoard} (also used by Projects › Tasks with
 * `projectId`); this page is the Board tab of the Tickets hub, which owns the
 * page header and the "New ticket" button.
 *
 * @module pages/Tickets
 */

import React from 'react';
import { TicketBoard, type TicketBoardProps } from '../components/Tickets/TicketBoard';

/** Props for {@link Tickets}: the board's props. */
export type TicketsProps = TicketBoardProps;

/**
 * Render the Board tab.
 *
 * @param props - {@link TicketsProps}
 * @returns The board
 */
export const Tickets: React.FC<TicketsProps> = (props) => <TicketBoard {...props} />;

export { TicketBoard };
export type { TicketBoardProps, TicketBoardCounts } from '../components/Tickets/TicketBoard';

export default Tickets;
