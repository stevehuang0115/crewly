/**
 * Tests for `createOssTeamMembershipValidator` — Phase C F2b (#333) OSS
 * tenant defense factory.
 *
 * @module services/chat-v2/chat-v2.team-membership.test
 */

import { createOssTeamMembershipValidator } from './chat-v2.team-membership.js';
import type { ChatPrincipal } from './types.js';

describe('createOssTeamMembershipValidator', () => {
  const principal: ChatPrincipal = { userId: 'user-a', source: 'oss' };

  function build(opts: {
    teams: Record<string, true>;
    getTeamDir?: (id: string) => string;
  }) {
    const teamDirs: Record<string, string> = {};
    for (const id of Object.keys(opts.teams)) {
      teamDirs[id] = `/fake/teams/${id}`;
    }
    return createOssTeamMembershipValidator({
      getTeamDir:
        opts.getTeamDir ?? ((teamId) => `/fake/teams/${teamId}`),
      fileExists: (filePath) => {
        // The factory composes <teamDir>/config.json; pass when the
        // injected fixture has the team configured.
        for (const [id, dir] of Object.entries(teamDirs)) {
          if (filePath === `${dir}/config.json`) {
            return opts.teams[id] === true;
          }
        }
        return false;
      },
    });
  }

  it('returns true when the team exists (config.json present)', () => {
    const validate = build({ teams: { 'team-known': true } });
    expect(validate(principal, 'team-known')).toBe(true);
  });

  it('returns false when the team does not exist (no config.json)', () => {
    const validate = build({ teams: {} });
    expect(validate(principal, 'team-fabricated')).toBe(false);
  });

  it('returns false for a blank/whitespace teamId without touching the FS', () => {
    let exists = jest.fn(() => true);
    const validate = createOssTeamMembershipValidator({
      getTeamDir: () => '/should/not/be/used',
      fileExists: exists as unknown as (p: string) => boolean,
    });
    expect(validate(principal, '')).toBe(false);
    expect(validate(principal, '   ')).toBe(false);
    expect(exists).not.toHaveBeenCalled();
  });

  it('uses the injected getTeamDir to resolve the config path', () => {
    const getTeamDir = jest.fn((id: string) => `/custom/${id}`);
    const fileExists = jest.fn(
      (p: string) => p === '/custom/team-x/config.json',
    );
    const validate = createOssTeamMembershipValidator({
      getTeamDir,
      fileExists,
    });
    expect(validate(principal, 'team-x')).toBe(true);
    expect(getTeamDir).toHaveBeenCalledWith('team-x');
    expect(fileExists).toHaveBeenCalledWith('/custom/team-x/config.json');
  });

  it('ignores the principal (single-user OSS — existence === membership)', () => {
    // Two distinct principals must produce the same answer for the same
    // team — the OSS validator does not branch on userId. Cloud Portal
    // Phase E swaps in a tenant-aware validator that does.
    const validate = build({ teams: { 'team-shared': true } });
    expect(validate(principal, 'team-shared')).toBe(true);
    expect(
      validate({ userId: 'user-b', source: 'oss' }, 'team-shared'),
    ).toBe(true);
  });

  it('rejects non-string teamId arguments defensively', () => {
    const validate = build({ teams: {} });
    // Belt-and-suspenders — service-layer validation already rejects
    // these, but the validator must not throw on bad input.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(validate(principal, undefined as any)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(validate(principal, null as any)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(validate(principal, 42 as any)).toBe(false);
  });
});
