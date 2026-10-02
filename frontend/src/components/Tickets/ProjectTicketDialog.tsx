/**
 * ProjectTicketDialog — the New ticket form and a project ticket's editor
 * (specs/2026-09-28-project-tickets.md), used by the Tickets board.
 *
 * Create: title, project (unless the board is locked to one), priority,
 * status (Backlog / Ready), labels, description, acceptance criteria and
 * "I review it myself". Edit: the same fields with the allowed status moves,
 * plus assigning a team member (which starts the work), the ticket's file,
 * its run and the last log lines.
 *
 * @module components/Tickets/ProjectTicketDialog
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, FormPopup, FormGroup, FormLabel, FormInput, FormTextarea, FormHelp } from '@crewly/ui';
import { Alert } from '@crewly/ui/Alert';
import { FormSelect } from '@crewly/ui/Form';
import type { Team } from '../../types';
import type { ProjectTicket, ProjectTicketPriority, ProjectTicketStatus } from '../../types/project-ticket.types';
import {
  DEFAULT_PROJECT_TICKET_PRIORITY,
  PROJECT_TICKET_PRIORITIES,
  PROJECT_TICKET_STATUS_LABELS,
  PROJECT_TICKET_TRANSITIONS,
} from '../../constants/project-tickets.constants';
import { LINKS } from '../../constants/routes.constants';
import { assignProjectTicket, createProjectTicket, updateProjectTicket } from '../../services/project-tickets.service';
import { formatAcceptance, parseAcceptance, parseLabels, type BoardProject } from './board.utils';

/** Props for {@link ProjectTicketDialog}. */
export interface ProjectTicketDialogProps {
  open: boolean;
  /** The ticket to edit; null opens the New ticket form */
  ticket: ProjectTicket | null;
  /** The edited ticket's project, or the project a new ticket is locked to */
  projectId?: string;
  /** Projects a new ticket can go to (ignored when `projectId` is set) */
  projects: BoardProject[];
  /** Teams (assignee choices: members of the project's teams) */
  teams: Team[];
  onClose: () => void;
  /** Called after a successful create / save / assign */
  onSaved: () => void;
}

/** Editable form state. */
interface TicketForm {
  title: string;
  project: string;
  priority: ProjectTicketPriority;
  status: ProjectTicketStatus;
  labels: string;
  description: string;
  acceptance: string;
  ownerReview: boolean;
}

/**
 * Render the dialog.
 *
 * @param props - {@link ProjectTicketDialogProps}
 * @returns The dialog
 */
