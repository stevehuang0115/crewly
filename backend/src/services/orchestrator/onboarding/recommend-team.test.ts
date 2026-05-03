/**
 * Tests for recommend-team logic.
 *
 * Covers:
 *   - Each of the 5 hardcoded mappings fires for its anchor input.
 *   - Generic fallback fires when nothing matches.
 *   - Returned shape is well-formed (templateId, ≥2 agents, reasoning, source).
 *   - Pure function: same input twice → identical output.
 *
 * @module services/orchestrator/onboarding/recommend-team.test
 */

import {
  recommendTeam,
  HARDCODED_MAPPING_COUNT,
  HARDCODED_MAPPING_KEYS,
  type BusinessContext,
  type TeamRecommendation,
} from './recommend-team.js';

const baseTask = (name: string) =>
  ({ name, tier: 'yes-today' } as const);

const baseCtx = (industry: string, tasks: string[]): BusinessContext => ({
  industry,
  scale: 'solo',
  tasks: tasks.map(baseTask),
});

function expectShape(rec: TeamRecommendation) {
  expect(typeof rec.templateId).toBe('string');
  expect(rec.templateId.length).toBeGreaterThan(0);
  expect(Array.isArray(rec.agents)).toBe(true);
  expect(rec.agents.length).toBeGreaterThanOrEqual(2);
  expect(rec.agents.length).toBeLessThanOrEqual(4);
  for (const a of rec.agents) {
    expect(typeof a.role).toBe('string');
    expect(a.role.length).toBeGreaterThan(0);
    expect(typeof a.responsibilities).toBe('string');
    expect(a.responsibilities.length).toBeGreaterThan(0);
    expect(Array.isArray(a.skillIds)).toBe(true);
  }
  expect(typeof rec.reasoning).toBe('string');
  expect(rec.reasoning.length).toBeGreaterThan(0);
  expect(typeof rec.source).toBe('string');
}

describe('recommendTeam — hardcoded mappings', () => {
  it('exposes exactly 5 hardcoded mappings (the spec target)', () => {
    expect(HARDCODED_MAPPING_COUNT).toBe(5);
    expect(HARDCODED_MAPPING_KEYS.length).toBe(5);
  });

  it('e-commerce + content + support → dtc-viral-content-team (2 agents)', () => {
    const rec = recommendTeam(
      baseCtx('small Shopify skincare shop', [
        'weekly blog content',
        'customer support replies',
      ]),
    );
    expect(rec.templateId).toBe('dtc-viral-content-team');
    expect(rec.agents.length).toBe(2);
    expect(rec.source).toBe('hardcoded:ecommerce-content-support');
    expectShape(rec);
  });

  it('solo creator (TikTok / YouTube) → ai-video-social-team (2 agents)', () => {
    const rec = recommendTeam(
      baseCtx('solo TikTok + YouTube creator focused on productivity', [
        'video editing',
        'newsletter drafts',
      ]),
    );
    expect(rec.templateId).toBe('ai-video-social-team');
    expect(rec.agents.length).toBe(2);
    expect(rec.source).toBe('hardcoded:solo-creator');
    expectShape(rec);
  });

  it('solo SaaS dev → pragmatic-mvp-dev-team (2 agents)', () => {
    const rec = recommendTeam({
      industry: 'solo SaaS founder building a B2B platform',
      scale: 'solo',
      tasks: [
        baseTask('code review on PRs'),
        baseTask('weekly metrics digest'),
      ],
    });
    expect(rec.templateId).toBe('pragmatic-mvp-dev-team');
    expect(rec.agents.length).toBe(2);
    expect(rec.source).toBe('hardcoded:engineering');
    expectShape(rec);
  });

  it('small dev team → web-dev-team (different template than solo path)', () => {
    const rec = recommendTeam({
      industry: 'small SaaS engineering team building developer tools',
      scale: 'small-team',
      tasks: [
        baseTask('code review'),
        baseTask('product metrics'),
      ],
    });
    expect(rec.templateId).toBe('web-dev-team');
    expect(rec.agents.length).toBe(2);
    expect(rec.source).toBe('hardcoded:engineering');
    expectShape(rec);
  });

  it('support / ops focus → customer-ops-team (2 agents)', () => {
    const rec = recommendTeam(
      baseCtx('B2B SaaS focused on customer service operations', [
        'helpdesk tickets',
        'feedback summary',
      ]),
    );
    // 'b2b' matches engineering, 'helpdesk' + 'feedback' + 'service' + 'tickets' match support-ops
    // support-ops should win on score.
    expect(rec.templateId).toBe('customer-ops-team');
    expect(rec.source).toBe('hardcoded:support-ops');
    expectShape(rec);
  });

  it('growth / marketing focus → growth-marketing-team (3 agents)', () => {
    const rec = recommendTeam(
      baseCtx('growth marketing agency running paid ads + SEO', [
        'lead gen pipeline',
        'content distribution',
      ]),
    );
    expect(rec.templateId).toBe('growth-marketing-team');
    expect(rec.agents.length).toBe(3);
    expect(rec.source).toBe('hardcoded:growth-marketing');
    expectShape(rec);
  });
});

