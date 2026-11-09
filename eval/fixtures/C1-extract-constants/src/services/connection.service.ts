/**
 * Connection service with hardcoded values that need to be extracted.
 * The agent should extract all magic numbers/strings into a constants module.
 */

export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting';

export interface ConnectionConfig {
  host: string;
  port: number;
  timeout: number;
}

export class ConnectionService {
  private status: ConnectionStatus = 'disconnected';
  private retryCount = 0;

  /**
   * Connect to the primary API server.
   */
  async connectApi(): Promise<void> {
    const url = 'http://localhost:' + 3000;
    this.status = 'reconnecting';

    for (let i = 0; i < 3; i++) {
      try {
        // Simulate connection with timeout
        await this.withTimeout(this.doConnect(url), 30000);
        this.status = 'connected';
        return;
      } catch {
        this.retryCount++;
        await this.delay(5000);
      }
    }
    this.status = 'disconnected';
  }

  /**
   * Connect to the WebSocket server.
   */
  async connectWebSocket(): Promise<void> {
    const url = 'ws://localhost:' + 3001;
    this.status = 'reconnecting';

    for (let i = 0; i < 5; i++) {
      try {
        await this.withTimeout(this.doConnect(url), 120000);
        this.status = 'connected';
        return;
      } catch {
        this.retryCount++;
        await this.delay(5000);
      }
    }
    this.status = 'disconnected';
  }

  /**
   * Connect to the admin panel.
   */
  async connectAdmin(): Promise<void> {
    const url = 'http://localhost:' + 8080;
    await this.withTimeout(this.doConnect(url), 30000);
    this.status = 'connected';
  }

  /** Get current connection status */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  /** Get retry count */
  getRetryCount(): number {
    return this.retryCount;
  }

  /** Reset connection state */
  reset(): void {
    this.status = 'disconnected';
    this.retryCount = 0;
  }

  private async doConnect(_url: string): Promise<void> {
    // Simulated connection
    return Promise.resolve();
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms)),
    ]);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
