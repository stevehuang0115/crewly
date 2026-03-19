/**
 * Tests for Auth barrel exports
 *
 * @module components/Auth/index.test
 */

import { describe, it, expect } from 'vitest';
import {
  AuthStatusIndicator,
} from './index';

describe('Auth barrel exports', () => {
  it('should export AuthStatusIndicator', () => {
    expect(AuthStatusIndicator).toBeDefined();
  });
});
