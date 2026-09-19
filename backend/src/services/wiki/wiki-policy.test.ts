import { decideWrite, canReview } from './wiki-policy.js';

const schema = { write_policy: { canonical: ['team-leader', 'orchestrator'], proposed_only: ['worker', 'researcher'], schema_writer: ['steve'] } };

describe('wiki-policy', () => {
  it('owner/orchestrator/canonical roles write directly; everyone else proposes', () => {
    expect(decideWrite(schema, undefined)).toBe('canonical');
    expect(decideWrite(schema, 'orchestrator')).toBe('canonical');
    expect(decideWrite(schema, 'Team-Leader')).toBe('canonical');
    expect(decideWrite(schema, 'researcher')).toBe('proposed');
    expect(decideWrite(schema, 'developer')).toBe('proposed'); // unlisted → safe default
  });

  it('only canonical roles review', () => {
    expect(canReview(schema, 'team-leader')).toBe(true);
    expect(canReview(schema, 'developer')).toBe(false);
  });
});
