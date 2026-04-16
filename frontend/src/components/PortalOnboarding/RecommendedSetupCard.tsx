/**
 * RecommendedSetupCard Component
 *
 * Highlights the product bridge from brand understanding to workspace creation.
 * Shows recommended template, team name, workflow, and integration.
 *
 * @module components/PortalOnboarding/RecommendedSetupCard
 */

import React from 'react';
import { Sparkles, Layout, Users, Zap, Link2 } from 'lucide-react';
import { Card } from '../UI/Card';

// =============================================================================
// Types
// =============================================================================

export interface RecommendedSetupCardProps {
  /** Recommended template name */
  template?: string;
  /** Suggested team name */
  teamName?: string;
  /** First workflow suggestion */
  workflow?: string;
  /** First integration suggestion */
  integration?: string;
  /** Whether fields are editable */
  editable?: boolean;
}

// =============================================================================
// Sub-component
// =============================================================================

const SetupRow: React.FC<{
  icon: React.FC<{ className?: string }>;
  label: string;
  value: string;
}> = ({ icon: Icon, label, value }) => (
  <div className="flex items-center gap-3 py-2" data-testid={`setup-row-${label.toLowerCase().replace(/\s+/g, '-')}`}>
    <Icon className="h-4 w-4 text-text-secondary-dark/60 flex-shrink-0" />
    <span className="text-sm text-text-secondary-dark w-36 flex-shrink-0">{label}</span>
    <span className="text-sm text-text-primary-dark font-medium">{value}</span>
  </div>
);

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the recommended Crewly setup card with template, team, workflow, integration.
 *
 * @param props - Component props
 * @returns RecommendedSetupCard element
 */
export const RecommendedSetupCard: React.FC<RecommendedSetupCardProps> = ({
  template,
  teamName,
  workflow,
  integration,
}) => {
  const hasAnyValue = template || teamName || workflow || integration;
  if (!hasAnyValue) return null;

  return (
    <Card variant="default" padding="lg" data-testid="recommended-setup-card">
      <div className="flex items-center gap-2 mb-4">
        <Sparkles className="h-5 w-5 text-primary" />
        <h3 className="text-base font-semibold text-text-primary-dark">Recommended Crewly Setup</h3>
      </div>

      <div className="divide-y divide-border-dark/50">
        {template && <SetupRow icon={Layout} label="Template" value={template} />}
        {teamName && <SetupRow icon={Users} label="Team name" value={teamName} />}
        {workflow && <SetupRow icon={Zap} label="First workflow" value={workflow} />}
        {integration && <SetupRow icon={Link2} label="First integration" value={integration} />}
      </div>
    </Card>
  );
};

RecommendedSetupCard.displayName = 'RecommendedSetupCard';
