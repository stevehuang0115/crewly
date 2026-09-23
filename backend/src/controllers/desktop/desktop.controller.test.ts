/**
 * Tests for the desktop HTTP surface.
 *
 * These routes are reachable from the relay, so the question they have to
 * answer correctly is not "does it work" but "what can the internet ask this
 * Mac to do". An allowlist that leaks one acting verb is worse than no route
 * at all.
 */

import { checkAction, parseSkillJson, DESKTOP_READ_ACTIONS, DESKTOP_ACT_ACTIONS, isLocalRequest } from './desktop.controller';
import { isAllowedMobileApiCall } from '../../services/cloud/mobile-api-relay.service';

describe('action allowlist', () => {
  it('lets a read-only caller look but not touch', () => {
    expect(checkAction('snapshot', false)).toBeNull();
    expect(checkAction('ocr', false)).toBeNull();
    const refusal = checkAction('click', false);
    expect(refusal).toMatchObject({ reason: 'read_only' });
    expect(String(refusal!.message)).toContain('Reading the screen is allowed');
  });

  it('lets an acting caller do both', () => {
    expect(checkAction('snapshot', true)).toBeNull();
    expect(checkAction('click', true)).toBeNull();
  });

  it('names the actions it knows when asked for one it does not', () => {
    const refusal = checkAction('rm -rf', true);
    expect(refusal).toMatchObject({ reason: 'unknown_action' });
    expect(refusal!.actions).toContain('snapshot');
  });

  it('requires an action at all', () => {
    expect(checkAction('', true)).toMatchObject({ reason: 'validation' });
  });

  it('keeps reading and acting disjoint, so neither set can quietly grow into the other', () => {
    for (const action of DESKTOP_ACT_ACTIONS) {
      // Named in the message via the loop variable — jest's expect takes no
      // second argument the way vitest's does.
      expect({ action, inBothSets: DESKTOP_READ_ACTIONS.has(action) }).toEqual({ action, inBothSets: false });
    }
    // Everything that moves something must be in the acting set.
    for (const action of ['click', 'type', 'key', 'drag', 'fill-ref', 'click-ref']) {
      expect({ action, canAct: DESKTOP_ACT_ACTIONS.has(action) }).toEqual({ action, canAct: true });
    }
  });
});

describe('what the relay may reach', () => {
  it('lets the owner watch a machine and take it back', () => {
    expect(isAllowedMobileApiCall('GET', '/desktop/status')).toBe(true);
    expect(isAllowedMobileApiCall('POST', '/desktop/look')).toBe(true);
    expect(isAllowedMobileApiCall('POST', '/desktop/stop')).toBe(true);
  });

  it('does not let it drive the mouse', () => {
    // /desktop/act moves a real keyboard on a real Mac. Reaching it from the
    // internet because the phone app can reach everything else here would be
    // the single worst thing in this feature.
    expect(isAllowedMobileApiCall('POST', '/desktop/act')).toBe(false);
  });

  it('is not fooled by a path that merely starts the same way', () => {
    expect(isAllowedMobileApiCall('POST', '/desktop/../desktop/act')).toBe(false);
    expect(isAllowedMobileApiCall('POST', '/desktop')).toBe(false);
    expect(isAllowedMobileApiCall('DELETE', '/desktop/stop')).toBe(false);
  });
});

describe('parseSkillJson', () => {
  it('takes the answer, not the warning that came before it', () => {
    // The shared runner warns on its own line when CREWLY_SESSION_NAME is
    // unset; the real reply is the last JSON line, not the first.
    expect(parseSkillJson('{"warning":"no session name"}\n{"success":true}')).toEqual({ success: true });
    expect(parseSkillJson('warning line\n{"success":true,"action":"click"}')).toEqual({ success: true, action: 'click' });
  });

  it('reads jq pretty-printed output, which spans every line', () => {
    expect(parseSkillJson('{\n  "success": false,\n  "reason": "paused"\n}')).toEqual({ success: false, reason: 'paused' });
  });

  it('describes the failure rather than throwing on junk', () => {
    expect(parseSkillJson('bash: not found')).toMatchObject({ success: false, reason: 'unparsable' });
    expect(parseSkillJson('')).toMatchObject({ reason: 'unparsable' });
  });
});

describe('isLocalRequest — remote control is switched on at the machine only', () => {
  const req = (addr: string, forwarded?: string) =>
    ({ socket: { remoteAddress: addr }, get: (h: string) => (h === 'X-Forwarded-For' ? forwarded : undefined) }) as never;

  it('accepts loopback and nothing else', () => {
    expect(isLocalRequest(req('127.0.0.1'))).toBe(true);
    expect(isLocalRequest(req('::1'))).toBe(true);
    expect(isLocalRequest(req('::ffff:127.0.0.1'))).toBe(true);
    expect(isLocalRequest(req('192.168.1.20'))).toBe(false);
    expect(isLocalRequest(req('127.0.0.1', '8.8.8.8'))).toBe(false);
  });
});

describe('the relay reaches the remote view and hands, never the on-switch', () => {
  it('allows the frame, input and status, and refuses PUT /desktop/remote', () => {
    expect(isAllowedMobileApiCall('POST', '/desktop/remote/frame')).toBe(true);
    expect(isAllowedMobileApiCall('POST', '/desktop/remote/input')).toBe(true);
    expect(isAllowedMobileApiCall('GET', '/desktop/remote')).toBe(true);
    expect(isAllowedMobileApiCall('PUT', '/desktop/remote')).toBe(false);
    expect(isAllowedMobileApiCall('POST', '/browser/extension/reload')).toBe(true);
  });
});
