import React, { useState, useEffect } from 'react';
import { FileText } from 'lucide-react';
import { Project } from '../../types';
import { FileTreeNode, EditorViewProps, FileTreeViewProps } from './types';
import { Button } from '@crewly/ui';

// File Tree View Component
const FileTreeView: React.FC<FileTreeViewProps> = ({ 
  files, 
  selectedFile, 
  expandedFolders, 
  onFileSelect, 
  onToggleFolder, 
  level = 0 
}) => {
  return (
    <div>
      {files.map((file) => (
        <div key={file.path}>
          <div
            className={`file-item ${selectedFile === file.path ? 'file-item--selected' : ''}`}
            style={{ paddingLeft: `${level * 16 + 8}px` }}
            onClick={() => {
              if (file.type === 'folder') {
                onToggleFolder(file.path);
              } else {
                onFileSelect(file.path);
              }
            }}
          >
            {file.type === 'folder' && (
              <span className="folder-toggle">
                {expandedFolders.has(file.path) ? '▼' : '▶'}
              </span>
            )}
            <span className="file-icon">{file.icon}</span>
            <span className="file-name">{file.name}</span>
          </div>
          
          {file.type === 'folder' && 
           expandedFolders.has(file.path) && 
           file.children && 
           file.children.length > 0 && (
            <FileTreeView
              files={file.children}
              selectedFile={selectedFile}
              expandedFolders={expandedFolders}
              onFileSelect={onFileSelect}
              onToggleFolder={onToggleFolder}
              level={level + 1}
            />
          )}
        </div>
      ))}
    </div>
  );
};

// Main EditorView Component
const EditorView: React.FC<EditorViewProps> = ({ 
  project, 
  selectedFile, 
  onFileSelect, 
  setIsMarkdownEditorOpen 
}) => {
  const [projectFiles, setProjectFiles] = useState<FileTreeNode[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['.crewly']));
  const [fileContent, setFileContent] = useState<string>('');
  const [loadingFile, setLoadingFile] = useState<boolean>(false);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    loadProjectFiles();
  }, [project]);

  useEffect(() => {
    if (selectedFile) {
      loadFileContent(selectedFile);
    } else {
      setFileContent('');
      setFileError(null);
    }
  }, [selectedFile, project]);

  const loadFileContent = async (filePath: string) => {
    try {
      setLoadingFile(true);
      setFileError(null);
      
      const response = await fetch(`/api/projects/${project.id}/file-content?filePath=${encodeURIComponent(filePath)}`);
      
      if (response.ok) {
        const result = await response.json();
        setFileContent(result.data.content);
      } else {
        const error = await response.json();
        setFileError(error.error || 'Failed to load file');
      }
    } catch (error) {
      console.error('Error loading file content:', error);
      setFileError('Failed to load file content');
    } finally {
      setLoadingFile(false);
    }
  };

  const loadProjectFiles = async () => {
    try {
      console.log(`Loading files for project: ${project.name} at path: ${project.path}`);
      const response = await fetch(`/api/projects/${project.id}/files?depth=4&includeDotFiles=true`);
      
      if (response.ok) {
        const result = await response.json();
        if (result.success && result.data.files) {
          console.log(`Loaded ${result.data.files.length} items from project directory:`);
          console.log(`Original path: ${result.data.projectPath}`);
          console.log(`Resolved path: ${result.data.resolvedPath}`);
          console.log('Files found:', result.data.files.map((f: any) => f.name).join(', '));
          setProjectFiles(result.data.files);
          
          // Auto-expand .crewly folder if it exists
          const crewlyExists = result.data.files.some((file: any) => file.name === '.crewly');
          if (crewlyExists) {
            setExpandedFolders(prev => new Set([...prev, '.crewly']));
          }
        } else {
          console.error('Failed to load project files:', result.error);
          setProjectFiles([]);
        }
      } else {
        console.error('Error loading project files:', response.status);
        setProjectFiles([]);
      }
    } catch (error) {
      console.error('Error loading project files:', error);
      setProjectFiles([]);
    }
  };

  const toggleFolder = (folderPath: string) => {
    const newExpanded = new Set(expandedFolders);
    if (newExpanded.has(folderPath)) {
      newExpanded.delete(folderPath);
    } else {
      newExpanded.add(folderPath);
    }
    setExpandedFolders(newExpanded);
  };

  return (
    <div className="editor-view">
      {/* Left Panel - File Tree */}
      <div className="file-tree-panel">
        <div className="file-tree-header">
          <h3>Project Files</h3>
          <div className="project-path-display">
            <small title={project.path}>{project.path}</small>
          </div>
        </div>
        <div className="file-tree">
          <FileTreeView 
            files={projectFiles}
            selectedFile={selectedFile}
            expandedFolders={expandedFolders}
            onFileSelect={onFileSelect}
            onToggleFolder={toggleFolder}
          />
        </div>
      </div>

      {/* Right Panel - Editor/Info */}
      <div className="editor-panel">
        {selectedFile ? (
          <div className="file-viewer">
            <div className="file-header">
              <h3>{selectedFile}</h3>
            </div>
            <div className="file-content">
              {loadingFile ? (
                <div className="loading-state">
                  <p>Loading file content...</p>
                </div>
              ) : fileError ? (
                <div className="error-state">
                  <p>Error: {fileError}</p>
                </div>
              ) : (
                <pre className="code-viewer">
                  <code>{fileContent}</code>
                </pre>
              )}
            </div>
          </div>
        ) : (
          <div className="project-info">
            <div className="info-header">
              <h3>Project Information</h3>
              <Button
                variant="primary"
                icon={FileText}
                onClick={() => setIsMarkdownEditorOpen(true)}
                title="Edit .crewly spec files"
              >
                Edit Specs
              </Button>
            </div>
            
            <div className="info-section">
              <h4>Name</h4>
              <p>{project.name}</p>
            </div>
            <div className="info-section">
              <h4>Path</h4>
              <p>{project.path}</p>
            </div>
            <div className="info-section">
              <h4>Status</h4>
              <p>{project.status}</p>
            </div>
            {project.description && (
              <div className="info-section">
                <h4>Description</h4>
                <p>{project.description}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// Named export
export { EditorView };

// Default export
export default EditorView;