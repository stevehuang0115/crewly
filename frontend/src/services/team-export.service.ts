/**
 * Team package API client (`/api/teams/:id/export`, `/api/teams/import`;
 * specs/2026-10-25-team-export-portable.md, issue #880).
 *
 * A package is one JSON file holding a team's config, member prompts, norms
 * and schedules with the running state stripped and secrets masked. The
 * dashboard downloads one from a team row's menu and imports one from the
 * Teams toolbar. Calls from the dashboard carry the owner identity, which
 * both endpoints require.
 *
 * @module services/team-export.service
 */

/** Paths of the team package API. */
export const TEAM_EXPORT_API = {
  /** Export of one team */
  exportPath: (teamId: string): string => `/api/teams/${encodeURIComponent(teamId)}/export`,
  /** Import */
  importPath: '/api/teams/import',
  /** Accepted import file types */
  accept: 'application/json,.json',
} as const;

/** What made the package portable. */
export interface TeamPackagePortability {
  redactions: number;
  scanClean: boolean;
  connectors: string[];
  strippedFields: string[];
}

/** A team package as the backend builds it (the fields the dashboard reads). */
export interface TeamPackage {
  version: string;
  exportedAt: string;
  team: { id: string; name: string; members?: unknown[] };
  prompts?: Record<string, string>;
  norms?: Record<string, string>;
  cronTasks?: unknown[];
  portability?: TeamPackagePortability;
}

/** The backend's answer to an import. */
export interface TeamImportResult {
  team: { id: string; name: string };
  promptsImported: number;
  normsImported: number;
  cronTasksImported: number;
  connectorsToReconnect?: string[];
}

/** Error from the team package API. */
export class TeamPackageApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'TeamPackageApiError';
  }
}

interface Envelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/**
 * Run a request and unwrap the `{ success, data }` envelope.
 *
 * @param url - URL
 * @param init - fetch options
 * @returns `data`
 * @throws TeamPackageApiError on a non-2xx status or `success: false`
 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  let body: Envelope<T> = {};
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    body = {};
  }
  if (!res.ok || body.success === false) throw new TeamPackageApiError(body.message || body.error || `HTTP ${res.status}`, res.status);
  return body.data as T;
}

/**
 * Fetch a team's package.
 *
 * @param teamId - Team id
 * @returns The package
 * @throws TeamPackageApiError when the backend refuses (not the owner, unknown team)
 */
export async function fetchTeamPackage(teamId: string): Promise<TeamPackage> {
  return request<TeamPackage>(TEAM_EXPORT_API.exportPath(teamId));
}

/**
 * File name of a package: `crewly-team-<slug>-<YYYY-MM-DD>.json` (same as the CLI).
 *
 * @param teamName - Team name
 * @param exportedAt - ISO timestamp of the export
 * @returns File name
 */
export function packageFileName(teamName: string, exportedAt: string): string {
  const slug = teamName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team';
  return `crewly-team-${slug}-${exportedAt.slice(0, 10)}.json`;
}

/** Hands a file to the browser's download flow. */
export type DownloadFn = (fileName: string, content: string) => void;

/**
 * Default download: a Blob behind a clicked anchor.
 *
 * @param fileName - File name
 * @param content - File content
 */
export const browserDownload: DownloadFn = (fileName, content) => {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

/**
 * Fetch a team's package and save it as a file.
 *
 * @param teamId - Team id
 * @param download - Download implementation (tests)
 * @returns The package and the file name it was saved under
 * @throws TeamPackageApiError when the backend refuses
 */
export async function downloadTeamPackage(teamId: string, download: DownloadFn = browserDownload): Promise<{ pkg: TeamPackage; fileName: string }> {
  const pkg = await fetchTeamPackage(teamId);
  const fileName = packageFileName(pkg.team.name, pkg.exportedAt);
  download(fileName, JSON.stringify(pkg, null, 2) + '\n');
  return { pkg, fileName };
}

/**
 * One paragraph on what a package holds and what it left out.
 *
 * @param pkg - Package
 * @returns Text for the confirmation dialog
 */
export function describePackage(pkg: TeamPackage): string {
  const n = (c: number, word: string): string => `${c} ${word}${c === 1 ? '' : 's'}`;
  const parts = [
    `${n(pkg.team.members?.length ?? 0, 'member')}, ${n(Object.keys(pkg.prompts ?? {}).length, 'prompt')}, ${n(Object.keys(pkg.norms ?? {}).length, 'norm')}, ${n(pkg.cronTasks?.length ?? 0, 'schedule')}.`,
  ];
  const p = pkg.portability;
  if (p) {
    parts.push(`Secrets masked: ${p.redactions}; final scan ${p.scanClean ? 'clean' : 'found something left — open the file before sharing it'}.`);
    parts.push(`Reconnect after import: ${p.connectors.length ? p.connectors.join(', ') : 'nothing'}.`);
  }
  parts.push('Running state and credentials are not in the file.');
  return parts.join(' ');
}

/**
 * Read a package file chosen by the owner. A saved API answer
 * (`{ success, data }`) is unwrapped.
 *
 * @param file - The chosen file
 * @returns The package
 * @throws Error when the file is not JSON or not a team package
 */
export async function readTeamPackageFile(file: File): Promise<TeamPackage> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error(`${file.name} is not a JSON file.`);
  }
  const pkg = (parsed && typeof parsed === 'object' && 'data' in (parsed as Record<string, unknown>) ? (parsed as { data: unknown }).data : parsed) as Partial<TeamPackage> | null;
  if (!pkg || typeof pkg !== 'object' || typeof pkg.version !== 'string' || !pkg.team || typeof pkg.team !== 'object') {
    throw new Error(`${file.name} is not a Crewly team package (expected version and team).`);
  }
  return pkg as TeamPackage;
}

/**
 * Import a package. Members come in inactive.
 *
 * @param pkg - Package
 * @returns Import result
 * @throws TeamPackageApiError when the backend refuses (unsupported version, not the owner)
 */
export async function importTeamPackage(pkg: TeamPackage): Promise<TeamImportResult> {
  return request<TeamImportResult>(TEAM_EXPORT_API.importPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pkg),
  });
}

/**
 * One paragraph on what an import created and what the owner must reconnect.
 *
 * @param result - Import result
 * @returns Text for the confirmation dialog
 */
export function describeImport(result: TeamImportResult): string {
  const n = (c: number, word: string): string => `${c} ${word}${c === 1 ? '' : 's'}`;
  const parts = [`${n(result.promptsImported, 'prompt')}, ${n(result.normsImported, 'norm')}, ${n(result.cronTasksImported, 'schedule')}. Members are inactive until you start them.`];
  const reconnect = result.connectorsToReconnect ?? [];
  if (reconnect.length) parts.push(`Reconnect on this machine: ${reconnect.join(', ')} (Settings › Connectors).`);
  return parts.join(' ');
}
