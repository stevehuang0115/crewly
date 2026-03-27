/**
 * Queue Status Bar Component
 *
 * Collapsible bar displaying message queue status in the chat panel.
 * Shows pending/processing message count and expands to reveal individual
 * messages with cancel actions. Updates in real-time via Socket.IO events.
 *
 * @module components/Chat/QueueStatusBar
 */

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from '../../services/api.service';
import { webSocketService } from '../../services/websocket.service';
import { formatRelativeTimeCompact } from '../../utils/time';
import { Clock, ChevronDown } from 'lucide-react';
import { Badge } from '../UI/Badge';
import { Button } from '../UI/Button';
import type { QueueStatus, QueuedMessage } from '../../types';
import './QueueStatusBar.css';

// =============================================================================
// Constants
// =============================================================================

/** Maximum characters to show in a message content preview */
const MAX_PREVIEW_LENGTH = 60;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Truncate a string to the given max length, adding ellipsis if needed.
 *
 * @param text - The text to truncate
 * @param maxLength - Maximum character count
 * @returns Truncated string
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}


// =============================================================================
// Component
// =============================================================================

/**
 * Collapsible queue status bar for the chat panel.
 *
 * Displays a compact summary of pending/processing messages.
 * Expands to show individual messages with source badges, timestamps,
 * and cancel actions. Hides automatically when the queue is empty.
 *
 * @returns JSX element or null when queue is empty
 */
