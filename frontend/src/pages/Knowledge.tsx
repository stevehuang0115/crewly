/**
 * Knowledge Page
 *
 * Company Knowledge management page for browsing, creating, and editing
 * knowledge documents. Supports both global (company-wide) and project-scoped documents.
 *
 * @module pages/Knowledge
 */

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BookOpen, Plus } from 'lucide-react';
import { apiService } from '../services/api.service';
import { KnowledgeScopeToggle } from '../components/Knowledge/KnowledgeScopeToggle';
import { KnowledgeCategoryFilter } from '../components/Knowledge/KnowledgeCategoryFilter';
import { KnowledgeDocumentList } from '../components/Knowledge/KnowledgeDocumentList';
import { KnowledgeDocumentViewer } from '../components/Knowledge/KnowledgeDocumentViewer';
import { KnowledgeDocumentEditor } from '../components/Knowledge/KnowledgeDocumentEditor';
import type { KnowledgeScope, KnowledgeDocumentSummary, KnowledgeDocument, Project } from '../types';

/** View mode for the content area */
type ViewMode = 'list' | 'view' | 'edit' | 'create';

/**
 * Knowledge page component.
 *
 * Layout: sidebar (categories) + main area (list / viewer / editor).
 *
 * @returns Knowledge page JSX
 */
