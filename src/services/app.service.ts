/**
 * God service that handles too many concerns.
 * This is intentionally bad architecture for evaluation.
 */
import type { User, Order, ApiResponse } from '../types/index.js';

export class AppService {
  private users: Map<string, User> = new Map();
  private orders: Map<string, Order> = new Map();
  private cache: Map<string, unknown> = new Map();
  private logs: string[] = [];

  // User operations
  createUser(name: string, email: string): User {
    const user: User = {
      id: `usr_${Date.now()}`,
      name,
      email,
      role: 'user',
      createdAt: new Date(),
    };
    this.users.set(user.id, user);
    this.log(`Created user ${user.id}`);
    return user;
  }

  getUser(id: string): User | undefined {
    const cached = this.cache.get(`user:${id}`) as User | undefined;
    if (cached) return cached;
    const user = this.users.get(id);
    if (user) this.cache.set(`user:${id}`, user);
    return user;
  }

  // Order operations
  createOrder(userId: string, items: { productId: string; quantity: number; price: number }[]): Order {
    const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const order: Order = {
      id: `ord_${Date.now()}`,
      userId,
      items,
      total,
      status: 'pending',
    };
    this.orders.set(order.id, order);
    this.log(`Created order ${order.id}`);
    return order;
  }

  getOrder(id: string): Order | undefined {
    return this.orders.get(id);
  }

  // Logging (should be separate)
  private log(message: string): void {
    this.logs.push(`[${new Date().toISOString()}] ${message}`);
  }

  getLogs(): string[] {
    return [...this.logs];
  }

  // Cache management (should be separate)
  clearCache(): void {
    this.cache.clear();
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  // Response formatting (should be separate utility)
  formatResponse<T>(data: T): ApiResponse<T> {
    return {
      success: true,
      data,
      timestamp: Date.now(),
    };
  }

  formatError(error: string): ApiResponse<never> {
    return {
      success: false,
      error,
      timestamp: Date.now(),
    };
  }
}
