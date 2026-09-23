import React from 'react';
import { Edit, Trash2, Clock, Play, Pause, CheckCircle } from 'lucide-react';
import { Badge } from '@crewly/ui/Badge';
import { IconButton } from '@crewly/ui/Button';
import { Card } from '@crewly/ui/Card';
import { ScheduledMessage } from './types';

interface ScheduledMessageCardProps {
  message: ScheduledMessage;
  onEdit: (message: ScheduledMessage) => void;
  onDelete: (id: string, name: string) => void;
  onToggleActive: (id: string, isActive: boolean) => void;
  onRunNow: (id: string, name: string) => void;
  formatDate: (dateString: string) => string;
  onCardClick?: (message: ScheduledMessage) => void;
}

export const ScheduledMessageCard: React.FC<ScheduledMessageCardProps> = ({
  message,
  onEdit,
  onDelete,
  onToggleActive,
  onRunNow,
  formatDate,
  onCardClick
}) => {
  const isActive = message.isActive;
  const handleCardClick = (e: React.MouseEvent) => {
    // Don't trigger card click if action button was clicked
    if ((e.target as Element).closest('[data-actions]')) {
      return;
    }
    onCardClick?.(message);
  };

  return (
    <Card
      onClick={handleCardClick}
      interactive={!!onCardClick}
      className="p-5 transition-all hover:shadow-lg hover:border-primary/50 flex flex-col justify-between"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold text-lg truncate">{message.name}</h3>
          <div className="mt-1 flex items-center gap-2 text-xs">
            <Badge variant={isActive ? 'success' : 'default'} className="gap-1">
              <CheckCircle className="w-3.5 h-3.5" />
              {isActive ? 'Active' : 'Completed'}
            </Badge>
          </div>
        </div>
        <div className="flex items-center gap-1.5" data-actions>
          <IconButton
            icon={isActive ? Pause : Play}
            variant="outline"
            size="xs"
            onClick={(e) => { e.stopPropagation(); onToggleActive(message.id, message.isActive); }}
            title={isActive ? 'Disable' : 'Re-activate'}
            aria-label={isActive ? 'Disable' : 'Re-activate'}
          />
          {isActive && (
            <>
              <IconButton
                icon={Edit}
                variant="outline"
                size="xs"
                onClick={(e) => { e.stopPropagation(); onEdit(message); }}
                title="Edit"
                aria-label="Edit"
              />
              <IconButton
                icon={Play}
                variant="outline"
                size="xs"
                onClick={(e) => { e.stopPropagation(); onRunNow(message.id, message.name); }}
                title="Run now"
                aria-label="Run now"
              />
            </>
          )}
          <IconButton
            icon={Trash2}
            variant="danger-ghost"
            size="xs"
            className="border border-border-dark hover:border-red-500/50"
            onClick={(e) => { e.stopPropagation(); onDelete(message.id, message.name); }}
            title="Delete"
            aria-label="Delete"
          />
        </div>
      </div>

      <div className="mt-4 space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex items-center gap-2">
            <span className="text-text-secondary-dark">Target:</span>
            <span className="font-medium">{message.targetTeam}</span>
          </div>
          {message.targetProject && (
            <div className="flex items-center gap-2">
              <span className="text-text-secondary-dark">Project:</span>
              <span className="font-medium">{message.targetProject}</span>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex items-center gap-2">
            <span className="text-text-secondary-dark">Schedule:</span>
            <span className="font-medium">
              {message.isRecurring ? 'Every' : 'Once after'} {message.delayAmount} {message.delayUnit}
            </span>
          </div>
          {message.nextRun && isActive && (
            <div className="flex items-center gap-2 text-text-secondary-dark">
              <Clock className="w-4 h-4" />
              <span className="font-medium text-text-primary-dark">Next: {formatDate(message.nextRun)}</span>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
};
