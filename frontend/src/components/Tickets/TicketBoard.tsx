/**
 * TicketBoard — the Tickets board (specs/2026-10-02-ui-redesign.md §Tickets),
 * reused by Tickets › Board and Projects › Tasks.
 *
 * It shows the owner's asks (`TKT-n`) and every project's tickets (`CE-n`)
 * in one board: **To review** first and highlighted, then In progress,
 * To do and Blocked, at most {@link BOARD_COLUMN_LIMIT} cards each before
 * "Show all N". Ideas and Done fold into one quiet line with "Show".
 * Project, type and cancelled filters sit behind one Filter button (active
 * filters as removable chips); search is an icon that opens a box.
 *
 * Clicking an ask opens the ticket drawer (Verified / Send back / Dismiss,
 * acceptance, title / priority / type edits); clicking a project ticket
 * opens its editor (fields, status moves, assign). "New ticket" creates a
 * project ticket. The board polls every {@link TICKETS_POLL_INTERVAL_MS}.
 *
 * Pass `projectId` to lock it to one project (asks, which belong to no
 * project, are then left out).
 *
 * @module components/Tickets/TicketBoard
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, RefreshCw, Ticket } from 'lucide-react';
import { Alert } from '@crewly/ui/Alert';
import { Button, IconButton } from '@crewly/ui/Button';
import { EmptyState } from '@crewly/ui/EmptyState';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { FilterButton, type FilterGroup, type FilterValue } from '@crewly/ui';
import { cn } from '@crewly/ui/cn';
import {
  TICKETS_POLL_INTERVAL_MS,
  TICKETS_SEARCH_DEBOUNCE_MS,
  TICKET_BOARD_TEXT,
  TICKET_COLUMN_LABEL,
  TICKET_EMPTY_COLUMN_TEXT,
  TICKET_KINDS,
  TICKET_KIND_LABEL,
  TICKET_TEXT,
} from '../../constants/tickets.constants';
import { fetchTickets } from '../../services/tickets.service';
import { listAllProjectTickets, listProjectTickets } from '../../services/project-tickets.service';
import type { Team } from '../../types';
import type { TicketBoardColumn, TicketKind, TicketListItem } from '../../types/ticket.types';
import type { InvalidProjectTicketFile, ProjectTicket } from '../../types/project-ticket.types';
import { ticketErrorMessage } from '../../utils/ticket.utils';
import { TicketDetailDrawer } from './TicketDetailDrawer';
import { TicketBoardCard } from './TicketBoardCard';
import { ProjectTicketDialog } from './ProjectTicketDialog';
import { SearchToggle } from './SearchToggle';
import { useTeams } from './useTeams';
import {
  BOARD_COLUMN_LIMIT,
  BOARD_MAIN_COLUMNS,
  BOARD_QUIET_COLUMNS,
  NO_PROJECT,
  agentDisplayName,
  cardMatchesSearch,
  groupCards,
  projectTicketToCard,
  ticketToCard,
  type BoardCard,
  type BoardProject,
} from './board.utils';

/** Counts the board reports to its container (tab badges). */
export interface TicketBoardCounts {
  /** Cards waiting for the owner's review */
  toReview: number;
  /** Every card except cancelled ones */
  total: number;
}

/** Props for {@link TicketBoard}. */
export interface TicketBoardProps {
  /** Lock the board to one project (Projects › Tasks). Asks are left out. */
  projectId?: string;
  /** Teams, when the caller has them (names and assignee choices); fetched otherwise */
  teams?: Team[];
  /** Show the board's own "New ticket" button (default true) */
  showNewTicket?: boolean;
  /** Change it to reload the board (e.g. after a ticket was created elsewhere) */
  refreshKey?: number;
  /** Told the counts after each load */
  onCountsChange?: (counts: TicketBoardCounts) => void;
  /** Refresh interval in ms; 0 disables polling (tests) */
  pollIntervalMs?: number;
  /** Current time in ms (injectable for tests) */
  now?: number;
}

/** One project's tickets as loaded. */
interface ProjectGroup {
  project: BoardProject;
  tickets: ProjectTicket[];
}

/** Ticket opened in the project ticket editor. */
interface EditingProjectTicket {
  ticket: ProjectTicket;
  projectId: string;
}

const EMPTY_FILTER: FilterValue = { project: [], type: [], include: [] };

