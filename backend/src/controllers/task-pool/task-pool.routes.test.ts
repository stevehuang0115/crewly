import { describe, it, expect } from 'vitest';
import { createTaskPoolRouter } from './task-pool.routes.js';

describe('createTaskPoolRouter', () => {
  it('should create a router with expected routes including /all alias', () => {
    const router = createTaskPoolRouter();
    expect(router).toBeDefined();
    const routes = (router as any).stack?.map((r: any) => r.route?.path).filter(Boolean) || [];
    expect(routes).toContain('/');
    expect(routes).toContain('/all');
  });
});
