/**
 * Knowledge Scope Toggle
 *
 * Switches between Global and Project scope for knowledge documents.
 * When Project scope is selected, shows a project selector dropdown.
 *
 * @module components/Knowledge/KnowledgeScopeToggle
 */

import { Globe, FolderOpen } from 'lucide-react';
import type { KnowledgeScope, Project } from '../../types';

interface KnowledgeScopeToggleProps {
  /** Current scope selection */
  scope: KnowledgeScope;
  /** Callback when scope changes */
  onScopeChange: (scope: KnowledgeScope) => void;
  /** Available projects for the project dropdown */
  projects: Project[];
  /** Currently selected project path */
  selectedProjectPath?: string;
  /** Callback when project selection changes */
  onProjectChange: (projectPath: string) => void;
}

/**
 * Renders a Global/Project toggle with an optional project dropdown.
 *
 * @param props - Component props
 * @returns Scope toggle JSX
 */
export function KnowledgeScopeToggle({
  scope,
  onScopeChange,
  projects,
  selectedProjectPath,
  onProjectChange,
}: KnowledgeScopeToggleProps) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex gap-1 bg-gray-900 rounded-lg p-1" role="tablist" aria-label="Document scope">
        <button
          role="tab"
          aria-selected={scope === 'global'}
          onClick={() => onScopeChange('global')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            scope === 'global' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'
          }`}
        >
          <Globe className="w-3.5 h-3.5" />
          Global
        </button>
        <button
          role="tab"
          aria-selected={scope === 'project'}
          onClick={() => onScopeChange('project')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            scope === 'project' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'
          }`}
        >
          <FolderOpen className="w-3.5 h-3.5" />
          Project
        </button>
      </div>

      {scope === 'project' && (
        <select
          value={selectedProjectPath || ''}
          onChange={(e) => onProjectChange(e.target.value)}
          aria-label="Select project"
          className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-primary"
        >
          <option value="" disabled>Select a project...</option>
          {projects.map((p) => (
            <option key={p.id} value={p.path}>{p.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}
