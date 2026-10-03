/**
 * Tests for the seo-ops metric fetcher (issue #986).
 */
import path from 'path';
import { createSeoOpsMetricFetcher, execProgram, jsonErrors, metricArgs, parseMetricOutput } from './seo-ops-metric.fetcher.js';
import type { ExperimentMetric } from '../../types/experiment.types.js';

const GSC: ExperimentMetric = { source: 'gsc', measure: 'clicks', config: '/cfg/ce.json', page: 'https://visa.example.com/', query: 'h1b' };

describe('metricArgs', () => {
  it('builds the seo-ops command line', () => {
    expect(metricArgs(GSC, { start: '2026-09-01', end: '2026-09-14' })).toEqual([
      '--config', '/cfg/ce.json', 'metric', '--source', 'gsc', '--measure', 'clicks', '--start', '2026-09-01', '--end', '2026-09-14',
      '--page', 'https://visa.example.com/', '--page-match', 'exact', '--query', 'h1b', '--query-match', 'exact',
    ]);
    expect(metricArgs({ source: 'ga4', measure: 'events', config: '/c.json', event: 'generate_lead', channel: 'all' }, { start: 'a', end: 'b' }).slice(-4)).toEqual([
      '--event', 'generate_lead', '--channel', 'all',
    ]);
  });
});

describe('parseMetricOutput', () => {
  it('reads totals and days', () => {
    const out = parseMetricOutput(JSON.stringify({
      start: '2026-09-01', end: '2026-09-02', total: 0.05, volume: 200, clicks: 10, impressions: 200,
      days: [{ date: '2026-09-01', value: 0.05, volume: 200, clicks: 10, impressions: 200 }, { date: '2026-09-02', value: null, volume: 0 }],
    }), 'T');
    expect(out).toEqual({
      start: '2026-09-01', end: '2026-09-02', total: 0.05, volume: 200, clicks: 10, impressions: 200, fetchedAt: 'T',
      days: [{ date: '2026-09-01', value: 0.05, volume: 200, clicks: 10, impressions: 200 }, { date: '2026-09-02', value: null, volume: 0 }],
    });
  });

  it('rejects non-JSON and incomplete output', () => {
    expect(() => parseMetricOutput('oops', 'T')).toThrow('not JSON');
    expect(() => parseMetricOutput('{"start":"a"}', 'T')).toThrow('missing');
  });

  it('rejects output that carries errors', () => {
    expect(() => parseMetricOutput(JSON.stringify({ schemaVersion: 1, start: 'a', end: 'b', days: [], errors: [{ message: 'HTTP 403', code: 3 }] }), 'T')).toThrow('seo-ops metric failed: HTTP 403');
    expect(parseMetricOutput(JSON.stringify({ schemaVersion: 1, start: 'a', end: 'b', total: 1, volume: 1, days: [], errors: [] }), 'T').total).toBe(1);
  });

  it('jsonErrors', () => {
    expect(jsonErrors('{"errors":[{"message":"a"},{"message":"b"}]}')).toBe('a; b');
    expect(jsonErrors('{"errors":[]}')).toBe('');
    expect(jsonErrors('nope')).toBe('');
  });
});

describe('createSeoOpsMetricFetcher', () => {
  it('runs the bundled script with python and parses the result', async () => {
    const run = jest.fn().mockResolvedValue(JSON.stringify({ start: 'a', end: 'b', total: 3, volume: 3, days: [] }));
    const fetch = createSeoOpsMetricFetcher({ packageRoot: '/pkg', run, now: () => new Date('2026-10-03T00:00:00Z') });
    const m = await fetch(GSC, { start: 'a', end: 'b' });
    expect(m.total).toBe(3);
    expect(m.fetchedAt).toBe('2026-10-03T00:00:00.000Z');
    expect(run).toHaveBeenCalledWith('python3', [path.join('/pkg', 'config/skills/agent/marketplace/seo-ops/seo_ops.py'), ...metricArgs(GSC, { start: 'a', end: 'b' })], 120000);
  });

  it('execProgram surfaces stderr on failure and stdout on success', async () => {
    await expect(execProgram(process.execPath, ['-e', 'console.error("seo-ops: no creds"); process.exit(2)'], 10000)).rejects.toThrow('seo-ops: no creds');
    await expect(execProgram(process.execPath, ['-e', 'process.stdout.write("ok")'], 10000)).resolves.toBe('ok');
    // No stderr: the JSON errors on stdout are the message.
    await expect(execProgram(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({errors:[{message:"HTTP 429"}]})); process.exit(1)'], 10000)).rejects.toThrow('HTTP 429');
  });
});
