/**
 * Tests for the crewly-agent credential guard (specs/2026-10-04-agent-credential-isolation.md).
 * Runs the real hook script.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { checkCredentialAccess } from './credential-guard.js';

const SCRIPT = resolve(__dirname, '../../../../config/hooks/credential-guard/guard.sh');

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ca-credguard-'));
  const crewly = join(home, '.crewly');
  mkdirSync(join(crewly, 'runtime', 'credential-guard'), { recursive: true });
  const paths = join(crewly, 'runtime', 'credential-guard', 'paths');
  writeFileSync(paths, `home\t-\t${crewly}\nabs\tcloud-config\t${crewly}/cloud\n`);
  env = {
    PATH: process.env.PATH,
    HOME: home,
    CREWLY_SESSION_NAME: 'deepseek-dev',
    CREWLY_API_URL: 'http://127.0.0.1:9',
    CREWLY_CREDENTIAL_GUARD_SCRIPT: SCRIPT,
    CREWLY_CREDENTIAL_GUARD_PATHS: paths,
  };
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('checkCredentialAccess', () => {
  it('refuses bash_exec and read_file on the Cloud credentials', () => {
    expect(checkCredentialAccess('Bash', { command: 'jq -r .token ~/.crewly/cloud/config.json' }, '/tmp', env)).toMatch(/not available to agents/);
    expect(checkCredentialAccess('Read', { file_path: join(home, '.crewly', 'cloud', 'config.json') }, '/tmp', env)).toMatch(/cloud-config/);
  });

  it('allows everything else', () => {
    expect(checkCredentialAccess('Bash', { command: 'ls ~/.crewly/teams' }, '/tmp', env)).toBeNull();
  });

  it('is off without the env the backend sets', () => {
    expect(checkCredentialAccess('Bash', { command: 'cat ~/.crewly/cloud/config.json' }, '/tmp', { PATH: process.env.PATH })).toBeNull();
  });
});
