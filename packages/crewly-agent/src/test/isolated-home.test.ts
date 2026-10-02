/**
 * Guard for vitest.setup.ts: tests run against a temp home, never the real one.
 */
import * as os from 'node:os';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLOUD_CONFIG_PATH } from '../runtime/cloud-config.js';

describe('vitest setup — isolated home', () => {
  const realHome = os.userInfo().homedir;

  it('points os.homedir() (namespace and named import), HOME and CREWLY_HOME at a temp home', () => {
    expect(os.homedir()).not.toBe(realHome);
    expect(homedir()).toBe(os.homedir());
    expect(process.env.HOME).toBe(os.homedir());
    expect(process.env.CREWLY_HOME).toBe(path.join(os.homedir(), '.crewly'));
  });

  it('resolves the cloud config path (computed at import) inside the temp home', () => {
    expect(CLOUD_CONFIG_PATH.startsWith(os.homedir() + path.sep)).toBe(true);
    expect(CLOUD_CONFIG_PATH.startsWith(path.join(realHome, '.crewly'))).toBe(false);
  });
});