export const QueueStatusBar: React.FC = () => {
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [pendingMessages, setPendingMessages] = useState<QueuedMessage[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(new Set());

  // ---------------------------------------------------------------------------
  // Fetch initial state
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    async function fetchInitialState() {
      try {
        const [status, messages] = await Promise.all([
          apiService.getQueueStatus(),
          apiService.getPendingMessages(),
        ]);
        if (!cancelled) {
          setQueueStatus(status);
          setPendingMessages(messages);
        }
      } catch {
        // Silently fail on initial load - the bar just won't show
      }
    }

    fetchInitialState();

    return () => {
      cancelled = true;
    };
  }, []);

  // ---------------------------------------------------------------------------
  // WebSocket event handlers
  // ---------------------------------------------------------------------------
  const handleStatusUpdate = useCallback((data: QueueStatus) => {
    setQueueStatus(data);
  }, []);

  const handleMessageEnqueued = useCallback((data: QueuedMessage) => {
    setPendingMessages((prev) => {
      if (prev.some((m) => m.id === data.id)) return prev;
      return [...prev, data];
    });
  }, []);

  const handleMessageProcessing = useCallback((data: QueuedMessage) => {
    setPendingMessages((prev) =>
      prev.map((m) => (m.id === data.id ? { ...m, status: 'processing' as const, processingStartedAt: data.processingStartedAt } : m))
    );
  }, []);

  const handleMessageCompleted = useCallback((data: QueuedMessage) => {
    setPendingMessages((prev) => prev.filter((m) => m.id !== data.id));
  }, []);

  const handleMessageFailed = useCallback((data: QueuedMessage) => {
    setPendingMessages((prev) => prev.filter((m) => m.id !== data.id));
  }, []);

  const handleMessageCancelled = useCallback((data: QueuedMessage) => {
    setPendingMessages((prev) => prev.filter((m) => m.id !== data.id));
    setCancellingIds((prev) => {
      const next = new Set(prev);
      next.delete(data.id);
      return next;
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Subscribe to WebSocket events
  // ---------------------------------------------------------------------------
  useEffect(() => {
    webSocketService.on('queue:status_update', handleStatusUpdate);
    webSocketService.on('queue:message_enqueued', handleMessageEnqueued);
    webSocketService.on('queue:message_processing', handleMessageProcessing);
    webSocketService.on('queue:message_completed', handleMessageCompleted);
    webSocketService.on('queue:message_failed', handleMessageFailed);
    webSocketService.on('queue:message_cancelled', handleMessageCancelled);

    return () => {
      webSocketService.off('queue:status_update', handleStatusUpdate);
      webSocketService.off('queue:message_enqueued', handleMessageEnqueued);
      webSocketService.off('queue:message_processing', handleMessageProcessing);
      webSocketService.off('queue:message_completed', handleMessageCompleted);
      webSocketService.off('queue:message_failed', handleMessageFailed);
      webSocketService.off('queue:message_cancelled', handleMessageCancelled);
    };
  }, [
    handleStatusUpdate,
    handleMessageEnqueued,
    handleMessageProcessing,
    handleMessageCompleted,
    handleMessageFailed,
    handleMessageCancelled,
  ]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /**
   * Cancel a pending message in the queue.
   *
   * @param messageId - ID of the message to cancel
   */
  const handleCancel = async (messageId: string) => {
    setCancellingIds((prev) => new Set(prev).add(messageId));
    try {
      await apiService.cancelQueueMessage(messageId);
    } catch {
      // If cancel fails, remove from cancelling set
      setCancellingIds((prev) => {
        const next = new Set(prev);
        next.delete(messageId);
        return next;
      });
    }
  };

  /**
   * Clear all messages from the queue (pending + processing).
   */
  const [isClearing, setIsClearing] = useState(false);
  const handleClearAll = async () => {
    setIsClearing(true);
    try {
      await apiService.clearQueue();
      setPendingMessages([]);
      setQueueStatus(null);
    } catch {
      // ignore
    } finally {
      setIsClearing(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Hide when queue is empty and not processing
  const pendingCount = queueStatus?.pendingCount ?? pendingMessages.filter((m) => m.status === 'pending').length;
  const isProcessing = queueStatus?.isProcessing ?? pendingMessages.some((m) => m.status === 'processing');

  if (pendingCount === 0 && !isProcessing && pendingMessages.length === 0) {
    return null;
  }

  // Build summary text
  const parts: string[] = [];
  if (pendingCount > 0) {
    parts.push(`${pendingCount} queued`);
  }
  if (isProcessing) {
    parts.push('1 processing');
  }
  const summaryText = parts.join(' \u00b7 ');

  return (
    <div className="queue-status-bar" data-testid="queue-status-bar">
      <div
        className="queue-status-summary"
        onClick={() => setIsExpanded(!isExpanded)}
        data-testid="queue-status-summary"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsExpanded(!isExpanded);
          }
        }}
      >
        {isProcessing && <div className="queue-spinner" data-testid="queue-spinner" />}
        <span className="queue-status-text">{summaryText}</span>
        <Button
          variant="outline"
          size="sm"
          className="queue-clear-all-btn"
          onClick={(e) => {
            e.stopPropagation();
            handleClearAll();
          }}
          disabled={isClearing}
          loading={isClearing}
          data-testid="queue-clear-all-btn"
          title="Clear all queued messages"
        >
          {isClearing ? 'Clearing...' : 'Clear All'}
        </Button>
        <button
          className={`queue-toggle-btn${isExpanded ? ' expanded' : ''}`}
          aria-label={isExpanded ? 'Collapse queue' : 'Expand queue'}
          tabIndex={-1}
        >
          <ChevronDown size={14} />
        </button>
      </div>

      <div
        className={`queue-message-list${isExpanded ? ' expanded' : ''}`}
        data-testid="queue-message-list"
      >
        {pendingMessages.map((msg) => (
          <div
            key={msg.id}
            className={`queue-message-item${msg.status === 'processing' ? ' processing' : ''}`}
            data-testid="queue-message-item"
          >
            <div className="queue-item-status">
              {msg.status === 'processing' ? (
                <div className="queue-spinner" />
              ) : (
                <Clock size={14} aria-label="pending" />
              )}
            </div>

            <div className="queue-item-content">
              <p className="queue-item-preview">{truncate(msg.content, MAX_PREVIEW_LENGTH)}</p>
              <div className="queue-item-meta">
                <Badge variant="default" size="sm">{msg.source === 'slack' ? 'slack' : 'web'}</Badge>
                <span className="queue-item-time">{formatRelativeTimeCompact(msg.enqueuedAt)}</span>
              </div>
            </div>

            <Button
              variant="danger-ghost"
              size="sm"
              className="queue-cancel-btn"
              onClick={() => msg.status === 'processing' ? handleClearAll() : handleCancel(msg.id)}
              disabled={cancellingIds.has(msg.id) || isClearing}
              loading={cancellingIds.has(msg.id) || isClearing}
              data-testid="queue-cancel-btn"
            >
              {cancellingIds.has(msg.id) || isClearing ? 'Cancelling...' : 'Cancel'}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default QueueStatusBar;
