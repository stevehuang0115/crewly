/**
 * CLI Team Export/Import — a team as one portable, secret-free JSON package.
 *
 *   crewly team export <team> [--out <file>] [--json]
 *   crewly team import <file> [--json]
 *
 * Talks to this machine's backend (`/api/teams/:id/export`,
 * `/api/teams/import`, issue #880). The package holds the team's config,
 * member prompts, norms and schedules; running state is stripped, secrets
 * are masked and the connectors the team uses are listed for reconnecting.
 *
 * @module cli/commands/team-export
 */

import chalk from 'chalk';
import fs from 'fs/promises';
import * as path from 'path';
import { DEFAULT_WEB_PORT } from '../constants.js';

/** Options of `crewly team export`. */
export interface TeamExportOptions {
  /** File to write; default `crewly-team-<slug>-<date>.json` in the current directory. */
  out?: string;
  /** Print the backend's answer as JSON instead of a summary. */
  json?: boolean;
}

/** Options of `crewly team import`. */
export interface TeamImportOptions {
  /** Print JSON. */
  json?: boolean;
}

/** Output sink (injectable for tests). */
export type Print = (line: string) => void;

/** `fetch` signature (injectable for tests). */
export type Fetch = typeof fetch;

/** The package as the backend builds it (fields this command reads). */
interface TeamPackage {
  version: string;
  exportedAt: string;
  team: { id: string; name: string; members?: unknown[] };
  prompts?: Record<string, string>;
  norms?: Record<string, string>;
  cronTasks?: unknown[];
  portability?: { redactions: number; scanClean: boolean; connectors: string[]; strippedFields: string[] };
}

/** The backend's import result (fields this command reads). */
interface ImportResult {
  team: { id: string; name: string };
  promptsImported: number;
  normsImported: number;
  cronTasksImported: number;
  connectorsToReconnect?: string[];
}

/** A team as `GET /api/teams` lists it (fields this command reads). */
interface TeamSummary {
  id: string;
  name: string;
}

/** A parsed backend answer. */
interface Answer {
  ok: boolean;
  status: number;
  json: Record<string, unknown>;
}

/**
 * Call the local backend.
 *
 * @param fetchImpl - fetch
 * @param method - HTTP method
 * @param apiPath - Path under /api
 * @param body - JSON body
 * @returns Parsed answer
 */
