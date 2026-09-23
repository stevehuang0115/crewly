import React, { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Button } from '@crewly/ui/Button';
import { FormError, FormHelp, FormInput, FormLabel } from '@crewly/ui/Form';
import { Popup } from '@crewly/ui/Popup';
import { FolderBrowser } from './FolderBrowser';

interface ProjectCreatorProps {
  onSave: (path: string) => Promise<void>;
  onClose: () => void;
}

/**
 * Dialog for creating a project from a filesystem path (typed or browsed).
 *
 * @param props - onSave receives the chosen path; onClose dismisses the dialog
 * @returns The project-creation dialog
 */
export const ProjectCreator: React.FC<ProjectCreatorProps> = ({
  onSave,
  onClose
}) => {
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!path.trim()) {
      setError('Please enter a project path');
      return;
    }

    try {
      setLoading(true);
      setError('');
      await onSave(path.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setLoading(false);
    }
  };

  const handleSelectFolder = () => {
    setShowFolderBrowser(true);
  };

  const handleFolderSelected = (selectedPath: string) => {
    setPath(selectedPath);
    setError('');
    setShowFolderBrowser(false);
  };

  const handleCreateProjectFromBrowser = async (selectedPath: string) => {
    // Directly create project from folder browser and close everything
    await onSave(selectedPath);
    // onSave will handle navigation/closing the parent
  };

  const footer = (
    <>
      <Button type="button" variant="secondary" onClick={onClose} disabled={loading}>
        Cancel
      </Button>
      <Button
        type="submit"
        onClick={handleSubmit}
        loading={loading}
        disabled={!path.trim()}
      >
        {loading ? 'Creating...' : 'Create Project'}
      </Button>
    </>
  );

  return (
    <>
      <Popup
        isOpen
        onClose={onClose}
        title="Create New Project"
        size="md"
        // Not closable while the folder browser is on top, so Escape only
        // dismisses the browser.
        closable={!loading && !showFolderBrowser}
        footer={footer}
      >
        <form onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div>
              <FormLabel htmlFor="project-path" required>
                Project Path
              </FormLabel>
              <div className="flex items-center gap-2">
                <FormInput
                  id="project-path"
                  placeholder="/Users/name/my-project"
                  type="text"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  disabled={loading}
                  required
                />
                <Button
                  type="button"
                  variant="secondary"
                  icon={FolderOpen}
                  className="whitespace-nowrap"
                  onClick={handleSelectFolder}
                  disabled={loading}
                >
                  Browse
                </Button>
              </div>
              <FormHelp className="mt-2">
                Enter the <strong>full absolute path</strong> to your project directory, or use Browse to navigate to it.
              </FormHelp>
              {error && <FormError className="text-sm mt-2">{error}</FormError>}
            </div>
          </div>
        </form>
      </Popup>

      {/* Folder Browser Modal - Direct project creation mode */}
      {showFolderBrowser && (
        <FolderBrowser
          title="Create New Project"
          onCreateProject={handleCreateProjectFromBrowser}
          onClose={() => setShowFolderBrowser(false)}
        />
      )}
    </>
  );
};
