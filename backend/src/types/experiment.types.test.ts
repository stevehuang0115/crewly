/**
 * Tests for the experiment type guards (issue #986).
 */
import { isExperimentSource, isExperimentStatus, EXPERIMENT_SOURCES, EXPERIMENT_STATUSES } from './experiment.types.js';

describe('experiment types', () => {
  it('recognises sources', () => {
    expect(EXPERIMENT_SOURCES).toEqual(['gsc', 'ga4']);
    expect(isExperimentSource('gsc')).toBe(true);
    expect(isExperimentSource('ga4')).toBe(true);
    expect(isExperimentSource('bing')).toBe(false);
    expect(isExperimentSource(3)).toBe(false);
  });

  it('recognises statuses', () => {
    expect(EXPERIMENT_STATUSES).toContain('running');
    expect(isExperimentStatus('done')).toBe(true);
    expect(isExperimentStatus('shipped')).toBe(false);
    expect(isExperimentStatus(undefined)).toBe(false);
  });
});
