/**
 * Tests for the Slack mention resolver.
 *
 * @module services/slack/slack-mention-resolver.test
 */

import {
  candidateAliases,
  extractMentionTokens,
  extractNativeMentionIds,
  levenshtein,
  resolveSlackMentions,
} from './slack-mention-resolver.js';

const team = [
  { name: 'Sam', sessionName: 'crewly-alpha-sam' },
  { name: 'Leo', sessionName: 'crewly-alpha-leo' },
  { name: 'Data Analyst', sessionName: 'crewly-alpha-data-analyst' },
  { name: '小明', sessionName: 'crewly-alpha-xiaoming' },
];

describe('levenshtein', () => {
  it('is 0 for equal strings regardless of case', () => {
    expect(levenshtein('Sam', 'sam')).toBe(0);
  });
  it('counts single edits', () => {
    expect(levenshtein('lee', 'leo')).toBe(1);
    expect(levenshtein('sam', 'samm')).toBe(1);
    expect(levenshtein('', 'abc')).toBe(3);
  });
});

describe('candidateAliases', () => {
  it('includes display name variants and the session short name', () => {
    expect(candidateAliases({ name: 'Data Analyst', sessionName: 'crewly-alpha-data-analyst' })).toEqual(
      expect.arrayContaining(['data analyst', 'dataanalyst', 'data-analyst', 'crewly-alpha-data-analyst']),
    );
  });
  it('tolerates a missing name', () => {
    expect(candidateAliases({ name: '', sessionName: 'crewly-a-b' })).toEqual(['crewly-a-b', 'b']);
  });
});

describe('extractMentionTokens', () => {
  it('finds @names anywhere in the text, deduped', () => {
    expect(extractMentionTokens('hey @sam and @Leo, @sam again')).toEqual(['sam', 'Leo']);
  });
  it('ignores emails, Slack native mentions and reserved words', () => {
    expect(extractMentionTokens('mail me@x.com <@U123> @here @channel ok @leo')).toEqual(['leo']);
  });
  it('handles CJK names and trailing punctuation', () => {
    expect(extractMentionTokens('@小明. 看一下 @leo-')).toEqual(['小明', 'leo']);
  });
  it('returns [] for empty text', () => {
    expect(extractMentionTokens('')).toEqual([]);
  });
});

describe('native <@U…> mentions (real agent identities)', () => {
  const withIds = [
    { name: 'Sam', sessionName: 'crewly-alpha-sam', botUserId: 'USAM' },
    { name: 'Leo', sessionName: 'crewly-alpha-leo' },
  ];
  it('extracts native mention ids', () => {
    expect(extractNativeMentionIds('<@USAM> and <@ULEO|leo> and <@USAM>')).toEqual(['USAM', 'ULEO']);
  });
  it('resolves an agent by its bot user id, and dedupes against the text alias', () => {
    const r = resolveSlackMentions('<@USAM> @sam @leo', withIds);
    expect(r.mentions).toEqual(['crewly-alpha-sam', 'crewly-alpha-leo']);
    expect(r.unknown).toEqual([]);
  });
  it('ignores native mentions of non-agents (the master bot, humans)', () => {
    const r = resolveSlackMentions('<@UBOT> <@UHUMAN> hi', withIds);
    expect(r).toEqual({ mentions: [], unknown: [] });
  });
});

describe('resolveSlackMentions', () => {
  it('maps exact names, short session names and spaced names to sessions', () => {
    const r = resolveSlackMentions('@sam @leo @data-analyst @小明 go', team);
    expect(r.mentions).toEqual([
      'crewly-alpha-sam',
      'crewly-alpha-leo',
      'crewly-alpha-data-analyst',
      'crewly-alpha-xiaoming',
    ]);
    expect(r.unknown).toEqual([]);
  });

  it('reports a typo with the closest names as suggestions', () => {
    const r = resolveSlackMentions('@lee please', team);
    expect(r.mentions).toEqual([]);
    expect(r.unknown).toEqual([{ token: 'lee', suggestions: ['Leo'] }]);
  });

  it('offers no suggestion when nothing is within the cutoff', () => {
    const r = resolveSlackMentions('@zebra please', team);
    expect(r.unknown).toEqual([{ token: 'zebra', suggestions: [] }]);
  });

  it('caps suggestions and orders by distance then name', () => {
    const many = [
      { name: 'Ann', sessionName: 'c-t-ann' },
      { name: 'Ana', sessionName: 'c-t-ana' },
      { name: 'Ant', sessionName: 'c-t-ant' },
      { name: 'Anne', sessionName: 'c-t-anne' },
    ];
    const r = resolveSlackMentions('@anx', many, { maxSuggestions: 2 });
    expect(r.unknown[0].suggestions).toEqual(['Ana', 'Ann']);
  });

  it('dedupes the same agent mentioned via two aliases', () => {
    const r = resolveSlackMentions('@sam @crewly-alpha-sam', team);
    expect(r.mentions).toEqual(['crewly-alpha-sam']);
  });

  it('works with no candidates', () => {
    expect(resolveSlackMentions('@sam', [])).toEqual({
      mentions: [],
      unknown: [{ token: 'sam', suggestions: [] }],
    });
  });
});
