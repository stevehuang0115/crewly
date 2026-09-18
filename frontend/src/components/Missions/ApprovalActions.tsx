/**
 * Approve / Reject controls for a pending OKR cascade proposal.
 *
 * The proposal IS the child mission: approving calls
 * POST /api/missions/:childId/approve; rejecting opens a small dialog for the
 * mandatory reason and calls POST /api/missions/:childId/reject.
 *
 * @module components/Missions/ApprovalActions
 */

import React, { useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '../UI/Button';
import { Modal, ModalBody, ModalFooter } from '../UI/Modal';
import { Alert } from '../UI/Alert';
import { apiService } from '../../services/api.service';
import type { Mission } from '../../types/mission.types';

export interface ApprovalActionsProps {
  /** The pending child mission (proposal). */
  missionId: string;
  /** Called with the server-returned mission after a decision. */
  onDecided: (mission: Mission) => void;
  /** Compact rendering for list rows. */
  size?: 'sm' | 'default';
}

/**
 * Owner decision buttons for a `pending_approval` mission.
 *
 * @param props - See {@link ApprovalActionsProps}
 */
export const ApprovalActions: React.FC<ApprovalActionsProps> = ({ missionId, onDecided, size = 'sm' }) => {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  const approve = async (): Promise<void> => {
    setBusy('approve');
    setError(null);
    try {
      const updated = await apiService.approveMission(missionId);
      onDecided(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve');
    } finally {
      setBusy(null);
    }
  };

  const reject = async (): Promise<void> => {
    if (!reason.trim()) {
      setError('A rejection reason is required.');
      return;
    }
    setBusy('reject');
    setError(null);
    try {
      const updated = await apiService.rejectMission(missionId, reason.trim());
      setRejecting(false);
      setReason('');
      onDecided(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="flex items-center gap-1.5 flex-wrap"
      data-testid={`approval-actions-${missionId}`}
      onClick={(e) => e.stopPropagation()}
    >
      <Button
        variant="primary"
        size={size}
        icon={Check}
        onClick={approve}
        disabled={busy !== null}
        data-testid={`approve-${missionId}`}
      >
        {busy === 'approve' ? 'Approving…' : 'Approve'}
      </Button>
      <Button
        variant="ghost"
        size={size}
        icon={X}
        onClick={() => { setError(null); setRejecting(true); }}
        disabled={busy !== null}
        data-testid={`reject-${missionId}`}
      >
        Reject
      </Button>
      {error && !rejecting && (
        <span className="text-xs text-red-400" data-testid={`approval-error-${missionId}`}>{error}</span>
      )}

      {rejecting && (
        <Modal isOpen={rejecting} onClose={() => setRejecting(false)} title="Reject proposal" size="sm">
          <ModalBody>
            <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">
              Reason <span className="text-red-400">*</span>
            </label>
            <textarea
              className="w-full bg-background-dark border border-border-dark rounded-lg px-3 py-2 text-sm text-text-primary-dark resize-y focus:outline-none focus:border-accent-blue/50"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this decomposition not acceptable?"
              data-testid={`reject-reason-${missionId}`}
            />
            {error && (
              <div className="mt-2">
                <Alert variant="error">{error}</Alert>
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" size="sm" onClick={() => setRejecting(false)} disabled={busy !== null}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={reject}
              disabled={busy !== null}
              data-testid={`reject-confirm-${missionId}`}
            >
              {busy === 'reject' ? 'Rejecting…' : 'Reject proposal'}
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </div>
  );
};

export default ApprovalActions;
