/**
 * Tests for the ticket intake outcome log (#828 coverage).
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TICKET_CONSTANTS } from '../../constants.js';
import { IntakeOutcomeLog, MemoryIntakeOutcomeLog } from './ticket-intake-log.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-log-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('IntakeOutcomeLog', () => {
  it('reads as not started before the first event', async () => {
    expect(await new IntakeOutcomeLog(dir).read()).toEqual({ startedAt: null, events: [] });
  });

  it('writes a start marker once, then one line per event, in order', async () => {
    const log = new IntakeOutcomeLog(dir, () => new Date('2026-09-26T12:00:00Z'));
    await Promise.all([
      log.record({ at: '2026-09-26T12:00:01Z', ref: 'a', action: 'created', ticketId: 't1' }),
      log.record({ at: '2026-09-26T12:00:02Z', ref: 'b', action: 'ignored', reason: 'trivial_or_short' }),
    ]);
    const raw = (await fs.readFile(path.join(dir, TICKET_CONSTANTS.INTAKE_LOG_FILENAME), 'utf8')).trim().split('\n');
    expect(raw).toHaveLength(3);
    expect(JSON.parse(raw[0])).toEqual({ type: 'start', at: '2026-09-26T12:00:00.000Z' });
    const reading = await log.read();
    expect(reading.startedAt).toBe('2026-09-26T12:00:00.000Z');
    expect(reading.events.map((e) => e.ref)).toEqual(['a', 'b']);
    expect(reading.events[0]).not.toHaveProperty('type');
  });

  it('skips a torn line instead of failing the read', async () => {
    const log = new IntakeOutcomeLog(dir);
    await log.record({ at: '2026-09-26T12:00:01Z', ref: 'a', action: 'created' });
    await fs.appendFile(path.join(dir, TICKET_CONSTANTS.INTAKE_LOG_FILENAME), '{"type":"event","at":');
    expect((await log.read()).events).toHaveLength(1);
  });

  it('a write failure is swallowed (intake must not stop)', async () => {
    const log = new IntakeOutcomeLog(path.join(dir, 'missing', 'deeper'));
    await expect(log.record({ at: '2026-09-26T12:00:01Z', ref: 'a', action: 'created' })).resolves.toBeUndefined();
  });
});

describe('MemoryIntakeOutcomeLog', () => {
  it('keeps events and its start time', async () => {
    const log = new MemoryIntakeOutcomeLog('2026-09-26T00:00:00Z');
    await log.record({ at: '2026-09-26T01:00:00Z', ref: 'x', action: 'appended', ticketId: 't' });
    expect(await log.read()).toEqual({ startedAt: '2026-09-26T00:00:00Z', events: [{ at: '2026-09-26T01:00:00Z', ref: 'x', action: 'appended', ticketId: 't' }] });
  });
});
