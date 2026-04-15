/**
 * Tests for Key Result types — validators, factory, and computation functions.
 *
 * @module types/v2/key-result.types.test
 */

import {
  isValidKRMetricType,
  isValidKRStatus,
  isValidKRMeasurementSource,
  validateCreateKeyResultInput,
  isKeyResult,
  createKeyResult,
  computeKRProgress,
  deriveKRStatus,
  deriveOKRRecommendation,
} from './key-result.types.js';

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

describe('isValidKRMetricType', () => {
  it('should accept valid types', () => {
    expect(isValidKRMetricType('number')).toBe(true);
    expect(isValidKRMetricType('percentage')).toBe(true);
    expect(isValidKRMetricType('boolean')).toBe(true);
    expect(isValidKRMetricType('currency')).toBe(true);
  });

  it('should reject invalid types', () => {
    expect(isValidKRMetricType('string')).toBe(false);
    expect(isValidKRMetricType(42)).toBe(false);
    expect(isValidKRMetricType(null)).toBe(false);
  });
});

describe('isValidKRStatus', () => {
  it('should accept valid statuses', () => {
    expect(isValidKRStatus('not_started')).toBe(true);
    expect(isValidKRStatus('on_track')).toBe(true);
    expect(isValidKRStatus('achieved')).toBe(true);
  });

  it('should reject invalid statuses', () => {
    expect(isValidKRStatus('done')).toBe(false);
    expect(isValidKRStatus('')).toBe(false);
  });
});

