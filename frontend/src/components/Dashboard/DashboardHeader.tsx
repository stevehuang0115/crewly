import React from 'react';
import { Badge } from '@crewly/ui/Badge';
import { DashboardHeaderProps } from './types';

export const DashboardHeader: React.FC<DashboardHeaderProps> = ({
  connected,
  selectedProject,
  teamsCount
}) => {
  return (
    <header className="bg-surface-dark shadow-sm border-b border-border-dark">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center py-4">
          <div className="flex items-center">
            <h1 className="text-2xl font-bold text-text-primary-dark">Crewly</h1>
            <Badge variant={connected ? 'success' : 'error'} className="ml-3">
              {connected ? 'Connected' : 'Disconnected'}
            </Badge>
          </div>
          
          <div className="flex items-center space-x-4">
            {selectedProject && (
              <div className="text-sm text-text-secondary-dark">
                <span className="font-medium">Project:</span> {selectedProject.name}
              </div>
            )}
            <div className="text-sm text-text-secondary-dark">
              <span className="font-medium">Teams:</span> {teamsCount}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};