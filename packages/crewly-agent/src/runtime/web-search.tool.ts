/**
 * `web_search` tool — Crewly cloud-backed web search.
 *
 * Models like DeepSeek that lack a built-in search capability call this tool
 * to delegate the search to the Crewly cloud service, which hits Gemini +
 * Google Search and returns a synthesized answer with cited sources. The
 * tool formats the response as markdown with a numbered Sources footer so
 * the model can naturally inline citations like [1][2].
 *
 * Claude Code / Gemini CLI / Codex runtimes have their own search and won't
 * be wired through this — this tool only ships in the Crewly agent runtime.
 *
 * @module services/agent/crewly-agent/web-search.tool
 */

import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { CloudNotLoggedInError, type CloudConfig } from './cloud-config.js';

const SEARCH_PATH = '/api/v1/search';
/** The local backend's proxy for Cloud search (it holds the Cloud token; agents never see it). */
const BACKEND_SEARCH_PATH = '/api/cloud/search';
const DEFAULT_TIMEOUT_MS = 30_000;

interface SearchSource {
  title: string;
  url: string;
  snippet: string;
}

interface SearchResponse {
  success: boolean;
  answer?: string;
  sources?: SearchSource[];
  error?: string;
}

/** Injectable IO for tests. */
export interface WebSearchDeps {
  /**
   * Direct mode: read the Cloud token and call Cloud. Only for tests and
   * tools outside an agent. Without it the tool goes through the local
   * backend (specs/2026-10-04-agent-credential-isolation.md): the Cloud
   * credentials are sealed and are not available to agents.
   */
  loadConfig?: () => Promise<CloudConfig>;
  /** Backend base URL for the default mode (default CREWLY_API_URL or http://localhost:8787). */
  apiBaseUrl?: string;
  /** Environment for the agent's session + badge headers (default process.env). */
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createWebSearchTool(deps: WebSearchDeps = {}): ToolDefinition {
  const loadConfig = deps.loadConfig;
  const env = deps.env ?? process.env;
  const apiBaseUrl = (deps.apiBaseUrl ?? env.CREWLY_API_URL ?? 'http://localhost:8787').replace(/\/$/, '');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    description:
      'Search the web. Returns a synthesized answer plus a numbered list of cited sources. Use it whenever the user asks about current events, third-party documentation, package versions, or anything that may have changed since training. Inline-cite sources as [1][2] in your reply.',
    inputSchema: z.object({
      query: z.string().min(1).describe('The search query in natural language.'),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Maximum number of cited sources to return (1-10, default 5).'),
    }),
    execute: async (args) => {
      const { query, max_results } = args as { query: string; max_results?: number };

      let url: string;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (loadConfig) {
        let config: CloudConfig;
        try {
          config = await loadConfig();
        } catch (err) {
          if (err instanceof CloudNotLoggedInError) {
            return { success: false, error: err.message };
          }
          throw err;
        }
        url = `${config.cloudUrl}${SEARCH_PATH}`;
        headers.Authorization = `Bearer ${config.token}`;
      } else {
        // Through the backend, identified by this agent's session + badge.
        url = `${apiBaseUrl}${BACKEND_SEARCH_PATH}`;
        if (env.CREWLY_SESSION_NAME) headers['X-Agent-Session'] = env.CREWLY_SESSION_NAME;
        if (env.CREWLY_AGENT_BADGE) headers['X-Agent-Badge'] = env.CREWLY_AGENT_BADGE;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let resp: Response;
      try {
        resp = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(
            max_results !== undefined ? { query, max_results } : { query },
          ),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Search request failed: ${message}` };
      }
      clearTimeout(timer);

      if (!resp.ok) {
        let body: SearchResponse | null = null;
        try {
          body = (await resp.json()) as SearchResponse;
        } catch {
          /* not JSON — fall through */
        }
        const detail = body?.error || resp.statusText;
        return { success: false, error: `Search backend returned ${resp.status}: ${detail}` };
      }

      const body = (await resp.json()) as SearchResponse;
      if (!body.success || typeof body.answer !== 'string') {
        return { success: false, error: body.error || 'Search returned no answer.' };
      }

      const sources = Array.isArray(body.sources) ? body.sources : [];
      return {
        success: true,
        result: formatAsMarkdown(body.answer, sources),
        sourceCount: sources.length,
      };
    },
  };
}

/**
 * Format `answer` + `sources` as a single markdown block ready to drop into
 * the model's context: synthesized answer followed by a numbered Sources
 * section. The model can inline [1][2] back-references.
 *
 * Exported for unit testing.
 */
export function formatAsMarkdown(answer: string, sources: readonly SearchSource[]): string {
  if (sources.length === 0) return answer.trim();

  const numbered = sources
    .map((s, i) => {
      const title = s.title?.trim() || s.url;
      return `[${i + 1}] ${title} — ${s.url}`;
    })
    .join('\n');

  return `${answer.trim()}\n\nSources:\n${numbered}`;
}
