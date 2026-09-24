/**
 * Tickets page — the ticket board (specs/ticket-loop.md, Phase 2).
 *
 * Columns 想法 / 待处理 / 进行中 / 阻塞 / 待验收 / 已完成 with counts, a search
 * box (`q`) and a kind filter. Clicking a card opens the detail drawer, where
 * the owner accepts (验过了), sends back (打回) or dismisses (不用记). The board
 * polls every {@link TICKETS_POLL_INTERVAL_MS} and refreshes after any action.
 *
 * On narrow screens the columns scroll sideways inside the board container,
 * never the page.
 *
 * @module pages/Tickets
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Ticket } from 'lucide-react';
import { Alert } from '@crewly/ui/Alert';
import { Badge } from '@crewly/ui/Badge';
import { IconButton } from '@crewly/ui/Button';
import { EmptyState } from '@crewly/ui/EmptyState';
import { Input } from '@crewly/ui/Input';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { SegmentedControl, type SegmentedOption } from '@crewly/ui/SegmentedControl';
import { TicketCard } from '../components/Tickets/TicketCard';
import { TicketDetailDrawer } from '../components/Tickets/TicketDetailDrawer';
import {
  TICKETS_POLL_INTERVAL_MS,
  TICKETS_SEARCH_DEBOUNCE_MS,
  TICKET_BOARD_COLUMN_ORDER,
  TICKET_COLUMN_LABEL,
  TICKET_KINDS,
  TICKET_KIND_FILTER_ALL,
  TICKET_KIND_FILTER_ALL_LABEL,
  TICKET_KIND_LABEL,
  TICKET_TEXT,
} from '../constants/tickets.constants';
import { fetchTickets } from '../services/tickets.service';
import type { TicketBoardResponse, TicketKind, TicketListItem } from '../types/ticket.types';
import { groupTicketsByColumn, ticketErrorMessage } from '../utils/ticket.utils';

/** Kind filter value. */
type KindFilter = TicketKind | typeof TICKET_KIND_FILTER_ALL;

/** Kind filter options: 全部 + each kind. */
const KIND_FILTER_OPTIONS: SegmentedOption<KindFilter>[] = [
  { value: TICKET_KIND_FILTER_ALL, label: TICKET_KIND_FILTER_ALL_LABEL },
  ...TICKET_KINDS.map((k) => ({ value: k as KindFilter, label: TICKET_KIND_LABEL[k] })),
];

/** Props for {@link Tickets}. */
export interface TicketsProps {
  /** Current time in ms (injectable for tests) */
  now?: number;
}

/**
 * Render the ticket board page.
 *
 * @param props - {@link TicketsProps}
 * @returns The page
 */
export const Tickets: React.FC<TicketsProps> = ({ now }) => {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [kind, setKind] = useState<KindFilter>(TICKET_KIND_FILTER_ALL);
  const [data, setData] = useState<TicketBoardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Guards against an older response overwriting a newer one. */
  const requestSeq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), TICKETS_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  /** Fetch the board with the current filters. */
  const load = useCallback(async (): Promise<void> => {
    const seq = ++requestSeq.current;
    try {
      const result = await fetchTickets({
        ...(kind !== TICKET_KIND_FILTER_ALL ? { kind } : {}),
        ...(debouncedSearch.trim() ? { q: debouncedSearch } : {}),
      });
      if (seq !== requestSeq.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(ticketErrorMessage(err));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [kind, debouncedSearch]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), TICKETS_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const groups = useMemo(() => groupTicketsByColumn(data?.tickets ?? []), [data]);
  const filtered = kind !== TICKET_KIND_FILTER_ALL || debouncedSearch.trim() !== '';
  const boardEmpty = data !== null && data.tickets.length === 0 && !filtered;

  /**
   * Open a ticket's detail.
   *
   * @param ticket - Clicked card
   */
  const handleOpen = useCallback((ticket: TicketListItem): void => setSelectedId(ticket.id), []);

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-4" data-testid="tickets-page">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-text-primary-dark">{TICKET_TEXT.PAGE_TITLE}</h1>
          <p className="mt-1 text-sm text-text-secondary-dark">{TICKET_TEXT.PAGE_SUBTITLE}</p>
        </div>
        <IconButton
          icon={RefreshCw}
          variant="ghost"
          aria-label={TICKET_TEXT.REFRESH}
          onClick={() => void load()}
        />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="w-full sm:max-w-xs">
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={TICKET_TEXT.SEARCH_PLACEHOLDER}
            aria-label={TICKET_TEXT.SEARCH_PLACEHOLDER}
            fullWidth
          />
        </div>
        <div className="max-w-full overflow-x-auto">
          <SegmentedControl<KindFilter>
            options={KIND_FILTER_OPTIONS}
            value={kind}
            onChange={setKind}
            size="sm"
            aria-label={TICKET_TEXT.KIND_FILTER_ARIA}
          />
        </div>
      </div>

      {error && (
        <Alert variant="error" size="sm" title={TICKET_TEXT.LOAD_FAILED}>
          {error}
        </Alert>
      )}

      {loading && !data ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner />
        </div>
      ) : boardEmpty ? (
        <EmptyState icon={Ticket} title={TICKET_TEXT.EMPTY_BOARD_TITLE} description={TICKET_TEXT.EMPTY_BOARD_DESC} />
      ) : (
        <div className="w-full min-w-0 overflow-x-auto pb-2" data-testid="tickets-board">
          <div className="flex gap-3 snap-x">
            {TICKET_BOARD_COLUMN_ORDER.map((col) => {
              const items = groups[col] ?? [];
              const count = data?.columns?.[col] ?? items.length;
              return (
                <section
                  key={col}
                  aria-label={TICKET_COLUMN_LABEL[col]}
                  data-testid={`tickets-column-${col}`}
                  className="flex w-64 shrink-0 snap-start flex-col rounded-2xl border border-border-dark bg-surface-dark/50 p-2 sm:w-72"
                >
                  <header className="flex items-center justify-between px-1 pb-2">
                    <h2 className="text-sm font-semibold text-text-primary-dark">{TICKET_COLUMN_LABEL[col]}</h2>
                    <Badge size="sm" variant={col === 'to_review' && count > 0 ? 'primary' : 'default'}>
                      {count}
                    </Badge>
                  </header>
                  <div className="flex flex-col gap-2">
                    {items.length === 0 ? (
                      <p className="px-1 py-4 text-center text-xs text-text-secondary-dark">{TICKET_TEXT.EMPTY_COLUMN}</p>
                    ) : (
                      items.map((t) => <TicketCard key={t.id} ticket={t} onOpen={handleOpen} now={now} />)
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}

      <TicketDetailDrawer
        ticketId={selectedId}
        onClose={() => setSelectedId(null)}
        onChanged={() => void load()}
        now={now}
      />
    </div>
  );
};

export default Tickets;
