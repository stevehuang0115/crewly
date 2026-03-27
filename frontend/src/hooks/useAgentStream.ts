/**
 * useAgentStream Hook
 *
 * Subscribes to the SSE endpoint GET /api/agents/:sessionName/stream
 * and provides a real-time feed of agent streaming events (text chunks,
 * tool calls, step completions).
 *
 * @module hooks/useAgentStream
 */

import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Stream event types received from the backend SSE endpoint
 */
export type StreamEventType =
  | 'text_chunk'
  | 'tool_call_start'
  | 'tool_call_finish'
  | 'step_finish'
  | 'connected'
  | 'heartbeat';

/**
 * Base stream event shape
 */
export interface StreamEvent {
  /** Event type */
  type: StreamEventType;
  /** Agent session name */
  sessionName: string;
  /** ISO timestamp */
  timestamp: string;
}

/**
 * Text chunk event — incremental model output
 */
export interface TextChunkEvent extends StreamEvent {
  type: 'text_chunk';
  text: string;
}

/**
 * Tool call start event
 */
export interface ToolCallStartEvent extends StreamEvent {
  type: 'tool_call_start';
  toolName: string;
  argsPreview: string;
}

/**
 * Tool call finish event
 */
export interface ToolCallFinishEvent extends StreamEvent {
  type: 'tool_call_finish';
  toolName: string;
  argsPreview: string;
  resultPreview: string;
  durationMs: number;
}

/**
 * Step finish event
 */
export interface StepFinishEvent extends StreamEvent {
  type: 'step_finish';
  stepIndex: number;
  hasToolCalls: boolean;
}

/**
 * Union of all stream events for display
 */
export type AgentStreamEvent =
  | TextChunkEvent
  | ToolCallStartEvent
  | ToolCallFinishEvent
  | StepFinishEvent;

/**
 * Display-friendly stream entry for the UI
 */
export interface StreamEntry {
  /** Unique ID */
  id: string;
  /** Event type */
  type: StreamEventType;
  /** Human-readable text for display */
  text: string;
  /** Optional detail (e.g., args preview, result preview) */
  detail?: string;
  /** ISO timestamp */
  timestamp: string;
  /** Duration in ms (for tool_call_finish) */
  durationMs?: number;
  /** Tool name (for tool events) */
  toolName?: string;
  /** Whether this tool is still in progress */
  inProgress?: boolean;
}

/** Maximum entries to keep in memory */
const MAX_ENTRIES = 200;

/** Counter for entry IDs */
let entryIdCounter = 0;

/**
 * Generate a unique entry ID
 */
function nextEntryId(): string {
  return `stream-${Date.now()}-${++entryIdCounter}`;
}

/**
 * Hook return type
 */
export interface UseAgentStreamResult {
  /** Stream entries sorted newest-first */
  entries: StreamEntry[];
  /** Whether the SSE connection is active */
  connected: boolean;
  /** Error message if connection failed */
  error: string | null;
  /** Accumulated text from text_chunk events */
  currentText: string;
  /** Clear all entries and accumulated text */
  clear: () => void;
}

/**
 * Subscribe to real-time agent streaming events via SSE.
 *
 * @param sessionName - Agent session name to subscribe to, or null to disconnect
 * @returns Stream entries, connection state, and control functions
 *
 * @example
 * ```tsx
 * const { entries, connected, currentText } = useAgentStream('my-agent');
 * ```
 */
export function useAgentStream(sessionName: string | null): UseAgentStreamResult {
  const [entries, setEntries] = useState<StreamEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentText, setCurrentText] = useState('');
  const eventSourceRef = useRef<EventSource | null>(null);
  /** Track in-progress tool calls to update on finish */
  const inProgressToolsRef = useRef<Map<string, string>>(new Map());

  const clear = useCallback(() => {
    setEntries([]);
    setCurrentText('');
    inProgressToolsRef.current.clear();
  }, []);

  useEffect(() => {
    if (!sessionName) {
      // Disconnect
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setConnected(false);
      return;
    }

    const url = `/api/agents/${encodeURIComponent(sessionName)}/stream`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => {
      setConnected(true);
      setError(null);
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'connected' || data.type === 'heartbeat') {
          // Keep-alive events — don't add to entries
          return;
        }

        switch (data.type) {
          case 'text_chunk': {
            // Accumulate text without creating individual entries (too noisy)
            setCurrentText(prev => prev + data.text);
            break;
          }

          case 'tool_call_start': {
            const entryId = nextEntryId();
            inProgressToolsRef.current.set(data.toolName, entryId);
            setEntries(prev => {
              const entry: StreamEntry = {
                id: entryId,
                type: 'tool_call_start',
                text: `Calling ${data.toolName}...`,
                detail: data.argsPreview,
                timestamp: data.timestamp,
                toolName: data.toolName,
                inProgress: true,
              };
              const next = [entry, ...prev];
              return next.length > MAX_ENTRIES ? next.slice(0, MAX_ENTRIES) : next;
            });
            break;
          }

          case 'tool_call_finish': {
            const startEntryId = inProgressToolsRef.current.get(data.toolName);
            if (startEntryId) {
              // Update existing start entry to show finished
              inProgressToolsRef.current.delete(data.toolName);
              setEntries(prev =>
                prev.map(e =>
                  e.id === startEntryId
                    ? {
                        ...e,
                        type: 'tool_call_finish' as const,
                        text: `${data.toolName} completed (${data.durationMs}ms)`,
                        detail: data.resultPreview,
                        durationMs: data.durationMs,
                        inProgress: false,
                      }
                    : e,
                ),
              );
            } else {
              // No matching start — add standalone finish entry
              setEntries(prev => {
                const entry: StreamEntry = {
                  id: nextEntryId(),
                  type: 'tool_call_finish',
                  text: `${data.toolName} completed (${data.durationMs}ms)`,
                  detail: data.resultPreview,
                  timestamp: data.timestamp,
                  toolName: data.toolName,
                  durationMs: data.durationMs,
                  inProgress: false,
                };
                const next = [entry, ...prev];
                return next.length > MAX_ENTRIES ? next.slice(0, MAX_ENTRIES) : next;
              });
            }
            break;
          }

          case 'step_finish': {
            // Flush accumulated text as an entry
            setCurrentText(prev => {
              if (prev.trim().length > 0) {
                const textEntry: StreamEntry = {
                  id: nextEntryId(),
                  type: 'text_chunk',
                  text: prev.trim().length > 500 ? prev.trim().substring(0, 500) + '...' : prev.trim(),
                  timestamp: data.timestamp,
                };
                setEntries(entries => {
                  const next = [textEntry, ...entries];
                  return next.length > MAX_ENTRIES ? next.slice(0, MAX_ENTRIES) : next;
                });
              }
              return '';
            });

            setEntries(prev => {
              const entry: StreamEntry = {
                id: nextEntryId(),
                type: 'step_finish',
                text: `Step ${data.stepIndex} completed${data.hasToolCalls ? ' (with tools)' : ''}`,
                timestamp: data.timestamp,
              };
              const next = [entry, ...prev];
              return next.length > MAX_ENTRIES ? next.slice(0, MAX_ENTRIES) : next;
            });
            break;
          }
        }
      } catch {
        // Ignore malformed events
      }
    };

    es.onerror = () => {
      setConnected(false);
      setError('Stream connection lost. Reconnecting...');
      // EventSource auto-reconnects
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
      setConnected(false);
    };
  }, [sessionName]);

  return { entries, connected, error, currentText, clear };
}