/**
 * Render the board.
 *
 * @param props - {@link TicketBoardProps}
 * @returns The board
 */
export const TicketBoard: React.FC<TicketBoardProps> = ({
  projectId,
  teams: providedTeams,
  showNewTicket = true,
  refreshKey = 0,
  onCountsChange,
  pollIntervalMs = TICKETS_POLL_INTERVAL_MS,
  now,
}) => {
  const { teams, names } = useTeams(providedTeams);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filter, setFilter] = useState<FilterValue>(EMPTY_FILTER);
  const [asks, setAsks] = useState<TicketListItem[]>([]);
  const [cancelledAsks, setCancelledAsks] = useState<TicketListItem[]>([]);
  const [askCancelledCount, setAskCancelledCount] = useState(0);
  const [groups, setGroups] = useState<ProjectGroup[]>([]);
  const [invalid, setInvalid] = useState<InvalidProjectTicketFile[]>([]);
  const [asksLoaded, setAsksLoaded] = useState(false);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [selectedAsk, setSelectedAsk] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingProjectTicket | null>(null);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<Set<TicketBoardColumn>>(new Set());
  const [quietOpen, setQuietOpen] = useState(false);
  const asksLoader = useRef<LoaderState>(newLoaderState());
  const projectsLoader = useRef<LoaderState>(newLoaderState());

  const kind = (filter.type?.[0] as TicketKind | undefined) ?? undefined;
  const projectFilter = projectId ?? filter.project?.[0] ?? null;
  const includeCancelled = (filter.include ?? []).includes('cancelled');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), TICKETS_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // Asks depend on the type / search / cancelled filters; project tickets
  // only on the project (their search and filters are applied locally).
  const askKey = projectId ? 'locked' : JSON.stringify([kind ?? '', debouncedSearch.trim(), includeCancelled]);
  const projectKey = projectId ?? '*';
  asksLoader.current.key = askKey;
  projectsLoader.current.key = projectKey;

  /**
   * Fetch the asks (and cancelled asks when included).
   *
   * @param fromPoll - A poll tick: skipped while a load is still in flight
   */
  const loadAsks = useCallback(
    async (fromPoll = false): Promise<void> => {
      if (projectId) {
        setAsksLoaded(true);
        return;
      }
      await runLoad(asksLoader.current, askKey, fromPoll, async () => {
        const askQuery = {
          ...(kind ? { kind } : {}),
          ...(debouncedSearch.trim() ? { q: debouncedSearch } : {}),
        };
        const [cancelledRes, asksRes] = await Promise.allSettled([
          includeCancelled ? fetchTickets({ column: 'cancelled', ...askQuery }) : Promise.resolve(null),
          fetchTickets(askQuery),
        ]);
        return () => {
          if (asksRes.status === 'fulfilled') {
            setAsks(asksRes.value?.tickets ?? []);
            setAskCancelledCount(asksRes.value?.columns?.cancelled ?? 0);
            setAskError(null);
          } else {
            setAskError(ticketErrorMessage(asksRes.reason));
          }
          if (cancelledRes.status === 'fulfilled') setCancelledAsks(cancelledRes.value?.tickets ?? []);
          setAsksLoaded(true);
        };
      });
    },
    [projectId, askKey, kind, debouncedSearch, includeCancelled],
  );

  /**
   * Fetch project tickets: one project when locked, else every project.
   *
   * @param fromPoll - A poll tick: skipped while a load is still in flight
   */
  const loadProjects = useCallback(
    async (fromPoll = false): Promise<void> => {
      await runLoad(projectsLoader.current, projectKey, fromPoll, async () => {
        try {
          const value = projectId
            ? await listProjectTickets(projectId).then((r) => ({
                groups: [{ project: { id: r.project?.id ?? projectId, name: r.project?.name ?? projectId }, tickets: r.tickets }],
                invalid: r.invalid,
              }))
            : await listAllProjectTickets().then((g) => ({
                groups: g.map((x) => ({ project: { id: x.project.id, name: x.project.name }, tickets: x.tickets })),
                invalid: [] as InvalidProjectTicketFile[],
              }));
          return () => {
            setGroups(value.groups);
            setInvalid(value.invalid);
            setProjectError(null);
            setProjectsLoaded(true);
          };
        } catch (err) {
          return () => {
            setProjectError(ticketErrorMessage(err));
            setProjectsLoaded(true);
          };
        }
      });
    },
    [projectId, projectKey],
  );

  /** Reload both sources now. */
  const loadAll = useCallback((): void => {
    void loadAsks();
    void loadProjects();
  }, [loadAsks, loadProjects]);

  useEffect(() => {
    void loadAsks();
  }, [loadAsks, refreshKey]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects, refreshKey]);

  // Poll: skip a tick while the previous load is still running or the tab
  // is hidden. The all-projects listing is the heavy one, so it refreshes
  // every PROJECTS_POLL_EVERY ticks; asks (and a locked project) every tick.
  const tick = useRef(0);
  useEffect(() => {
    if (!pollIntervalMs) return undefined;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      tick.current += 1;
      void loadAsks(true);
      if (projectId || tick.current % PROJECTS_POLL_EVERY === 0) void loadProjects(true);
    }, pollIntervalMs);
    const onVisible = (): void => {
      if (!document.hidden) {
        void loadAsks(true);
        void loadProjects(true);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadAsks, loadProjects, pollIntervalMs, projectId]);

  const loaded = asksLoaded && projectsLoaded;
  const error = [askError, projectError].filter(Boolean).join(' · ') || null;

  const projects: BoardProject[] = useMemo(() => groups.map((g) => g.project), [groups]);

  /** Every card that passes the filters. */
  const cards = useMemo(() => {
    const out: BoardCard[] = [];
    const wantAsks = !projectId && (projectFilter === null || projectFilter === NO_PROJECT);
    const wantProjects = !kind && projectFilter !== NO_PROJECT;
    if (wantAsks) {
      for (const t of asks) out.push(ticketToCard(t, now));
      if (includeCancelled) for (const t of cancelledAsks) out.push(ticketToCard(t, now));
    }
    if (wantProjects) {
      for (const g of groups) {
        if (projectFilter && g.project.id !== projectFilter) continue;
        for (const pt of g.tickets) {
          const card = projectTicketToCard(pt, g.project);
          if (card.column === 'cancelled' && !includeCancelled) continue;
          if (!cardMatchesSearch(card, debouncedSearch)) continue;
          out.push(card);
        }
      }
    }
    return out;
  }, [asks, cancelledAsks, groups, projectId, projectFilter, kind, includeCancelled, debouncedSearch, now]);

  const byColumn = useMemo(() => groupCards(cards), [cards]);

  useEffect(() => {
    if (!loaded || !onCountsChange) return;
    onCountsChange({
      toReview: byColumn.to_review.length,
      total: cards.filter((c) => c.column !== 'cancelled').length,
    });
  }, [loaded, byColumn, cards, onCountsChange]);

  /** Cancelled tickets that exist (for the filter option count). */
  const cancelledCount = useMemo(
    () => (projectId ? 0 : askCancelledCount) + groups.reduce((n, g) => n + g.tickets.filter((t) => t.status === 'cancelled').length, 0),
    [projectId, askCancelledCount, groups],
  );

  const filterGroups: FilterGroup[] = useMemo(() => {
    const out: FilterGroup[] = [];
    if (!projectId) {
      out.push({
        id: 'project',
        label: TICKET_BOARD_TEXT.FILTER_PROJECT,
        single: true,
        options: [
          ...groups.map((g) => ({ value: g.project.id, label: g.project.name, count: g.tickets.filter((t) => t.status !== 'cancelled').length })),
          { value: NO_PROJECT, label: TICKET_BOARD_TEXT.NO_PROJECT, count: asks.length },
        ],
      });
      out.push({
        id: 'type',
        label: TICKET_BOARD_TEXT.FILTER_TYPE,
        single: true,
        options: TICKET_KINDS.map((k) => ({ value: k, label: TICKET_KIND_LABEL[k] })),
      });
    }
    out.push({
      id: 'include',
      label: TICKET_BOARD_TEXT.FILTER_INCLUDE,
      options: [{ value: 'cancelled', label: TICKET_BOARD_TEXT.CANCELLED, count: cancelledCount }],
    });
    return out;
  }, [projectId, groups, asks.length, cancelledCount]);

  /**
   * Open a card: the drawer for an ask, the editor for a project ticket.
   *
   * @param card - Clicked card
   */
  const handleOpen = useCallback((card: BoardCard): void => {
    if (card.ticket) setSelectedAsk(card.ticket.id);
    else if (card.projectTicket && card.projectId) setEditing({ ticket: card.projectTicket, projectId: card.projectId });
  }, []);

  const toggleColumn = (col: TicketBoardColumn): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });

  const filtered = debouncedSearch.trim() !== '' || Object.values(filter).some((v) => v.length > 0);
  const boardEmpty = loaded && cards.length === 0 && !filtered && !error;
  const quietColumns: TicketBoardColumn[] = includeCancelled ? [...BOARD_QUIET_COLUMNS, 'cancelled'] : [...BOARD_QUIET_COLUMNS];

  /**
   * Render a list of cards with "Show all N".
   *
   * @param col - Column
   * @param items - Its cards
   * @param limit - Cards shown before "Show all"
   * @returns The cards
   */
  const renderCards = (col: TicketBoardColumn, items: BoardCard[], limit: number): React.ReactNode => {
    const open = expanded.has(col);
    const shown = open ? items : items.slice(0, limit);
    return (
      <>
        {shown.map((c) => (
          <TicketBoardCard key={c.key} card={c} assigneeName={agentDisplayName(c.assignee, names)} onOpen={handleOpen} />
        ))}
        {items.length > limit && (
          <button
            type="button"
            onClick={() => toggleColumn(col)}
            aria-expanded={open}
            className="self-start px-0.5 py-1 text-[13px] font-semibold text-primary-text hover:underline"
            data-testid={`tickets-column-${col}-more`}
          >
            {open ? TICKET_BOARD_TEXT.SHOW_LESS : `Show all ${items.length}`}
          </button>
        )}
      </>
    );
  };

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-6" data-testid="tickets-page">
      <div className="flex flex-wrap items-center gap-2">
        <FilterButton groups={filterGroups} value={filter} onChange={setFilter} />
        <SearchToggle value={search} onChange={setSearch} placeholder={TICKET_TEXT.SEARCH_PLACEHOLDER} data-testid="tickets-search" />
        <div className="ml-auto flex items-center gap-2">
          <IconButton icon={RefreshCw} variant="ghost" aria-label={TICKET_TEXT.REFRESH} onClick={loadAll} />
          {showNewTicket && (
            <Button size="sm" icon={Plus} onClick={() => setCreating(true)}>
              {TICKET_BOARD_TEXT.NEW_TICKET}
            </Button>
          )}
        </div>
      </div>

      {projectId && <p className="-mt-3 text-[13px] text-text-2">{TICKET_BOARD_TEXT.PROJECT_HINT}</p>}
      {kind && <p className="-mt-3 text-[13px] text-text-2">{TICKET_BOARD_TEXT.TYPE_HIDES_PROJECT}</p>}

      {error && (
        <Alert variant="error" size="sm" title={TICKET_TEXT.LOAD_FAILED}>
          {error}
        </Alert>
      )}
      {invalid.length > 0 && (
        <Alert variant="warning" size="sm">
          {invalid.length} file(s) in .crewly/tickets/ could not be read: {invalid.map((i) => `${i.fileName} (${i.error})`).join('; ')}
        </Alert>
      )}

      {!loaded ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner />
        </div>
      ) : boardEmpty ? (
        <EmptyState
          icon={Ticket}
          title={projectId ? TICKET_BOARD_TEXT.EMPTY_PROJECT_TITLE : TICKET_TEXT.EMPTY_BOARD_TITLE}
          description={projectId ? TICKET_BOARD_TEXT.EMPTY_PROJECT_DESC : TICKET_TEXT.EMPTY_BOARD_DESC}
        />
      ) : (
        <>
          {filtered && cards.length === 0 && <p className="text-[13px] text-text-2">{TICKET_BOARD_TEXT.NO_MATCH}</p>}
          <div className="grid min-w-0 grid-cols-1 items-start gap-6 sm:grid-cols-2 xl:grid-cols-4" data-testid="tickets-board">
            {BOARD_MAIN_COLUMNS.map((col) => {
              const items = byColumn[col];
              const review = col === 'to_review' && items.length > 0;
              return (
                <section
                  key={col}
                  aria-label={TICKET_COLUMN_LABEL[col]}
                  data-testid={`tickets-column-${col}`}
                  className={cn('flex min-w-0 flex-col gap-2', review && 'rounded-2xl bg-attention-soft p-3')}
                >
                  <header className="flex items-baseline gap-2 px-0.5 pb-1">
                    <h2 className={cn('text-[15px] font-bold leading-snug', review ? 'text-attention' : 'text-text')}>{TICKET_COLUMN_LABEL[col]}</h2>
                    <span className="text-[13px] text-text-2" data-testid={`tickets-column-${col}-count`}>{items.length}</span>
                    {review && <span className="ml-auto text-[13px] font-semibold text-attention">{TICKET_BOARD_TEXT.NEEDS_YOU}</span>}
                  </header>
                  {items.length === 0 ? (
                    <p className="px-0.5 py-3 text-[13px] text-text-3">{TICKET_EMPTY_COLUMN_TEXT[col]}</p>
                  ) : (
                    renderCards(col, items, BOARD_COLUMN_LIMIT)
                  )}
                </section>
              );
            })}
          </div>

          <div className="flex flex-col gap-4 border-t border-border-soft pt-4">
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-2" data-testid="tickets-quiet-line">
              {quietColumns.map((col, i) => (
                <React.Fragment key={col}>
                  {i > 0 && <span className="text-text-3">·</span>}
                  <span>
                    {TICKET_COLUMN_LABEL[col]} {byColumn[col].length}
                  </span>
                </React.Fragment>
              ))}
              <span className="text-text-3">—</span>
              <button
                type="button"
                onClick={() => setQuietOpen((o) => !o)}
                aria-expanded={quietOpen}
                className="font-semibold text-primary-text hover:underline"
                data-testid="tickets-quiet-toggle"
              >
                {quietOpen ? TICKET_BOARD_TEXT.HIDE : TICKET_BOARD_TEXT.SHOW}
              </button>
            </div>
            {quietOpen &&
              quietColumns.map((col) => (
                <section key={col} aria-label={TICKET_COLUMN_LABEL[col]} data-testid={`tickets-column-${col}`} className="flex flex-col gap-2">
                  <h2 className="text-[15px] font-bold text-text">
                    {TICKET_COLUMN_LABEL[col]} <span className="text-[13px] font-normal text-text-2">{byColumn[col].length}</span>
                  </h2>
                  {byColumn[col].length === 0 ? (
                    <p className="py-1 text-[13px] text-text-3">{TICKET_EMPTY_COLUMN_TEXT[col]}</p>
                  ) : (
                    <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2 xl:grid-cols-4">{renderCards(col, byColumn[col], 8)}</div>
                  )}
                </section>
              ))}
          </div>
        </>
      )}

      <TicketDetailDrawer ticketId={selectedAsk} onClose={() => setSelectedAsk(null)} onChanged={() => void loadAsks()} now={now} />
      <ProjectTicketDialog
        open={creating || editing !== null}
        ticket={editing?.ticket ?? null}
        projectId={editing?.projectId ?? projectId ?? (projectFilter && projectFilter !== NO_PROJECT ? projectFilter : undefined)}
        projects={projects}
        teams={teams}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => void loadProjects()}
      />
    </div>
  );
};

