/**
 * Rate Limiter for Crewly Agent API Calls
 *
 * Provides token-bucket rate limiting, message coalescing, and 429 retry
 * logic to prevent Gemini API quota exhaustion when multiple agents are
 * actively generating messages.
 *
 * @module services/agent/crewly-agent/rate-limiter
 */

/**
 * Configuration for the rate limiter.
 */
export interface RateLimiterConfig {
  /** Maximum requests allowed per window */
  maxRequestsPerWindow: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Maximum retry attempts for 429 errors */
  maxRetries: number;
  /** Initial backoff delay in milliseconds for 429 retries */
  initialBackoffMs: number;
  /** Backoff multiplier for exponential retry */
  backoffMultiplier: number;
  /** Maximum backoff delay in milliseconds */
  maxBackoffMs: number;
  /** Coalescing window — how long to wait for additional messages before processing (ms) */
  coalesceWindowMs: number;
}

/**
 * Default rate limiter configuration.
 */
export const RATE_LIMITER_DEFAULTS: RateLimiterConfig = {
  maxRequestsPerWindow: 10,
  windowMs: 60_000,
  maxRetries: 3,
  initialBackoffMs: 5_000,
  backoffMultiplier: 2,
  maxBackoffMs: 60_000,
  coalesceWindowMs: 2_000,
};

/**
 * A queued message awaiting processing.
 */
interface QueuedMessage<T> {
  /** The message content */
  message: string;
  /** Optional metadata passed through to the handler */
  metadata?: Record<string, string>;
  /** Promise resolve callback */
  resolve: (value: T) => void;
  /** Promise reject callback */
  reject: (error: Error) => void;
  /** Timestamp when the message was enqueued */
  enqueuedAt: number;
}

/**
 * Token-bucket rate limiter with message coalescing and 429 retry.
 *
 * Features:
 * - **Rate limiting**: Enforces max requests per time window using a sliding window.
 * - **Message coalescing**: Groups messages arriving within a short window into one.
 * - **429 retry**: Wraps API calls with exponential backoff on quota errors.
 *
 * @example
 * ```typescript
 * const limiter = new RateLimiter<AgentRunResult>();
 * const result = await limiter.enqueue('Check status', undefined, async (msg) => {
 *   return agentRunner.run(msg);
 * });
 * ```
 */
