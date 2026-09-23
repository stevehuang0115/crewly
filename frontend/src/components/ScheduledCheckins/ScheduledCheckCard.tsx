import React from 'react';
import { Trash2, Clock, RefreshCw, Timer } from 'lucide-react';
import { Badge } from '@crewly/ui/Badge';
import { IconButton } from '@crewly/ui/Button';
import { Card } from '@crewly/ui/Card';
import { ScheduledCheck } from './types';

interface ScheduledCheckCardProps {
  check: ScheduledCheck;
  onCancel: (id: string, message: string) => void;
  formatDate: (dateString: string) => string;
}

/**
 * Card component for displaying a scheduled check from the SchedulerService.
 * These are orchestrator-created check-ins, supporting cancel only.
 */
export const ScheduledCheckCard: React.FC<ScheduledCheckCardProps> = ({
  check,
  onCancel,
  formatDate
}) => {
  const preview = check.message.length > 120 ? check.message.slice(0, 120) + '...' : check.message;

  return (
    <Card className="p-5 transition-all hover:shadow-lg hover:border-amber-500/50 flex flex-col justify-between">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {check.isRecurring ? (
              <RefreshCw className="w-4 h-4 text-amber-400 shrink-0" />
            ) : (
              <Timer className="w-4 h-4 text-blue-400 shrink-0" />
            )}
            <Badge variant={check.isRecurring ? 'warning' : 'info'}>
              {check.isRecurring ? 'Recurring' : 'One-time'}
            </Badge>
          </div>
          <p className="mt-2 text-sm text-text-secondary-dark">{preview}</p>
        </div>
        <IconButton
          icon={Trash2}
          variant="danger-ghost"
          size="xs"
          className="border border-border-dark hover:border-red-500/50 shrink-0"
          onClick={() => onCancel(check.id, check.message)}
          title="Cancel check"
          aria-label="Cancel check"
        />
      </div>

      <div className="mt-4 space-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-text-secondary-dark">Target:</span>
          <span className="font-medium">{check.targetSession}</span>
        </div>
        {check.isRecurring && check.intervalMinutes != null && (
          <div className="flex items-center gap-2">
            <span className="text-text-secondary-dark">Interval:</span>
            <span className="font-medium">Every {check.intervalMinutes} min</span>
          </div>
        )}
        <div className="flex items-center gap-2 text-text-secondary-dark">
          <Clock className="w-4 h-4" />
          <span className="font-medium text-text-primary-dark">
            Next: {formatDate(check.scheduledFor)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-text-secondary-dark text-xs">ID: {check.id.slice(0, 8)}</span>
        </div>
      </div>
    </Card>
  );
};
