/**
 * Knowledge Document List
 *
 * Displays a list of knowledge document summaries with search.
 * Each row shows title, category, and date. Clicking opens the viewer.
 *
 * @module components/Knowledge/KnowledgeDocumentList
 */

import { Search, FileText } from 'lucide-react';
import type { KnowledgeDocumentSummary } from '../../types';

interface KnowledgeDocumentListProps {
  /** Document summaries to display */
  documents: KnowledgeDocumentSummary[];
  /** Whether data is loading */
  loading: boolean;
  /** Search query value */
  searchQuery: string;
  /** Callback when search query changes */
  onSearchChange: (query: string) => void;
  /** Currently selected document ID */
  selectedDocId?: string;
  /** Callback when a document is selected */
  onSelectDocument: (id: string) => void;
}

/**
 * Format an ISO date string to a short display format.
 *
 * @param iso - ISO date string
 * @returns Formatted date (e.g. "Jan 15, 2026")
 */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

/**
 * Renders a searchable list of document summaries.
 *
 * @param props - Component props
 * @returns Document list JSX
 */
export function KnowledgeDocumentList({
  documents,
  loading,
  searchQuery,
  onSearchChange,
  selectedDocId,
  onSelectDocument,
}: KnowledgeDocumentListProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          type="text"
          placeholder="Search documents..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          aria-label="Search documents"
          className="w-full bg-gray-900 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-primary"
        />
      </div>

      {/* List */}
      {loading ? (
        <div className="text-center py-8 text-gray-400" role="status">Loading documents...</div>
      ) : documents.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          <FileText className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>No documents found</p>
        </div>
      ) : (
        <div className="space-y-1 overflow-y-auto flex-1">
          {documents.map((doc) => (
            <button
              key={doc.id}
              onClick={() => onSelectDocument(doc.id)}
              className={`w-full text-left px-3 py-3 rounded-lg transition-colors ${
                selectedDocId === doc.id
                  ? 'bg-primary/20 border border-primary/30'
                  : 'hover:bg-gray-800 border border-transparent'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-medium text-gray-200 truncate">{doc.title}</h4>
                  <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{doc.preview}</p>
                </div>
                <div className="flex flex-col items-end flex-shrink-0">
                  <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">
                    {doc.category}
                  </span>
                  <span className="text-xs text-gray-600 mt-1">{formatDate(doc.updatedAt)}</span>
                </div>
              </div>
              {doc.tags.length > 0 && (
                <div className="flex gap-1 mt-1.5 flex-wrap">
                  {doc.tags.slice(0, 3).map((tag) => (
                    <span key={tag} className="text-xs px-1.5 py-0.5 rounded bg-gray-900 text-gray-500">
                      {tag}
                    </span>
                  ))}
                  {doc.tags.length > 3 && (
                    <span className="text-xs text-gray-600">+{doc.tags.length - 3}</span>
                  )}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
