/**
 * useUsage Hook
 *
 * Token usage stats, daily token caps and temporary boosts for the Usage
 * page (`/api/system/usage`, `/api/system/usage/caps`,
 * `/api/system/usage/boost`). Extracted from the former Settings › System
 * usage panel so the page keeps its exact behaviour: the same requests, the
 * same confirmation notes and the same validation of typed token amounts.
 *
 * specs/2026-10-02-spend-cap.md, specs/2026-10-02-ui-redesign.md
 *
 * @module hooks/useUsage
 */

import { useCallback, useEffect, useState } from 'react';
import {
  parseTokenInput,
  tokens,
  usageService,
  type BoostRequest,
  type CapsPatch,
  type CapsView,
  type UsageGroupBy,
  type UsageStats,
} from '../services/usage.service';

/** The ranges the page offers, in days (1 = today). */
export const USAGE_PERIODS = [
  { key: '1', label: 'Today' },
  { key: '7', label: '7 days' },
  { key: '30', label: '30 days' },
] as const;

/** One of {@link USAGE_PERIODS}. */
export type UsagePeriod = (typeof USAGE_PERIODS)[number]['key'];

/** Groupings the page reads from the stats endpoint. */
export const USAGE_GROUPS: UsageGroupBy[] = ['team', 'agent', 'runtime', 'workItem', 'model'];

/** Typed cap fields, as the owner entered them (`""` = off). */
export interface CapsDraft {
  /** All agents together, per day */
  total: string;
  /** Default per agent, per day */
  defaultAgent: string;
  /** Per team id; only teams the owner edited */
  teams: Record<string, string>;
  /** Per agent session; only agents the owner edited (`""` = back to the default, `No cap` = never capped) */
  agents: Record<string, string>;
}

/** Result of {@link useUsage}. */
export interface UseUsageResult {
  stats: UsageStats | null;
  caps: CapsView | null;
  /** Last load or action error */
  error: string | null;
  /** Confirmation of the last action */
  note: string | null;
  /** An action is running */
  busy: boolean;
  /** When the data was last loaded */
  lastUpdated: Date | null;
  /** Reload the current period */
  reload: () => Promise<void>;
  /** Boost a team, an agent or everyone until midnight */
  boost: (req: BoostRequest, who: string) => Promise<void>;
  /** End a boost early */
  endBoost: (id: string) => Promise<void>;
  /** Validate and save typed caps */
  saveCaps: (draft: CapsDraft) => Promise<boolean>;
}

/**
 * Build the caps patch from typed fields.
 *
 * @param draft - Typed fields
 * @returns The patch
 * @throws Error with an owner-facing message when an amount can't be read
 */
export function capsPatchFromDraft(draft: CapsDraft): CapsPatch {
  const d = parseTokenInput(draft.defaultAgent);
  const t = parseTokenInput(draft.total);
  if (d === undefined || t === undefined) throw new Error('Caps are token amounts like 5M or 500k, or empty for off.');
  const patch: CapsPatch = { defaultAgentCapTokens: d, totalCapTokens: t };
  const teams: Record<string, number | null> = {};
  for (const [teamId, text] of Object.entries(draft.teams)) {
    const v = parseTokenInput(text);
    if (v === undefined) throw new Error('Team caps are token amounts like 50M, or empty for no cap.');
    teams[teamId] = v;
  }
  if (Object.keys(teams).length > 0) patch.teams = teams;
  const agents: Record<string, number | null | 'default'> = {};
  for (const [session, text] of Object.entries(draft.agents)) {
    if (/^\s*no\s*cap\s*$/i.test(text)) {
      agents[session] = null;
      continue;
    }
    const v = parseTokenInput(text);
    if (v === undefined) throw new Error('Agent caps are token amounts like 5M, "No cap", or empty for the default.');
    agents[session] = v === null ? 'default' : v;
  }
  if (Object.keys(agents).length > 0) patch.agents = agents;
  return patch;
}

/**
 * Usage data and owner actions for one period.
 *
 * @param period - Days (as a key of {@link USAGE_PERIODS})
 * @returns {@link UseUsageResult}
 */
export function useUsage(period: UsagePeriod): UseUsageResult {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [caps, setCaps] = useState<CapsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(async (p: UsagePeriod) => {
    try {
      const [s, c] = await Promise.all([usageService.stats(Number(p), USAGE_GROUPS), usageService.caps(Number(p))]);
      setStats(s);
      setCaps(c);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load(period);
  }, [load, period]);

  const run = useCallback(
    async (action: () => Promise<string>): Promise<boolean> => {
      setBusy(true);
      try {
        setNote(await action());
        setError(null);
        await load(period);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, period],
  );

  const boost = useCallback(
    async (req: BoostRequest, who: string): Promise<void> => {
      await run(async () => {
        await usageService.boost(req);
        return req.unlimited ? `${who}: no cap until midnight.` : `${who}: +${tokens(req.extraTokens ?? 0)} until midnight.`;
      });
    },
    [run],
  );

  const endBoost = useCallback(
    async (id: string): Promise<void> => {
      await run(async () => {
        await usageService.endBoost(id);
        return 'Boost ended.';
      });
    },
    [run],
  );

  const saveCaps = useCallback(
    (draft: CapsDraft): Promise<boolean> =>
      run(async () => {
        await usageService.setCaps(capsPatchFromDraft(draft));
        return 'Caps saved. They apply right away and reset each day at midnight.';
      }),
    [run],
  );

  const reload = useCallback(() => load(period), [load, period]);

  return { stats, caps, error, note, busy, lastUpdated, reload, boost, endBoost, saveCaps };
}
