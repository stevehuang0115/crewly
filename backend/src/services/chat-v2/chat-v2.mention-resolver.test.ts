/**
 * Unit tests for ChatV2MentionResolver — Phase C BE.2 mention dispatch
 * routing scaffolding.
 *
 * The resolver is intentionally test-friendly: it only depends on a
 * `loadTeams()` callback, so all branches are exercised against in-memory
 * team fixtures with no real `StorageService`.
 *
 * @module services/chat-v2/chat-v2.mention-resolver.test
 */

import { ChatV2MentionResolver } from './chat-v2.mention-resolver.js';
import type { Team, TeamMember } from '../../types/index.js';
import { LoggerService } from '../core/logger.service.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function member(over: Partial<TeamMember> & Pick<TeamMember, 'id' | 'sessionName'>): TeamMember {
  return {
    name: over.name ?? `mem-${over.id}`,
    role: over.role ?? 'developer',
    systemPrompt: '',
    agentStatus: 'inactive',
    workingStatus: 'idle',
    runtimeType: 'claude-code',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function team(over: Partial<Team> & Pick<Team, 'id'>): Team {
  return {
    name: over.name ?? `team-${over.id}`,
    members: over.members ?? [],
    projectIds: over.projectIds ?? [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

// A fixture covering all of TL pick rules + a normal worker + edge cases.
function buildFixture(): Team[] {
  const product = team({
    id: 'team-product',
    members: [
      member({
        id: 'sam-id',
        sessionName: 'crewly-product-sam',
        role: 'team-leader',
        hierarchyLevel: 1,
        canDelegate: true,
      }),
      member({ id: 'leo-id', sessionName: 'crewly-product-leo', role: 'developer' }),
      member({ id: 'max-id', sessionName: 'crewly-product-max', role: 'developer' }),
    ],
  });
  const marketing = team({
    id: 'team-marketing',
    members: [
      // No hierarchy fields, but role='team-leader' — falls through to rule 3.
      member({ id: 'ella-id', sessionName: 'crewly-marketing-ella', role: 'team-leader' }),
      member({ id: 'luna-id', sessionName: 'crewly-marketing-luna' }),
    ],
  });
  const legacyOnlyDelegator = team({
    id: 'team-legacy',
    members: [
      // canDelegate=true but no hierarchyLevel — rule 2 hits.
      member({ id: 'old-tl-id', sessionName: 'sess-old-tl', canDelegate: true }),
      member({ id: 'old-worker', sessionName: 'sess-old-worker' }),
    ],
  });
  const noLeadTeam = team({
    id: 'team-flat',
    members: [
      // No TL at all — rule 4 fallback to first member.
      member({ id: 'first-id', sessionName: 'sess-first' }),
      member({ id: 'second-id', sessionName: 'sess-second' }),
    ],
  });
  const emptyTeam = team({ id: 'team-empty', members: [] });
  return [product, marketing, legacyOnlyDelegator, noLeadTeam, emptyTeam];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatV2MentionResolver', () => {
  type LoadTeamsFn = () => Promise<Team[]> | Team[];
  function build(loadTeams: LoadTeamsFn = () => buildFixture()) {
    return new ChatV2MentionResolver({ loadTeams });
  }

  describe('@agent mentions', () => {
    it('resolves a member id to that member sessionName', async () => {
      const r = build();
      const out = await r.resolve(['leo-id']);
      expect(out).toEqual([
        {
          kind: 'agent',
          mentionId: 'leo-id',
          memberId: 'leo-id',
          sessionName: 'crewly-product-leo',
        },
      ]);
    });

    it('resolves multiple distinct member ids in input order', async () => {
      const r = build();
      const out = await r.resolve(['leo-id', 'max-id']);
      expect(out.map((t) => t.sessionName)).toEqual([
        'crewly-product-leo',
        'crewly-product-max',
      ]);
    });

    it('skips an empty / whitespace mention id silently', async () => {
      const r = build();
      const out = await r.resolve(['leo-id', '', '   ', 'max-id']);
      expect(out).toHaveLength(2);
    });

    it('skips members with empty sessionName', async () => {
      const r = build(() => [
        team({
          id: 't',
          members: [member({ id: 'no-sess', sessionName: '' })],
        }),
      ]);
      const out = await r.resolve(['no-sess']);
      expect(out).toEqual([]);
    });
  });

  describe('@team mentions', () => {
    it('resolves a team id to its hierarchy-1 + canDelegate TL (rule 1)', async () => {
      const r = build();
      const out = await r.resolve(['team-product']);
      expect(out).toEqual([
        {
          kind: 'team',
          mentionId: 'team-product',
          memberId: 'sam-id',
          sessionName: 'crewly-product-sam',
          teamId: 'team-product',
        },
      ]);
    });

    it('falls back to canDelegate=true when no hierarchy fields are set (rule 2)', async () => {
      const r = build();
      const out = await r.resolve(['team-legacy']);
      expect(out[0]).toMatchObject({
        kind: 'team',
        memberId: 'old-tl-id',
        sessionName: 'sess-old-tl',
      });
    });

    it("falls back to role='team-leader' when canDelegate is unset (rule 3)", async () => {
      const r = build();
      const out = await r.resolve(['team-marketing']);
      expect(out[0]).toMatchObject({
        kind: 'team',
        memberId: 'ella-id',
        sessionName: 'crewly-marketing-ella',
      });
    });

    it('falls back to first member when no TL marker exists (rule 4)', async () => {
      const r = build();
      const out = await r.resolve(['team-flat']);
      expect(out[0]).toMatchObject({
        kind: 'team',
        memberId: 'first-id',
        sessionName: 'sess-first',
      });
    });

    it('skips empty teams (no members → no target)', async () => {
      const r = build();
      const out = await r.resolve(['team-empty']);
      expect(out).toEqual([]);
    });

    it('takes precedence over a same-named member id (team-first)', async () => {
      // Synthesize a clash where 'collide' is both a team id and a member id.
      const collidingFixture = (): Team[] => [
        team({
          id: 'collide',
          members: [
            member({ id: 'tl-of-collide', sessionName: 'sess-tl', canDelegate: true }),
          ],
        }),
        team({
          id: 'other',
          members: [member({ id: 'collide', sessionName: 'sess-collide-as-member' })],
        }),
      ];
      const r = build(collidingFixture);
      const out = await r.resolve(['collide']);
      expect(out).toHaveLength(1);
      expect(out[0].kind).toBe('team');
      expect(out[0].sessionName).toBe('sess-tl');
    });
  });

  describe('mixed + dedup + unknown', () => {
    it('mixes @team + @agent mentions and preserves input order', async () => {
      const r = build();
      const out = await r.resolve(['team-marketing', 'max-id']);
      expect(out.map((t) => ({ kind: t.kind, sessionName: t.sessionName }))).toEqual([
        { kind: 'team', sessionName: 'crewly-marketing-ella' },
        { kind: 'agent', sessionName: 'crewly-product-max' },
      ]);
    });

    it('deduplicates by sessionName (same target mentioned twice)', async () => {
      const r = build();
      // Sam is the TL of team-product AND a member with id sam-id — two
      // mention paths to the same session. Output should have one entry.
      const out = await r.resolve(['team-product', 'sam-id']);
      expect(out).toHaveLength(1);
      expect(out[0].sessionName).toBe('crewly-product-sam');
      // Team-mention came first in input order, so it wins.
      expect(out[0].kind).toBe('team');
    });

    it('skips unknown mention ids silently', async () => {
      const r = build();
      const out = await r.resolve(['leo-id', 'does-not-exist', 'team-does-not-exist']);
      expect(out).toHaveLength(1);
      expect(out[0].sessionName).toBe('crewly-product-leo');
    });

    it('returns empty when given empty mentions array', async () => {
      const r = build();
      expect(await r.resolve([])).toEqual([]);
    });

    it('tolerates non-string entries in the mentions array', async () => {
      const r = build();
      // Defense-in-depth: validation happens at the chat-v2 service layer
      // (mentions must be string[]), but the resolver shouldn't throw if a
      // bad entry slips through (e.g., from a future caller).
      const bad = [null, undefined, 0, true, 'leo-id'] as unknown as string[];
      const out = await r.resolve(bad);
      expect(out).toHaveLength(1);
      expect(out[0].sessionName).toBe('crewly-product-leo');
    });
  });

  describe('loadTeams error handling', () => {
    it('returns no targets when loadTeams throws (does not crash dispatch)', async () => {
      const r = build(() => {
        throw new Error('storage unavailable');
      });
      const out = await r.resolve(['leo-id']);
      expect(out).toEqual([]);
    });

    it('awaits an async loadTeams and resolves correctly', async () => {
      const r = build(async () => {
        await Promise.resolve();
        return buildFixture();
      });
      const out = await r.resolve(['leo-id']);
      expect(out).toHaveLength(1);
      expect(out[0].sessionName).toBe('crewly-product-leo');
    });
  });

  // ---------------------------------------------------------------------
  // Phase C F2a (#333) — cross-tenant scope enforcement when
  // context.teamId is set. Replaces the BE.2 placeholder test.
  // ---------------------------------------------------------------------
  describe('context.teamId — F2a cross-tenant scope', () => {
    /**
     * Capture warn/debug log calls without depending on the real logger.
     * `createComponentLogger` returns a fresh ComponentLogger per call,
     * so patching one instance doesn't affect another. Stub the factory
     * itself to return a stable spy logger that every resolver built
     * during the spec sees.
     */
    type LogCall = { level: 'warn' | 'debug' | 'info' | 'error'; message: string; meta: unknown };
    let logSpy: LogCall[];
    let createComponentLoggerSpy: jest.SpyInstance;

    beforeEach(() => {
      logSpy = [];
      const stubLogger = {
        warn: (message: string, meta?: unknown) =>
          logSpy.push({ level: 'warn', message, meta }),
        debug: (message: string, meta?: unknown) =>
          logSpy.push({ level: 'debug', message, meta }),
        info: (message: string, meta?: unknown) =>
          logSpy.push({ level: 'info', message, meta }),
        error: (message: string, meta?: unknown) =>
          logSpy.push({ level: 'error', message, meta }),
      };
      createComponentLoggerSpy = jest
        .spyOn(LoggerService.getInstance(), 'createComponentLogger')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockReturnValue(stubLogger as any);
    });

    afterEach(() => {
      createComponentLoggerSpy.mockRestore();
    });

    describe('@agent scoping', () => {
      it('resolves an @agent in the scoped team', async () => {
        const r = build();
        const out = await r.resolve(['leo-id'], { teamId: 'team-product' });
        expect(out).toEqual([
          {
            kind: 'agent',
            mentionId: 'leo-id',
            memberId: 'leo-id',
            sessionName: 'crewly-product-leo',
          },
        ]);
      });

      it('drops an @agent that lives in a foreign team (cross-tenant leak guard)', async () => {
        // The Arch-described attack: scope is team-product, attacker
        // mentions an agent id that belongs to team-marketing. Resolver
        // must NOT produce a dispatch target for the foreign agent.
        const r = build();
        const out = await r.resolve(['luna-id'], { teamId: 'team-product' });
        expect(out).toEqual([]);
        expect(
          logSpy.some(
            (c) =>
              c.level === 'debug' &&
              c.message ===
                'chat-v2 mention-resolver dropping foreign-team @agent',
          ),
        ).toBe(true);
      });

      it('drops only foreign-team @agents in a mixed list (same-team kept)', async () => {
        const r = build();
        const out = await r.resolve(
          ['leo-id', 'luna-id', 'max-id'],
          { teamId: 'team-product' },
        );
        // leo + max are same-team, kept; luna is foreign, dropped.
        expect(out.map((t) => t.memberId)).toEqual(['leo-id', 'max-id']);
      });

      it('treats blank context.teamId as "no scope" (back-compat)', async () => {
        const r = build();
        // Empty string and whitespace must not trigger scope filtering;
        // matches listChannels' teamIdFilter normalization. A foreign
        // @agent should still resolve under "no scope".
        for (const teamIdRaw of ['', '   ']) {
          const out = await r.resolve(['luna-id'], { teamId: teamIdRaw });
          expect(out).toHaveLength(1);
          expect(out[0].memberId).toBe('luna-id');
        }
      });

      it('preserves global resolution when context is omitted entirely', async () => {
        const r = build();
        const out = await r.resolve(['luna-id']);
        expect(out).toHaveLength(1);
        expect(out[0].memberId).toBe('luna-id');
      });
    });

    describe('@team scoping', () => {
      it('resolves a same-team @team mention without warn', async () => {
        const r = build();
        const out = await r.resolve(['team-product'], {
          teamId: 'team-product',
        });
        expect(out[0]).toMatchObject({
          kind: 'team',
          memberId: 'sam-id',
          teamId: 'team-product',
        });
        expect(
          logSpy.some(
            (c) =>
              c.level === 'warn' &&
              c.message === 'chat-v2 mention-resolver cross-team @team mention',
          ),
        ).toBe(false);
      });

      it('still resolves a cross-team @team mention but emits a warn', async () => {
        // Cross-team @team is not blocked — it's a useful coordination
        // affordance — but the warn surfaces it for audit.
        const r = build();
        const out = await r.resolve(['team-marketing'], {
          teamId: 'team-product',
        });
        expect(out[0]).toMatchObject({
          kind: 'team',
          teamId: 'team-marketing',
          memberId: 'ella-id',
        });
        const warn = logSpy.find(
          (c) =>
            c.level === 'warn' &&
            c.message === 'chat-v2 mention-resolver cross-team @team mention',
        );
        expect(warn).toBeDefined();
        expect(warn?.meta).toMatchObject({
          mentionId: 'team-marketing',
          mentionedTeamId: 'team-marketing',
          contextTeamId: 'team-product',
        });
      });
    });

    describe('regression: cross-tenant leak vector', () => {
      it('reproduces and blocks the Arch-described leak (team-A channel cannot dispatch to team-B agent)', async () => {
        // Arch's attack writeup on PR #331:
        //   1. Create type=channel channel with teamId=team-other-tenant.
        //   2. POST message with mentions=[agent-id-from-foreign-team].
        //   3. Resolver walks ALL teams, finds foreign agent, dispatcher
        //      fans out, foreign session receives the message.
        // After F2a, step 3 must produce no targets.
        const r = build();
        const attackerScopedTeamId = 'team-product';
        const foreignAgentMemberId = 'luna-id'; // belongs to team-marketing
        const out = await r.resolve([foreignAgentMemberId], {
          teamId: attackerScopedTeamId,
        });
        expect(out).toEqual([]);
      });
    });
  });
});
