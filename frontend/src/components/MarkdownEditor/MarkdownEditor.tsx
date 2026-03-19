import React, { useState, useEffect } from 'react';
import DOMPurify from 'dompurify';
import { X, Save, Eye, Edit3, File, FolderOpen } from 'lucide-react';
import { Button, IconButton } from '../UI';

interface MarkdownFile {
  name: string;
  path: string;
  content: string;
  modified: boolean;
}

interface MarkdownEditorProps {
  projectPath?: string;
  onClose: () => void;
}

export const MarkdownEditor: React.FC<MarkdownEditorProps> = ({
  projectPath,
  onClose
}) => {
  const [activeFile, setActiveFile] = useState<MarkdownFile | null>(null);
  const [availableFiles, setAvailableFiles] = useState<string[]>([]);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Common .crewly spec file templates
  const templates = {
    'project-spec.md': `# Project Specification

## Overview
Brief description of the project goals and objectives.

## Requirements
- [ ] Requirement 1
- [ ] Requirement 2
- [ ] Requirement 3

## Architecture
Description of the system architecture and design decisions.

## Implementation Notes
Key implementation details and considerations.
`,
    'team-prompts.md': `# Team System Prompts

## Project Manager
You are a Project Manager AI agent responsible for:
- Coordinating team activities
- Managing project timeline and milestones
- Facilitating communication between team members
- Ensuring project deliverables meet requirements

## Developer
You are a Developer AI agent responsible for:
- Writing clean, maintainable code
- Implementing features according to specifications
- Following coding standards and best practices
- Collaborating with other developers

## QA Tester
You are a QA Tester AI agent responsible for:
- Creating comprehensive test plans
- Executing manual and automated tests
- Reporting and tracking bugs
- Ensuring quality standards are met
`,
    'workflow.md': `# Project Workflow

## Development Process
1. **Planning Phase**
   - Requirements gathering
   - Architecture design
   - Task breakdown

2. **Implementation Phase**
   - Feature development
   - Code reviews
   - Testing

3. **Deployment Phase**
   - Build and deployment
   - Monitoring and maintenance

## Team Coordination
- Daily standups
- Sprint planning
- Retrospectives

## Tools and Resources
- Development environment setup
- CI/CD pipeline
- Documentation standards
`
  };

  useEffect(() => {
    if (projectPath) {
      loadAvailableFiles();
    }
  }, [projectPath]);

  const loadAvailableFiles = async () => {
    if (!projectPath) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      const response = await fetch(
        `/api/projects/files?projectPath=${encodeURIComponent(projectPath)}&type=crewly-md`
      );
      
      if (response.ok) {
        const data = await response.json();
        setAvailableFiles(data.files || []);
      } else {
        setError('Failed to load available files');
      }
    } catch (err) {
      setError('Error loading files: ' + (err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const loadFile = async (filePath: string) => {
    setIsLoading(true);
    setError(null);
    
    try {
      const response = await fetch(
        `/api/projects/file-content?projectPath=${encodeURIComponent(projectPath || '')}&filePath=${encodeURIComponent(filePath)}`
      );
      
      if (response.ok) {
        const data = await response.json();
        setActiveFile({
          name: filePath.split('/').pop() || filePath,
          path: filePath,
          content: data.content,
          modified: false
        });
      } else {
        setError('Failed to load file');
      }
    } catch (err) {
      setError('Error loading file: ' + (err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const createNewFile = (templateName: keyof typeof templates) => {
    const fileName = templateName;
    setActiveFile({
      name: fileName,
      path: `.crewly/${fileName}`,
      content: templates[templateName],
      modified: true
    });
  };

  const saveFile = async () => {
    if (!activeFile || !projectPath) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      const response = await fetch('/api/projects/save-file', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectPath,
          filePath: activeFile.path,
          content: activeFile.content
        }),
      });
      
      if (response.ok) {
        setActiveFile({
          ...activeFile,
          modified: false
        });
        // Refresh file list
        await loadAvailableFiles();
      } else {
        setError('Failed to save file');
      }
    } catch (err) {
      setError('Error saving file: ' + (err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleContentChange = (newContent: string) => {
    if (activeFile) {
      setActiveFile({
        ...activeFile,
        content: newContent,
        modified: true
      });
    }
  };

  const renderMarkdown = (content: string) => {
    // Simple markdown renderer for preview — sanitized via DOMPurify
    const raw = content
      .replace(/^# (.*)/gm, '<h1>$1</h1>')
      .replace(/^## (.*)/gm, '<h2>$1</h2>')
      .replace(/^### (.*)/gm, '<h3>$1</h3>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/- \[ \] (.*)/g, '☐ $1')
      .replace(/- \[x\] (.*)/gi, '☑ $1')
      .replace(/^- (.*)/gm, '• $1')
      .replace(/\n/g, '<br>');
    return DOMPurify.sanitize(raw);
  };

  return (
    <div className="markdown-editor-overlay">
      <div className="markdown-editor">
        <div className="markdown-editor-header">
          <div className="header-left">
            <h2>Markdown Editor</h2>
            {activeFile && (
              <span className="file-info">
                {activeFile.name}
                {activeFile.modified && <span className="modified-indicator">●</span>}
              </span>
            )}
          </div>
          
          <div className="header-right">
            {activeFile && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsPreviewMode(!isPreviewMode)}
                  title={isPreviewMode ? 'Edit Mode' : 'Preview Mode'}
                  icon={isPreviewMode ? Edit3 : Eye}
                />

                <Button
                  variant="primary"
                  size="sm"
                  onClick={saveFile}
                  disabled={!activeFile.modified || isLoading}
                  title="Save File"
                  icon={Save}
                />
              </>
            )}

            <IconButton aria-label="Close" variant="ghost" icon={X} onClick={onClose} />
          </div>
        </div>

        {error && (
          <div className="error-message">
            {error}
          </div>
        )}

        <div className="markdown-editor-content">
          {!activeFile ? (
            <div className="file-browser">
              <div className="file-section">
                <h3><FolderOpen size={16} /> Available Files</h3>
                {isLoading ? (
                  <div className="loading">Loading files...</div>
                ) : availableFiles.length > 0 ? (
                  <ul className="file-list">
                    {availableFiles.map((file, index) => (
                      <li key={index}>
                        <button
                          onClick={() => loadFile(file)}
                          className="file-item"
                        >
                          <File size={14} />
                          {file}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="no-files">No .crewly markdown files found</p>
                )}
              </div>

              <div className="file-section">
                <h3><File size={16} /> Create New File</h3>
                <div className="template-list">
                  {Object.keys(templates).map((templateName) => (
                    <button
                      key={templateName}
                      onClick={() => createNewFile(templateName as keyof typeof templates)}
                      className="template-item"
                    >
                      <File size={14} />
                      {templateName}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="editor-pane">
              {isPreviewMode ? (
                <div 
                  className="markdown-preview"
                  dangerouslySetInnerHTML={{ 
                    __html: renderMarkdown(activeFile.content) 
                  }}
                />
              ) : (
                <textarea
                  className="markdown-textarea"
                  value={activeFile.content}
                  onChange={(e) => handleContentChange(e.target.value)}
                  placeholder="Enter your markdown content here..."
                  spellCheck={false}
                />
              )}
            </div>
          )}
        </div>

        {activeFile && (
          <div className="editor-footer">
            <span className="file-path">{activeFile.path}</span>
            <span className="editor-mode">
              {isPreviewMode ? 'Preview' : 'Edit'} Mode
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
