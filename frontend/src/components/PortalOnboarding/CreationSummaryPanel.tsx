/**
 * CreationSummaryPanel Component
 *
 * Final summary panel before workspace creation.
 * Shows what will be created with a confirmation checkbox and action buttons.
 *
 * @module components/PortalOnboarding/CreationSummaryPanel
 */

import React from 'react';
import { Layout, Users, Zap, Link2, CheckSquare, Square } from 'lucide-react';
import { Card } from '../UI/Card';
import { Button } from '../UI/Button';

// =============================================================================
// Types
// =============================================================================

export interface CreationSummaryPanelProps {
  /** Team name to create */
  teamName: string;
  /** Template to use */
  template?: string;
  /** First workflow */
  workflow?: string;
  /** First integration */
  integration?: string;
  /** Whether to show the confirmation checkbox */
  showCheckbox?: boolean;
  /** Whether the checkbox is checked */
  isConfirmed?: boolean;
  /** Checkbox change handler */
  onConfirmedChange?: (checked: boolean) => void;
  /** Create workspace handler */
  onConfirm: () => void;
  /** Back to review handler */
  onBack: () => void;
  /** Whether creation is in progress */
  isSubmitting?: boolean;
  /** Whether there are unresolved blocking fields */
  hasBlockingFields?: boolean;
}

// =============================================================================
// Sub-component
// =============================================================================

const SummaryRow: React.FC<{
  icon: React.FC<{ className?: string }>;
  label: string;
  value: string;
}> = ({ icon: Icon, label, value }) => (
  <div className="flex items-center gap-3 py-2.5 border-b border-border-dark/30 last:border-0">
    <Icon className="h-4 w-4 text-text-secondary-dark/60 flex-shrink-0" />
    <span className="text-sm text-text-secondary-dark w-36 flex-shrink-0">{label}</span>
    <span className="text-sm text-text-primary-dark font-medium">{value}</span>
  </div>
);

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the final creation summary with confirmation controls.
 *
 * @param props - Component props
 * @returns CreationSummaryPanel element
 */
export const CreationSummaryPanel: React.FC<CreationSummaryPanelProps> = ({
  teamName,
  template,
  workflow,
  integration,
  showCheckbox = true,
  isConfirmed = false,
  onConfirmedChange,
  onConfirm,
  onBack,
  isSubmitting = false,
  hasBlockingFields = false,
}) => {
  const isBlocked = hasBlockingFields || (showCheckbox && !isConfirmed) || isSubmitting;

  return (
    <div data-testid="creation-summary-panel">
      <Card variant="default" padding="lg">
        <div className="divide-y divide-border-dark/30">
          <SummaryRow icon={Users} label="Team name" value={teamName} />
          {template && <SummaryRow icon={Layout} label="Template" value={template} />}
          {workflow && <SummaryRow icon={Zap} label="First workflow" value={workflow} />}
          {integration && <SummaryRow icon={Link2} label="First integration" value={integration} />}
        </div>
      </Card>

      {/* Confirmation checkbox */}
      {showCheckbox && (
        <button
          type="button"
          className="flex items-center gap-3 mt-5 text-sm text-text-secondary-dark hover:text-text-primary-dark transition-colors"
          onClick={() => onConfirmedChange?.(!isConfirmed)}
          data-testid="creation-confirm-checkbox"
        >
          {isConfirmed ? (
            <CheckSquare className="h-5 w-5 text-primary" />
          ) : (
            <Square className="h-5 w-5" />
          )}
          <span>I've reviewed the highlighted fields</span>
        </button>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-3 mt-6" data-testid="creation-actions">
        <Button
          variant="primary"
          onClick={onConfirm}
          disabled={isBlocked}
          loading={isSubmitting}
          data-testid="create-workspace-btn"
        >
          Create my workspace
        </Button>
        <Button
          variant="ghost"
          onClick={onBack}
          disabled={isSubmitting}
          data-testid="back-to-review-btn"
        >
          Back to review
        </Button>
      </div>
    </div>
  );
};

CreationSummaryPanel.displayName = 'CreationSummaryPanel';
