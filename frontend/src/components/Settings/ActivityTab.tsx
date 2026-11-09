/**
 * Settings › Activity
 *
 * The activity log (issue #881, specs/2026-10-25-activity-log.md): who
 * changed what and when — team and member config, owner decisions, sent
 * mail and WhatsApp drafts, budget stops, browser holds, settings and
 * connector changes. Newest first; filter by who (owner / agent / system),
 * action (exact or a `team.` prefix), target and date range. Each row shows
 * the actor, the action, the target and the changed fields (secrets are
 * masked before they are written, so nothing here needs hiding).
 *
 * @module components/Settings/ActivityTab
 */

import React, { useCallback, useEffect, useState } from 'react';
import { History, RefreshCw } from 'lucide-react';
import { Alert, Button, EmptyState, LoadingSpinner } from '@crewly/ui';
import {
  listActivity,
  type ActivityActorType,
  type ActivityEntry,
  type ActivityQuery,
} from '../../services/activity.service';
import { formatDateTime } from '../../utils/time';

const FIELD =
  'h-9 rounded-lg border border-border bg-bg px-3 text-sm text-text focus:border-primary focus:outline-none';

/** Rows per page, and the steps "Show more" climbs. */
export const ACTIVITY_PAGE_SIZES = [100, 300, 1000] as const;

/** Actor type labels. */
export const ACTOR_TYPE_LABELS: Record<ActivityActorType, string> = {
  owner: 'Owner',
  agent: 'Agent',
  system: 'System',
};

/**
 * One line describing an actor: type, id and how it was recognised.
 *
 * @param actor - Entry actor
 * @returns e.g. `Agent · ce-vera-d8f94e9c (agent-session)`
 */
export function describeActor(actor: ActivityEntry['actor']): string {
  const parts = [ACTOR_TYPE_LABELS[actor.type] ?? actor.type];
  if (actor.id) parts.push(actor.id);
  const head = parts.join(' · ');
  return actor.via ? `${head} (${actor.via})` : head;
}

/**
 * One line describing a target: type, then name or id.
 *
 * @param target - Entry target
 * @returns e.g. `team member · Vera`
 */
export function describeTarget(target: ActivityEntry['target']): string {
  const type = target.type.replace(/[-_]/g, ' ');
  return target.name ? `${type} · ${target.name}` : `${type} · ${target.id}`;
}

/**
 * A compact one-line rendering of a value for the change column.
 *
 * @param value - Any JSON value
 * @returns Text
 */