export const ProjectTicketDialog: React.FC<ProjectTicketDialogProps> = ({
  open,
  ticket,
  projectId,
  projects,
  teams,
  onClose,
  onSaved,
}) => {
  const creating = ticket === null;
  const [form, setForm] = useState<TicketForm>(() => emptyForm(projectId ?? projects[0]?.id ?? ''));
  const [assignee, setAssignee] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (ticket) {
      setAssignee(ticket.assignee ?? '');
      setForm({
        title: ticket.title,
        project: projectId ?? '',
        priority: ticket.priority,
        status: ticket.status,
        labels: ticket.labels.join(', '),
        description: ticket.description,
        acceptance: formatAcceptance(ticket.acceptance),
        ownerReview: ticket.ownerReview,
      });
    } else {
      setForm(emptyForm(projectId ?? projects[0]?.id ?? ''));
    }
    // Reset only when the dialog opens or switches ticket (not on every projects change).
  }, [open, ticket]);

  // Projects may arrive after the form opened: preselect the first one.
  useEffect(() => {
    if (open && creating && !projectId && !form.project && projects.length > 0) {
      setForm((f) => ({ ...f, project: projects[0].id }));
    }
  }, [open, creating, projectId, form.project, projects]);

  const targetProject = projectId ?? form.project;

  const members = useMemo(() => {
    const own = teams.filter((t) => (t.projectIds ?? []).includes(targetProject));
    return (own.length > 0 ? own : teams).flatMap((team) =>
      (team.members ?? []).map((m) => ({ value: m.sessionName, label: `${m.name} (${team.name})` })),
    );
  }, [teams, targetProject]);

  /**
   * Run a call, then close and refresh, or show the error.
   *
   * @param fn - The call
   */
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await fn();
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setSaving(false);
    }
  };

  const submit = (): void => {
    if (creating) {
      void run(() =>
        createProjectTicket(targetProject, {
          title: form.title,
          priority: form.priority,
          status: form.status,
          labels: parseLabels(form.labels),
          description: form.description,
          acceptance: parseAcceptance(form.acceptance).map((c) => c.text),
          ownerReview: form.ownerReview,
        }),
      );
      return;
    }
    if (!ticket || !projectId) return;
    void run(() =>
      updateProjectTicket(projectId, ticket.id, {
        title: form.title,
        priority: form.priority,
        labels: parseLabels(form.labels),
        description: form.description,
        acceptance: parseAcceptance(form.acceptance, ticket.acceptance),
        ownerReview: form.ownerReview,
        ...(form.status !== ticket.status ? { status: form.status } : {}),
      }),
    );
  };

  const submitAssign = (): void => {
    if (!ticket || !projectId || !assignee) return;
    void run(() => assignProjectTicket(projectId, ticket.id, assignee));
  };

  const statusChoices: ProjectTicketStatus[] = ticket
    ? [ticket.status, ...PROJECT_TICKET_TRANSITIONS[ticket.status]]
    : ['backlog', 'ready'];

  return (
    <FormPopup
      isOpen={open}
      onClose={onClose}
      onSubmit={submit}
      title={ticket ? `${ticket.id}: ${ticket.title}` : 'New ticket'}
      submitText={creating ? 'Create ticket' : 'Save'}
      loading={saving}
      submitDisabled={!form.title.trim() || !targetProject}
      size={creating ? undefined : 'lg'}
    >
      {error && (
        <Alert variant="error" size="sm" className="mb-3" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <FormGroup>
        <div>
          <FormLabel htmlFor="pt-title" required>Title</FormLabel>
          <FormInput id="pt-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
        </div>
        {creating && !projectId && (
          <div>
            <FormLabel htmlFor="pt-project" required>Project</FormLabel>
            <FormSelect id="pt-project" aria-label="Project" value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })}>
              {projects.length === 0 && <option value="">No projects yet</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </FormSelect>
            <FormHelp>Saved in the project&apos;s .crewly/tickets/ folder. Team members pick up Ready tickets on their own.</FormHelp>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FormLabel htmlFor="pt-priority">Priority</FormLabel>
            <FormSelect id="pt-priority" aria-label="Priority" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as ProjectTicketPriority })}>
              {PROJECT_TICKET_PRIORITIES.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </FormSelect>
          </div>
          <div>
            <FormLabel htmlFor="pt-status">Status</FormLabel>
            <FormSelect id="pt-status" aria-label="Status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as ProjectTicketStatus })}>
              {statusChoices.map((s) => (
                <option key={s} value={s}>{PROJECT_TICKET_STATUS_LABELS[s]}</option>
              ))}
            </FormSelect>
          </div>
        </div>
        <div>
          <FormLabel htmlFor="pt-labels">Labels</FormLabel>
          <FormInput id="pt-labels" value={form.labels} onChange={(e) => setForm({ ...form, labels: e.target.value })} placeholder="ui, export" />
        </div>
        <div>
          <FormLabel htmlFor="pt-description">Description</FormLabel>
          <FormTextarea id="pt-description" rows={5} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div>
          <FormLabel htmlFor="pt-acceptance">Acceptance criteria</FormLabel>
          <FormTextarea id="pt-acceptance" rows={4} value={form.acceptance} onChange={(e) => setForm({ ...form, acceptance: e.target.value })} placeholder="One per line; start a line with [x] when it is met" />
        </div>
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" checked={form.ownerReview} onChange={(e) => setForm({ ...form, ownerReview: e.target.checked })} />
          I review it myself before it counts as done
        </label>
      </FormGroup>

      {ticket && (
        <FormGroup>
          <div>
            <FormLabel htmlFor="pt-assignee">Assignee</FormLabel>
            <div className="flex items-center gap-2">
              <FormSelect id="pt-assignee" aria-label="Assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Nobody</option>
                {members.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
                {assignee && !members.some((m) => m.value === assignee) && <option value={assignee}>{assignee}</option>}
              </FormSelect>
              <Button size="sm" variant="secondary" onClick={submitAssign} disabled={!assignee || assignee === ticket.assignee || saving}>
                Assign
              </Button>
            </div>
            <FormHelp>Assigning a team member starts the work: they get it as a task right away.</FormHelp>
          </div>
          <div className="text-xs text-text-2">
            <div>
              File: <code>{ticket.fileName}</code>
              {ticket.workItemId && (
                <>
                  {' · '}
                  <Link to={LINKS.run(ticket.workItemId)} className="text-primary-text hover:underline">
                    Run {ticket.workItemId.slice(0, 8)}
                  </Link>
                </>
              )}
            </div>
            {ticket.log.length > 0 && (
              <ul className="mt-2 space-y-1" aria-label="Ticket log">
                {ticket.log.slice(-10).map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        </FormGroup>
      )}
    </FormPopup>
  );
};

/**
 * A blank form.
 *
 * @param project - Preselected project
 * @returns The form state
 */
function emptyForm(project: string): TicketForm {
  return {
    title: '',
    project,
    priority: DEFAULT_PROJECT_TICKET_PRIORITY,
    status: 'backlog',
    labels: '',
    description: '',
    acceptance: '',
    ownerReview: false,
  };
}
