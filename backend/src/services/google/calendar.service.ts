/**
 * Calendar Service
 *
 * List and create events on the owner's Google Calendar through the
 * Calendar REST API with a Cloud-minted access token.
 *
 * @module services/google/calendar.service
 */

import { GOOGLE_WORKSPACE_CONSTANTS } from '../../constants.js';
import { GoogleWorkspaceError } from './google-workspace-token.service.js';
import { buildGoogleUrl, googleRequest, type GoogleApiDeps } from './google-api.client.js';
import { clampMax } from './gmail.service.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Google's event date/time: either an all-day `date` or a `dateTime`. */
export interface CalendarEventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

/** A calendar event, trimmed to what agents act on. */
export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  status?: string;
  htmlLink?: string;
  start: CalendarEventTime;
  end: CalendarEventTime;
  attendees: Array<{ email: string; responseStatus?: string; organizer?: boolean }>;
  organizer?: string;
}

/** Input to {@link CalendarService.listEvents}. */
export interface CalendarListInput {
  calendarId?: string;
  /** ISO 8601 lower bound (inclusive) */
  timeMin?: string;
  /** ISO 8601 upper bound (exclusive) */
  timeMax?: string;
  max?: number;
}

/** Input to {@link CalendarService.createEvent}. */
export interface CalendarCreateInput {
  calendarId?: string;
  summary: string;
  /** ISO 8601 date-time, or YYYY-MM-DD for an all-day event */
  start: string;
  /** ISO 8601 date-time, or YYYY-MM-DD (exclusive) for an all-day event */
  end: string;
  description?: string;
  attendees?: string[];
  /** IANA zone applied to `start`/`end` when they carry no offset */
  timezone?: string;
}

// ---------------------------------------------------------------------------
// Wire types (subset)
// ---------------------------------------------------------------------------

interface CalendarWireEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  htmlLink?: string;
  start?: CalendarEventTime;
  end?: CalendarEventTime;
  attendees?: Array<{ email: string; responseStatus?: string; organizer?: boolean }>;
  organizer?: { email?: string };
}

interface CalendarListResponse {
  items?: CalendarWireEvent[];
  nextPageToken?: string;
}

/** YYYY-MM-DD */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Turn a caller's start/end string into Google's `{date}` / `{dateTime}`.
 *
 * @param value - YYYY-MM-DD or ISO 8601 date-time
 * @param timezone - Applied to date-times
 * @param field - Name for the validation message
 * @returns Google event time
 * @throws GoogleWorkspaceError(400, validation) when empty or unparseable
 */
export function toEventTime(value: string, timezone: string | undefined, field: string): CalendarEventTime {
  const CODES = GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES;
  const v = (value ?? '').trim();
  if (!v) throw new GoogleWorkspaceError(400, CODES.VALIDATION, `"${field}" is required`);
  if (DATE_ONLY.test(v)) return { date: v };
  if (!Number.isFinite(Date.parse(v))) {
    throw new GoogleWorkspaceError(400, CODES.VALIDATION, `"${field}" must be YYYY-MM-DD or an ISO 8601 date-time`);
  }
  return timezone ? { dateTime: v, timeZone: timezone } : { dateTime: v };
}

/**
 * Trim a wire event to {@link CalendarEvent}.
 *
 * @param e - Google event
 * @returns Trimmed event
 */
function toEvent(e: CalendarWireEvent): CalendarEvent {
  return {
    id: e.id,
    summary: e.summary ?? '',
    ...(e.description ? { description: e.description } : {}),
    ...(e.location ? { location: e.location } : {}),
    ...(e.status ? { status: e.status } : {}),
    ...(e.htmlLink ? { htmlLink: e.htmlLink } : {}),
    start: e.start ?? {},
    end: e.end ?? {},
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.email,
      ...(a.responseStatus ? { responseStatus: a.responseStatus } : {}),
      ...(a.organizer ? { organizer: true } : {}),
    })),
    ...(e.organizer?.email ? { organizer: e.organizer.email } : {}),
  };
}

/**
 * Calendar operations on the signed-in owner's calendars.
 *
 * @example
 * ```ts
 * const cal = new CalendarService({ tokens: GoogleWorkspaceTokenService.getInstance() });
 * const events = await cal.listEvents({ timeMin: new Date().toISOString() });
 * ```
 */
export class CalendarService {
  private readonly deps: GoogleApiDeps;
  private readonly base = GOOGLE_WORKSPACE_CONSTANTS.CALENDAR_API_BASE;

  /**
   * @param deps - Token provider and optional fetch override
   */
  constructor(deps: GoogleApiDeps) {
    this.deps = deps;
  }

  /**
   * `events.list` — single events (recurrences expanded), ordered by start.
   *
   * @param input - Calendar, window and cap
   * @returns Events in start order
   * @throws GoogleWorkspaceError on auth / Google failures
   */
  async listEvents(input: CalendarListInput = {}): Promise<CalendarEvent[]> {
    const calendarId = (input.calendarId ?? '').trim() || GOOGLE_WORKSPACE_CONSTANTS.DEFAULT_CALENDAR_ID;
    const max = clampMax(input.max, GOOGLE_WORKSPACE_CONSTANTS.CALENDAR_DEFAULT_MAX_RESULTS, GOOGLE_WORKSPACE_CONSTANTS.CALENDAR_MAX_RESULTS_CEILING);
    const data = await googleRequest<CalendarListResponse>(
      this.deps,
      buildGoogleUrl(`${this.base}/calendars/${encodeURIComponent(calendarId)}/events`, {
        timeMin: input.timeMin?.trim(),
        timeMax: input.timeMax?.trim(),
        maxResults: max,
        singleEvents: 'true',
        orderBy: 'startTime',
      }),
    );
    return (data.items ?? []).map(toEvent);
  }

  /**
   * `events.insert`.
   *
   * @param input - Summary, start/end, optional description/attendees/timezone
   * @returns The created event
   * @throws GoogleWorkspaceError(400, validation) for a missing summary or bad times; auth / Google failures
   */
  async createEvent(input: CalendarCreateInput): Promise<CalendarEvent> {
    const CODES = GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES;
    const summary = (input.summary ?? '').trim();
    if (!summary) throw new GoogleWorkspaceError(400, CODES.VALIDATION, '"summary" is required');
    const calendarId = (input.calendarId ?? '').trim() || GOOGLE_WORKSPACE_CONSTANTS.DEFAULT_CALENDAR_ID;
    const timezone = input.timezone?.trim() || undefined;

    const body: Record<string, unknown> = {
      summary,
      start: toEventTime(input.start, timezone, 'start'),
      end: toEventTime(input.end, timezone, 'end'),
    };
    if (input.description?.trim()) body.description = input.description.trim();
    const attendees = (input.attendees ?? []).map((a) => a.trim()).filter(Boolean);
    if (attendees.length > 0) body.attendees = attendees.map((email) => ({ email }));

    const created = await googleRequest<CalendarWireEvent>(
      this.deps,
      `${this.base}/calendars/${encodeURIComponent(calendarId)}/events`,
      { method: 'POST', body },
    );
    return toEvent(created);
  }
}
