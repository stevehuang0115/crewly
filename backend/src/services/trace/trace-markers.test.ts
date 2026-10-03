/**
 * Tests for run trace text helpers.
 */

import {
	appendTraceMarker,
	cleanTraceData,
	extractTextRefs,
	formatTraceMarker,
	parseTraceMarkers,
	safeSummary,
	skillLabel,
	stripTraceMarkers,
} from './trace-markers.js';

const T1 = 'tr-20261003-0123abcd';
const T2 = 'tr-20261003-89abcdef';

describe('trace markers', () => {
	it('formats and parses markers, de-duplicated and in order', () => {
		expect(formatTraceMarker(T1)).toBe(`[TRACE:${T1}]`);
		expect(parseTraceMarkers(`a [TRACE:${T2}] b [TRACE:${T1}] [TRACE:${T2}]`)).toEqual([T2, T1]);
		expect(parseTraceMarkers('[TRACE:not-an-id]')).toEqual([]);
	});

	it('appends the marker as the last line once', () => {
		expect(appendTraceMarker('hello', T1)).toBe(`hello\n[TRACE:${T1}]`);
		expect(appendTraceMarker(`hello\n[TRACE:${T1}]`, T1)).toBe(`hello\n[TRACE:${T1}]`);
		expect(appendTraceMarker('hello', null)).toBe('hello');
		expect(appendTraceMarker('hello', 'bogus')).toBe('hello');
	});

	it('strips markers from text going to the owner', () => {
		expect(stripTraceMarkers(`Done, the page is live.\n[TRACE:${T1}]`)).toBe('Done, the page is live.');
		expect(stripTraceMarkers(`Brief\n  Trace: [TRACE:${T1}]\nNext line`)).toBe('Brief\nNext line');
		expect(stripTraceMarkers(`a [TRACE:${T1}] b`)).toBe('a b');
		expect(stripTraceMarkers('nothing to strip\n')).toBe('nothing to strip\n');
	});

	it('extracts ids a delivered text refers to', () => {
		const text = '[TICKET:TKT-0012 9b1f0d1e-0000-4000-8000-000000000001] see WorkItem 2C2A1C55-1111-4111-8111-111111111111, CE-7 and [DECISION D-12]';
		const refs = extractTextRefs(text);
		expect(refs.requestIds).toEqual(['9b1f0d1e-0000-4000-8000-000000000001']);
		expect(refs.workItemIds).toContain('2c2a1c55-1111-4111-8111-111111111111');
		expect(refs.decisionIds).toEqual(['D-12']);
		expect(refs.ticketIds).toEqual(expect.arrayContaining(['TKT-0012', 'CE-7']));
		expect(refs.ticketIds).not.toContain('D-12');
	});

	it('summaries drop routing prefixes and markers, redact secrets and cut long bodies', () => {
		const s = safeSummary(`[CHAT:abc:12345678] [SLACK:C1:2.3] please use sk-ant-api03-${'x'.repeat(40)} now [TRACE:${T1}]`);
		expect(s.startsWith('please use')).toBe(true);
		expect(s).not.toContain('sk-ant-api03');
		expect(s).not.toContain('TRACE');
		expect(safeSummary('ran with GITHUB_TOKEN=abc123def456 and xoxb-123456789-abcdefghijkl')).toBe('ran with GITHUB_TOKEN=[REDACTED] and [REDACTED slack_token]');
		const long = safeSummary('word '.repeat(200));
		expect(long.length).toBeLessThanOrEqual(200);
		expect(long.endsWith('…')).toBe(true);
		expect(safeSummary(undefined)).toBe('');
	});

	it('keeps only small data values', () => {
		expect(cleanTraceData({ a: 1, b: true, c: 'x', d: '', e: Number.NaN, f: { nested: 1 } })).toEqual({ a: 1, b: true, c: 'x' });
		expect(cleanTraceData({ d: '' })).toBeUndefined();
		expect(cleanTraceData(undefined)).toBeUndefined();
	});

	it('labels skill calls by endpoint with ids normalised', () => {
		expect(skillLabel('post', '/task-pool/add')).toBe('POST /task-pool/add');
		expect(skillLabel('POST', '/terminal/dev-1/write?x=1')).toBe('POST /terminal/:session/write');
		expect(skillLabel('get', '/task-pool/2c2a1c55-1111-4111-8111-111111111111')).toBe('GET /task-pool/:id');
		expect(skillLabel('put', '/project-tickets/p/CE-7')).toBe('PUT /project-tickets/p/:id');
		expect(skillLabel('get', `/x/${T1}`)).toBe('GET /x/:id');
	});
});
