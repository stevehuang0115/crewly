/**
 * Crewly Agent API Client
 *
 * Lightweight HTTP client for calling the Crewly backend REST API.
 * Replaces the bash curl wrapper used by orchestrator skill scripts
 * with direct fetch() calls for in-process tool execution.
 *
 * @module services/agent/crewly-agent/api-client
 */

import { CREWLY_AGENT_DEFAULTS, type ApiCallResult } from './types.js';

/**
 * HTTP client for the Crewly backend REST API.
 *
 * Each tool in the ToolRegistry uses this client to make API calls
 * instead of shelling out to bash scripts.
 *
 * @example
 * ```typescript
 * const client = new CrewlyApiClient('http://localhost:8787', 'crewly-orc');
 * const result = await client.get('/teams');
 * const result2 = await client.post('/terminal/agent-sam/deliver', { message: 'Hello' });
 * ```
 */
export class CrewlyApiClient {
  private baseUrl: string;
  private sessionName: string;
  private timeoutMs: number;

  /**
   * Create a new API client instance.
   *
   * @param baseUrl - Base URL for the Crewly API (e.g., 'http://localhost:8787')
   * @param sessionName - Agent session name for the X-Agent-Session header
   * @param timeoutMs - Request timeout in milliseconds
   */
  constructor(
    baseUrl: string = CREWLY_AGENT_DEFAULTS.API_BASE_URL,
    sessionName: string = 'crewly-orc',
    timeoutMs: number = CREWLY_AGENT_DEFAULTS.API_TIMEOUT_MS,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.sessionName = sessionName;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Make a GET request to the Crewly API.
   *
   * @param endpoint - API endpoint path (e.g., '/teams')
   * @returns API call result with parsed JSON data
   */
  async get<T = unknown>(endpoint: string): Promise<ApiCallResult<T>> {
    return this.request<T>('GET', endpoint);
  }

  /**
   * Make a POST request to the Crewly API.
   *
   * @param endpoint - API endpoint path (e.g., '/terminal/agent-sam/deliver')
   * @param body - Request body to send as JSON
   * @returns API call result with parsed JSON data
   */
  async post<T = unknown>(endpoint: string, body: unknown): Promise<ApiCallResult<T>> {
    return this.request<T>('POST', endpoint, body);
  }

  /**
   * Make a DELETE request to the Crewly API.
   *
   * @param endpoint - API endpoint path (e.g., '/schedule/check-123')
   * @returns API call result with parsed JSON data
   */
  async delete<T = unknown>(endpoint: string): Promise<ApiCallResult<T>> {
    return this.request<T>('DELETE', endpoint);
  }

  /**
   * Internal request method handling fetch, timeout, and error mapping.
   *
   * @param method - HTTP method
   * @param endpoint - API endpoint path
   * @param body - Optional request body
   * @returns Parsed API call result
   */
  private async request<T>(method: string, endpoint: string, body?: unknown): Promise<ApiCallResult<T>> {
    const url = `${this.baseUrl}/api${endpoint}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.sessionName) {
        headers['X-Agent-Session'] = this.sessionName;
      }

      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }

      const response = await fetch(url, init);
      const responseBody = await response.text();

      let data: T | undefined;
      try {
        const parsed = JSON.parse(responseBody);
        data = parsed.data !== undefined ? parsed.data : parsed;
      } catch {
        data = responseBody as unknown as T;
      }

      if (response.ok) {
        return { success: true, data, status: response.status };
      }
      return {
        success: false,
        error: typeof data === 'object' && data !== null && 'error' in data
          ? String((data as Record<string, unknown>).error)
          : `HTTP ${response.status}`,
        status: response.status,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, error: `Request timeout after ${this.timeoutMs}ms`, status: 0 };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        status: 0,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