async function call(fetchImpl: Fetch, method: string, apiPath: string, body?: unknown): Promise<Answer> {
  const port = process.env['WEB_PORT'] ?? String(DEFAULT_WEB_PORT);
  const res = await fetchImpl(`http://localhost:${port}/api${apiPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok && json['success'] !== false, status: res.status, json };
}

/**
 * The one line to show for a failed call.
 *
 * @param res - Answer
 * @returns Message
 */
function errorLine(res: Answer): string {
  return String(res.json['message'] ?? res.json['error'] ?? `Request failed (HTTP ${res.status})`);
}

/**
 * Wrap a connection failure the way a failed answer looks.
 *
 * @param error - Thrown by fetch
 * @returns A failed answer
 */
function notRunning(error: unknown): Answer {
  return { ok: false, status: 0, json: { error: `Crewly is not running here (${error instanceof Error ? error.message : String(error)})` } };
}

/**
 * Resolve a team name (case-insensitive) or id to its id.
 *
 * @param fetchImpl - fetch
 * @param team - Name or id
 * @returns The team, or an error message
 */
async function resolveTeam(fetchImpl: Fetch, team: string): Promise<{ team?: TeamSummary; error?: string }> {
  if (/^[0-9a-f-]{36}$/i.test(team)) return { team: { id: team, name: team } };
  const res = await call(fetchImpl, 'GET', '/teams');
  if (!res.ok) return { error: errorLine(res) };
  const teams = (res.json['data'] ?? []) as TeamSummary[];
  const exact = teams.find((t) => t.name === team) ?? teams.find((t) => t.name.toLowerCase() === team.toLowerCase());
  if (exact) return { team: exact };
  const byId = teams.find((t) => t.id === team);
  if (byId) return { team: byId };
  return { error: `No team named "${team}". Teams here: ${teams.map((t) => t.name).join(', ') || '(none)'}` };
}

/**
 * Default file name of a package: `crewly-team-<slug>-<YYYY-MM-DD>.json`.
 *
 * @param teamName - Team name
 * @param exportedAt - ISO timestamp of the export
 * @returns File name
 */
export function defaultPackageFileName(teamName: string, exportedAt: string): string {
  const slug = teamName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team';
  return `crewly-team-${slug}-${exportedAt.slice(0, 10)}.json`;
}

/**
 * `crewly team export <team>`: write the team's package to a file and say what is in it.
 *
 * @param team - Team name or id
 * @param options - Flags
 * @param print - Output sink
 * @param fetchImpl - fetch (tests)
 * @returns Exit code
 */
export async function teamExportCommand(team: string, options: TeamExportOptions, print: Print = (l) => console.log(l), fetchImpl: Fetch = fetch): Promise<number> {
  let resolved: { team?: TeamSummary; error?: string };
  try {
    resolved = await resolveTeam(fetchImpl, team);
  } catch (error) {
    print(chalk.red(errorLine(notRunning(error))));
    return 1;
  }
  if (!resolved.team) {
    print(chalk.red(resolved.error ?? 'Team not found'));
    return 1;
  }
  const res = await call(fetchImpl, 'GET', `/teams/${encodeURIComponent(resolved.team.id)}/export`).catch(notRunning);
  if (!res.ok) {
    print(chalk.red(errorLine(res)));
    return 1;
  }
  const pkg = res.json['data'] as TeamPackage;
  const file = path.resolve(options.out ?? defaultPackageFileName(pkg.team.name, pkg.exportedAt));
  await fs.writeFile(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  if (options.json) {
    print(JSON.stringify({ file, ...pkg }, null, 2));
    return 0;
  }
  const p = pkg.portability;
  print(chalk.green(`Exported ${pkg.team.name} to ${file}`));
  print(`  members: ${pkg.team.members?.length ?? 0}, prompts: ${Object.keys(pkg.prompts ?? {}).length}, norms: ${Object.keys(pkg.norms ?? {}).length}, schedules: ${pkg.cronTasks?.length ?? 0}`);
  if (p) {
    print(`  secrets masked: ${p.redactions}; final scan ${p.scanClean ? 'clean' : chalk.yellow('found something left — open the file before sharing it')}`);
    print(`  connectors to reconnect after import: ${p.connectors.length ? p.connectors.join(', ') : 'none'}`);
    print('  running state (sessions, status, tickets in hand) was left out; no grants or tokens are in the file.');
  }
  print('Import it elsewhere with `crewly team import <file>`.');
  return p && !p.scanClean ? 2 : 0;
}

/**
 * `crewly team import <file>`: recreate a team from a package.
 *
 * @param file - Package file (as written by `crewly team export`, or a saved API answer)
 * @param options - Flags
 * @param print - Output sink
 * @param fetchImpl - fetch (tests)
 * @returns Exit code
 */
export async function teamImportCommand(file: string, options: TeamImportOptions = {}, print: Print = (l) => console.log(l), fetchImpl: Fetch = fetch): Promise<number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path.resolve(file), 'utf8'));
  } catch (error) {
    print(chalk.red(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`));
    return 1;
  }
  const pkg = (parsed && typeof parsed === 'object' && 'data' in (parsed as Record<string, unknown>) ? (parsed as { data: unknown }).data : parsed) as Partial<TeamPackage> | null;
  if (!pkg || typeof pkg !== 'object' || !pkg.version || !pkg.team) {
    print(chalk.red(`${file} is not a Crewly team package (expected version and team).`));
    return 1;
  }
  const res = await call(fetchImpl, 'POST', '/teams/import', pkg).catch(notRunning);
  if (options.json) {
    print(JSON.stringify(res.json, null, 2));
    return res.ok ? 0 : 1;
  }
  if (!res.ok) {
    print(chalk.red(errorLine(res)));
    return 1;
  }
  const result = res.json['data'] as ImportResult;
  print(chalk.green(`Imported ${result.team.name} (${result.team.id})`));
  print(`  prompts: ${result.promptsImported}, norms: ${result.normsImported}, schedules: ${result.cronTasksImported}`);
  const reconnect = result.connectorsToReconnect ?? [];
  if (reconnect.length) print(chalk.yellow(`  reconnect on this machine: ${reconnect.join(', ')} (Settings › Connectors)`));
  print('Members are inactive; start them from the team page or the CLI when you are ready.');
  return 0;
}
