/**
 * Tests for CalendarService — exact Calendar request shapes for list /
 * create over a fake fetch, all-day vs timed events, validation.
 *
 * @module services/google/calendar.service.test
 */

import { CalendarService, toEventTime } from './calendar.service.js';
import type { GoogleApiDeps } from './google-api.client.js';

const BASE = 'https://www.googleapis.com/calendar/v3';

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

let fetchMock: jest.Mock;
let cal: CalendarService;

beforeEach(() => {
  fetchMock = jest.fn();
  const deps: GoogleApiDeps = {
    tokens: { getAccessToken: jest.fn().mockResolvedValue('ya29.tok'), clearCache: jest.fn() },
    fetchImpl: fetchMock as unknown as typeof fetch,
  };
  cal = new CalendarService(deps);
});

describe('listEvents', () => {
  it('lists primary with the window, singleEvents and startTime ordering, and trims the items', async () => {
    fetchMock.mockResolvedValueOnce(response(200, {
      items: [
        {
          id: 'e1', summary: 'Standup', status: 'confirmed', htmlLink: 'https://cal/e1', location: 'Zoom',
          start: { dateTime: '2026-09-18T09:00:00+08:00', timeZone: 'Asia/Shanghai' },
          end: { dateTime: '2026-09-18T09:15:00+08:00', timeZone: 'Asia/Shanghai' },
          attendees: [{ email: 'owner@example.com', responseStatus: 'accepted', organizer: true }, { email: 'ann@example.com', responseStatus: 'needsAction' }],
          organizer: { email: 'owner@example.com' },
          etag: '"x"', kind: 'calendar#event',
        },
        { id: 'e2', start: { date: '2026-09-19' }, end: { date: '2026-09-20' } },
      ],
    }));

    const events = await cal.listEvents({ timeMin: '2026-09-18T00:00:00Z', timeMax: '2026-09-25T00:00:00Z' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/calendars/primary/events?timeMin=2026-09-18T00%3A00%3A00Z&timeMax=2026-09-25T00%3A00%3A00Z&maxResults=50&singleEvents=true&orderBy=startTime`);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ya29.tok');
    expect(events).toEqual([
      {
        id: 'e1', summary: 'Standup', status: 'confirmed', htmlLink: 'https://cal/e1', location: 'Zoom',
        start: { dateTime: '2026-09-18T09:00:00+08:00', timeZone: 'Asia/Shanghai' },
        end: { dateTime: '2026-09-18T09:15:00+08:00', timeZone: 'Asia/Shanghai' },
        attendees: [{ email: 'owner@example.com', responseStatus: 'accepted', organizer: true }, { email: 'ann@example.com', responseStatus: 'needsAction' }],
        organizer: 'owner@example.com',
      },
      { id: 'e2', summary: '', start: { date: '2026-09-19' }, end: { date: '2026-09-20' }, attendees: [] },
    ]);
  });

  it('URL-encodes a non-primary calendar id, drops empty bounds and clamps max to 250', async () => {
    fetchMock.mockResolvedValueOnce(response(200, {}));
    await expect(cal.listEvents({ calendarId: 'team@group.calendar.google.com', max: 9999, timeMin: ' ' })).resolves.toEqual([]);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      `${BASE}/calendars/team%40group.calendar.google.com/events?maxResults=250&singleEvents=true&orderBy=startTime`,
    );
  });
});

describe('createEvent', () => {
  it('POSTs a timed event with timezone, description and attendees', async () => {
    fetchMock.mockResolvedValueOnce(response(200, {
      id: 'new1', summary: 'Design review', htmlLink: 'https://cal/new1',
      start: { dateTime: '2026-09-20T14:00:00', timeZone: 'Asia/Shanghai' },
      end: { dateTime: '2026-09-20T15:00:00', timeZone: 'Asia/Shanghai' },
      attendees: [{ email: 'ann@example.com', responseStatus: 'needsAction' }],
    }));

    const created = await cal.createEvent({
      summary: 'Design review',
      start: '2026-09-20T14:00:00',
      end: '2026-09-20T15:00:00',
      timezone: 'Asia/Shanghai',
      description: 'Walk through v2',
      attendees: ['ann@example.com', ' ', ''],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/calendars/primary/events`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      summary: 'Design review',
      start: { dateTime: '2026-09-20T14:00:00', timeZone: 'Asia/Shanghai' },
      end: { dateTime: '2026-09-20T15:00:00', timeZone: 'Asia/Shanghai' },
      description: 'Walk through v2',
      attendees: [{ email: 'ann@example.com' }],
    });
    expect(created).toEqual({
      id: 'new1', summary: 'Design review', htmlLink: 'https://cal/new1',
      start: { dateTime: '2026-09-20T14:00:00', timeZone: 'Asia/Shanghai' },
      end: { dateTime: '2026-09-20T15:00:00', timeZone: 'Asia/Shanghai' },
      attendees: [{ email: 'ann@example.com', responseStatus: 'needsAction' }],
    });
  });

  it('POSTs an all-day event as {date} on the named calendar without optional fields', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { id: 'd1', summary: 'Offsite', start: { date: '2026-10-01' }, end: { date: '2026-10-02' } }));
    await cal.createEvent({ calendarId: 'ops@example.com', summary: 'Offsite', start: '2026-10-01', end: '2026-10-02', attendees: [] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/calendars/ops%40example.com/events`);
    expect(JSON.parse(init.body as string)).toEqual({ summary: 'Offsite', start: { date: '2026-10-01' }, end: { date: '2026-10-02' } });
  });

  it('rejects a missing summary or an unparseable time before calling Google', async () => {
    await expect(cal.createEvent({ summary: ' ', start: '2026-10-01', end: '2026-10-02' })).rejects.toMatchObject({ status: 400, code: 'validation' });
    await expect(cal.createEvent({ summary: 'x', start: 'tomorrow', end: '2026-10-02' })).rejects.toMatchObject({ status: 400, code: 'validation', message: '"start" must be YYYY-MM-DD or an ISO 8601 date-time' });
    await expect(cal.createEvent({ summary: 'x', start: '2026-10-01', end: '' })).rejects.toMatchObject({ status: 400, code: 'validation', message: '"end" is required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('toEventTime', () => {
  it('maps YYYY-MM-DD to date, ISO to dateTime (+timeZone when given)', () => {
    expect(toEventTime('2026-10-01', 'Asia/Shanghai', 'start')).toEqual({ date: '2026-10-01' });
    expect(toEventTime('2026-10-01T10:00:00Z', undefined, 'start')).toEqual({ dateTime: '2026-10-01T10:00:00Z' });
    expect(toEventTime('2026-10-01T10:00:00', 'Europe/Berlin', 'start')).toEqual({ dateTime: '2026-10-01T10:00:00', timeZone: 'Europe/Berlin' });
  });
});
