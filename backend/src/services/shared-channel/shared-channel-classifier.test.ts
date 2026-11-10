import { classifySharedSend, describeFindings, hasSecretShape } from './shared-channel-classifier.js';

const codes = (text: string, ctx = {}) => classifySharedSend(text, ctx).findings.map((f) => f.code);

describe('classifySharedSend', () => {
  it('lets small talk and plain scheduling through', () => {
    for (const t of ['Thanks, see you Tuesday!', 'Sounds good. We can meet next week.', 'Hi Fern, happy to help with the event.']) {
      expect(classifySharedSend(t)).toEqual({ verdict: 'plain', findings: [] });
    }
  });

  it.each([
    ['file_path', 'The draft is at /Users/steve/Desktop/plan.md'],
    ['file_path', 'see ~/notes/acme.txt'],
    ['file_path', 'I put it in report.xlsx'],
    ['email', 'Write to jane@acme.co'],
    ['phone', 'Call 415-555-1234'],
    ['money', 'The quote is $4,000'],
    ['money', 'about 3万 a month'],
    ['money', 'our budget for this'],
    ['internal_url', 'open http://localhost:8787/teams'],
    ['internal_url', 'it is on 192.168.1.20'],
    ['internal_url', 'https://apps.crewlyai.com/abc'],
    ['internal_ref', 'tracked in CREW-646'],
    ['internal_ref', 'ask crewly-orc'],
    ['wiki_memory', 'from our wiki: [[Pricing]]'],
    ['owner_connector', 'I found it in Gmail'],
    ['confidential', 'this is internal only'],
    ['children_mention', 'we run camps for kids'],
    ['code_block', '```\nls\n```'],
  ])('holds %s', (code, text) => {
    const r = classifySharedSend(text);
    expect(r.verdict).toBe('internal');
    expect(r.findings.map((f) => f.code)).toContain(code);
  });

  it('holds a long message as unsure', () => {
    expect(codes('word '.repeat(400))).toContain('long_text');
  });

  it('holds when the owner\'s own connector was read just before', () => {
    const r = classifySharedSend('Sure, Thursday works.', { recentPeople: ['owner'] });
    expect(r.verdict).toBe('internal');
    expect(r.findings[0]!.code).toBe('owner_connector');
  });

  it.each([
    ['sk key', 'here: sk-abcdefghijklmnopqrstuvwxyz123456'],
    ['github token', 'ghp_abcdefghijklmnopqrstuvwxyz0123'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'],
    ['password', 'password: hunter2hunter2'],
    ['long token', 'use a8f3k2j4h5g6f7d8s9a0q1w2e3r4t5y6u7'],
    ['url param', 'https://example.com/x?token=abcdef123456'],
  ])('refuses a %s', (_name, text) => {
    const r = classifySharedSend(text);
    expect(r.verdict).toBe('refused');
    expect(r.findings[0]!.code).toBe('secret');
  });

  it('refuses children\'s personal data, not a mere mention', () => {
    expect(classifySharedSend('Amy is a student, 9 years old, allergic to nuts').verdict).toBe('refused');
    expect(codes('Her parents can be reached at mom@family.org (kid in grade 3)')).toContain('children_data');
    expect(classifySharedSend('孩子今年8岁').verdict).toBe('refused');
    expect(classifySharedSend('We teach kids robotics').verdict).toBe('internal');
  });

  it('refuses after another person\'s connector was read', () => {
    const r = classifySharedSend('Thursday works', { recentPeople: ['owner', 'p-amy'] });
    expect(r.verdict).toBe('refused');
    expect(r.findings.map((f) => f.code)).toEqual(['private_person_data', 'owner_connector']);
  });

  it('lists refusals before holds', () => {
    const r = classifySharedSend('email a@b.co the key ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(r.findings[0]!.code).toBe('secret');
    expect(describeFindings(r.findings, 'refused')).toBe('a secret or token-shaped string');
    expect(describeFindings(r.findings)).toContain('an email address');
  });
});

describe('hasSecretShape', () => {
  it('does not take a UUID or ordinary words for a token', () => {
    expect(hasSecretShape('message 0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(false);
    expect(hasSecretShape('internationalization-and-localization')).toBe(false);
    expect(hasSecretShape('nothing here')).toBe(false);
  });
});
