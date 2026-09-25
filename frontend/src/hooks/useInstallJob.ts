/**
 * useInstallJob Hook
 *
 * Starts a harness install/update (`POST /api/harness/:id/install`) and
 * polls the job (`GET /api/harness/install/:jobId`) every second until it
 * succeeds or fails.
 *
 * @module hooks/useInstallJob
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { harnessService } from '../services/harness.service';
import type { HarnessId, InstallJob } from '../types/harness.types';
import { HARNESS_TIMING } from '../constants/harness.constants';

export interface UseInstallJobResult {
  /** Latest job snapshot (null before the first install) */
  job: InstallJob | null;
  /** Start / request error */
  error: string | null;
  /** True from the click until the job reaches a final state */
  running: boolean;
  /** Start the install */
  start: () => Promise<void>;
}

/**
 * Install-job state for one harness.
 *
 * @param harnessId - Harness to install
 * @param onFinished - Called once when the job ends (with its final state)
 * @returns {@link UseInstallJobResult}
 */
export function useInstallJob(
  harnessId: HarnessId,
  onFinished?: (job: InstallJob) => void,
): UseInstallJobResult {
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<InstallJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const start = useCallback(async () => {
    setError(null);
    setStarting(true);
    try {
      const id = await harnessService.startInstall(harnessId);
      setJob({ state: 'running', log: '', usedUserPrefix: false });
      setJobId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }, [harnessId]);

  // Poll while running. Each new snapshot re-arms the timer.
  useEffect(() => {
    if (!jobId || !job || job.state !== 'running') return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const next = await harnessService.getInstallJob(jobId);
        if (cancelled) return;
        setJob(next);
        if (next.state !== 'running') onFinishedRef.current?.(next);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setJob((prev) => (prev ? { ...prev, state: 'failed' } : prev));
      }
    }, HARNESS_TIMING.INSTALL_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobId, job]);

  return { job, error, running: starting || job?.state === 'running', start };
}
