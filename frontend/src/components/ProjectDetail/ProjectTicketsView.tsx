/**
 * Project tickets board — the project's own backlog
 * (`<project>/.crewly/tickets/`, specs/2026-09-28-project-tickets.md).
 *
 * One column per status, a card per ticket; create, edit (title, priority,
 * labels, description, acceptance criteria, status) and assign to a member of
 * the project's teams. Agents claim `ready` tickets on their own; the board
 * refreshes on a timer so their claims and hand edits of the files show up.
 *
 * @module components/ProjectDetail/ProjectTicketsView
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Inbox } from 'lucide-react';
import { Button, FormPopup, FormGroup, FormLabel, FormInput, FormTextarea, FormHelp } from '@crewly/ui';
import { Alert } from '@crewly/ui/Alert';
import { FormSelect } from '@crewly/ui/Form';
import type { Project, Team } from '../../types';
import type {
  ProjectTicket,
  ProjectTicketCriterion,
  ProjectTicketPriority,
  ProjectTicketStatus,
  InvalidProjectTicketFile,
} from '../../types/project-ticket.types';
import {
  DEFAULT_PROJECT_TICKET_PRIORITY,
  PROJECT_TICKET_PRIORITIES,
  PROJECT_TICKET_PRIORITY_CLASSES,
  PROJECT_TICKET_STATUS_LABELS,
  PROJECT_TICKET_STATUS_ORDER,
  PROJECT_TICKET_TRANSITIONS,
  PROJECT_TICKETS_PAGE_SIZE,
  PROJECT_TICKETS_POLL_INTERVAL_MS,
} from '../../constants/project-tickets.constants';
import {
  assignProjectTicket,
  createProjectTicket,
  listProjectTickets,
  updateProjectTicket,
} from '../../services/project-tickets.service';

/** Props of {@link ProjectTicketsView}. */
export interface ProjectTicketsViewProps {
  project: Project;
  /** Teams assigned to the project (assignee choices) */
  teams: Team[];
  /** Told the ticket count after each load (tab badge) */
  onCountChange?: (count: number) => void;
  /** Refresh interval override (tests); 0 disables polling */
  pollIntervalMs?: number;
}

/** Editable form state of one ticket. */
interface TicketForm {
  title: string;
  priority: ProjectTicketPriority;
  status: ProjectTicketStatus;
  labels: string;
  description: string;
  acceptance: string;
  ownerReview: boolean;
}

const EMPTY_FORM: TicketForm = {
  title: '',
  priority: DEFAULT_PROJECT_TICKET_PRIORITY,
  status: 'backlog',
  labels: '',
  description: '',
  acceptance: '',
  ownerReview: false,
};

/**
 * Split a comma list.
 *
 * @param text - `a, b`
 * @returns Trimmed, non-empty items
 */
export function parseLabels(text: string): string[] {
  return text.split(',').map((l) => l.trim()).filter(Boolean);
}

/**
 * Turn the acceptance textarea into criteria. `[x] ` marks a done item; the
 * done flag of an unchanged line is kept.
 *
 * @param text - One criterion per line
 * @param previous - Current criteria (to keep done flags)
 * @returns Criteria
 */
export function parseAcceptance(text: string, previous: ProjectTicketCriterion[] = []): ProjectTicketCriterion[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^\[( |x|X)\]\s*(.*)$/.exec(line);
      if (m) return { text: m[2].trim(), done: m[1].toLowerCase() === 'x' };
      return { text: line, done: previous.find((c) => c.text === line)?.done ?? false };
    })
    .filter((c) => c.text.length > 0);
}

/**
 * Render criteria for the textarea.
 *
 * @param criteria - Criteria
 * @returns One per line, `[x] ` for done ones
 */
export function formatAcceptance(criteria: ProjectTicketCriterion[]): string {
  return criteria.map((c) => (c.done ? `[x] ${c.text}` : c.text)).join('\n');
}

/**
 * Board of a project's tickets.
 *
 * @param props - {@link ProjectTicketsViewProps}
 * @returns The board
 */
