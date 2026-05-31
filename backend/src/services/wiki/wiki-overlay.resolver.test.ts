/**
 * Tests for the wiki canonical-folder overlay resolver.
 *
 * @module services/wiki/wiki-overlay.resolver.test
 */

import * as path from 'path';
import { overlayRootFor, resolveOverlayFilePath } from './wiki-overlay.resolver';

describe('overlayRootFor', () => {
  const vault = '/home/u/.crewly/teams/abc/wiki';

  afterEach(() => {
    delete process.env.CREWLY_CONFIG_DIR;
  });

  it('returns null for non-overlay folders', () => {
    expect(overlayRootFor(vault, 'llm-curated')).toBeNull();
    expect(overlayRootFor(vault, 'memory')).toBeNull();
  });

  it('maps sop/ to <configDir>/sops', () => {
    process.env.CREWLY_CONFIG_DIR = '/opt/crewly/config';
    expect(overlayRootFor(vault, 'sop')).toBe(path.join('/opt/crewly/config', 'sops'));
  });

  it('maps team-norm/ to the sibling norms dir', () => {
    expect(overlayRootFor(vault, 'team-norm')).toBe(
      path.resolve('/home/u/.crewly/teams/abc/norms'),
    );
  });
});

describe('resolveOverlayFilePath', () => {
  const vault = '/home/u/.crewly/teams/abc/wiki';

  beforeEach(() => {
    process.env.CREWLY_CONFIG_DIR = '/opt/crewly/config';
  });
  afterEach(() => {
    delete process.env.CREWLY_CONFIG_DIR;
  });

  it('returns null when the path is not under an overlay folder', () => {
    expect(resolveOverlayFilePath(vault, 'llm-curated/log.md')).toBeNull();
    expect(resolveOverlayFilePath(vault, 'SCHEMA.md')).toBeNull();
  });

  it('resolves a sop/ page to the real config file', () => {
    expect(resolveOverlayFilePath(vault, 'sop/pm/progress-tracking.md')).toBe(
      path.resolve('/opt/crewly/config/sops', 'pm/progress-tracking.md'),
    );
  });

  it('resolves a team-norm/ page to the sibling norms dir', () => {
    expect(resolveOverlayFilePath(vault, 'team-norm/canDelegate.md')).toBe(
      path.resolve('/home/u/.crewly/teams/abc/norms', 'canDelegate.md'),
    );
  });

  it('throws overlay_escape on path traversal', () => {
    expect(() => resolveOverlayFilePath(vault, 'sop/../../../etc/passwd')).toThrow(
      /escapes source root/,
    );
  });
});
