/**
 * Step 4: Launch First Project
 *
 * Final step: user provides a project path and launches team creation.
 * Shows a summary of what will be created and a prominent launch button.
 *
 * @module components/Onboarding/StepLaunchProject
 */

import React from 'react';
import { Rocket, ArrowLeft, FolderOpen } from 'lucide-react';
import { Alert } from '@crewly/ui/Alert';
import { Button } from '@crewly/ui/Button';
import { Card } from '@crewly/ui/Card';
import { FormInput, FormLabel } from '@crewly/ui/Form';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface StepLaunchProjectProps {
  /** Current project path */
  projectPath: string;
  /** Callback to update project path */
  onProjectPathChange: (path: string) => void;
  /** Trigger the launch (team + project creation) */
  onLaunch: () => void;
  /** Go back */
  onBack: () => void;
  /** Whether creation is in progress */
  isCreating: boolean;
  /** Error message from creation attempt */
  error: string | null;
  /** Team name for summary */
  teamName: string;
  /** Template name for summary */
  templateName: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Final launch step with project path input and creation summary.
 *
 * @param props - {@link StepLaunchProjectProps}
 * @returns Launch step
 */
export const StepLaunchProject: React.FC<StepLaunchProjectProps> = ({
  projectPath,
  onProjectPathChange,
  onLaunch,
  onBack,
  isCreating,
  error,
  teamName,
  templateName,
}) => (
  <div data-testid="step-launch-project">
    {/* Heading */}
    <h3 className="text-xl font-bold mb-1">Launch Your First Project</h3>
    <p className="text-sm text-text-secondary-dark mb-6">
      Point to an existing directory where your project lives. This is optional — you can add projects later.
    </p>

    {/* Project Path Input */}
    <div className="mb-6">
      <FormLabel htmlFor="project-path" className="text-xs text-text-secondary-dark mb-1.5 uppercase tracking-wide">
        Project Directory (optional)
      </FormLabel>
      <div className="relative">
        <FolderOpen className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary-dark" />
        <FormInput
          id="project-path"
          type="text"
          value={projectPath}
          onChange={(e) => onProjectPathChange(e.target.value)}
          placeholder="/path/to/your/project"
          className="pl-10 font-mono"
          disabled={isCreating}
          data-testid="project-path-input"
        />
      </div>
      <p className="text-xs text-text-secondary-dark/70 mt-1.5">
        Leave empty to create a team without a project.
      </p>
    </div>

    {/* Summary Card */}
    <Card className="mb-6">
      <p className="text-xs font-medium text-text-secondary-dark uppercase tracking-wide mb-3">
        What will be created
      </p>
      <div className="space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-text-secondary-dark">Team</span>
          <span className="font-medium text-text-primary-dark">{teamName}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-text-secondary-dark">Template</span>
          <span className="font-medium text-text-primary-dark">{templateName}</span>
        </div>
        {projectPath.trim() && (
          <div className="flex items-center justify-between">
            <span className="text-text-secondary-dark">Project</span>
            <span className="font-medium text-text-primary-dark font-mono text-xs truncate max-w-[200px]" title={projectPath}>
              {projectPath}
            </span>
          </div>
        )}
      </div>
    </Card>

    {/* Error */}
    {error && (
      <Alert variant="error" size="sm" className="mb-4" data-testid="launch-error">
        {error}
      </Alert>
    )}

    {/* Actions */}
    <div className="flex items-center justify-between">
      <Button
        variant="ghost"
        icon={ArrowLeft}
        onClick={onBack}
        disabled={isCreating}
        data-testid="launch-back-btn"
      >
        Back
      </Button>
      <Button
        icon={Rocket}
        onClick={onLaunch}
        loading={isCreating}
        className="px-8"
        data-testid="launch-btn"
      >
        {isCreating ? 'Creating...' : 'Launch Team'}
      </Button>
    </div>
  </div>
);

export default StepLaunchProject;
