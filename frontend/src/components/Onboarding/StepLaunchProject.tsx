/**
 * Step 4: Launch First Project
 *
 * Final step: user provides a project path and launches team creation.
 * Shows a summary of what will be created and a prominent launch button.
 *
 * @module components/Onboarding/StepLaunchProject
 */

import React from 'react';
import { Rocket, ArrowLeft, FolderOpen, Loader2, AlertCircle } from 'lucide-react';

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
      <label htmlFor="project-path" className="block text-xs font-medium text-text-secondary-dark mb-1.5 uppercase tracking-wide">
        Project Directory (optional)
      </label>
      <div className="relative">
        <FolderOpen className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary-dark" />
        <input
          id="project-path"
          type="text"
          value={projectPath}
          onChange={(e) => onProjectPathChange(e.target.value)}
          placeholder="/path/to/your/project"
          className="w-full bg-surface-dark border border-border-dark rounded-lg pl-10 pr-4 py-2.5 text-sm font-mono focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
          disabled={isCreating}
          data-testid="project-path-input"
        />
      </div>
      <p className="text-xs text-text-secondary-dark/70 mt-1.5">
        Leave empty to create a team without a project.
      </p>
    </div>

    {/* Summary Card */}
    <div className="bg-surface-dark border border-border-dark rounded-lg p-4 mb-6">
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
    </div>

    {/* Error */}
    {error && (
      <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 mb-4" role="alert" data-testid="launch-error">
        <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
        <p className="text-sm text-red-400">{error}</p>
      </div>
    )}

    {/* Actions */}
    <div className="flex items-center justify-between">
      <button
        onClick={onBack}
        disabled={isCreating}
        className="flex items-center gap-1.5 px-4 py-2 text-sm text-text-secondary-dark hover:text-text-primary-dark transition-colors disabled:opacity-50"
        data-testid="launch-back-btn"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>
      <button
        onClick={onLaunch}
        disabled={isCreating}
        className="flex items-center gap-2 px-8 py-3 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
        data-testid="launch-btn"
      >
        {isCreating ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Creating...
          </>
        ) : (
          <>
            <Rocket className="w-4 h-4" />
            Launch Team
          </>
        )}
      </button>
    </div>
  </div>
);

export default StepLaunchProject;
