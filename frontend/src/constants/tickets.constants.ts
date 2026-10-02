/**
 * Ticket board constants (specs/ticket-loop.md, Phase 2).
 *
 * Endpoints, refresh cadence and every English label the board shows, kept in
 * one place so components carry no magic values.
 *
 * @module constants/tickets.constants
 */

import type {
  TicketAcceptanceCheck,
  TicketAcceptanceSource,
  TicketBoardColumn,
  TicketKind,
  TicketPriority,
  TicketPriorityLabel,
} from '../types/ticket.types';

/** Base path of the tickets API. */
export const TICKETS_API_BASE = '/api/tickets';

/** Dashboard route of the board. */
export const TICKETS_ROUTE = '/tickets';

/** How often the board refreshes itself (ms). */
export const TICKETS_POLL_INTERVAL_MS = 15_000;

/** Delay between the last keystroke in the search box and the query (ms). */
export const TICKETS_SEARCH_DEBOUNCE_MS = 300;

/** Milliseconds in one day (auto-accept countdown). */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Columns shown on the board, in display order (`cancelled` stays hidden). */
export const TICKET_BOARD_COLUMN_ORDER: readonly TicketBoardColumn[] = [
  'idea',
  'todo',
  'in_progress',
  'blocked',
  'to_review',
  'done',
] as const;

/** Column headings. */
export const TICKET_COLUMN_LABEL: Record<TicketBoardColumn, string> = {
  idea: 'Ideas',
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  to_review: 'To review',
  done: 'Done',
  cancelled: 'Cancelled',
};

/** Kind labels. */
export const TICKET_KIND_LABEL: Record<TicketKind, string> = {
  issue: 'Issue',
  feature: 'Feature',
  idea: 'Idea',
  /** #827: a pure information question, no acceptance step */
  question: 'Question',
};

/** Kinds in display order. */
export const TICKET_KINDS: readonly TicketKind[] = ['issue', 'feature', 'idea', 'question'] as const;

/** Value of the kind filter meaning "every kind". */
export const TICKET_KIND_FILTER_ALL = 'all' as const;

/** Label of the "every kind" filter option. */
export const TICKET_KIND_FILTER_ALL_LABEL = 'All';

/** Priorities, most urgent first, with their display labels. */
export const TICKET_PRIORITY_OPTIONS: ReadonlyArray<{ value: TicketPriority; label: TicketPriorityLabel }> = [
  { value: 'urgent', label: 'P0' },
  { value: 'high', label: 'P1' },
  { value: 'normal', label: 'P2' },
  { value: 'low', label: 'P3' },
] as const;

/** Badge variant per priority label. */
export const TICKET_PRIORITY_VARIANT: Record<TicketPriorityLabel, 'error' | 'warning' | 'primary' | 'default'> = {
  P0: 'error',
  P1: 'warning',
  P2: 'primary',
  P3: 'default',
};

/** Acceptance source badge text (absent source = the owner). */
export const TICKET_ACCEPTANCE_SOURCE_LABEL: Record<TicketAcceptanceSource, string> = {
  owner: 'Me',
  decompose: 'Breakdown',
  reject: 'Sent back',
  agent: 'Agent',
};

/** Acceptance check badge text (absent check = judgment). */
export const TICKET_ACCEPTANCE_CHECK_LABEL: Record<TicketAcceptanceCheck, string> = {
  auto: 'Auto',
  judgment: 'Manual',
};

/** Human text for the origin channel. Unknown channels show as-is. */
export const TICKET_ORIGIN_CHANNEL_LABEL: Record<string, string> = {
  'slack-channel': 'Slack channel',
  'slack-dm': 'Slack DM',
  chat: 'Chat',
  portal: 'Portal',
  mobile: 'Mobile',
  'bug-button': 'Bug button',
  agent: 'Agent',
  cron: 'Scheduled task',
  mission: 'Mission',
  legacy: 'Legacy record',
};

/** Human text for each server refusal code. */
export const TICKET_ERROR_TEXT: Record<string, string> = {
  not_in_review: 'This ticket is not in review, so it cannot be sent back',
  already_done: 'This ticket is already done',
  open_work: 'Some work items are still open, so it cannot be accepted yet',
  cancelled: 'This ticket was cancelled',
  invalid: 'Invalid input',
};

