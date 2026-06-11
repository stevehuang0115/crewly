/**
 * Tests for the web_search tool.
 *
 * @module services/agent/crewly-agent/web-search.tool.test
 */

import { describe, it, expect, vi } from 'vitest';
import { createWebSearchTool, formatAsMarkdown } from './web-search.tool.js';
import { CloudNotLoggedInError, type CloudConfig } from './cloud-config.js';

const config: CloudConfig = {
  cloudUrl: 'https://api.crewlyai.com',
  token: 'fake-jwt',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('formatAsMarkdown', () => {
  it('returns just the answer when there are no sources', () => {
    expect(formatAsMarkdown('hello\n', [])).toBe('hello');
  });

  it('appends a numbered Sources list', () => {
    const out = formatAsMarkdown('Some answer.', [
      { title: 'Title A', url: 'https://a.com', snippet: '' },
      { title: 'Title B', url: 'https://b.com', snippet: '' },
    ]);
    expect(out).toBe(
      'Some answer.\n\nSources:\n[1] Title A — https://a.com\n[2] Title B — https://b.com',
    );
  });

  it('falls back to url when title is missing', () => {
    const out = formatAsMarkdown('a', [{ title: '', url: 'https://x.com', snippet: '' }]);
    expect(out.endsWith('[1] https://x.com — https://x.com')).toBe(true);
  });
});

describe('createWebSearchTool', () => {
  it('returns CloudNotLoggedInError as a structured failure (does not throw)', async () => {
    const tool = createWebSearchTool({
      loadConfig: () => Promise.reject(new CloudNotLoggedInError()),
    });
    const result = (await tool.execute({ query: 'hi' })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Crewly Cloud is not connected/);
  });

  it('sends the query + bearer token to the configured endpoint', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        answer: 'answer text',
        sources: [{ title: 'A', url: 'https://a.com', snippet: '' }],
      }),
    );
    const tool = createWebSearchTool({
      loadConfig: () => Promise.resolve(config),
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    const result = (await tool.execute({ query: 'what is X', max_results: 3 })) as {
      success: boolean;
      result?: string;
    };

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.crewlyai.com/api/v1/search');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer fake-jwt');
    expect(JSON.parse(init.body)).toEqual({ query: 'what is X', max_results: 3 });

    expect(result.success).toBe(true);
    expect(result.result).toContain('answer text');
    expect(result.result).toContain('[1] A — https://a.com');
  });

  it('omits max_results from body when not provided', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, answer: 'ok', sources: [] }),
    );
    const tool = createWebSearchTool({
      loadConfig: () => Promise.resolve(config),
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await tool.execute({ query: 'hi' });
    expect(JSON.parse(fetchSpy.mock.calls[0]![1].body)).toEqual({ query: 'hi' });
  });

  it('returns a structured error on non-2xx response', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ success: false, error: 'bad query' }, 400),
    );
    const tool = createWebSearchTool({
      loadConfig: () => Promise.resolve(config),
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const result = (await tool.execute({ query: 'hi' })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Search backend returned 400.*bad query/);
  });

  it('returns a structured error on fetch failure', async () => {
    const tool = createWebSearchTool({
      loadConfig: () => Promise.resolve(config),
      fetchImpl: (() => Promise.reject(new Error('network down'))) as unknown as typeof fetch,
    });
    const result = (await tool.execute({ query: 'hi' })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/network down/);
  });

  it('reports when the backend returns success:false', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ success: false, error: 'quota exhausted' }, 200),
    );
    const tool = createWebSearchTool({
      loadConfig: () => Promise.resolve(config),
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const result = (await tool.execute({ query: 'hi' })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/quota exhausted/);
  });
});
