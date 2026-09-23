import React from 'react';
import { Badge } from '@crewly/ui/Badge';
import { Card } from '@crewly/ui/Card';
import { ProjectInfoPanelProps } from './types';

export const ProjectInfoPanel: React.FC<ProjectInfoPanelProps> = ({
  project,
  teamsCount,
  totalMembers
}) => {
  return (
    <Card padding="lg" className="shadow-md">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center space-x-3">
          <div className="flex-shrink-0">
            <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center">
              <svg className="w-6 h-6 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path 
                  strokeLinecap="round" 
                  strokeLinejoin="round" 
                  strokeWidth={2} 
                  d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" 
                />
              </svg>
            </div>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-text-primary-dark">{project.name}</h3>
            <p className="text-sm text-text-secondary-dark">Project Overview</p>
          </div>
        </div>
        <Badge variant={project.status === 'active' ? 'success' : project.status === 'paused' ? 'warning' : 'default'}>
          {project.status}
        </Badge>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-text-secondary-dark">Project Path</label>
          <code className="mt-1 block w-full text-sm bg-background-dark rounded-2xl border border-border-dark p-2 break-all">
            {project.path}
          </code>
        </div>

        {project.description && (
          <div>
            <label className="block text-sm font-medium text-text-secondary-dark">Description</label>
            <p className="mt-1 text-sm text-text-secondary-dark">{project.description}</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 pt-4 border-t border-border-dark">
          <div>
            <label className="block text-sm font-medium text-text-secondary-dark">Teams</label>
            <p className="text-2xl font-bold text-primary">{teamsCount}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary-dark">Total Members</label>
            <p className="text-2xl font-bold text-green-400">{totalMembers}</p>
          </div>
        </div>
      </div>
    </Card>
  );
};