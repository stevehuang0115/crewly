/**
 * RequestTracker — Correlation bridge between user messages and task delegations.
 *
 * Maintains a mapping from orchestrator context to the most recently created
 * Request. When a user message arrives and creates a Request, the tracker
 * records it. When a task is delegated shortly after, the tracker provides
 * the requestId for correlation.
 *
 * Uses a time-window approach: if a delegation happens within
 * CORRELATION_WINDOW_MS of the last user message, it's considered part of
 * the same request.
 *
 * @module services/v3/request-tracker
 */

/** Default correlation window — 5 minutes. */
const DEFAULT_CORRELATION_WINDOW_MS = 5 * 60 * 1000;

/**
 * Tracks the active Request so downstream task delegations can be linked back.
 *
 * Design decisions:
 * - **Singleton** — one tracker per backend process (one orchestrator)
 * - **Time-windowed** — auto-expires after CORRELATION_WINDOW_MS
 * - **Non-consuming** — one user message can spawn multiple WorkItems
 * - **Clear on new message** — prevents linking unrelated delegations
 */
export class RequestTracker {
  private static instance: RequestTracker;

  /** The currently active request context. */
  private activeRequest: { requestId: string; timestamp: number } | null = null;

  /** Correlation window in milliseconds. */
  private readonly correlationWindowMs: number;

  /**
   * Creates a new RequestTracker.
   *
   * @param correlationWindowMs - Time window for linking delegations to requests
   */
  constructor(correlationWindowMs: number = DEFAULT_CORRELATION_WINDOW_MS) {
    this.correlationWindowMs = correlationWindowMs;
  }

  /**
   * Returns the singleton instance.
   *
   * @returns The shared RequestTracker instance
   */
  static getInstance(): RequestTracker {
    if (!RequestTracker.instance) {
      RequestTracker.instance = new RequestTracker();
    }
    return RequestTracker.instance;
  }

  /**
   * Resets the singleton — used for testing only.
   */
  static resetInstance(): void {
    RequestTracker.instance = undefined as unknown as RequestTracker;
  }

  /**
   * Records a Request as the active context for future WorkItem correlation.
   * Called when a Request is auto-created from a user message.
   *
   * @param requestId - The newly created Request's ID
   */
  setActiveRequest(requestId: string): void {
    this.activeRequest = {
      requestId,
      timestamp: Date.now(),
    };
  }

  /**
   * Returns the active requestId if within the correlation window.
   * Does NOT consume the request — multiple delegations from one message
   * are valid (e.g., orchestrator fans out to several agents).
   *
   * @deprecated Time-window correlation is unreliable in high-concurrency
   * scenarios. All delegation paths should pass requestId explicitly via
   * the --request-id flag. This method will be removed in a future release.
   *
   * @returns The active requestId, or null if expired/absent
   */
  getActiveRequestId(): string | null {
    if (!this.activeRequest) return null;

    const elapsed = Date.now() - this.activeRequest.timestamp;
    if (elapsed > this.correlationWindowMs) {
      // Expired — clear stale reference
      this.activeRequest = null;
      return null;
    }

    return this.activeRequest.requestId;
  }

  /**
   * Clears the active request context.
   * Called when a new user message arrives to prevent stale correlations.
   */
  clearOnNewMessage(): void {
    this.activeRequest = null;
  }

  /**
   * Returns the current correlation window in milliseconds.
   * Exposed for testing.
   *
   * @returns The correlation window in ms
   */
  getCorrelationWindowMs(): number {
    return this.correlationWindowMs;
  }
}
