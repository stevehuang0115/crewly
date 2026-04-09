/**
 * Tests for RequestTracking barrel exports
 *
 * @module components/RequestTracking/index.test
 */

import { describe, it, expect } from 'vitest';
import {
  RequestSummaryBar,
  RequestFilters,
  RequestList,
  RequestRow,
} from './index';

describe('RequestTracking barrel exports', () => {
  it('exports RequestSummaryBar', () => {
    expect(RequestSummaryBar).toBeDefined();
  });

  it('exports RequestFilters', () => {
    expect(RequestFilters).toBeDefined();
  });

  it('exports RequestList', () => {
    expect(RequestList).toBeDefined();
  });

  it('exports RequestRow', () => {
    expect(RequestRow).toBeDefined();
  });
});
