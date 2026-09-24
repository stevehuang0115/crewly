/**
 * Tests for the Slack source preference store.
 *
 * @module services/slack/slack-source-preference.service.test
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  isSlackSourceName,
  loadSlackSourcePreference,
  saveSlackSourcePreference,
  getSlackSourcePreferencePath,
} from './slack-source-preference.service.js';

describe('slack-source-preference', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-slack-source-'));
    file = path.join(dir, 'slack-source.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads null when nothing was recorded', async () => {
    expect(await loadSlackSourcePreference(file)).toBeNull();
  });

  it('round-trips a recorded source', async () => {
    const written = await saveSlackSourcePreference('env', 'connect-route', file);
    expect(written.source).toBe('env');
    const read = await loadSlackSourcePreference(file);
    expect(read).toEqual(written);
  });

  it('a later record replaces an earlier one', async () => {
    await saveSlackSourcePreference('env', 'boot', file);
    await saveSlackSourcePreference('cloud', 'owner-choice', file);
    expect((await loadSlackSourcePreference(file))?.source).toBe('cloud');
  });

  it('treats a malformed file as no record', async () => {
    await fs.writeFile(file, JSON.stringify({ source: 'socket' }));
    expect(await loadSlackSourcePreference(file)).toBeNull();
    await fs.writeFile(file, 'not json');
    expect(await loadSlackSourcePreference(file)).toBeNull();
  });

  it('fills missing metadata rather than rejecting a valid source', async () => {
    await fs.writeFile(file, JSON.stringify({ source: 'cloud' }));
    expect(await loadSlackSourcePreference(file)).toEqual({ source: 'cloud', recordedAt: '', reason: '' });
  });

  it('isSlackSourceName accepts only env and cloud', () => {
    expect(isSlackSourceName('env')).toBe(true);
    expect(isSlackSourceName('cloud')).toBe(true);
    expect(isSlackSourceName('auto')).toBe(false);
    expect(isSlackSourceName(undefined)).toBe(false);
  });

  it('defaults to slack-source.json under CREWLY_HOME', () => {
    expect(path.basename(getSlackSourcePreferencePath())).toBe('slack-source.json');
  });
});
