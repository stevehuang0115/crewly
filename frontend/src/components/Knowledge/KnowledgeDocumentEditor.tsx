/**
 * Knowledge Document Editor
 *
 * Form for creating or editing a knowledge document.
 * Includes fields for title, category, tags, and content (textarea).
 *
 * @module components/Knowledge/KnowledgeDocumentEditor
 */

import { useState } from 'react';
import { Save, X } from 'lucide-react';
import type { KnowledgeDocument } from '../../types';

/** Default categories available in the editor */
const DEFAULT_CATEGORIES = ['SOPs', 'Team Norms', 'Architecture', 'Onboarding', 'Runbooks', 'General'];

interface KnowledgeDocumentEditorProps {
  /** Existing document to edit (null for create mode) */
  document: KnowledgeDocument | null;
  /** Available categories from the backend */
  categories: string[];
  /** Whether save is in progress */
  saving: boolean;
  /** Callback when the form is submitted */
  onSave: (data: { title: string; content: string; category: string; tags: string[] }) => void;
  /** Callback to cancel editing */
  onCancel: () => void;
}

/**
 * Renders a document editor form for creating or editing knowledge documents.
 *
 * @param props - Component props
 * @returns Document editor JSX
 */
export function KnowledgeDocumentEditor({
  document: doc,
  categories,
  saving,
  onSave,
  onCancel,
}: KnowledgeDocumentEditorProps) {
  const [title, setTitle] = useState(doc?.title || '');
  const [content, setContent] = useState(doc?.content || '');
  const [category, setCategory] = useState(doc?.category || 'General');
  const [tagsInput, setTagsInput] = useState(doc?.tags.join(', ') || '');

  const allCategories = [...new Set([...DEFAULT_CATEGORIES, ...categories])].sort();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    onSave({ title, content, category, tags });
  };

  const isValid = title.trim().length > 0 && content.trim().length > 0;

  return (
    <form onSubmit={handleSubmit} className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-white">
          {doc ? 'Edit Document' : 'New Document'}
        </h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
          >
            <X className="w-3.5 h-3.5" />
            Cancel
          </button>
          <button
            type="submit"
            disabled={!isValid || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary hover:bg-primary/90 text-white rounded-lg disabled:opacity-50 transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      <div className="space-y-4 flex-1 flex flex-col">
        {/* Title */}
        <div>
          <label htmlFor="doc-title" className="block text-sm font-medium text-gray-300 mb-1">Title</label>
          <input
            id="doc-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Document title"
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-primary"
            maxLength={200}
          />
        </div>

        {/* Category and Tags row */}
        <div className="flex gap-4">
          <div className="flex-1">
            <label htmlFor="doc-category" className="block text-sm font-medium text-gray-300 mb-1">Category</label>
            <select
              id="doc-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-primary"
            >
              {allCategories.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label htmlFor="doc-tags" className="block text-sm font-medium text-gray-300 mb-1">Tags (comma-separated)</label>
            <input
              id="doc-tags"
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="api, backend, auth"
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-primary"
            />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 flex flex-col">
          <label htmlFor="doc-content" className="block text-sm font-medium text-gray-300 mb-1">Content (Markdown)</label>
          <textarea
            id="doc-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Write your document content in Markdown..."
            className="flex-1 min-h-[200px] w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-primary font-mono resize-none"
          />
        </div>
      </div>
    </form>
  );
}
