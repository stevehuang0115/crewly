/**
 * Tests for the bundle type helpers.
 */

import { describe, expect, it } from 'vitest';
import { initialAnswers, isDeploymentFinished, missingRequiredAnswers, type BundleQuestion } from './bundle.types';

const QUESTIONS: BundleQuestion[] = [
  { id: 'business_name', label: '名字', type: 'text', required: true },
  { id: 'platforms', label: '平台', type: 'multiselect', required: true, options: [{ value: 'a' }] },
  { id: 'tone', label: '语气', type: 'select', required: false, default: '亲切', options: [{ value: '亲切' }] },
  { id: 'tags', label: '标签', type: 'multiselect', required: false, default: 'x', options: [{ value: 'x' }] },
];

describe('bundle type helpers', () => {
  it('isDeploymentFinished', () => {
    expect(isDeploymentFinished({ status: 'running' })).toBe(false);
    expect(isDeploymentFinished({ status: 'partial' })).toBe(true);
  });

  it('initialAnswers takes the defaults, multiselects as lists', () => {
    expect(initialAnswers(QUESTIONS)).toEqual({ business_name: '', platforms: [], tone: '亲切', tags: ['x'] });
  });

  it('missingRequiredAnswers lists empty required answers', () => {
    expect(missingRequiredAnswers(QUESTIONS, initialAnswers(QUESTIONS))).toEqual(['business_name', 'platforms']);
    expect(missingRequiredAnswers(QUESTIONS, { business_name: '  ', platforms: ['a'] })).toEqual(['business_name']);
    expect(missingRequiredAnswers(QUESTIONS, { business_name: 'x', platforms: ['a'] })).toEqual([]);
  });
});
