/**
 * GuidedActionChecklist Component
 *
 * Action sequencing checklist for post-onboarding guided first steps.
 * Shows prioritized next actions with status indicators.
 *
 * @module components/PortalOnboarding/GuidedActionChecklist
 */

import React from 'react';
import { CheckCircle2, Circle, ArrowRight } from 'lucide-react';
import { Card } from '../UI/Card';
import { Button } from '../UI/Button';

// =============================================================================
// Types
// =============================================================================

export interface GuidedActionItem {
  /** Unique identifier */
  id: string;
  /** Action label */
  label: string;
  /** Completion status */
  status: 'todo' | 'active' | 'done';
}

export interface GuidedActionChecklistProps {
  /** Checklist items */
  items: GuidedActionItem[];
  /** Label for the primary action button */
  primaryActionLabel?: string;
  /** Handler for the primary action */
  onPrimaryAction?: () => void;
  /** Label for secondary action */
  secondaryActionLabel?: string;
  /** Handler for secondary action */
  onSecondaryAction?: () => void;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders a guided action checklist for post-onboarding next steps.
 *
 * @param props - Component props
 * @returns GuidedActionChecklist element
 */
export const GuidedActionChecklist: React.FC<GuidedActionChecklistProps> = ({
  items,
  primaryActionLabel,
  onPrimaryAction,
  secondaryActionLabel,
  onSecondaryAction,
}) => {
  return (
    <div data-testid="guided-action-checklist">
      {/* Checklist */}
      <Card variant="default" padding="lg" className="mb-6">
        <h3 className="text-base font-semibold text-text-primary-dark mb-4">Start here</h3>
        <div className="space-y-3" data-testid="checklist-items">
          {items.map((item, index) => {
            const isDone = item.status === 'done';
            const isActive = item.status === 'active';

            return (
              <div
                key={item.id}
                className={`flex items-center gap-3 text-sm ${
                  isDone
                    ? 'text-emerald-400'
                    : isActive
                    ? 'text-primary font-medium'
                    : 'text-text-secondary-dark'
                }`}
                data-testid={`checklist-item-${item.id}`}
              >
                {isDone ? (
                  <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                ) : isActive ? (
                  <ArrowRight className="h-4 w-4 flex-shrink-0" />
                ) : (
                  <Circle className="h-4 w-4 flex-shrink-0 opacity-40" />
                )}
                <span>
                  {index + 1}. {item.label}
                </span>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Action buttons */}
      {(primaryActionLabel || secondaryActionLabel) && (
        <div className="flex flex-wrap gap-3" data-testid="checklist-actions">
          {primaryActionLabel && (
            <Button
              variant="primary"
              onClick={onPrimaryAction}
              data-testid="checklist-primary-action"
            >
              {primaryActionLabel}
            </Button>
          )}
          {secondaryActionLabel && (
            <Button
              variant="ghost"
              onClick={onSecondaryAction}
              data-testid="checklist-secondary-action"
            >
              {secondaryActionLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

GuidedActionChecklist.displayName = 'GuidedActionChecklist';
