import { scanForSensitive, redactSensitive, applyPrivacyGate } from './wiki-redaction.js';

const SLACK = 'xoxb-' + '1234567890-9876543210-abcdefghijkl';
const OPENAI = 'sk-' + 'A'.repeat(32);

describe('wiki-redaction', () => {
  it('names matched secret patterns without echoing values', () => {
    const scan = scanForSensitive(`token ${SLACK} and key ${OPENAI} and password=hunter22`);
    expect(scan.secrets.sort()).toEqual(['openai_key', 'password_assignment', 'slack_token']);
    expect(JSON.stringify(scan)).not.toContain('1234567890');
  });

  it('masks secrets (and PII on request)', () => {
    const masked = redactSensitive(`call me at 415-555-1234, token ${SLACK}, mail a@b.co`, true);
    expect(masked).not.toContain(SLACK);
    expect(masked).toContain('[REDACTED slack_token]');
    expect(masked).toContain('[phone]');
    expect(masked).toContain('[email]');
    expect(redactSensitive('mail a@b.co')).toBe('mail a@b.co'); // PII kept unless asked
  });

  it('gate: secrets always refuse; PII follows the vault policy', () => {
    expect(applyPrivacyGate(`x ${OPENAI}`, { pii: 'allow' })).toMatchObject({ ok: false, reason: 'secret_detected', patterns: ['openai_key'] });
    expect(applyPrivacyGate('parent a@b.co', { pii: 'refuse' })).toMatchObject({ ok: false, reason: 'pii_refused', patterns: ['email'] });
    expect(applyPrivacyGate('parent a@b.co', { pii: 'mask' })).toEqual({ ok: true, body: 'parent [email]', masked: ['email'] });
    expect(applyPrivacyGate('parent a@b.co', { pii: 'allow' })).toEqual({ ok: true, body: 'parent a@b.co', masked: [] });
    expect(applyPrivacyGate('plain fact, nothing sensitive', { pii: 'refuse' })).toEqual({ ok: true, body: 'plain fact, nothing sensitive', masked: [] });
  });

  it('does not flag placeholders that look like docs examples', () => {
    expect(scanForSensitive('set SLACK_BOT_TOKEN=xoxb-your-token-here').secrets).toEqual([]);
    expect(scanForSensitive('sk-proceed with caution').secrets).toEqual([]);
  });
});
