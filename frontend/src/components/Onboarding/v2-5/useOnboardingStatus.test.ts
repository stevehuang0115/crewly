/**
 * Tests for useOnboardingStatus — the W1 stub orc-status resolver.
 *
 * @module components/Onboarding/v2-5/useOnboardingStatus.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useOnboardingStatus,
  setOnboardingStatusForTests,
} from './useOnboardingStatus';

const originalLocation = window.location;

function setSearch(search: string) {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { ...originalLocation, search },
  });
}

describe('useOnboardingStatus', () => {
  beforeEach(() => {
    setOnboardingStatusForTests(null);
    setSearch('');
  });

  afterEach(() => {
    setOnboardingStatusForTests(null);
    Object.defineProperty(window, 'location', {
      writable: true,
      value: originalLocation,
    });
  });

  it('defaults to mode=normal, loading=false, no stage / error', () => {
    const { result } = renderHook(() => useOnboardingStatus());
    expect(result.current).toEqual({ mode: 'normal', loading: false });
  });

  it('reads ?onboarding=1 → mode=onboarding (no stage)', () => {
    setSearch('?onboarding=1');
    const { result } = renderHook(() => useOnboardingStatus());
    expect(result.current.mode).toBe('onboarding');
    expect(result.current.stage).toBeUndefined();
  });

  it('reads ?onboarding=1&stage=S3 → mode=onboarding stage=S3', () => {
    setSearch('?onboarding=1&stage=S3');
    const { result } = renderHook(() => useOnboardingStatus());
    expect(result.current.mode).toBe('onboarding');
    expect(result.current.stage).toBe('S3');
  });

  it('lowercases stage and accepts s5', () => {
    setSearch('?onboarding=1&stage=s5');
    const { result } = renderHook(() => useOnboardingStatus());
    expect(result.current.stage).toBe('S5');
  });

  it('drops invalid stage values silently', () => {
    setSearch('?onboarding=1&stage=S99');
    const { result } = renderHook(() => useOnboardingStatus());
    expect(result.current.stage).toBeUndefined();
  });

  it('ignores stage when mode is normal', () => {
    setSearch('?onboarding=normal&stage=S3');
    const { result } = renderHook(() => useOnboardingStatus());
    expect(result.current.mode).toBe('normal');
    expect(result.current.stage).toBeUndefined();
  });

  it('?onboarding=escape-hatch → mode=escape-hatch', () => {
    setSearch('?onboarding=escape-hatch');
    const { result } = renderHook(() => useOnboardingStatus());
    expect(result.current.mode).toBe('escape-hatch');
  });

  it('garbage param falls back to normal', () => {
    setSearch('?onboarding=garbage');
    const { result } = renderHook(() => useOnboardingStatus());
    expect(result.current.mode).toBe('normal');
  });

  it('test override beats URL', () => {
    setSearch('?onboarding=1&stage=S3');
    setOnboardingStatusForTests({
      mode: 'escape-hatch',
      loading: false,
    });
    const { result } = renderHook(() => useOnboardingStatus());
    expect(result.current.mode).toBe('escape-hatch');
    expect(result.current.stage).toBeUndefined();
  });

  it('test override carries the loading=true / error fields through', () => {
    setOnboardingStatusForTests({
      mode: 'normal',
      loading: true,
      error: 'fetch failed',
    });
    const { result } = renderHook(() => useOnboardingStatus());
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBe('fetch failed');
  });

  it('clearing the override returns to URL resolution', () => {
    setSearch('?onboarding=1');
    setOnboardingStatusForTests({ mode: 'normal', loading: false });
    const first = renderHook(() => useOnboardingStatus());
    expect(first.result.current.mode).toBe('normal');

    setOnboardingStatusForTests(null);
    const second = renderHook(() => useOnboardingStatus());
    expect(second.result.current.mode).toBe('onboarding');
  });
});