export class RateLimiter<T> {
  private config: RateLimiterConfig;
  private requestTimestamps: number[] = [];
  private queue: QueuedMessage<T>[] = [];
  private processing = false;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Create a new RateLimiter instance.
   *
   * @param config - Optional partial config overrides
   */
  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = { ...RATE_LIMITER_DEFAULTS, ...config };
  }

  /**
   * Enqueue a message for rate-limited processing.
   *
   * If multiple messages arrive within the coalescing window, they are
   * merged into a single request to reduce API call count.
   *
   * @param message - Message to process
   * @param metadata - Optional metadata
   * @param handler - Async function that performs the actual API call
   * @returns Result from the handler
   */
  enqueue(
    message: string,
    metadata: Record<string, string> | undefined,
    handler: (message: string, metadata?: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        message,
        metadata,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      });

      // Reset coalesce timer — wait for more messages before processing
      if (this.coalesceTimer) {
        clearTimeout(this.coalesceTimer);
      }

      this.coalesceTimer = setTimeout(() => {
        this.coalesceTimer = null;
        if (!this.processing) {
          this.processQueue(handler).catch(() => {
            // Errors are already routed to individual promise reject callbacks
          });
        }
      }, this.config.coalesceWindowMs);
    });
  }

  /**
   * Get the current number of messages in the queue.
   *
   * @returns Queue length
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Check if the rate limiter is currently processing.
   *
   * @returns True if processing
   */
  isProcessing(): boolean {
    return this.processing;
  }

  /**
   * Get the number of requests made in the current window.
   *
   * @returns Request count in current window
   */
  getRequestCountInWindow(): number {
    this.pruneOldTimestamps();
    return this.requestTimestamps.length;
  }

  /**
   * Get the current configuration.
   *
   * @returns Rate limiter configuration
   */
  getConfig(): RateLimiterConfig {
    return { ...this.config };
  }

  /**
   * Reset internal state (for testing).
   */
  reset(): void {
    this.requestTimestamps = [];
    this.queue = [];
    this.processing = false;
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
  }

  /**
   * Process the queue: coalesce messages, enforce rate limit, execute with retry.
   *
   * @param handler - The actual API call handler
   */
  private async processQueue(
    handler: (message: string, metadata?: Record<string, string>) => Promise<T>,
  ): Promise<void> {
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        // Wait for rate limit window if needed
        await this.waitForCapacity();

        // Coalesce all pending messages into one
        const batch = this.queue.splice(0, this.queue.length);
        const coalesced = this.coalesceMessages(batch);

        // Record this request timestamp
        this.requestTimestamps.push(Date.now());

        // Execute with 429 retry
        try {
          const result = await this.executeWithRetry(
            coalesced.message,
            coalesced.metadata,
            handler,
          );

          // Resolve all promises in the batch with the same result
          for (const item of batch) {
            item.resolve(result);
          }
        } catch (error) {
          // Reject all promises in the batch
          const err = error instanceof Error ? error : new Error(String(error));
          for (const item of batch) {
            item.reject(err);
          }
        }
      }
    } finally {
      this.processing = false;

      // Check if more messages arrived while processing
      if (this.queue.length > 0) {
        this.processQueue(handler).catch(() => {
          // Errors are already routed to individual promise reject callbacks
        });
      }
    }
  }

  /**
   * Wait until we have capacity in the rate limit window.
   */
  private async waitForCapacity(): Promise<void> {
    this.pruneOldTimestamps();

    while (this.requestTimestamps.length >= this.config.maxRequestsPerWindow) {
      // Calculate how long to wait until the oldest request falls out of the window
      const oldestTimestamp = this.requestTimestamps[0];
      const waitMs = (oldestTimestamp + this.config.windowMs) - Date.now() + 100; // +100ms buffer

      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

      this.pruneOldTimestamps();
    }
  }

  /**
   * Remove timestamps older than the current window.
   */
  private pruneOldTimestamps(): void {
    const cutoff = Date.now() - this.config.windowMs;
    this.requestTimestamps = this.requestTimestamps.filter((ts) => ts > cutoff);
  }

  /**
   * Coalesce multiple queued messages into a single message.
   *
   * If there's only one message, it passes through unchanged.
   * Multiple messages are joined with a separator and a header.
   *
   * @param batch - Array of queued messages to coalesce
   * @returns Single coalesced message and metadata from the most recent item
   */
  private coalesceMessages(batch: QueuedMessage<T>[]): { message: string; metadata?: Record<string, string> } {
    if (batch.length === 1) {
      return { message: batch[0].message, metadata: batch[0].metadata };
    }

    // Use metadata from the most recent message
    const latestMetadata = batch[batch.length - 1].metadata;

    // Coalesce messages with a numbered separator
    const parts = batch.map((item, index) => {
      return `[Message ${index + 1}/${batch.length}]\n${item.message}`;
    });

    const coalesced = `${batch.length} messages received while rate-limited. Process them together:\n\n${parts.join('\n\n---\n\n')}`;

    return { message: coalesced, metadata: latestMetadata };
  }

  /**
   * Execute the handler with exponential backoff retry on 429/quota errors.
   *
   * @param message - Message to send
   * @param metadata - Optional metadata
   * @param handler - The API call handler
   * @returns Handler result
   * @throws Error after max retries exhausted
   */
  private async executeWithRetry(
    message: string,
    metadata: Record<string, string> | undefined,
    handler: (message: string, metadata?: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await handler(message, metadata);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Only retry on 429 / quota errors
        if (!this.isRetryableError(lastError)) {
          throw lastError;
        }

        if (attempt >= this.config.maxRetries) {
          break;
        }

        // Exponential backoff
        const backoffMs = Math.min(
          this.config.initialBackoffMs * Math.pow(this.config.backoffMultiplier, attempt),
          this.config.maxBackoffMs,
        );

        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    throw new Error(
      `Rate limit retries exhausted (${this.config.maxRetries} attempts). Last error: ${lastError?.message}`,
    );
  }

  /**
   * Check if an error is retryable (429 or quota-related).
   *
   * @param error - The error to check
   * @returns True if the error should be retried
   */
  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('429') ||
      message.includes('quota') ||
      message.includes('rate limit') ||
      message.includes('resource_exhausted') ||
      message.includes('too many requests')
    );
  }
}