export function Knowledge() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Scope state
  const [scope, setScope] = useState<KnowledgeScope>(
    searchParams.get('project') ? 'project' : 'global',
  );
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string>('');

  // Document state
  const [documents, setDocuments] = useState<KnowledgeDocumentSummary[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);

  // View state
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedDocId, setSelectedDocId] = useState<string | undefined>();
  const [currentDocument, setCurrentDocument] = useState<KnowledgeDocument | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load projects on mount
  useEffect(() => {
    apiService.getProjects().then(setProjects).catch(() => {});
  }, []);

  // Auto-select project from URL param
  useEffect(() => {
    const projectId = searchParams.get('project');
    if (projectId && projects.length > 0) {
      const project = projects.find((p) => p.id === projectId);
      if (project) {
        setScope('project');
        setSelectedProjectPath(project.path);
      }
    }
  }, [searchParams, projects]);

  /**
   * Load documents and categories for the current scope.
   */
  const loadDocuments = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      if (scope === 'project' && !selectedProjectPath) {
        setDocuments([]);
        setCategories([]);
        setLoading(false);
        return;
      }

      const [docs, cats] = await Promise.all([
        apiService.getKnowledgeDocuments(scope, selectedProjectPath || undefined, selectedCategory || undefined, searchQuery || undefined),
        apiService.getKnowledgeCategories(scope, selectedProjectPath || undefined),
      ]);

      setDocuments(docs);
      setCategories(cats);
    } catch {
      setError('Failed to load documents');
    } finally {
      setLoading(false);
    }
  }, [scope, selectedProjectPath, selectedCategory, searchQuery]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  /**
   * Handle scope change.
   */
  const handleScopeChange = (newScope: KnowledgeScope) => {
    setScope(newScope);
    setSelectedDocId(undefined);
    setCurrentDocument(null);
    setViewMode('list');
    if (newScope === 'global') {
      setSelectedProjectPath('');
      setSearchParams({});
    }
  };

  /**
   * Handle project selection.
   */
  const handleProjectChange = (projectPath: string) => {
    setSelectedProjectPath(projectPath);
    setSelectedDocId(undefined);
    setCurrentDocument(null);
    setViewMode('list');
    const project = projects.find((p) => p.path === projectPath);
    if (project) {
      setSearchParams({ project: project.id });
    }
  };

  /**
   * Handle document selection — load full document.
   */
  const handleSelectDocument = async (id: string) => {
    setSelectedDocId(id);
    try {
      const doc = await apiService.getKnowledgeDocument(id, scope, selectedProjectPath || undefined);
      setCurrentDocument(doc);
      setViewMode('view');
    } catch {
      setError('Failed to load document');
    }
  };

  /**
   * Handle creating a new document.
   */
  const handleCreate = () => {
    setSelectedDocId(undefined);
    setCurrentDocument(null);
    setViewMode('create');
  };

  /**
   * Handle saving a document (create or update).
   */
  const handleSave = async (data: { title: string; content: string; category: string; tags: string[] }) => {
    setSaving(true);
    try {
      if (viewMode === 'create') {
        const id = await apiService.createKnowledgeDocument({
          ...data,
          scope,
          projectPath: selectedProjectPath || undefined,
        });
        await loadDocuments();
        await handleSelectDocument(id);
      } else if (currentDocument) {
        await apiService.updateKnowledgeDocument(currentDocument.id, {
          ...data,
          scope,
          projectPath: selectedProjectPath || undefined,
        });
        await loadDocuments();
        await handleSelectDocument(currentDocument.id);
      }
    } catch {
      setError('Failed to save document');
    } finally {
      setSaving(false);
    }
  };

  /**
   * Handle deleting a document.
   */
  const handleDelete = async () => {
    if (!currentDocument) return;
    try {
      await apiService.deleteKnowledgeDocument(currentDocument.id, scope, selectedProjectPath || undefined);
      setCurrentDocument(null);
      setSelectedDocId(undefined);
      setViewMode('list');
      await loadDocuments();
    } catch {
      setError('Failed to delete document');
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <BookOpen className="w-6 h-6 text-primary" />
          <h1 className="text-2xl font-bold text-white">Knowledge</h1>
        </div>
        <KnowledgeScopeToggle
          scope={scope}
          onScopeChange={handleScopeChange}
          projects={projects}
          selectedProjectPath={selectedProjectPath}
          onProjectChange={handleProjectChange}
        />
      </div>

      {error && (
        <div className="mb-4 px-4 py-2 bg-red-900/20 border border-red-500/30 rounded-lg text-sm text-red-400" role="alert">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
        </div>
      )}

      {/* Main layout: sidebar + content */}
      <div className="flex gap-6 flex-1 min-h-0">
        {/* Sidebar - categories */}
        <div className="w-44 flex-shrink-0">
          <div className="mb-4">
            <button
              onClick={handleCreate}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-sm bg-primary hover:bg-primary/90 text-white rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Document
            </button>
          </div>
          <KnowledgeCategoryFilter
            categories={categories}
            selectedCategory={selectedCategory}
            onCategoryChange={setSelectedCategory}
          />
        </div>

        {/* Content area */}
        <div className="flex-1 min-w-0 flex gap-6">
          {/* Document list (always visible unless in create/edit mode on small screens) */}
          <div className={`w-80 flex-shrink-0 ${viewMode === 'create' || viewMode === 'edit' ? 'hidden lg:block' : ''}`}>
            <KnowledgeDocumentList
              documents={documents}
              loading={loading}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              selectedDocId={selectedDocId}
              onSelectDocument={handleSelectDocument}
            />
          </div>

          {/* Viewer / Editor */}
          <div className="flex-1 min-w-0">
            {viewMode === 'view' && currentDocument && (
              <KnowledgeDocumentViewer
                document={currentDocument}
                onEdit={() => setViewMode('edit')}
                onDelete={handleDelete}
              />
            )}
            {viewMode === 'edit' && currentDocument && (
              <KnowledgeDocumentEditor
                document={currentDocument}
                categories={categories}
                saving={saving}
                onSave={handleSave}
                onCancel={() => setViewMode('view')}
              />
            )}
            {viewMode === 'create' && (
              <KnowledgeDocumentEditor
                document={null}
                categories={categories}
                saving={saving}
                onSave={handleSave}
                onCancel={() => setViewMode('list')}
              />
            )}
            {viewMode === 'list' && !loading && (
              <div className="flex items-center justify-center h-full text-gray-500">
                <div className="text-center">
                  <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p>Select a document to view</p>
                  <p className="text-sm mt-1">or create a new one</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
