/**
 * Tests for the wiki canonical-folder overlay resolver.
 *
 * @module services/wiki/wiki-overlay.resolver.test
 */

import * as path from 'path';
import { overlayRootFor, resolveOverlayFilePath } from './wiki-overlay.resolver';

describe('overlayRootFor', () => {
  const vault = '/home/u/.crewly/teams/abc/wiki';

  it('returns null for non-overlay folders', () => {
    expect(overlayRootFor(vault, 'llm-curated')).toBeNull();
    expect(overlayRootFor(vault, 'memory')).toBeNull();
  });

  it('maps sop/ to the per-team installed sops sibling dir', () => {
    expect(overlayRootFor(vault, 'sop')).toBe(
      path.resolve('/home/u/.crewly/teams/abc/sops'),
    );
  });

  it('maps team-norm/ to the sibling norms dir', () => {
    expect(overlayRootFor(vault, 'team-norm')).toBe(
      path.resolve('/home/u/.crewly/teams/abc/norms'),
    );
  });
});

describe('resolveOverlayFilePath', () => {
  const vault = '/home/u/.crewly/teams/abc/wiki';

  it('returns null when the path is not under an overlay folder', () => {
    expect(resolveOverlayFilePath(vault, 'llm-curated/log.md')).toBeNull();
    expect(resolveOverlayFilePath(vault, 'SCHEMA.md')).toBeNull();
  });

  it('resolves a sop/ page to the per-team installed file', () => {
    expect(resolveOverlayFilePath(vault, 'sop/pm/progress-tracking.md')).toBe(
      path.resolve('/home/u/.crewly/teams/abc/sops', 'pm/progress-tracking.md'),
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
