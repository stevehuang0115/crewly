/**
 * install.sh must finish the nvm path on a machine without Node.
 *
 * The script runs with `set -euo pipefail`, and nvm.sh is not nounset-safe:
 * it reads variables (e.g. PROVIDED_VERSION) that are not set yet. The nvm
 * section therefore has to run with nounset off. This test runs the real
 * `install_node_via_nvm` function under bash with `set -euo pipefail` against
 * a stub nvm.sh that behaves the same way.
 *
 * @module tests/integration/install-sh-nvm.test
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const INSTALL_SH = path.resolve(__dirname, '../../scripts/install.sh');

/** Runs install_node_via_nvm from install.sh against a stub nvm.sh. */
function runNvmSection(nvmShBody: string): { status: number | null; output: string; checked: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-nvm-'));
  try {
    fs.writeFileSync(path.join(dir, 'nvm.sh'), nvmShBody);
    const src = fs.readFileSync(INSTALL_SH, 'utf8');
    const start = src.indexOf('install_node_via_nvm() {');
    const end = src.indexOf('\n}\n', start);
    expect(start).toBeGreaterThan(-1); // the function must exist: this test examines it
    const fn = src.slice(start, end + 3);
    const script = [
      'set -euo pipefail',
      'RED=; GREEN=; BLUE=; YELLOW=; NC=',
      'node() { echo v22.0.0; }',
      fn,
      'install_node_via_nvm',
      'echo REACHED_END',
    ].join('\n');
    const res = spawnSync('bash', ['-c', script], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, NVM_DIR: dir },
      encoding: 'utf8',
    });
    return { status: res.status, output: `${res.stdout}${res.stderr}`, checked: fn.length };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('install.sh nvm section under set -u', () => {
  const NVM_READS_UNSET =
    'nvm() { local v="$PROVIDED_VERSION"; echo "Now using node $v"; }\n';

  it('finishes when nvm.sh reads a variable that is not set', () => {
    const r = runNvmSection(NVM_READS_UNSET);
    expect(r.checked).toBeGreaterThan(0);
    expect(r.output).not.toContain('unbound variable');
    expect(r.output).toContain('REACHED_END');
    expect(r.status).toBe(0);
  });

  it('finishes when nvm.sh reads an unset variable while it is sourced', () => {
    const r = runNvmSection('echo "${UNSET_AT_SOURCE}x" >/dev/null; echo "$UNSET_AT_SOURCE"\nnvm() { :; }\n');
    expect(r.output).not.toContain('unbound variable');
    expect(r.status).toBe(0);
  });

  it('turns nounset back on after the nvm section', () => {
    const src = fs.readFileSync(INSTALL_SH, 'utf8');
    const start = src.indexOf('install_node_via_nvm() {');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body.indexOf('set +u')).toBeGreaterThan(-1);
    expect(body.lastIndexOf('set -u')).toBeGreaterThan(body.lastIndexOf('nvm use --lts'));
  });
});
