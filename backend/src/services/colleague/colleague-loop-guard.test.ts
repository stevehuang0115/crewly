import { ColleagueLoopGuard } from './colleague-loop-guard.js';
import { COLLEAGUE_MESSAGE_CONSTANTS } from '../../constants.js';

describe('ColleagueLoopGuard', () => {
  it('allows the default cap of messages, then refuses with the wait until the oldest ages out', () => {
    let t = 1_000_000;
    const guard = new ColleagueLoopGuard({ now: () => t });
    for (let i = 0; i < COLLEAGUE_MESSAGE_CONSTANTS.LOOP_CAP_MESSAGES; i++) {
      expect(guard.take('a|b')).toEqual({ allowed: true });
      t += 1000;
    }
    const refused = guard.take('a|b');
    expect(refused.allowed).toBe(false);
    expect(refused.allowed === false && refused.retryAfterMs).toBe(COLLEAGUE_MESSAGE_CONSTANTS.LOOP_CAP_WINDOW_MS - COLLEAGUE_MESSAGE_CONSTANTS.LOOP_CAP_MESSAGES * 1000);
  });

  it('lets messages through again once the window has passed', () => {
    let t = 0;
    const guard = new ColleagueLoopGuard({ now: () => t, maxMessages: 2, windowMs: 1000 });
    expect(guard.take('k').allowed).toBe(true);
    expect(guard.take('k').allowed).toBe(true);
    expect(guard.take('k').allowed).toBe(false);
    t = 1001;
    expect(guard.take('k').allowed).toBe(true);
  });

  it('counts each pair on its own, and both directions of a pair together', () => {
    const guard = new ColleagueLoopGuard({ maxMessages: 1 });
    expect(guard.take(ColleagueLoopGuard.pairKey('x', 'y')).allowed).toBe(true);
    expect(guard.take(ColleagueLoopGuard.pairKey('y', 'x')).allowed).toBe(false);
    expect(guard.take(ColleagueLoopGuard.pairKey('x', 'z')).allowed).toBe(true);
  });

  it('a refused message is not counted (it does not extend the lockout)', () => {
    let t = 0;
    const guard = new ColleagueLoopGuard({ now: () => t, maxMessages: 1, windowMs: 1000 });
    guard.take('k');
    t = 900;
    guard.take('k');
    t = 1001;
    expect(guard.take('k').allowed).toBe(true);
  });
});
