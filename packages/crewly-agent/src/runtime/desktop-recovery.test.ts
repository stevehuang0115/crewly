/**
 * Tests for surprise detection.
 *
 * The failure being guarded against: a dialog appears at step 15, the agent
 * does not notice, and the next twenty steps act on a world that no longer
 * exists. Each one looks fine on its own.
 */

import { describe, it, expect } from 'vitest';
import { detectSurprise, shouldRetryAfter, type Scene } from './desktop-recovery.js';

describe('detectSurprise', () => {
  it('sees nothing wrong with an ordinary window', () => {
    expect(detectSurprise({ app: 'TextEdit', elements: [{ role: 'AXButton', name: 'Bold' }] })).toBeNull();
  });

  it('spots a modal and lists the buttons so the agent can choose', () => {
    const out = detectSurprise({
      elements: [
        { role: 'AXSheet', name: 'Save changes?' },
        { role: 'AXButton', name: 'Save' },
        { role: 'AXButton', name: "Don't Save" },
      ],
    });
    expect(out?.kind).toBe('modal-dialog');
    expect(out?.instruction).toContain("Don't Save");
    // The most common way to get this wrong is to save when nobody asked.
    expect(out?.instruction).toMatch(/if the task did not ask to save, do not save/i);
    expect(out?.selfRecoverable).toBe(true);
  });

  it('tells the agent its refs are stale after a dialog', () => {
    const out = detectSurprise({ elements: [{ role: 'AXDialog', name: 'Export' }] });
    expect(out?.instruction).toMatch(/fresh snapshot/);
  });

  it('treats a permission prompt as the owner\'s decision, not a dialog to answer', () => {
    const out = detectSurprise({
      elements: [
        { role: 'AXSheet', name: 'Terminal would like to access your Documents folder' },
        { role: 'AXButton', name: 'Allow' },
      ],
    });
    expect(out?.kind).toBe('permission-prompt');
    expect(out?.selfRecoverable).toBe(false);
  });

  it('stops at a sign-in wall instead of typing credentials', () => {
    for (const name of ['Sign in to continue', 'Enter your password', '请输入验证码']) {
      const out = detectSurprise({ elements: [{ role: 'AXStaticText', name }] });
      expect(out?.kind, name).toBe('login-required');
      expect(out?.selfRecoverable).toBe(false);
    }
  });

  it('reads a locked screen off the last failure, and calls it unrecoverable', () => {
    const out = detectSurprise({ elements: [], lastFailure: { reason: 'screen_locked' } });
    expect(out?.kind).toBe('screen-locked');
    expect(out?.selfRecoverable).toBe(false);
  });

  it('warns not to repeat a timed-out action blindly — it may have gone through', () => {
    const out = detectSurprise({ elements: [], lastFailure: { reason: 'timeout' } });
    expect(out?.kind).toBe('app-not-responding');
    expect(out?.instruction).toMatch(/may have gone through/);
  });

  it('notices focus moving away from the app the plan is about', () => {
    expect(detectSurprise({ app: 'Safari', elements: [] }, 'TextEdit')?.kind).toBe('focus-lost');
    expect(detectSurprise({ app: 'TextEdit', elements: [] }, 'textedit')).toBeNull();
  });

  it('prefers the specific diagnosis when two apply', () => {
    // A permission prompt is also a modal; the specific instruction is the
    // useful one.
    const out = detectSurprise({
      elements: [
        { role: 'AXSheet', name: 'Crewly would like to access your Calendar' },
        { role: 'AXButton', name: 'Allow' },
      ],
    });
    expect(out?.kind).toBe('permission-prompt');
  });
});

describe('shouldRetryAfter', () => {
  it('never retries something that needs a person', () => {
    const out = shouldRetryAfter('login-required', 0, false);
    expect(out.retry).toBe(false);
    expect(out.escalation).toMatch(/needs a person/);
  });

  it('allows three goes at a recoverable surprise, then stops', () => {
    expect(shouldRetryAfter('modal-dialog', 0, true).retry).toBe(true);
    expect(shouldRetryAfter('modal-dialog', 2, true).retry).toBe(true);
    const out = shouldRetryAfter('modal-dialog', 3, true);
    expect(out.retry).toBe(false);
    expect(out.escalation).toMatch(/will not be different/);
  });
});
