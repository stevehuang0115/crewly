/**
 * Schedules page (route `/triggers`) constants: thresholds, page sizes and
 * every label the page shows, so components carry no magic values.
 *
 * @module constants/schedules.constants
 */

/** Dashboard route (kept as `/triggers` so existing links keep working). */
export const SCHEDULES_ROUTE = '/triggers';

/** Nav label for the page. */
export const SCHEDULES_NAV_LABEL = 'Schedules';

/** A recurring schedule with this many runs left or fewer shows a renew warning. */
export const SCHEDULE_EXPIRY_WARN_REMAINING = 7;

/** History rows per page. */
export const SCHEDULE_HISTORY_PAGE_SIZE = 20;

/** How often the nav badge refreshes its count (ms). */
export const SCHEDULE_BADGE_POLL_MS = 60_000;

/** The EventBus subscriber the reconciler uses — harness-internal. */
export const RECONCILER_SUBSCRIBER = '__reconciler__';

/** Auto-generated follow-up names (`followup:<8 hex>`) are not human names. */
export const AUTO_FOLLOWUP_NAME_PATTERN = /^followup:[0-9a-f]{8}$/i;

/** Session name of the orchestrator. */
export const ORCHESTRATOR_SESSION = 'crewly-orc';

/** Short labels for common IANA timezones. */
export const TIMEZONE_SHORT_LABEL: Record<string, string> = {
  'America/New_York': 'ET',
  'America/Detroit': 'ET',
  'America/Toronto': 'ET',
  'America/Chicago': 'CT',
  'America/Denver': 'MT',
  'America/Phoenix': 'MT',
  'America/Los_Angeles': 'PT',
  'America/Vancouver': 'PT',
  'Asia/Shanghai': 'Beijing',
  'Asia/Hong_Kong': 'Hong Kong',
  'Asia/Taipei': 'Taipei',
  'Asia/Tokyo': 'Tokyo',
  'Europe/London': 'London',
  UTC: 'UTC',
  'Etc/UTC': 'UTC',
};

/** Weekday names, index = cron day-of-week (0 = Sunday). */
export const WEEKDAY_LABEL: readonly string[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Short weekday names for lists of days ("Every Mon, Wed"). */
export const WEEKDAY_SHORT_LABEL: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Month abbreviations for dates ("Sep 30"). */
export const MONTH_SHORT_LABEL: readonly string[] = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Every label on the page. */
export const SCHEDULE_TEXT = {
  PAGE_TITLE: 'Schedules',
  PAGE_SUBTITLE: 'What your teams do on a schedule, and reminders waiting to go off',
  TAB_SCHEDULED: 'Schedules',
  TAB_REMINDERS: 'Reminders',
  TAB_HISTORY: 'History',
  SHOW_SYSTEM: 'Show system tasks',
  REFRESH: 'Refresh',
  NEW: 'New',
  ENGINE_STOPPED: 'The scheduler is not running, so schedules will not fire for now.',
  EMPTY_SCHEDULED_TITLE: 'No schedules yet',
  EMPTY_SCHEDULED_BODY: 'Ask a team lead to set one up, e.g. "send the ops report every day at 22:30". It will show up here.',
  EMPTY_REMINDERS_TITLE: 'No pending reminders',
  EMPTY_REMINDERS_BODY: 'One-time follow-ups and reminders waiting on an event show up here.',
  EMPTY_HISTORY_TITLE: 'No history yet',
  EMPTY_HISTORY_BODY: 'Finished and cancelled schedules are archived here.',
  HIDDEN_SYSTEM_HINT: (n: number) => `${n} system ${n === 1 ? 'task' : 'tasks'} hidden`,
  OTHER_TEAM: 'Other',
  ORCHESTRATOR: 'Orchestrator',
  NEXT_RUN: 'Next run',
  LAST_RUN: 'Last run',
  NEVER_RUN: 'Not run yet',
  RUNS: (count: number) => `Ran ${count} ${count === 1 ? 'time' : 'times'}`,
  RUNS_OF: (count: number, max: number) => `Ran ${count}/${max}`,
  REMAINING: (n: number) => `${n} left`,
  EXPIRING_SOON: 'Expiring soon — renew',
  ENDS_AROUND: (date: string) => `Ends ~${date}`,
  PAUSED: 'Paused',
  RUNS_AS: 'Runs as',
  TEAM: 'Team',
  SCHEDULE: 'Schedule',
  RAW_CRON: 'Cron',
  CREATED_BY: 'Created by',
  CREATED_AT: 'Created',
  DESCRIPTION: 'What it does',
  NO_DESCRIPTION: 'No details',
  RESULT_OK: 'Succeeded',
  RESULT_SKIPPED: 'Skipped (the previous run was still going)',
  RESULT_FAILED: 'Failed',
  HEADS_UP_SENT: 'Team lead reminded to renew',
  PAUSE: 'Pause',
  RESUME: 'Resume',
  CANCEL: 'Cancel schedule',
  DELETE: 'Delete',
  CANCEL_CONFIRM_TITLE: 'Cancel this schedule?',
  CANCEL_CONFIRM_BODY: 'It will stop firing and cannot be resumed. A team lead can set it up again if needed.',
  DELETE_CONFIRM_TITLE: 'Delete this record?',
  DELETE_CONFIRM_BODY: 'This record will be deleted permanently.',
  WAITING_EVENTS: 'Waiting on events',
  ONE_SHOT: 'One-time reminder',
  WHEN_EVENT: (event: string) => `When ${event} happens`,
  HISTORY_SUMMARY: (n: number) => `${n} finished ${n === 1 ? 'record' : 'records'}`,
  EXPAND: 'Show',
  COLLAPSE: 'Hide',
  PREV_PAGE: 'Previous',
  NEXT_PAGE: 'Next',
  PAGE_OF: (page: number, pages: number) => `${page} / ${pages}`,
  STATUS_CANCELLED: 'Cancelled',
  STATUS_EXHAUSTED: 'Finished',
  SYSTEM_CHIP: 'System',
  CRON_TASK_CHIP: 'Team cron',
  ID: 'ID',
} as const;

/** Labels for the create-schedule form. */
export const SCHEDULE_FORM_TEXT = {
  TITLE: 'New schedule',
  TYPE: 'Type',
  TYPE_TIME: 'On a schedule',
  TYPE_SIGNAL: 'On an event',
  NAME: 'Name',
  NAME_PLACEHOLDER: 'e.g. Daily ops report',
  CRON: 'Cron expression',
  CRON_HELP: '5-field cron (minute hour day month weekday), in your timezone',
  EVENT_TYPE: 'Event type',
  TARGET: 'Send to',
  TARGET_PLACEHOLDER: 'Member session name',
  MESSAGE: 'Message',
  MESSAGE_PLACEHOLDER: 'What should happen when it fires?',
  MAX_FIRES: 'Max runs (optional)',
  MAX_FIRES_HELP: 'Leave empty for no limit.',
  RUNS: 'Runs',
  CANCEL: 'Cancel',
  CREATE: 'Create',
  CREATING: 'Creating…',
  ERROR_CRON: 'Enter a cron expression',
  ERROR_EVENT: 'Enter an event type',
  ERROR_TARGET: 'Enter who to send it to and the message',
  ERROR_CREATE: 'Could not create the schedule',
} as const;

/** Labels for who created a trigger. */
export const CREATOR_LABEL: Record<string, string> = {
  user: 'You',
  orchestrator: 'Orchestrator',
  agent: 'Team member',
  mission: 'Mission',
  'delegate-task': 'Delegation follow-up check',
  system: 'System',
};