describe('isValidKRMeasurementSource', () => {
  it('should accept valid sources', () => {
    expect(isValidKRMeasurementSource('manual')).toBe(true);
    expect(isValidKRMeasurementSource('task_completion')).toBe(true);
    expect(isValidKRMeasurementSource('skill_output')).toBe(true);
  });

  it('should reject invalid sources', () => {
    expect(isValidKRMeasurementSource('api')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCreateKeyResultInput
// ---------------------------------------------------------------------------

describe('validateCreateKeyResultInput', () => {
  const validInput = {
    missionId: 'mission-1',
    title: 'Reduce latency to 200ms',
    metricType: 'number',
    baseline: 500,
    target: 200,
    unit: 'ms',
  };

  it('should return empty array for valid input', () => {
    expect(validateCreateKeyResultInput(validInput)).toEqual([]);
  });

  it('should require missionId', () => {
    const errors = validateCreateKeyResultInput({ ...validInput, missionId: undefined });
    expect(errors).toContain('missionId is required');
  });

  it('should require title', () => {
    const errors = validateCreateKeyResultInput({ ...validInput, title: '' });
    expect(errors).toContain('title is required');
  });

  it('should require valid metricType', () => {
    const errors = validateCreateKeyResultInput({ ...validInput, metricType: 'invalid' });
    expect(errors.some(e => e.includes('metricType'))).toBe(true);
  });

  it('should require numeric baseline and target', () => {
    const errors = validateCreateKeyResultInput({ ...validInput, baseline: 'a', target: 'b' });
    expect(errors).toContain('baseline must be a number');
    expect(errors).toContain('target must be a number');
  });

  it('should reject equal baseline and target', () => {
    const errors = validateCreateKeyResultInput({ ...validInput, baseline: 100, target: 100 });
    expect(errors).toContain('baseline and target must be different');
  });

  it('should reject non-object input', () => {
    expect(validateCreateKeyResultInput(null)).toEqual(['Input must be an object']);
    expect(validateCreateKeyResultInput('string')).toEqual(['Input must be an object']);
  });
});

// ---------------------------------------------------------------------------
// isKeyResult
// ---------------------------------------------------------------------------

describe('isKeyResult', () => {
  it('should accept valid KeyResult', () => {
    const kr = createKeyResult({
      missionId: 'mission-1',
      title: 'Test KR',
      metricType: 'number',
      baseline: 0,
      target: 100,
      unit: 'count',
    });
    expect(isKeyResult(kr)).toBe(true);
  });

  it('should reject incomplete objects', () => {
    expect(isKeyResult({})).toBe(false);
    expect(isKeyResult(null)).toBe(false);
    expect(isKeyResult({ id: '1', missionId: '2' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createKeyResult
// ---------------------------------------------------------------------------

describe('createKeyResult', () => {
  it('should create with correct defaults', () => {
    const kr = createKeyResult({
      missionId: 'mission-1',
      title: 'Latency target',
      metricType: 'number',
      baseline: 500,
      target: 200,
      unit: 'ms',
    });

    expect(kr.id).toBeDefined();
    expect(kr.missionId).toBe('mission-1');
    expect(kr.current).toBe(500); // starts at baseline
    expect(kr.status).toBe('not_started');
    expect(kr.measurementSource).toBe('manual');
    expect(kr.linkedWorkItemIds).toEqual([]);
    expect(kr.measurements).toEqual([]);
  });

  it('should accept optional measurementSource', () => {
    const kr = createKeyResult({
      missionId: 'm1',
      title: 'KR',
      metricType: 'percentage',
      baseline: 0,
      target: 80,
      unit: '%',
      measurementSource: 'task_completion',
    });
    expect(kr.measurementSource).toBe('task_completion');
  });
});

// ---------------------------------------------------------------------------
// computeKRProgress
// ---------------------------------------------------------------------------

describe('computeKRProgress', () => {
  it('should compute 0% at baseline', () => {
    expect(computeKRProgress({ baseline: 0, target: 100, current: 0 })).toBe(0);
  });

  it('should compute 100% at target', () => {
    expect(computeKRProgress({ baseline: 0, target: 100, current: 100 })).toBe(100);
  });

  it('should compute 50% at midpoint', () => {
    expect(computeKRProgress({ baseline: 0, target: 100, current: 50 })).toBe(50);
  });

  it('should handle "lower is better" (target < baseline)', () => {
    // Latency: baseline=500ms, target=200ms, current=350ms
    // Progress = (350-500)/(200-500) = -150/-300 = 50%
    expect(computeKRProgress({ baseline: 500, target: 200, current: 350 })).toBe(50);
  });

  it('should clamp to 0-100', () => {
    expect(computeKRProgress({ baseline: 0, target: 100, current: -20 })).toBe(0);
    expect(computeKRProgress({ baseline: 0, target: 100, current: 150 })).toBe(100);
  });

  it('should return 100% if baseline equals target', () => {
    expect(computeKRProgress({ baseline: 50, target: 50, current: 50 })).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// deriveKRStatus
// ---------------------------------------------------------------------------

describe('deriveKRStatus', () => {
  it('should return achieved at 100%+', () => {
    expect(deriveKRStatus(100, 100, 0)).toBe('achieved');
    expect(deriveKRStatus(110, 110, 0)).toBe('achieved');
  });

  it('should return not_started when current equals baseline', () => {
    expect(deriveKRStatus(0, 0, 0)).toBe('not_started');
  });

  it('should return on_track at 50%+', () => {
    expect(deriveKRStatus(60, 60, 0)).toBe('on_track');
  });

  it('should return at_risk at 25-49%', () => {
    expect(deriveKRStatus(30, 30, 0)).toBe('at_risk');
  });

  it('should return off_track below 25%', () => {
    expect(deriveKRStatus(10, 10, 0)).toBe('off_track');
  });
});

// ---------------------------------------------------------------------------
// deriveOKRRecommendation
// ---------------------------------------------------------------------------

describe('deriveOKRRecommendation', () => {
  it('should return continue when most KRs are healthy', () => {
    expect(deriveOKRRecommendation(['achieved', 'on_track', 'on_track'])).toBe('continue');
  });

  it('should return adjust_strategy with mixed results', () => {
    expect(deriveOKRRecommendation(['on_track', 'at_risk', 'at_risk'])).toBe('adjust_strategy');
  });

  it('should return replan when many KRs are off track', () => {
    expect(deriveOKRRecommendation(['off_track', 'off_track', 'on_track'])).toBe('replan');
  });

  it('should return escalate after 2+ stale cycles', () => {
    expect(deriveOKRRecommendation(['at_risk', 'at_risk'], 2)).toBe('escalate');
    expect(deriveOKRRecommendation(['on_track', 'on_track'], 3)).toBe('escalate');
  });

  it('should return continue for empty KR list', () => {
    expect(deriveOKRRecommendation([])).toBe('continue');
  });
});
