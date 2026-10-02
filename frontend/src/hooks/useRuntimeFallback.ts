/**
 * useRuntimeFallback Hook
 *
 * State of the runtime fallback (`/api/system/runtime-fallback`): the saved
 * settings plus an editable draft (fallback order, per-agent orders, the
 * on/off switch, whether the orchestrator switches too), which runtimes are
 * out of usage, which agents run on a fallback, and the per-runtime smoke
 * test (`/api/system/runtime-smoke-test`).
 *
 * Extracted from the former fallback panel so Settings › Runtimes can show
 * the order up top and the rest under Advanced while sharing one draft.
 *
 * specs/2026-10-01-runtime-fallback.md
 *
 * @module hooks/useRuntimeFallback
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  runtimeFallbackService,
  type RuntimeFallbackSettings,
  type RuntimeFallbackState,
  type SmokeTestJob,
} from '../services/runtime-fallback.service';
import { apiService } from '../services/api.service';

/** How often a running smoke test is polled. */
export const SMOKE_POLL_MS = 3000;

/** A member that can get its own order. */
export interface FallbackMemberOption {
  id: string;
  label: string;
}

/** A runtime's smoke test: the job, or the error that stopped it. */
export type SmokeTestEntry = SmokeTestJob | { error: string };

/** Result of {@link useRuntimeFallback}. */
export interface UseRuntimeFallbackResult {
  state: RuntimeFallbackState | null;
  draft: RuntimeFallbackSettings | null;
  setDraft: (next: RuntimeFallbackSettings) => void;
  /** The draft differs from the saved settings */
  dirty: boolean;
  saving: boolean;
  error: string | null;
  members: FallbackMemberOption[];
  tests: Record<string, SmokeTestEntry>;
  load: () => Promise<void>;
  save: () => Promise<void>;
  discard: () => void;
  runTest: (runtime: string) => Promise<void>;
  /** Label of a runtime id */
  labelOf: (runtime: string) => string;
  /** Label of a member id */
  memberName: (id: string) => string;
  /** Add one of the owner's other Claude Code accounts (#942); resolves to what the owner does next */
  addClaudeAccount: (name: string) => Promise<string | null>;
  /** Send a fresh sign-in link for an account */
  signInClaudeAccount: (name: string) => Promise<string | null>;
  /** Remove an account */
  removeClaudeAccount: (name: string) => Promise<void>;
}

/**
 * Whether a smoke test is still running.
 *
 * @param t - Entry
 * @returns True while running
 */
export function isTestRunning(t: SmokeTestEntry | undefined): boolean {
  return Boolean(t && 'state' in t && t.state === 'running');
}

/**
 * Runtime fallback state, draft and smoke tests.
 *
 * @param smokePollMs - Poll interval of a running smoke test (tests shorten it)
 * @returns {@link UseRuntimeFallbackResult}
 */
export function useRuntimeFallback(smokePollMs: number = SMOKE_POLL_MS): UseRuntimeFallbackResult {
  const [state, setState] = useState<RuntimeFallbackState | null>(null);
  const [draft, setDraft] = useState<RuntimeFallbackSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [members, setMembers] = useState<FallbackMemberOption[]>([]);
  const [tests, setTests] = useState<Record<string, SmokeTestEntry>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const load = useCallback(async () => {
    try {
      const next = await runtimeFallbackService.getState();
      setState(next);
      setDraft(next.settings);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    apiService
      .getTeams()
      .then((teams) =>
        setMembers(
          teams.flatMap((t) => (t.members ?? []).filter((m) => m.id !== 'orchestrator-member').map((m) => ({ id: m.id, label: `${m.name} (${t.name})` }))),
        ),
      )
      .catch(() => setMembers([]));
    const pending = timers.current;
    return () => Object.values(pending).forEach(clearTimeout);
  }, [load]);

  const dirty = useMemo(() => Boolean(state && draft && JSON.stringify(state.settings) !== JSON.stringify(draft)), [state, draft]);

  const save = useCallback(async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    try {
      const next = await runtimeFallbackService.updateSettings(draft);
      setState(next);
      setDraft(next.settings);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const discard = useCallback(() => {
    if (state) setDraft(state.settings);
  }, [state]);

  const poll = useCallback(
    (runtime: string, jobId: string) => {
      timers.current[runtime] = setTimeout(async () => {
        try {
          const job = await runtimeFallbackService.getSmokeTest(jobId);
          setTests((t) => ({ ...t, [runtime]: job }));
          if (job.state === 'running') poll(runtime, jobId);
        } catch (err) {
          setTests((t) => ({ ...t, [runtime]: { error: err instanceof Error ? err.message : String(err) } }));
        }
      }, smokePollMs);
    },
    [smokePollMs],
  );

  const runTest = useCallback(
    async (runtime: string): Promise<void> => {
      try {
        const job = await runtimeFallbackService.startSmokeTest(runtime);
        setTests((t) => ({ ...t, [runtime]: job }));
        if (job.state === 'running') poll(runtime, job.jobId);
      } catch (err) {
        setTests((t) => ({ ...t, [runtime]: { error: err instanceof Error ? err.message : String(err) } }));
      }
    },
    [poll],
  );

  /**
   * Take a new state from the server: the saved settings follow it; an
   * unsaved draft keeps its edits, minus runtimes that no longer exist.
   */
  const adopt = useCallback((next: RuntimeFallbackState) => {
    setState(next);
    setDraft((current) => {
      if (!current || !state || JSON.stringify(current) === JSON.stringify(state.settings)) return next.settings;
      const known = new Set(next.runtimes.map((r) => r.runtime));
      const keep = (chain: string[]) => chain.filter((r) => known.has(r));
      return {
        ...current,
        chain: keep(current.chain),
        memberChains: Object.fromEntries(Object.entries(current.memberChains).map(([id, chain]) => [id, keep(chain)])),
      };
    });
    setError(null);
  }, [state]);

  const addClaudeAccount = useCallback(
    async (name: string): Promise<string | null> => {
      try {
        const next = await runtimeFallbackService.addClaudeAccount(name);
        adopt(next);
        return next.login.next;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [adopt],
  );

  const signInClaudeAccount = useCallback(
    async (name: string): Promise<string | null> => {
      try {
        const next = await runtimeFallbackService.signInClaudeAccount(name);
        adopt(next);
        return next.login.next;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [adopt],
  );

  const removeClaudeAccount = useCallback(
    async (name: string): Promise<void> => {
      try {
        adopt(await runtimeFallbackService.removeClaudeAccount(name));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [adopt],
  );

  const labelOf = useCallback((runtime: string): string => state?.runtimes.find((r) => r.runtime === runtime)?.label ?? runtime, [state]);
  const memberName = useCallback((id: string): string => members.find((m) => m.id === id)?.label ?? id, [members]);

  return {
    state,
    draft,
    setDraft,
    dirty,
    saving,
    error,
    members,
    tests,
    load,
    save,
    discard,
    runTest,
    labelOf,
    memberName,
    addClaudeAccount,
    signInClaudeAccount,
    removeClaudeAccount,
  };
}
