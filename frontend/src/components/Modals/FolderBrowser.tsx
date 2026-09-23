import React, { useState, useEffect, useCallback } from 'react';
import { Folder, ChevronRight, ChevronUp, Home, RefreshCw, FolderPlus } from 'lucide-react';
import { Button, IconButton } from '@crewly/ui/Button';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { Popup } from '@crewly/ui/Popup';
import { Toggle } from '@crewly/ui/Toggle';

interface DirectoryEntry {
  name: string;
  path: string;
  type: 'directory' | 'file';
  isHidden: boolean;
}

interface FolderBrowserProps {
  /** Called when a folder is selected (basic mode) */
  onSelect?: (path: string) => void;
  /** Called to directly create a project (project creation mode) */
  onCreateProject?: (path: string) => Promise<void>;
  onClose: () => void;
  initialPath?: string;
  /** Title for the modal */
  title?: string;
  /** Text for the action button */
  actionButtonText?: string;
}

/**
 * A modal folder browser that navigates the server filesystem.
 * Uses backend API to get full paths (not limited by browser security).
 *
 * Can be used in two modes:
 * 1. Basic selection mode: Pass onSelect to get the selected path
 * 2. Project creation mode: Pass onCreateProject to directly create a project
 */
export const FolderBrowser: React.FC<FolderBrowserProps> = ({
  onSelect,
  onCreateProject,
  onClose,
  initialPath,
  title = 'Select Folder',
  actionButtonText
}) => {
  const [currentPath, setCurrentPath] = useState<string>('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [creating, setCreating] = useState(false);

  // Determine the mode and button text
  const isProjectMode = !!onCreateProject;
  const buttonText = actionButtonText || (isProjectMode ? 'Create Project Here' : 'Select');

  const loadDirectory = useCallback(async (path?: string) => {
    setLoading(true);
    setError('');

    try {
      const params = new URLSearchParams();
      if (path) {
        params.set('path', path);
      }
      if (showHidden) {
        params.set('showHidden', 'true');
      }

      const response = await fetch(`/api/directories?${params.toString()}`);
      const data = await response.json();

      if (data.success) {
        setCurrentPath(data.data.currentPath);
        setParentPath(data.data.parentPath);
        setEntries(data.data.entries);
      } else {
        setError(data.error || 'Failed to load directory');
      }
    } catch (err) {
      setError('Failed to connect to server');
    } finally {
      setLoading(false);
    }
  }, [showHidden]);

  // Initial load
  useEffect(() => {
    loadDirectory(initialPath);
  }, [initialPath, loadDirectory]);

  const handleNavigate = (path: string) => {
    loadDirectory(path);
  };

  const handleGoUp = () => {
    if (parentPath) {
      loadDirectory(parentPath);
    }
  };

  const handleGoHome = () => {
    loadDirectory();
  };

  const handleSelectCurrent = async () => {
    if (isProjectMode && onCreateProject) {
      setCreating(true);
      setError('');
      try {
        await onCreateProject(currentPath);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create project');
        setCreating(false);
      }
    } else if (onSelect) {
      onSelect(currentPath);
      onClose();
    }
  };

  const handleSelectEntry = (entry: DirectoryEntry) => {
    if (entry.type === 'directory') {
      // Navigate into the directory
      handleNavigate(entry.path);
    }
  };

  const handleDoubleClick = async (entry: DirectoryEntry) => {
    if (entry.type === 'directory') {
      if (isProjectMode && onCreateProject) {
        setCreating(true);
        setError('');
        try {
          await onCreateProject(entry.path);
          onClose();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to create project');
          setCreating(false);
        }
      } else if (onSelect) {
        onSelect(entry.path);
        onClose();
      }
    }
  };

  const footer = (
    <>
      <p className="text-xs text-text-secondary-dark">
        Double-click to {isProjectMode ? 'create project in' : 'select'} a folder
      </p>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onClose} disabled={creating}>
          Cancel
        </Button>
        <Button
          icon={FolderPlus}
          onClick={handleSelectCurrent}
          loading={creating}
          disabled={loading}
        >
          {creating ? 'Creating...' : buttonText}
        </Button>
      </div>
    </>
  );

  return (
    // z-[60]: the browser opens on top of other dialogs (e.g. project creation).
    <div className="relative z-[60]">
      <Popup
        isOpen
        onClose={onClose}
        title={title}
        size="xl"
        className="max-w-2xl"
        closable={!creating}
        footer={footer}
        footerAlign="space-between"
      >
        <div className="-m-6">
          {/* Toolbar */}
          <div className="px-4 py-2 border-b border-border-dark flex items-center gap-1">
            <IconButton
              icon={ChevronUp}
              size="sm"
              onClick={handleGoUp}
              disabled={!parentPath || loading}
              title="Go up"
              aria-label="Go up"
            />
            <IconButton
              icon={Home}
              size="sm"
              onClick={handleGoHome}
              disabled={loading}
              title="Go to home"
              aria-label="Go to home"
            />
            <IconButton
              icon={RefreshCw}
              size="sm"
              onClick={() => loadDirectory(currentPath)}
              loading={loading}
              title="Refresh"
              aria-label="Refresh"
            />
            <div className="flex-1" />
            <Toggle
              size="sm"
              label="Show hidden"
              labelPosition="left"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
          </div>

          {/* Current path */}
          <div className="px-4 py-2 bg-background-dark/50 border-b border-border-dark">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-text-secondary-dark">Path:</span>
              <code className="bg-background-dark px-2 py-1 rounded text-xs flex-1 overflow-x-auto whitespace-nowrap">
                {currentPath}
              </code>
            </div>
          </div>

          {/* Directory listing */}
          <div className="overflow-y-auto p-2 h-[45vh] min-h-[240px]">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <LoadingSpinner size="sm" />
              </div>
            ) : error ? (
              <div className="flex items-center justify-center h-full text-red-400 text-sm">
                {error}
              </div>
            ) : entries.length === 0 ? (
              <div className="flex items-center justify-center h-full text-text-secondary-dark text-sm">
                Empty directory
              </div>
            ) : (
              <div className="space-y-1">
                {entries.map((entry) => (
                  // Whole-row click target (click = open, double-click = choose).
                  <button
                    key={entry.path}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-2xl text-left hover:bg-border-dark/50 transition-colors ${
                      entry.isHidden ? 'opacity-60' : ''
                    }`}
                    onClick={() => handleSelectEntry(entry)}
                    onDoubleClick={() => handleDoubleClick(entry)}
                  >
                    <Folder className="w-5 h-5 text-blue-400 flex-shrink-0" />
                    <span className="flex-1 truncate">{entry.name}</span>
                    <ChevronRight className="w-4 h-4 text-text-secondary-dark" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {error && (
            <p className="px-4 pb-3 text-red-400 text-sm">{error}</p>
          )}
        </div>
      </Popup>
    </div>
  );
};
