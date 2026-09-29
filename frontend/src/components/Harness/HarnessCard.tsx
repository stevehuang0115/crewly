/**
 * HarnessCard
 *
 * One coding harness (Claude Code / Codex / Antigravity CLI; Gemini CLI when already in use): install, version
 * and login badges, an Install / Update button and the live install log.
 * Optionally selectable (radio) for the setup flow's "which one do you
 * want" step.
 *
 * @module components/Harness/HarnessCard
 */

import React from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { Alert, Badge, Button, Card } from '@crewly/ui';
import type { HarnessStatus, InstallJob } from '../../types/harness.types';
import { LOGIN_STATE_BADGES, harnessDisplayName } from '../../constants/harness.constants';
import { useInstallJob } from '../../hooks/useInstallJob';
import { InstallLog } from './InstallLog';

export interface HarnessCardProps {
  /** Harness status */
  harness: HarnessStatus;
  /** Radio group name; when set the card shows a radio for selection */
  selectName?: string;
  /** Whether this harness is the selected one */
  selected?: boolean;
  /** Selection handler */
  onSelect?: (id: HarnessStatus['id']) => void;
  /** Called when an install / update job ends (refresh status) */
  onInstallFinished?: (job: InstallJob) => void;
}

/**
 * Status + install card for a single harness.
 *
 * @param props - {@link HarnessCardProps}
 * @returns Card element
 */
export const HarnessCard: React.FC<HarnessCardProps> = ({
  harness,
  selectName,
  selected = false,
  onSelect,
  onInstallFinished,
}) => {
  const { job, error, running, start } = useInstallJob(harness.id, onInstallFinished);
  const loginBadge = LOGIN_STATE_BADGES[harness.loginState];
  const canInstall = !harness.installed || harness.updateAvailable || job?.state === 'failed';
  const installLabel =
    job?.state === 'failed' ? 'Retry install' : harness.installed ? 'Update' : 'Install';

  const title = (
    <span className="font-semibold text-text-primary-dark">{harnessDisplayName(harness)}</span>
  );

  return (
    <Card
      padding="md"
      data-testid={`harness-card-${harness.id}`}
      className={selected ? 'border-primary' : undefined}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {selectName ? (
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="radio"
                name={selectName}
                value={harness.id}
                checked={selected}
                onChange={() => onSelect?.(harness.id)}
                className="h-4 w-4 accent-[var(--crewly-primary)]"
              />
              {title}
            </label>
          ) : (
            title
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {harness.installed ? (
              <Badge variant="success">Installed{harness.version ? ` v${harness.version}` : ''}</Badge>
            ) : (
              <Badge variant="default">Not installed</Badge>
            )}
            {harness.installed && harness.updateAvailable && (
              <Badge variant="info">Update available{harness.latestVersion ? ` → v${harness.latestVersion}` : ''}</Badge>
            )}
            {harness.installed && <Badge variant={loginBadge.variant}>{loginBadge.label}</Badge>}
            {harness.installed && harness.loginSource && (
              <span className="text-xs text-text-secondary-dark">{harness.loginSource}</span>
            )}
          </div>
        </div>
        {canInstall && (
          <Button
            type="button"
            variant={harness.installed && job?.state !== 'failed' ? 'secondary' : 'primary'}
            size="sm"
            icon={harness.installed ? RefreshCw : Download}
            loading={running}
            onClick={() => void start()}
            className="shrink-0 self-start"
          >
            {running ? 'Installing…' : installLabel}
          </Button>
        )}
      </div>

      {error && (
        <Alert variant="error" size="sm" className="mt-3">
          {error}
        </Alert>
      )}

      {job && <InstallLog log={job.log} />}

      {job?.state === 'succeeded' && (
        <Alert variant="success" size="sm" className="mt-3" title="Installed">
          {job.usedUserPrefix
            ? 'Installed to your user folder (no admin rights needed).'
            : `${harness.displayName} is ready.`}
        </Alert>
      )}
      {job?.state === 'failed' && !error && (
        <Alert variant="error" size="sm" className="mt-3" title="Install failed">
          Check the log above and try again.
        </Alert>
      )}
    </Card>
  );
};
