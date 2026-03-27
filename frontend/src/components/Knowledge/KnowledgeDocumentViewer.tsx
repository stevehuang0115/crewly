/**
 * Knowledge Document Viewer
 *
 * Displays the full content of a knowledge document with edit and delete buttons.
 * Renders markdown content as formatted text.
 *
 * @module components/Knowledge/KnowledgeDocumentViewer
 */

import { Edit3, Trash2, Clock, User } from 'lucide-react';
import type { KnowledgeDocument } from '../../types';

interface KnowledgeDocumentViewerProps {
  /** The document to display */
  document: KnowledgeDocument;
  /** Callback to enter edit mode */
  onEdit: () => void;
  /** Callback to delete the document */
  onDelete: () => void;
}

/**
 * Format an ISO date string for display.
 *
 * @param iso - ISO date string
 * @returns Formatted date with time
 */
function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/**
 * Renders a full knowledge document with metadata, actions, and content.
 *
 * @param props - Component props
 * @returns Document viewer JSX
 */
export function KnowledgeDocumentViewer({
  document: doc,
  onEdit,
  onDelete,
}: KnowledgeDocumentViewerProps) {
  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-bold text-white mb-2">{doc.title}</h2>
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span className="px-2 py-0.5 rounded bg-gray-800 text-gray-300">{doc.category}</span>
            <span className="flex items-center gap-1">
              <User className="w-3 h-3" />
              {doc.createdBy}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDateTime(doc.updatedAt)}
            </span>
          </div>
          {doc.tags.length > 0 && (
            <div className="flex gap-1.5 mt-2 flex-wrap">
              {doc.tags.map((tag) => (
                <span key={tag} className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex gap-2 ml-4">
          <button
            onClick={onEdit}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
            aria-label="Edit document"
          >
            <Edit3 className="w-3.5 h-3.5" />
            Edit
          </button>
          <button
            onClick={onDelete}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-gray-800 hover:bg-red-900/50 text-gray-300 hover:text-red-300 rounded-lg transition-colors"
            aria-label="Delete document"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="border-t border-gray-800 pt-4">
        <div className="prose prose-invert prose-sm max-w-none whitespace-pre-wrap text-gray-300 leading-relaxed">
          {doc.content}
        </div>
      </div>
    </div>
  );
}
