/**
 * Existing tests for the app — these must continue to pass.
 */

import { describe, it, expect } from 'vitest';

describe('App', () => {
  it('should export app', async () => {
    const mod = await import('./app.js');
    expect(mod.app).toBeDefined();
  });
});
