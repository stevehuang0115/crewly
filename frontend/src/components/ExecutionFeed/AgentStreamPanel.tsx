/**
 * AgentStreamPanel — Real-time streaming output panel for agent execution.
 *
 * Displays live text output, tool call status, and step progress
 * for a specific agent session using the SSE stream endpoint.
 *
 * @module components/ExecutionFeed/AgentStreamPanel
 */

import React, { useRef, useEffect } from 'react';
import { useAgentStream, type StreamEntry } from '../../hooks/useAgentStream';

/**
 * Props for AgentStreamPanel
 */
export interface AgentStreamPanelProps {
  /** Agent session name to stream, or null to show empty state */
  sessionName: string | null;
  /** Optional CSS class name */
  className?: string;
  /** Maximum height for scrollable area (default: '400px') */
  maxHeight?: string;
}

/** Map entry types to dot colors */
const DOT_COLORS: Record<string, string> = {
  text_chunk: 'bg-blue-400',
  tool_call_start: 'bg-amber-400',
  tool_call_finish: 'bg-emerald-400',
  step_finish: 'bg-primary',
};

/**
 * Single stream entry row.
 *
 * @param entry - Stream entry to render
 */
const StreamEntryRow: React.FC<{ entry: StreamEntry }> = ({ entry }) => {
  const dotColor = DOT_COLORS[entry.type] || 'bg-gray-400';
  const isInProgress = entry.inProgress === true;

  return (
    <div
      className="flex items-start gap-3 px-4 py-2 border-b border-border-dark hover:bg-surface-dark/50 transition-colors"
      data-testid="stream-entry"
      role="listitem"
    >
      {/* Status dot */}
      <span
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotColor} ${isInProgress ? 'animate-pulse' : ''}`}
        aria-hidden="true"
      />

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text-secondary-dark uppercase tracking-wide">
            {entry.toolName || entry.type.replace('_', ' ')}
          </span>
          {entry.durationMs !== undefined && (
            <span className="text-xs text-text-secondary-dark/70">
              {entry.durationMs}ms
            </span>
          )}
          {isInProgress && (
            <span className="text-xs text-amber-400 font-medium">Running...</span>
          )}
        </div>
        <p className="text-sm text-text-primary-dark whitespace-pre-wrap break-words">
          {entry.text}
        </p>
        {entry.detail && (
          <p className="text-xs text-text-secondary-dark/70 truncate mt-0.5 font-mono">
            {entry.detail}
          </p>
        )}
      </div>
    </div>
  );
};

/**
 * Real-time agent streaming output panel.
 *
 * Shows:
 * - Live text output as the model generates it
 * - Tool call start/finish with durations
 * - Step completion markers
 * - Connection status indicator
 *
 * @param props - Component props
 * @returns React element
 *
 * @example
 * ```tsx
 * <AgentStreamPanel sessionName="crewly-assistant" className="h-96" />
 * ```
 */
export const AgentStreamPanel: React.FC<AgentStreamPanelProps> = ({
  sessionName,
  className = '',
  maxHeight = '400px',
}) => {
  const { entries, connected, error, currentText, clear } = useAgentStream(sessionName);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to top when new entries arrive (newest first)
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [entries.length]);

  return (
    <div
      className={`flex flex-col rounded-lg border border-border-dark bg-surface-dark overflow-hidden ${className}`}
      data-testid="agent-stream-panel"
      role="log"
      aria-label={`Agent stream output for ${sessionName || 'no agent'}`}
      aria-live="polite"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-dark">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-gray-500'}`}
            aria-label={connected ? 'Connected' : 'Disconnected'}
          />
          <h3 className="text-sm font-semibold text-text-primary-dark">
            Agent Stream
          </h3>
          {sessionName && (
            <span className="text-xs text-text-secondary-dark font-mono">
              {sessionName}
            </span>
          )}
          {entries.length > 0 && (
            <span className="text-xs text-text-secondary-dark">
              ({entries.length})
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {error && (
            <span className="text-xs text-red-400" role="alert">
              {error}
            </span>
          )}
          {entries.length > 0 && (
            <button
              onClick={clear}
              className="text-xs text-text-secondary-dark hover:text-text-primary-dark transition-colors"
              data-testid="stream-clear"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Current streaming text (live, before step flush) */}
      {currentText.length > 0 && (
        <div className="px-4 py-2 border-b border-border-dark bg-background-dark/50">
          <div className="flex items-center gap-2 mb-1">
            <span className="h-2 w-2 rounded-full bg-blue-400 animate-pulse" aria-hidden="true" />
            <span className="text-xs font-medium text-text-secondary-dark uppercase tracking-wide">
              Thinking...
            </span>
          </div>
          <p className="text-sm text-text-primary-dark whitespace-pre-wrap break-words font-mono" data-testid="stream-current-text">
            {currentText.length > 500 ? currentText.substring(currentText.length - 500) : currentText}
          </p>
        </div>
      )}

      {/* Entry list */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        style={{ maxHeight }}
        role="list"
      >
        {!sessionName ? (
          <div className="flex flex-col items-center justify-center py-12 text-text-secondary-dark">
            <p className="text-sm">Select an agent to see streaming output</p>
          </div>
        ) : entries.length === 0 && !currentText ? (
          <div className="flex flex-col items-center justify-center py-12 text-text-secondary-dark">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse mb-3" />
            <p className="text-sm">Waiting for agent activity...</p>
          </div>
        ) : (
          entries.map((entry) => (
            <StreamEntryRow key={entry.id} entry={entry} />
          ))
        )}
      </div>
    </div>
  );
};

export default AgentStreamPanel;
