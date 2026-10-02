/**
 * ProjectRow — one project in the redesigned Projects list
 * (specs/2026-10-02-ui-redesign.md, simplify rules).
 *
 * One line (name), one quiet meta line ("75 of 78 tasks done · CE ·
 * updated 2h ago"), status as colour + word, and "⋯" for pin / archive.
 * The folder path is a detail-page fact, so it lives in the row's tooltip
 * and on the project page header, not in the list.
 *
 * @module components/Projects/ProjectRow
 */

import React from 'react';
import { Pin } from 'lucide-react';
import { CompactRow, StatusLabel, type OverflowMenuItem, type StatusTone } from '@crewly/ui';
import type { Project, Team } from '@/types';
import { formatRelativeTimeCompact } from '@/utils/time';

/** Task counts behind a project's progress line. */
export interface ProjectProgress {
  percent: number;
  total: number;
  open: number;
  inProgress: number;
  pending: number;
  done: number;
  blocked: number;
}

export interface ProjectRowProps {
  project: Project;
  /** Teams working on the project */
  assignedTeams?: Team[];
  /** Task counts (absent while loading) */
  progress?: ProjectProgress;
  onOpen: (projectId: string) => void;
  /** Mark the project completed; shown for projects that are not completed */
  onArchive?: (projectId: string) => void;
  isPinned?: boolean;
  onTogglePin?: () => void;
}

/** Project status → label + tone (same words the old cards used). */
export const PROJECT_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  active: { label: 'Running', tone: 'success' },
  paused: { label: 'Idle', tone: 'neutral' },
  stopped: { label: 'Idle', tone: 'neutral' },
  completed: { label: 'Completed', tone: 'primary' },
  blocked: { label: 'Blocked', tone: 'danger' },
};

/**
 * Status label for a project status.
 *
 * @param status - Project status from the API
 * @returns Label and tone (unknown statuses read as Running, like before)
 */
export function projectStatus(status: string): { label: string; tone: StatusTone } {
  return PROJECT_STATUS[status] ?? PROJECT_STATUS.active;
}

/**
 * The progress part of the meta line.
 *
 * @param progress - Task counts
 * @returns e.g. "75 of 78 tasks done", "No tasks yet"
 */
export function progressText(progress?: ProjectProgress): string | null {
  if (!progress) return null;
  if (progress.total === 0) return 'No tasks yet';
  return `${progress.done} of ${progress.total} tasks done`;
}

/**
 * Compact project row.
 *
 * @param props - {@link ProjectRowProps}
 * @returns The row
 */
export const ProjectRow: React.FC<ProjectRowProps> = ({
  project,
  assignedTeams = [],
  progress,
  onOpen,
  onArchive,
  isPinned = false,
  onTogglePin,
}) => {
  const status = projectStatus(project.status);
  const done = progressText(progress);
  const teamNames = assignedTeams.map((t) => t.name).join(', ');
  const memberNames = assignedTeams.flatMap((t) => t.members ?? []).map((m) => m.name).join(', ');
  const breakdown = progress
    ? `Open: ${progress.open}, In progress: ${progress.inProgress}, Pending: ${progress.pending}, Done: ${progress.done}, Blocked: ${progress.blocked}`
    : undefined;

  const parts: React.ReactNode[] = [];
  if (done) parts.push(<span key="p" title={breakdown}>{done}</span>);
  parts.push(<span key="t" title={memberNames ? `Members: ${memberNames}` : undefined}>{teamNames || 'No team yet'}</span>);
  parts.push(<span key="u" title={`Updated ${new Date(project.updatedAt).toLocaleString()}`}>updated {formatRelativeTimeCompact(project.updatedAt)}</span>);

  const overflow: OverflowMenuItem[] = [
    { label: 'Open project', onClick: () => onOpen(project.id) },
    ...(onTogglePin ? [{ label: isPinned ? 'Unpin from favorites' : 'Pin to favorites', onClick: onTogglePin }] : []),
    ...(onArchive && project.status !== 'completed' ? [{ label: 'Archive', onClick: () => onArchive(project.id), separator: true }] : []),
  ];

  return (
    <CompactRow
      data-testid={`project-row-${project.id}`}
      onClick={() => onOpen(project.id)}
      primary={
        <span className="inline-flex min-w-0 items-center gap-2" title={project.path}>
          <span className="truncate">{project.name}</span>
          {isPinned && <Pin className="h-3.5 w-3.5 shrink-0 text-text-3" aria-label="Pinned" />}
        </span>
      }
      meta={parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="text-text-3"> · </span>}
          {p}
        </React.Fragment>
      ))}
      trailing={<StatusLabel tone={status.tone}>{status.label}</StatusLabel>}
      overflow={overflow}
      overflowLabel={`More actions for ${project.name}`}
    />
  );
};

export default ProjectRow;
