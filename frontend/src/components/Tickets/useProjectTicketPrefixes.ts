/**
 * Known project ticket id prefixes (`CE`, `FLO`), so run titles can be
 * linked to their ticket without mistaking `GPT-5` or `UTF-8` for one.
 *
 * Loaded once per page session from `GET /api/project-tickets` and shared by
 * every caller; a failed load is forgotten so the next caller tries again.
 *
 * @module components/Tickets/useProjectTicketPrefixes
 */

import { useEffect, useState } from 'react';
import { listAllProjectTickets } from '../../services/project-tickets.service';
import { ticketPrefixes } from './board.utils';

let cache: Promise<Set<string>> | null = null;

/**
 * Load (or reuse) the prefixes.
 *
 * @returns The prefixes
 */
export function loadProjectTicketPrefixes(): Promise<Set<string>> {
  if (!cache) {
    cache = Promise.resolve()
      .then(() => listAllProjectTickets())
      .then((groups) => ticketPrefixes(groups.flatMap((g) => g.tickets.map((t) => t.id))))
      .catch((err) => {
        cache = null;
        throw err;
      });
  }
  return cache;
}

/** Forget the cached prefixes (tests). */
export function resetProjectTicketPrefixes(): void {
  cache = null;
}

/**
 * The known project ticket prefixes; empty until loaded (or when the load
 * fails — then only `TKT-n` refs are recognised).
 *
 * @returns The prefixes
 */
export function useProjectTicketPrefixes(): ReadonlySet<string> {
  const [prefixes, setPrefixes] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let alive = true;
    loadProjectTicketPrefixes()
      .then((p) => {
        if (alive) setPrefixes(p);
      })
      .catch(() => {
        // Only TKT-n refs are recognised meanwhile.
      });
    return () => {
      alive = false;
    };
  }, []);
  return prefixes;
}