/** All-projects listing refreshes every Nth poll tick (it is the heavy request). */
const PROJECTS_POLL_EVERY = 4;

/** Bookkeeping of one data source's loads. */
interface LoaderState {
  /** Filter key the source currently wants */
  key: string;
  /** A load is running */
  inFlight: boolean;
  /** Sequence of the last load started */
  seq: number;
  /** Sequence of the last reply applied */
  applied: number;
}

/**
 * Fresh loader bookkeeping.
 *
 * @returns The state
 */
function newLoaderState(): LoaderState {
  return { key: '', inFlight: false, seq: 0, applied: 0 };
}

/**
 * Run one load of a source. A poll tick is skipped while a load is in
 * flight (so slow replies are never thrown away by the next tick). A reply
 * is dropped only when the filters changed meanwhile (its key is stale) or
 * a newer reply for the same filters was already applied.
 *
 * @param state - The source's bookkeeping
 * @param key - Filter key this load is for
 * @param fromPoll - Started by the poll timer
 * @param fetcher - Does the requests; returns a function that applies the result
 */
async function runLoad(state: LoaderState, key: string, fromPoll: boolean, fetcher: () => Promise<() => void>): Promise<void> {
  if (fromPoll && state.inFlight) return;
  const seq = ++state.seq;
  state.inFlight = true;
  try {
    const apply = await fetcher();
    if (state.key !== key || seq < state.applied) return;
    state.applied = seq;
    apply();
  } finally {
    if (seq === state.seq) state.inFlight = false;
  }
}

export default TicketBoard;
