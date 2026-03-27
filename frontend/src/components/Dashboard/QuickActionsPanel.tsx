/**
 * QuickActionsPanel Component
 *
 * Provides quick access buttons for common team management actions.
 * Uses the dark theme design system tokens for consistency.
 *
 * @module components/Dashboard/QuickActionsPanel
 */

import React from 'react';
import clsx from 'clsx';
import { Users, Terminal, Settings, ChevronRight } from 'lucide-react';
import { QuickActionsPanelProps } from './types';

/**
 * Quick actions panel with common team management buttons.
 *
 * @param props - Component props
 * @returns Quick actions panel component
 */
export const QuickActionsPanel: React.FC<QuickActionsPanelProps> = ({
  selectedMember,
  onManageTeamsClick,
  onTerminalClick,
  onProjectSettingsClick
}) => {
  return (
    <div className="bg-surface-dark rounded-lg border border-border-dark p-6">
      <h3 className="text-lg font-semibold text-text-primary-dark mb-4">Quick Actions</h3>
      <div className="space-y-3">
        {/* Manage Teams Action */}
        <button
          onClick={onManageTeamsClick}
          className="w-full flex items-center justify-between p-3 text-left rounded-lg border border-border-dark hover:bg-background-dark transition-colors"
        >
          <div className="flex items-center space-x-3">
            <Users className="w-5 h-5 text-primary" />
            <span className="text-text-primary-dark">Manage Teams</span>
          </div>
          <ChevronRight className="w-4 h-4 text-text-secondary-dark" />
        </button>

        {/* Terminal Action */}
        <button
          onClick={onTerminalClick}
          disabled={!selectedMember}
          className={clsx(
            "w-full flex items-center justify-between p-3 text-left rounded-lg border transition-colors",
            selectedMember
              ? "border-border-dark hover:bg-background-dark"
              : "border-border-dark/50 bg-background-dark cursor-not-allowed"
          )}
        >
          <div className="flex items-center space-x-3">
            <Terminal
              className={clsx("w-5 h-5", selectedMember ? "text-emerald-400" : "text-text-secondary-dark")}
            />
            <span className={selectedMember ? "text-text-primary-dark" : "text-text-secondary-dark"}>
              {selectedMember ? `Terminal: ${selectedMember.name}` : 'Select a member for terminal'}
            </span>
          </div>
          {selectedMember && (
            <ChevronRight className="w-4 h-4 text-text-secondary-dark" />
          )}
        </button>

        {/* Project Settings Action */}
        <button
          onClick={onProjectSettingsClick}
          className="w-full flex items-center justify-between p-3 text-left rounded-lg border border-border-dark hover:bg-background-dark transition-colors"
        >
          <div className="flex items-center space-x-3">
            <Settings className="w-5 h-5 text-primary" />
            <span className="text-text-primary-dark">Project Settings</span>
          </div>
          <ChevronRight className="w-4 h-4 text-text-secondary-dark" />
        </button>
      </div>
    </div>
  );
};