function compact(value: unknown): string {
  if (value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * The fields an entry changed, as `field: before → after` lines.
 *
 * @param entry - Entry
 * @returns Lines (empty when the entry carries no before / after)
 */
export function changeLines(entry: ActivityEntry): string[] {
  const keys = new Set([...Object.keys(entry.before ?? {}), ...Object.keys(entry.after ?? {})]);
  const lines: string[] = [];
  for (const k of keys) {
    const b = entry.before?.[k];
    const a = entry.after?.[k];
    if (b !== undefined && a !== undefined) lines.push(`${k}: ${compact(b)} → ${compact(a)}`);
    else if (a !== undefined) lines.push(`${k}: ${compact(a)}`);
    else lines.push(`${k}: ${compact(b)} → —`);
  }
  return lines;
}

/** The filter form's state. */
interface Filters {
  actorType: ActivityActorType | '';
  actorId: string;
  action: string;
  targetId: string;
  since: string;
  until: string;
}

const EMPTY_FILTERS: Filters = { actorType: '', actorId: '', action: '', targetId: '', since: '', until: '' };

/**
 * The Activity tab.
 *
 * @returns Panel
 */
export const ActivityTab: React.FC = () => {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [limit, setLimit] = useState<number>(ACTIVITY_PAGE_SIZES[0]);
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (q: Filters, l: number) => {
    setLoading(true);
    setError(null);
    try {
      const query: ActivityQuery = { ...q, limit: l };
      const page = await listActivity(query);
      setEntries(page.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the activity log');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(applied, limit);
  }, [applied, limit, load]);

  const apply = (e: React.FormEvent): void => {
    e.preventDefault();
    setLimit(ACTIVITY_PAGE_SIZES[0]);
    setApplied(filters);
  };

  const reset = (): void => {
    setFilters(EMPTY_FILTERS);
    setLimit(ACTIVITY_PAGE_SIZES[0]);
    setApplied(EMPTY_FILTERS);
  };

  const nextSize = ACTIVITY_PAGE_SIZES.find((s) => s > limit);
  const canShowMore = entries.length >= limit && nextSize !== undefined;
  const set = (patch: Partial<Filters>): void => setFilters((f) => ({ ...f, ...patch }));

  return (
    <div className="flex flex-col gap-6" data-testid="activity-tab">
      <div>
        <h2 className="text-[15px] font-semibold text-text">Activity</h2>
        <p className="text-[13px] text-text-2">
          Who changed what, and when: team and member settings, decisions, sent mail and messages, budget stops, browser holds,
          settings and connections. Newest first. Secrets are masked before anything is written.
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3" onSubmit={apply} data-testid="activity-filters">
        <label className="flex flex-col gap-1 text-xs text-text-2">
          Who
          <select
            className={FIELD}
            value={filters.actorType}
            onChange={(e) => set({ actorType: e.target.value as ActivityActorType | '' })}
            data-testid="activity-filter-actor-type"
          >
            <option value="">Anyone</option>
            {(Object.keys(ACTOR_TYPE_LABELS) as ActivityActorType[]).map((t) => (
              <option key={t} value={t}>
                {ACTOR_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-2">
          Actor id
          <input
            className={FIELD}
            value={filters.actorId}
            onChange={(e) => set({ actorId: e.target.value })}
            placeholder="session or Slack user id"
            data-testid="activity-filter-actor-id"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-2">
          Action
          <input
            className={FIELD}
            value={filters.action}
            onChange={(e) => set({ action: e.target.value })}
            placeholder="team.member.updated or team."
            data-testid="activity-filter-action"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-2">
          Target id
          <input
            className={FIELD}
            value={filters.targetId}
            onChange={(e) => set({ targetId: e.target.value })}
            placeholder="team, member, decision id…"
            data-testid="activity-filter-target-id"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-2">
          From
          <input className={FIELD} type="date" value={filters.since} onChange={(e) => set({ since: e.target.value })} data-testid="activity-filter-since" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-2">
          To
          <input className={FIELD} type="date" value={filters.until} onChange={(e) => set({ until: e.target.value })} data-testid="activity-filter-until" />
        </label>
        <Button type="submit" size="sm" variant="primary">
          Filter
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={reset}>
          Clear
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => void load(applied, limit)} aria-label="Refresh" icon={RefreshCw}>
          Refresh
        </Button>
      </form>

      {error && <Alert variant="error">{error}</Alert>}

      {loading ? (
        <LoadingSpinner centered text="Loading activity…" />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={History}
          title="Nothing recorded"
          description={
            applied === EMPTY_FILTERS
              ? 'Changes to teams, members, settings and connections, decisions and sent messages will show up here.'
              : 'Nothing matches these filters.'
          }
          compact
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border" data-testid="activity-list">
          {entries.map((entry) => {
            const lines = changeLines(entry);
            return (
              <li key={entry.id} className="flex flex-col gap-1 px-4 py-3" data-testid={`activity-${entry.id}`}>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-xs tabular-nums text-text-2" title={entry.ts}>
                    {formatDateTime(entry.ts)}
                  </span>
                  <span className="text-sm font-medium text-text">{describeActor(entry.actor)}</span>
                  <code className="rounded bg-surface px-1.5 py-0.5 text-xs text-text">{entry.action}</code>
                  <span className="text-sm text-text-2">{describeTarget(entry.target)}</span>
                </div>
                {lines.length > 0 && (
                  <ul className="flex flex-col gap-0.5 pl-1 text-xs text-text-2">
                    {lines.map((l) => (
                      <li key={l} className="break-all">
                        {l}
                      </li>
                    ))}
                  </ul>
                )}
                {entry.note && <p className="text-xs italic text-text-2 break-words">{entry.note}</p>}
                {(entry.requestId || entry.workItemId) && (
                  <p className="text-[11px] text-text-3">
                    {entry.requestId ? `request ${entry.requestId}` : ''}
                    {entry.requestId && entry.workItemId ? ' · ' : ''}
                    {entry.workItemId ? `run ${entry.workItemId}` : ''}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!loading && canShowMore && (
        <div>
          <Button size="sm" variant="secondary" onClick={() => setLimit(nextSize)}>
            Show more
          </Button>
        </div>
      )}
    </div>
  );
};
