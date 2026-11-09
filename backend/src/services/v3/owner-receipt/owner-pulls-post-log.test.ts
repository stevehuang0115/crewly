/**
 * Tests for the owner-pulls post log (#1387): what is kept, and the size trim.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OWNER_RECEIPT_CONSTANTS } from '../../../constants.js';
import { OwnerPullsPostLog, getOwnerPullsPostLog, setOwnerPullsPostLog } from './owner-pulls-post-log.js';

jest.mock('../../core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ warn: jest.fn() }) }) },
}));

const NOW = new Date('2026-09-27T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const C = OWNER_RECEIPT_CONSTANTS.PULLS_WEEKLY;

describe('OwnerPullsPostLog', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pulls-post-log-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps who, when and whether it asked — never the text', async () => {
    const log = new OwnerPullsPostLog(dir, () => NOW);
    await log.note({ agent: 'ella', text: 'Secret plan. Ok to post?' });
    await log.note({ agent: 'ella', text: '  ' });
    expect(await log.read()).toEqual([{ at: NOW.toISOString(), agent: 'ella', endsWithQuestion: true }]);
    expect(readFileSync(join(dir, C.POST_LOG_FILENAME), 'utf8')).not.toContain('Secret');
  });

  it('reads nothing when there is no log, and skips a torn line', async () => {
    const log = new OwnerPullsPostLog(dir, () => NOW);
    expect(await log.read()).toEqual([]);
    writeFileSync(join(dir, C.POST_LOG_FILENAME), `{"at":"${NOW.toISOString()}","agent":"a","endsWithQuestion":false}\n{"at":`);
    expect(await log.read()).toHaveLength(1);
  });

  it('drops posts older than two weeks once the file is too big', async () => {
    const old = new Date(NOW.getTime() - 20 * DAY).toISOString();
    const line = `${JSON.stringify({ at: old, agent: 'x'.repeat(200), endsWithQuestion: false })}\n`;
    writeFileSync(join(dir, C.POST_LOG_FILENAME), line.repeat(Math.ceil(C.POST_LOG_MAX_BYTES / line.length) + 1));
    const log = new OwnerPullsPostLog(dir, () => NOW);
    await log.note({ agent: 'ella', text: 'Done.' });
    expect(await log.read()).toEqual([{ at: NOW.toISOString(), agent: 'ella', endsWithQuestion: false }]);
  });

  it('logs stalled work as a stuck record: who and when only', async () => {
    const log = new OwnerPullsPostLog(dir, () => NOW);
    await log.noteStuck('atlas');
    await log.noteStuck('');
    expect(await log.read()).toEqual([{ at: NOW.toISOString(), agent: 'atlas', endsWithQuestion: false, kind: 'stuck' }]);
  });

  it('shares one log through the accessor', () => {
    const log = new OwnerPullsPostLog(dir, () => NOW);
    setOwnerPullsPostLog(log);
    expect(getOwnerPullsPostLog()).toBe(log);
    setOwnerPullsPostLog(null);
    expect(getOwnerPullsPostLog()).toBeNull();
  });
});
