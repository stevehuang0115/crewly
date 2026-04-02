/**
 * Simple API service fixture for eval tasks.
 *
 * Provides a minimal class that eval tasks can search for,
 * read, and modify.
 */

/**
 * Configuration for the ApiService.
 */
export interface ApiServiceConfig {
  /** Base URL of the API */
  baseUrl: string;
  /** Request timeout in milliseconds */
  timeoutMs: number;
}

/**
 * A minimal API service used as a fixture for evaluation tasks.
 *
 * @example
 * ```typescript
 * const api = new ApiService({ baseUrl: 'https://api.example.com', timeoutMs: 5000 });
 * const data = await api.get('/users');
 * ```
 */
export class ApiService {
  private config: ApiServiceConfig;

  /**
   * Create a new ApiService instance.
   *
   * @param config - service configuration
   */
  constructor(config: ApiServiceConfig) {
    this.config = config;
  }

  /**
   * Perform a GET request.
   *
   * @param endpoint - API endpoint path
   * @returns parsed response data
   */
  async get<T>(endpoint: string): Promise<T> {
    const url = `${this.config.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    return response.json() as Promise<T>;
  }
}
