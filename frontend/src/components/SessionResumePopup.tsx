/**
 * Session Resume Popup Component
 *
 * Shown on app startup when previously running agents are detected.
 * Offers the user the choice to resume all teams or dismiss those sessions.
 *
 * @module components/SessionResumePopup
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Play, Monitor } from 'lucide-react';
import { Popup } from '@crewly/ui/Popup';
import { Button } from '@crewly/ui/Button';
import { Badge } from '@crewly/ui/Badge';
import { apiService } from '../services/api.service';
import { settingsService } from '../services/settings.service';
import type { PreviousSession } from '../types';

/**
 * SessionResumePopup checks for previously running sessions on mount.
 * If found, displays a popup listing them with Resume All / Dismiss options.
 */
export const SessionResumePopup: React.FC = () => {
  const [sessions, setSessions] = useState<PreviousSession[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const autoResumeTriggered = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const checkPreviousSessions = async () => {
      try {
        const [result, settings] = await Promise.all([
          apiService.getPreviousSessions(),
          settingsService.getSettings().catch(() => null),
        ]);
        // Filter out orchestrator — it auto-starts on its own
        const nonOrchestrator = result.sessions.filter(s => s.role !== 'orchestrator');
        if (cancelled || nonOrchestrator.length === 0) return;

        setSessions(nonOrchestrator);

        // If auto-resume is enabled, start teams automatically without
        // showing the dialog. The setting defaults to true when missing.
        const autoResume = settings?.general?.autoResumeOnRestart ?? true;
        if (autoResume && !autoResumeTriggered.current) {
          autoResumeTriggered.current = true;
          // Extract unique team IDs and start them
          const teamIds = new Set<string>();
          for (const s of nonOrchestrator) {
            if (s.teamId && s.role !== 'orchestrator') {
              teamIds.add(s.teamId);
            }
          }
          for (const teamId of teamIds) {
            try {
              await apiService.startTeam(teamId);
            } catch {
              // Best-effort — failed teams can be started manually
            }
          }
          try {
            await apiService.dismissPreviousSessions();
          } catch {
            // Best-effort dismiss
          }
          return;
        }

        // Auto-resume disabled — show the dialog for manual action
        setIsOpen(true);
      } catch {
        // No previous sessions or API not ready yet - silently ignore
      }
    };

    checkPreviousSessions();
    return () => { cancelled = true; };
  }, []);

  /** Unique team IDs from non-orchestrator sessions */
  const resumableTeamIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of sessions) {
      if (s.teamId && s.role !== 'orchestrator') {
        ids.add(s.teamId);
      }
    }
    return Array.from(ids);
  }, [sessions]);

  const hasResumableTeams = resumableTeamIds.length > 0;

  const handleDismiss = useCallback(async () => {
    setLoading(true);
    try {
      await apiService.dismissPreviousSessions();
    } catch {
      // Best-effort dismiss
    }
    setIsOpen(false);
    setLoading(false);
  }, []);

  /**
   * Start all resumable teams sequentially.
   * On full success, dismiss and close. On partial failure, show error.
   */
  const handleResumeAll = useCallback(async () => {
    setLoading(true);
    setResumeError(null);

    const failures: string[] = [];
    for (const teamId of resumableTeamIds) {
      try {
        await apiService.startTeam(teamId);
      } catch {
        failures.push(teamId);
      }
    }

    if (failures.length === 0) {
      try {
        await apiService.dismissPreviousSessions();
      } catch {
        // Best-effort dismiss
      }
      setIsOpen(false);
    } else {
      setResumeError(`Failed to start ${failures.length} team(s). You can start them manually from the Teams page.`);
    }

    setLoading(false);
  }, [resumableTeamIds]);

  if (!isOpen) return null;

  const footer = (
    <>
      <Button
        variant="secondary"
        onClick={handleDismiss}
        disabled={loading}
      >
        Dismiss
      </Button>
      <Button
        variant="primary"
        icon={Play}
        onClick={handleResumeAll}
        disabled={loading || !hasResumableTeams}
      >
        Resume All
      </Button>
    </>
  );

  return (
    <Popup
      isOpen={isOpen}
      onClose={handleDismiss}
      title="Previous Sessions Detected"
      subtitle="The following agents were running before the app restarted."
      size="lg"
      footer={footer}
      loading={loading}
    >
      <div className="space-y-2">
        {sessions.map((session) => (
          <div
            key={session.name}
            className="flex items-center justify-between p-3 rounded-lg bg-background-dark border border-border-dark"
          >
            <div className="flex items-center gap-3">
              <Monitor className="w-4 h-4 text-text-secondary-dark" />
              <div>
                <div className="text-sm font-medium">{session.name}</div>
                {session.role && (
                  <div className="text-xs text-text-secondary-dark">{session.role}</div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={session.hasResumeId ? 'success' : 'default'} size="sm">
                {session.hasResumeId ? 'Resumable' : 'Restart'}
              </Badge>
              <Badge variant="default" size="sm">
                {session.runtimeType}
              </Badge>
            </div>
          </div>
        ))}
      </div>
      {resumeError && (
        <p className="mt-3 text-xs text-rose-400">{resumeError}</p>
      )}
      <p className="mt-4 text-xs text-text-secondary-dark">
        Click &quot;Resume All&quot; to restart all teams, or dismiss to start them manually from the Teams page.
      </p>
    </Popup>
  );
};