/** Every piece of UI copy on the board. */
export const TICKET_TEXT = {
  PAGE_TITLE: 'Tickets',
  PAGE_SUBTITLE: 'Everything you have asked for, in one place',
  SEARCH_PLACEHOLDER: 'Search tickets…',
  KIND_FILTER_ARIA: 'Filter by type',
  REFRESH: 'Refresh',
  EMPTY_COLUMN: 'Nothing here',
  EMPTY_BOARD_TITLE: 'No tickets yet',
  EMPTY_BOARD_DESC: 'Ask for something in Slack or chat ("please help me…") and a ticket is created automatically.',
  LOAD_FAILED: 'Failed to load tickets',
  UNASSIGNED: 'Unassigned',
  REJECT_BADGE: 'Sent back',
  AUTO_ACCEPT_IN_DAYS: 'Auto-accepts in',
  AUTO_ACCEPT_SOON: 'Auto-accepts soon',
  /** Done card: the owner reviewed it (#813) */
  ACCEPTED_BY_OWNER: 'Accepted',
  /** Done card: silence accepted it — nobody checked it (#813) */
  ACCEPTED_BY_SILENCE: 'Auto-accepted · not reviewed',
  /** Tooltip for {@link TICKET_TEXT.ACCEPTED_BY_SILENCE} */
  ACCEPTED_BY_SILENCE_HINT: 'Nobody objected before the deadline, so it closed as accepted; nobody checked the result',
  DETAIL_LOADING: 'Loading…',
  TITLE_LABEL: 'Title',
  SAVE: 'Save',
  PRIORITY_LABEL: 'Priority',
  KIND_LABEL: 'Type',
  ORIGIN_LABEL: 'Source',
  ASSIGNEE_LABEL: 'Assignee',
  DESCRIPTION_LABEL: 'Description',
  REPLY_LABEL: "Agent's answer",
  NO_REPLY: 'No answer yet',
  DISCUSSION_LABEL: 'Discussion',
  NO_DISCUSSION: 'No discussion yet',
  ACCEPTANCE_LABEL: 'Acceptance criteria',
  NO_ACCEPTANCE: 'No acceptance criteria yet',
  ACCEPTANCE_ADD_PLACEHOLDER: 'Add an acceptance criterion…',
  ACCEPTANCE_CHECK_ARIA: 'How it is checked',
  ACCEPTANCE_ADD: 'Add',
  ACCEPTANCE_REMOVE: 'Remove',
  SELF_CHECK_PASS: 'Self-check passed',
  SELF_CHECK_FAIL: 'Self-check failed',
  VERIFY: 'Verified',
  REJECT: 'Send back',
  DISMISS: 'Dismiss',
  REJECT_REASON_LABEL: 'Reason for sending back',
  REJECT_REASON_PLACEHOLDER: 'What is wrong? This becomes a new acceptance criterion',
  REJECT_REASON_REQUIRED: 'Please give a reason for sending it back',
  REJECT_CONFIRM: 'Confirm send back',
  CANCEL: 'Cancel',
  REJECTED_TIMES: 'Sent back',
  SUBMITTED_TIMES: 'Submitted',
} as const;

/** Copy of the redesigned board (specs/2026-10-02-ui-redesign.md §Tickets). */
export const TICKET_BOARD_TEXT = {
  NEW_TICKET: 'New ticket',
  NEEDS_YOU: 'Needs you',
  SHOW: 'Show',
  HIDE: 'Hide',
  SHOW_LESS: 'Show less',
  FILTER_PROJECT: 'Project',
  FILTER_TYPE: 'Type',
  FILTER_INCLUDE: 'Include',
  CANCELLED: 'Cancelled',
  NO_PROJECT: 'No project (your asks)',
  EMPTY_PROJECT_TITLE: 'No tickets in this project yet',
  EMPTY_PROJECT_DESC: 'Create one, or ask a team member in chat. Team members pick up Ready tickets on their own.',
  NO_MATCH: 'No tickets match the current filters.',
  PROJECT_HINT: 'Tickets live in .crewly/tickets/ in the project and are tracked in git. Team members pick up Ready tickets on their own.',
  TYPE_HIDES_PROJECT: 'Type applies to your asks only, so project tickets are hidden while it is set.',
} as const;

/** Empty-column text per column. */
export const TICKET_EMPTY_COLUMN_TEXT: Record<TicketBoardColumn, string> = {
  to_review: 'Nothing to review',
  in_progress: 'Nothing in progress',
  todo: 'Nothing to do',
  blocked: 'Nothing blocked',
  idea: 'No ideas',
  done: 'Nothing done yet',
  cancelled: 'Nothing cancelled',
};