export const ProjectTicketsView: React.FC<ProjectTicketsViewProps> = ({
  project,
  teams,
  onCountChange,
  pollIntervalMs = PROJECT_TICKETS_POLL_INTERVAL_MS,
}) => {
  const [tickets, setTickets] = useState<ProjectTicket[]>([]);
  const [invalid, setInvalid] = useState<InvalidProjectTicketFile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  const [visible, setVisible] = useState<Record<string, number>>({});
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ProjectTicket | null>(null);
  const [form, setForm] = useState<TicketForm>(EMPTY_FORM);
  const [assignee, setAssignee] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await listProjectTickets(project.id);
      setTickets(r.tickets);
      setInvalid(r.invalid);
      onCountChange?.(r.tickets.filter((t) => t.status !== 'cancelled').length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tickets');
    } finally {
      setLoaded(true);
    }
  }, [project.id, onCountChange]);

  useEffect(() => {
    void load();
    if (!pollIntervalMs) return undefined;
    const timer = setInterval(() => void load(), pollIntervalMs);
    return () => clearInterval(timer);
  }, [load, pollIntervalMs]);

  const members = useMemo(
    () =>
      teams.flatMap((team) =>
        (team.members ?? []).map((m) => ({ value: m.sessionName, label: `${m.name} (${team.name})` })),
      ),
    [teams],
  );

  const columns = useMemo(
    () => PROJECT_TICKET_STATUS_ORDER.filter((s) => s !== 'cancelled' || showCancelled),
    [showCancelled],
  );

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setCreating(true);
  };

  const openEdit = (t: ProjectTicket) => {
    setEditing(t);
    setAssignee(t.assignee ?? '');
    setForm({
      title: t.title,
      priority: t.priority,
      status: t.status,
      labels: t.labels.join(', '),
      description: t.description,
      acceptance: formatAcceptance(t.acceptance),
      ownerReview: t.ownerReview,
    });
  };

  const run = async (fn: () => Promise<unknown>, done: () => void) => {
    setSaving(true);
    setError(null);
    try {
      await fn();
      done();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setSaving(false);
    }
  };

  const submitCreate = () =>
    run(
      () =>
        createProjectTicket(project.id, {
          title: form.title,
          priority: form.priority,
          status: form.status,
          labels: parseLabels(form.labels),
          description: form.description,
          acceptance: parseAcceptance(form.acceptance).map((c) => c.text),
          ownerReview: form.ownerReview,
        }),
      () => setCreating(false),
    );

  const submitEdit = () => {
    if (!editing) return Promise.resolve();
    const current = editing;
    return run(
      () =>
        updateProjectTicket(project.id, current.id, {
          title: form.title,
          priority: form.priority,
          labels: parseLabels(form.labels),
          description: form.description,
          acceptance: parseAcceptance(form.acceptance, current.acceptance),
          ownerReview: form.ownerReview,
          ...(form.status !== current.status ? { status: form.status } : {}),
        }),
      () => setEditing(null),
    );
  };

  const submitAssign = () => {
    if (!editing || !assignee) return Promise.resolve();
    const current = editing;
    return run(() => assignProjectTicket(project.id, current.id, assignee), () => setEditing(null));
  };

  const statusChoices = editing ? [editing.status, ...PROJECT_TICKET_TRANSITIONS[editing.status]] : (['backlog', 'ready'] as ProjectTicketStatus[]);

  const formFields = (
    <FormGroup>
      <div>
        <FormLabel htmlFor="pt-title" required>Title</FormLabel>
        <FormInput id="pt-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
      </div>
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
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.ownerReview} onChange={(e) => setForm({ ...form, ownerReview: e.target.checked })} />
        I review it myself before it counts as done
      </label>
    </FormGroup>
  );

  return (
    <div className="project-tickets-view">
      {error && (
        <Alert variant="error" size="sm" className="mb-4" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {invalid.length > 0 && (
        <Alert variant="warning" size="sm" className="mb-4">
          {invalid.length} file(s) in .crewly/tickets/ could not be read: {invalid.map((i) => `${i.fileName} (${i.error})`).join('; ')}
        </Alert>
      )}

      <div className="flex items-center justify-between mb-4 gap-3">
        <p className="text-sm text-text-secondary-dark">
          Tickets live in <code>.crewly/tickets/</code> in the project and are tracked in git. Team members pick up
          {' '}<strong>Ready</strong> tickets on their own.
        </p>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button variant="ghost" size="sm" onClick={() => setShowCancelled((v) => !v)}>
            {showCancelled ? 'Hide cancelled' : 'Show cancelled'}
          </Button>
          <Button size="sm" icon={Plus} onClick={openCreate}>New ticket</Button>
        </div>
      </div>

      <div className="kanban-board" role="list" aria-label="Project tickets">
        {columns.map((status) => {
          const inColumn = tickets.filter((t) => t.status === status);
          const limit = visible[status] ?? PROJECT_TICKETS_PAGE_SIZE;
          return (
            <section key={status} className={`task-column task-column--${status}`} aria-label={PROJECT_TICKET_STATUS_LABELS[status]}>
              <div className="column-header">
                <div className="flex items-center gap-2">
                  <h4 className="column-title">{PROJECT_TICKET_STATUS_LABELS[status]}</h4>
                  <span className="task-count">{inColumn.length}</span>
                </div>
              </div>
              <div className="column-content overflow-y-auto">
                {inColumn.slice(0, limit).map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    onClick={() => openEdit(t)}
                    className="w-full text-left bg-surface-dark p-3 rounded-lg border border-border-dark hover:border-primary/50 transition-all"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-text-secondary-dark">{t.id}</span>
                      <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${PROJECT_TICKET_PRIORITY_CLASSES[t.priority]}`}>{t.priority}</span>
                    </div>
                    <p className="font-semibold text-sm leading-snug mt-1">{t.title}</p>
                    <div className="flex items-center justify-between mt-2 gap-2 text-xs text-text-secondary-dark">
                      <span className="truncate">{t.labels.join(', ')}</span>
                      {t.assignee && <span className="truncate">@{t.assignee}</span>}
                    </div>
                  </button>
                ))}
                {loaded && inColumn.length === 0 && (
                  <div className="p-4 flex flex-col items-center text-center text-text-secondary-dark">
                    <Inbox className="w-8 h-8 mb-2" />
                    <span className="text-xs">Nothing here</span>
                  </div>
                )}
              </div>
              {inColumn.length > limit && (
                <div className="p-3 border-t border-border-dark">
                  <Button variant="secondary" size="sm" fullWidth onClick={() => setVisible((v) => ({ ...v, [status]: limit + PROJECT_TICKETS_PAGE_SIZE }))}>
                    Show more
                  </Button>
                </div>
              )}
            </section>
          );
        })}
      </div>

      <FormPopup
        isOpen={creating}
        onClose={() => setCreating(false)}
        onSubmit={() => void submitCreate()}
        title="New ticket"
        submitText="Create ticket"
        loading={saving}
        submitDisabled={!form.title.trim()}
      >
        {formFields}
      </FormPopup>

      <FormPopup
        isOpen={!!editing}
        onClose={() => setEditing(null)}
        onSubmit={() => void submitEdit()}
        title={editing ? `${editing.id}: ${editing.title}` : ''}
        submitText="Save"
        loading={saving}
        submitDisabled={!form.title.trim()}
        size="lg"
      >
        {formFields}
        {editing && (
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
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void submitAssign()}
                  disabled={!assignee || assignee === editing.assignee || saving}
                >
                  Assign
                </Button>
              </div>
              <FormHelp>Assigning a team member starts the work: they get it as a task right away.</FormHelp>
            </div>
            <div className="text-xs text-text-secondary-dark">
              <div>File: <code>{editing.fileName}</code>{editing.workItemId ? ` · WorkItem ${editing.workItemId}` : ''}</div>
              {editing.log.length > 0 && (
                <ul className="mt-2 space-y-1" aria-label="Ticket log">
                  {editing.log.slice(-10).map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
          </FormGroup>
        )}
      </FormPopup>
    </div>
  );
};

export default ProjectTicketsView;
