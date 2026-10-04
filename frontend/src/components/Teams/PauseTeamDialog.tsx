/**
 * PauseTeamDialog — the owner pauses a team (specs/2026-10-04-team-pause.md).
 *
 * Says what a pause does (no automatic wake-ups, hidden from other agents,
 * running agents stop) and takes an optional reason and an optional
 * auto-resume time.
 *
 * @module components/Teams/PauseTeamDialog
 */

import React, { useEffect, useState } from 'react';
import { Button, Input } from '@crewly/ui';
import { Modal, ModalBody, ModalFooter } from '@crewly/ui/Modal';
import { localDateTimeToIso } from '@/utils/team-pause.utils';

export interface PauseTeamDialogProps {
  isOpen: boolean;
  teamName: string;
  /** Issue repo other agents are pointed to while paused, when set */
  issueRepo?: string;
  busy?: boolean;
  onCancel: () => void;
  /** Called with the reason and the ISO auto-resume time, both optional */
  onConfirm: (input: { reason?: string; until?: string }) => void;
}

/**
 * Pause dialog.
 *
 * @param props - {@link PauseTeamDialogProps}
 * @returns The dialog
 */
export const PauseTeamDialog: React.FC<PauseTeamDialogProps> = ({ isOpen, teamName, issueRepo, busy = false, onCancel, onConfirm }) => {
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');

  useEffect(() => {
    if (isOpen) {
      setReason('');
      setUntil('');
    }
  }, [isOpen]);

  const submit = (): void => {
    const trimmed = reason.trim();
    const untilIso = localDateTimeToIso(until);
    onConfirm({ ...(trimmed ? { reason: trimmed } : {}), ...(untilIso ? { until: untilIso } : {}) });
  };

  return (
    <Modal isOpen={isOpen} onClose={onCancel} title={`Pause ${teamName}`} size="md" data-testid="pause-team-dialog">
      <ModalBody>
        <div className="flex flex-col gap-4 text-[13px] text-text-2">
          <p>
            While paused, nothing wakes this team automatically and other agents can't see it or hand it work
            {issueRepo ? (
              <> — they file a GitHub issue in <span className="font-semibold text-text">{issueRepo}</span> instead</>
            ) : (
              <> — they tell the orc instead</>
            )}
            . Its running agents stop. Work already in progress stays where it is.
          </p>
          <Input
            label="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. harness work is handled elsewhere this week"
            maxLength={500}
            fullWidth
            data-testid="pause-reason"
          />
          <Input
            label="Resume automatically at (optional)"
            type="datetime-local"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            fullWidth
            data-testid="pause-until"
          />
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} loading={busy} disabled={busy} data-testid="pause-confirm">
          Pause team
        </Button>
      </ModalFooter>
    </Modal>
  );
};

export default PauseTeamDialog;
