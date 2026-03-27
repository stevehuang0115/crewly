/**
 * Step 3: Review Team Members & Skills
 *
 * Shows the roles that will be created from the selected template.
 * User can customize the team name before proceeding.
 *
 * @module components/Onboarding/StepReviewTeam
 */

import React from 'react';
import { Users, ArrowRight, ArrowLeft, User } from 'lucide-react';
import type { TemplateInfo } from './onboarding.types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface StepReviewTeamProps {
  /** Selected template (null should not reach this step) */
  template: TemplateInfo | null;
  /** Current team name */
  teamName: string;
  /** Callback to update team name */
  onTeamNameChange: (name: string) => void;
  /** Proceed to next step */
  onNext: () => void;
  /** Go back */
  onBack: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Team review step showing roles list and editable team name.
 *
 * @param props - {@link StepReviewTeamProps}
 * @returns Team review step
 */
export const StepReviewTeam: React.FC<StepReviewTeamProps> = ({
  template,
  teamName,
  onTeamNameChange,
  onNext,
  onBack,
}) => {
  if (!template) {
    return (
      <div className="text-center py-12 text-text-secondary-dark">
        No template selected. Please go back and choose one.
      </div>
    );
  }

  const roles = template.roles ?? [];

  return (
    <div data-testid="step-review-team">
      {/* Heading */}
      <h3 className="text-xl font-bold mb-1">Review Your Team</h3>
      <p className="text-sm text-text-secondary-dark mb-6">
        These agents will be created based on the <span className="font-medium text-text-primary-dark">{template.name}</span> template.
      </p>

      {/* Team Name Input */}
      <div className="mb-5">
        <label htmlFor="team-name" className="block text-xs font-medium text-text-secondary-dark mb-1.5 uppercase tracking-wide">
          Team Name
        </label>
        <input
          id="team-name"
          type="text"
          value={teamName}
          onChange={(e) => onTeamNameChange(e.target.value)}
          placeholder="Enter a team name..."
          className="w-full bg-surface-dark border border-border-dark rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
          data-testid="team-name-input"
        />
      </div>

      {/* Roles List */}
      <div className="mb-2">
        <div className="flex items-center gap-2 mb-3">
          <Users className="w-4 h-4 text-text-secondary-dark" />
          <span className="text-xs font-medium text-text-secondary-dark uppercase tracking-wide">
            Team Members ({roles.length})
          </span>
        </div>

        {roles.length > 0 ? (
          <div className="space-y-2 max-h-[200px] overflow-y-auto pr-1">
            {roles.map((role, index) => (
              <div
                key={role.role}
                className="flex items-center gap-3 p-3 rounded-lg bg-surface-dark border border-border-dark"
                data-testid={`team-role-${index}`}
              >
                <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 text-primary flex-shrink-0">
                  <User className="w-4 h-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary-dark">
                    {role.label || role.defaultName}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-text-secondary-dark capitalize">
                      {role.role}
                    </span>
                    {role.runtime && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-background-dark text-text-secondary-dark">
                        {role.runtime}
                      </span>
                    )}
                  </div>
                  {role.description && (
                    <p className="text-xs text-text-secondary-dark/70 mt-1 line-clamp-1">
                      {role.description}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-6 text-sm text-text-secondary-dark bg-surface-dark rounded-lg border border-border-dark">
            This template uses default roles. Members will be configured after creation.
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between mt-6">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 px-4 py-2 text-sm text-text-secondary-dark hover:text-text-primary-dark transition-colors"
          data-testid="review-back-btn"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <button
          onClick={onNext}
          disabled={!teamName.trim()}
          className="flex items-center gap-2 px-6 py-2.5 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="review-next-btn"
        >
          Continue
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

export default StepReviewTeam;
