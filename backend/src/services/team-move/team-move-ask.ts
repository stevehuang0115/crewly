/**
 * "Ask the team to commit and push": the harness message that tells the
 * team's lead which repositories block a move and what to do about them. The
 * owner taps one button on their phone; the agent does the git work.
 *
 * @module services/team-move/team-move-ask
 */

import type { Team, TeamMember } from '../../types/index.js';
import { pickTeamLead } from '../../utils/team.utils.js';
import type { PreflightFinding, RepoPreflight } from './team-move.types.js';

/** Changed files named per repository in the message. */
const FILES_PER_REPO = 25;

/**
 * Who gets the request: the team's lead (the agent that owns the team's
 * work), or the first member when no lead is set.
 *
 * @param team - The team being moved
 * @returns The member, or null for a team without members
 */
export function pickAskRecipient(team: Team): TeamMember | null {
  return pickTeamLead(team);
}

/**
 * The message to the orchestrator and the team lead when a team arrived
 * without some of its project memory, or with credentials masked in it.
 *
 * @param teamName - The team that arrived
 * @param warnings - The memory sentences of the import report
 * @returns Message text
 */
export function buildMemoryNotice(teamName: string, warnings: readonly string[]): string {
  return [
    `[TEAM MOVE] Team "${teamName}" arrived on this machine, but some project memory is not here as it was on the source:`,
    '',
    ...warnings.map((w) => `- ${w}`),
    '',
    'Do not read an empty or small memory store as the whole history. Tell the owner once, and ask for the source folder to be kept until the missing memory is here.',
  ].join('\n');
}

/**
 * Whether a repository holds work that exists only on the source.
 *
 * @param repo - Repository as the preflight read it
 * @returns True when it has uncommitted changes or unpushed commits
 */
export function repoNeedsPush(repo: RepoPreflight): boolean {
  // A repository that travels in the package (git bundle) needs no push.
  if (repo.bundle?.possible && (repo.carry === null || repo.carry.possible)) return false;
  return repo.isRepo && (repo.modified > 0 || repo.untracked > 0 || repo.unpushed > 0);
}

/**
 * The message to the team lead.
 *
 * @param input - Team name, target machine and what the preflight found
 * @returns Message text, or null when there is nothing to ask for
 */
export function buildAskTeamMessage(input: { teamName: string; targetName: string; repos: readonly RepoPreflight[]; findings: readonly PreflightFinding[] }): string | null {
  const repos = input.repos.filter(repoNeedsPush);
  const findings = input.findings;
  if (repos.length === 0 && findings.length === 0) return null;

  const lines: string[] = [
    `[TEAM MOVE] The owner wants to move team "${input.teamName}" to ${input.targetName}. The move cannot start until the work below is safely in git. The owner is on a phone and cannot do this; please do it now. Do not message the owner about it unless something needs their decision.`,
    '',
  ];
  for (const repo of repos) {
    const parts: string[] = [];
    if (repo.modified > 0) parts.push(`${repo.modified} modified`);
    if (repo.untracked > 0) parts.push(`${repo.untracked} untracked`);
    if (repo.unpushed > 0) parts.push(`${repo.unpushed} commit${repo.unpushed === 1 ? '' : 's'} not pushed`);
    lines.push(`Repository "${repo.projectName}" (${repo.path})${repo.branch ? `, branch ${repo.branch}` : ''}: ${parts.join(', ')}.`);
    for (const file of repo.topFiles.slice(0, FILES_PER_REPO)) lines.push(`  - ${file.status}: ${file.path}`);
    if (repo.filesTruncated || repo.topFiles.length > FILES_PER_REPO) lines.push('  - ... more (run git status to see all of them)');
    if (repo.noRemote) lines.push('  This repository has no remote and is too large to be carried in the package: tell the owner in your reply that the code cannot reach the new machine until a remote exists.');
  }
  if (findings.length > 0) {
    lines.push('', 'The secret scan found credentials in these files. Remove the credential (use an environment variable or the settings store instead) or stop tracking the file:');
    for (const finding of findings.slice(0, FILES_PER_REPO)) lines.push(`  - ${finding.file}`);
  }
  lines.push(
    '',
    'What to do:',
    '1. Review each change with git status and git diff. Commit what belongs to the project with a clear message; add specific files, not git add -A.',
    '2. Machine-local or generated files (build output, caches, logs, editor folders, .env copies) must not be committed: add them to .gitignore instead, or delete them if they are junk.',
    '3. Never commit secrets, tokens, passwords or private keys. If a file holds one, remove it from the file first.',
    '4. Push the current branch to its remote (git push). Do not force-push and do not touch other branches.',
    '5. When everything is pushed, reply with one line saying what you committed and what you ignored. Crewly re-checks the repositories by itself.',
  );
  return lines.join('\n');
}
