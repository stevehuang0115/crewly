import { SHARED_CHANNEL_CONSTANTS } from '../../constants.js';
import { classifySharedSend } from './shared-channel-classifier.js';
import {
  NEVER_ALLOWED_CODES,
  SHARED_NORM_ALLOWANCES,
  allowanceForCode,
  allowancesCovering,
  describeAllowances,
  describeNormForAgent,
  isSharedNormAllowance,
  normalizeAllowances,
  parseNormUpdate,
  splitByNorm,
} from './shared-channel-norms.js';

describe('shared-channel norms', () => {
  it('maps hold codes to allowances and never maps refusals or private-data holds', () => {
    expect(allowanceForCode('money')).toBe('money');
    expect(allowanceForCode('file_path')).toBe('file_names');
    expect(allowanceForCode('email')).toBe('contact_details');
    expect(allowanceForCode('phone')).toBe('contact_details');
    expect(allowanceForCode('internal_url')).toBe('internal_links');
    for (const code of NEVER_ALLOWED_CODES) expect(allowanceForCode(code)).toBeUndefined();
    // No allowance claims a never-allowed code.
    for (const a of SHARED_NORM_ALLOWANCES) for (const c of a.codes) expect(NEVER_ALLOWED_CODES.has(c)).toBe(false);
  });

  it('validates and orders allowance keys', () => {
    expect(isSharedNormAllowance('money')).toBe(true);
    expect(isSharedNormAllowance('secret')).toBe(false);
    expect(normalizeAllowances(['wiki_notes', 'money', 'money', 'x', 3])).toEqual(['money', 'wiki_notes']);
  });

  it('splits findings by the allowances; refusals always remain', () => {
    const c = classifySharedSend('The quote is $4,000, file at ~/Desktop/quote.pdf');
    const split = splitByNorm(c.findings, ['money']);
    expect(split.allowed.map((f) => f.code)).toEqual(['money']);
    expect(split.remaining.map((f) => f.code)).toEqual(['file_path']);
    expect(splitByNorm(c.findings, ['money', 'file_names']).remaining).toEqual([]);
    const secret = classifySharedSend('key sk-abcdefghijklmnopqrstuvwxyz0123456789 costs $5');
    const s2 = splitByNorm(secret.findings, normalizeAllowances(SHARED_NORM_ALLOWANCES.map((a) => a.key)));
    expect(s2.remaining.map((f) => f.code)).toContain('secret');
  });

  it('offers covering allowances only when every finding can be allowed', () => {
    expect(allowancesCovering([{ code: 'phone', reason: '' }, { code: 'money', reason: '' }])).toEqual(['money', 'contact_details']);
    expect(allowancesCovering([{ code: 'money', reason: '' }, { code: 'confidential', reason: '' }])).toBeNull();
    expect(allowancesCovering([])).toBeNull();
    expect(describeAllowances(['money', 'file_names'])).toBe('money, file names and paths');
  });

  it('parses an owner update', () => {
    expect(parseNormUpdate({ norm: '  Project X only.\r\n ', allow: ['money'] })).toEqual({ ok: true, update: { norm: 'Project X only.', allow: ['money'] } });
    expect(parseNormUpdate({ allow: [] })).toEqual({ ok: true, update: { allow: [] } });
    expect(parseNormUpdate({ norm: '' })).toEqual({ ok: true, update: { norm: '' } });
    expect(parseNormUpdate(null)).toMatchObject({ ok: false });
    expect(parseNormUpdate({})).toMatchObject({ ok: false, error: expect.stringContaining('Nothing to change') });
    expect(parseNormUpdate({ norm: 5 })).toMatchObject({ ok: false });
    expect(parseNormUpdate({ norm: 'x'.repeat(SHARED_CHANNEL_CONSTANTS.NORM_MAX_CHARS + 1) })).toMatchObject({ ok: false });
    expect(parseNormUpdate({ allow: 'money' })).toMatchObject({ ok: false });
    expect(parseNormUpdate({ allow: ['money', 'nope'] })).toMatchObject({ ok: false, error: expect.stringContaining('Unknown allowance: nope') });
    const never = parseNormUpdate({ allow: ['secret', 'children_data'] });
    expect(never).toMatchObject({ ok: false, error: expect.stringContaining('can never be allowed') });
  });

  it('describes the norm for the orchestrator', () => {
    expect(describeNormForAgent(undefined, 'Acme')).toContain('no norm for Acme');
    expect(describeNormForAgent({ norm: '', allow: [] }, 'Acme')).toContain('no norm');
    const s = describeNormForAgent({ norm: 'They are our printer; share order details.', allow: ['money'] }, 'Acme');
    expect(s).toContain('"They are our printer; share order details."');
    expect(s).toContain('without his approval: money.');
    expect(s).toContain("children's data never go");
  });
});