describe('recommendTeam — fallback', () => {
  it('falls back to startup-team for unrecognised input', () => {
    const rec = recommendTeam({
      industry: 'professional underwater basket weaving',
      scale: 'solo',
      tasks: [baseTask('something obscure')],
    });
    expect(rec.templateId).toBe('startup-team');
    expect(rec.source).toBe('fallback');
    expect(rec.agents.length).toBe(2);
    expectShape(rec);
  });

  it('falls back when industry + tasks are empty', () => {
    const rec = recommendTeam({
      industry: '',
      scale: 'solo',
      tasks: [],
    });
    expect(rec.templateId).toBe('startup-team');
    expect(rec.source).toBe('fallback');
    expectShape(rec);
  });

  it('falls back gracefully when tasks have whitespace-only names', () => {
    const rec = recommendTeam({
      industry: '',
      scale: 'company',
      tasks: [{ name: '   ', tier: 'yes-today' }],
    });
    expect(rec.source).toBe('fallback');
    expectShape(rec);
  });
});

describe('recommendTeam — properties', () => {
  it('is pure: same input twice → deeply equal output', () => {
    const ctx = baseCtx('Shopify e-commerce skincare', [
      'content', 'support',
    ]);
    expect(recommendTeam(ctx)).toEqual(recommendTeam(ctx));
  });

  it('every recommendation declares a real-looking template id (kebab-case, ≥2 segments)', () => {
    // Walk all 5 hardcoded scenarios + the fallback.
    const samples: BusinessContext[] = [
      baseCtx('shopify', ['support', 'content']),
      baseCtx('youtube creator', ['video']),
      baseCtx('saas startup', ['code review']),
      baseCtx('helpdesk operations', ['tickets']),
      baseCtx('growth marketing agency', ['ads']),
      baseCtx('???', ['???']),
    ];
    for (const s of samples) {
      const rec = recommendTeam(s);
      expect(rec.templateId).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(rec.templateId.split('-').length).toBeGreaterThanOrEqual(2);
    }
  });

  it('every recommendation has a non-empty reasoning string', () => {
    const samples: BusinessContext[] = [
      baseCtx('shopify', ['support']),
      baseCtx('???', ['???']),
    ];
    for (const s of samples) {
      const rec = recommendTeam(s);
      expect(rec.reasoning.length).toBeGreaterThan(20);
    }
  });

  it('agents always have at least one skillId', () => {
    const rec = recommendTeam(baseCtx('shopify', ['support', 'content']));
    for (const a of rec.agents) {
      expect(a.skillIds.length).toBeGreaterThan(0);
    }
  });
});
