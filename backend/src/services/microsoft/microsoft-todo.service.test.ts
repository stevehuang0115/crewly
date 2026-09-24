/**
 * Tests for MicrosoftTodoService — list resolution by id / name / default,
 * Graph request shapes (lists, tasks, add, patch, delete), trimming, and the
 * 401 / 403 / 404 / 429 handling.
 *
 * @module services/microsoft/microsoft-todo.service.test
 */

import { MicrosoftTodoService, noteText, pickList, toDueDateTime, toImportance, toList, toTask } from './microsoft-todo.service.js';
import { MicrosoftError } from './microsoft-token.service.js';

const LISTS_URL = 'https://graph.microsoft.com/v1.0/me/todo/lists';

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null },
    text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const WIRE_LISTS = {
  value: [
    { id: 'L-default', displayName: 'Tasks', wellknownListName: 'defaultList', isShared: false },
    { id: 'L-groc', displayName: 'Groceries', wellknownListName: 'none', isShared: true },
    { id: 'L-work', displayName: 'Work', wellknownListName: 'none' },
  ],
};

let fetchMock: jest.Mock;
let sleep: jest.Mock;
let clearCache: jest.Mock;
let getAccessToken: jest.Mock;
let todo: MicrosoftTodoService;

beforeEach(() => {
  fetchMock = jest.fn();
  sleep = jest.fn().mockResolvedValue(undefined);
  clearCache = jest.fn();
  getAccessToken = jest.fn().mockResolvedValue('ms.tok');
  todo = new MicrosoftTodoService({ tokens: { getAccessToken, clearCache }, fetchImpl: fetchMock as unknown as typeof fetch, sleep });
});

const call = (i: number) => fetchMock.mock.calls[i] as [string, RequestInit];

describe('helpers', () => {
  it('toList / toTask trim Graph resources for agents', () => {
    expect(WIRE_LISTS.value.map(toList)).toEqual([
      { id: 'L-default', name: 'Tasks', isDefault: true },
      { id: 'L-groc', name: 'Groceries', isShared: true },
      { id: 'L-work', name: 'Work' },
    ]);
    expect(
      toTask({
        id: 't1',
        title: 'Buy milk',
        status: 'completed',
        importance: 'high',
        body: { content: 'two litres', contentType: 'text' },
        dueDateTime: { dateTime: '2026-09-30T00:00:00.0000000', timeZone: 'UTC' },
        completedDateTime: { dateTime: '2026-09-29T08:00:00.0000000', timeZone: 'UTC' },
      }),
    ).toEqual({ id: 't1', title: 'Buy milk', status: 'completed', importance: 'high', due: '2026-09-30', note: 'two litres', completedAt: '2026-09-29' });
    expect(toTask({ id: 't2', title: 'x', status: 'notStarted', importance: 'normal', body: { content: '', contentType: 'text' } })).toEqual({ id: 't2', title: 'x', status: 'notStarted' });
  });

  it('noteText strips Outlook HTML and truncates', () => {
    expect(noteText({ content: '<html><body><p>Call&nbsp;Ann &amp; Bob</p></body></html>', contentType: 'html' })).toBe('Call Ann & Bob');
    expect(noteText({ content: 'a'.repeat(500), contentType: 'text' })).toHaveLength(201);
    expect(noteText(undefined)).toBeUndefined();
  });

  it('toDueDateTime accepts real dates only; toImportance validates', () => {
    expect(toDueDateTime('2026-02-28')).toEqual({ dateTime: '2026-02-28T00:00:00', timeZone: 'UTC' });
    for (const bad of ['2026-02-30', '26-1-1', 'tomorrow', '2026-13-01']) expect(() => toDueDateTime(bad)).toThrow(MicrosoftError);
    expect(toImportance(' High ')).toBe('high');
    expect(() => toImportance('urgent')).toThrow(MicrosoftError);
  });

  it('pickList: id, case-insensitive name, default / empty, ambiguity and miss', () => {
    const lists = WIRE_LISTS.value.map(toList);
    expect(pickList(lists, 'L-work').id).toBe('L-work');
    expect(pickList(lists, '  groceries ').id).toBe('L-groc');
    expect(pickList(lists, '').id).toBe('L-default');
    expect(pickList(lists, undefined).id).toBe('L-default');
    expect(pickList(lists, 'Default').id).toBe('L-default');
    expect(() => pickList(lists, 'Holiday')).toThrow(expect.objectContaining({ status: 404, code: 'not_found', message: expect.stringContaining('Tasks, Groceries, Work') }));
    expect(() => pickList([...lists, { id: 'L-w2', name: 'work' }], 'Work')).toThrow(expect.objectContaining({ status: 400, code: 'validation' }));
    expect(() => pickList([], '')).toThrow(expect.objectContaining({ code: 'not_found' }));
  });
});

describe('lists', () => {
  it('lists every page with the bearer token', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { value: WIRE_LISTS.value.slice(0, 2), '@odata.nextLink': `${LISTS_URL}?$skip=2` }))
      .mockResolvedValueOnce(response(200, { value: WIRE_LISTS.value.slice(2) }));
    const lists = await todo.listLists();
    expect(lists.map((l) => l.id)).toEqual(['L-default', 'L-groc', 'L-work']);
    expect(call(0)[0]).toBe(LISTS_URL);
    expect(call(1)[0]).toBe(`${LISTS_URL}?$skip=2`);
    expect(call(0)[1].headers).toEqual({ Authorization: 'Bearer ms.tok', Accept: 'application/json' });
  });

  it('creates a list by display name', async () => {
    fetchMock.mockResolvedValueOnce(response(201, { id: 'L-new', displayName: 'Trip', wellknownListName: 'none' }));
    await expect(todo.createList(' Trip ')).resolves.toEqual({ id: 'L-new', name: 'Trip' });
    expect(call(0)[1].method).toBe('POST');
    expect(JSON.parse(call(0)[1].body as string)).toEqual({ displayName: 'Trip' });
    await expect(todo.createList(' ')).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('tasks', () => {
  it('lists open tasks of a named list with $top and the status filter; --all drops the filter', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, WIRE_LISTS))
      .mockResolvedValueOnce(response(200, { value: [{ id: 't1', title: 'Milk', status: 'notStarted' }], '@odata.nextLink': 'next' }));
    await expect(todo.listTasks({ list: 'GROCERIES', limit: 500 })).resolves.toEqual({
      list: { id: 'L-groc', name: 'Groceries' },
      tasks: [{ id: 't1', title: 'Milk', status: 'notStarted' }],
      hasMore: true,
    });
    const url = new URL(call(1)[0]);
    expect(url.origin + url.pathname).toBe(`${LISTS_URL}/L-groc/tasks`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ $top: '100', $filter: "status ne 'completed'" });

    fetchMock.mockResolvedValueOnce(response(200, WIRE_LISTS)).mockResolvedValueOnce(response(200, { value: [] }));
    await todo.listTasks({ includeCompleted: true });
    const all = new URL(call(3)[0]);
    expect(all.pathname).toBe('/v1.0/me/todo/lists/L-default/tasks');
    expect(Object.fromEntries(all.searchParams)).toEqual({ $top: '50' });
  });

  it('adds a task with note, due date and importance', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, WIRE_LISTS))
      .mockResolvedValueOnce(response(201, { id: 't9', title: 'Send deck', status: 'notStarted', importance: 'high', dueDateTime: { dateTime: '2026-10-01T00:00:00.0000000', timeZone: 'UTC' } }));
    const out = await todo.addTask({ list: 'work', title: ' Send deck ', note: 'to Ann', due: '2026-10-01', importance: 'HIGH' });
    expect(out).toEqual({ list: { id: 'L-work', name: 'Work' }, task: { id: 't9', title: 'Send deck', status: 'notStarted', importance: 'high', due: '2026-10-01' } });
    expect(call(1)[0]).toBe(`${LISTS_URL}/L-work/tasks`);
    expect(call(1)[1].method).toBe('POST');
    expect((call(1)[1].headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(call(1)[1].body as string)).toEqual({
      title: 'Send deck',
      body: { content: 'to Ann', contentType: 'text' },
      dueDateTime: { dateTime: '2026-10-01T00:00:00', timeZone: 'UTC' },
      importance: 'high',
    });
  });

  it('validates add input before calling Graph', async () => {
    await expect(todo.addTask({ title: ' ' })).rejects.toMatchObject({ code: 'validation' });
    await expect(todo.addTask({ title: 'x', due: '2026-02-31' })).rejects.toMatchObject({ code: 'validation' });
    await expect(todo.addTask({ title: 'x', importance: 'urgent' })).rejects.toMatchObject({ code: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('PATCHes complete / title / due, clears a due date with null, and reopens', async () => {
    fetchMock.mockResolvedValueOnce(response(200, WIRE_LISTS)).mockResolvedValueOnce(response(200, { id: 't/1', title: 'New', status: 'completed' }));
    await expect(todo.updateTask({ list: 'Tasks', taskId: 't/1', complete: true, title: 'New', due: '2026-12-01' })).resolves.toEqual({
      list: { id: 'L-default', name: 'Tasks' },
      task: { id: 't/1', title: 'New', status: 'completed' },
    });
    expect(call(1)[0]).toBe(`${LISTS_URL}/L-default/tasks/t%2F1`);
    expect(call(1)[1].method).toBe('PATCH');
    expect(JSON.parse(call(1)[1].body as string)).toEqual({ title: 'New', dueDateTime: { dateTime: '2026-12-01T00:00:00', timeZone: 'UTC' }, status: 'completed' });

    fetchMock.mockResolvedValueOnce(response(200, WIRE_LISTS)).mockResolvedValueOnce(response(200, { id: 't1', title: 'x', status: 'notStarted' }));
    await todo.updateTask({ taskId: 't1', due: null, complete: false });
    expect(JSON.parse(call(3)[1].body as string)).toEqual({ dueDateTime: null, status: 'notStarted' });

    await expect(todo.updateTask({ taskId: 't1' })).rejects.toMatchObject({ code: 'validation' });
    await expect(todo.updateTask({ taskId: ' ', complete: true })).rejects.toMatchObject({ code: 'validation' });
    await expect(todo.updateTask({ taskId: 't1', title: ' ' })).rejects.toMatchObject({ code: 'validation' });
  });

  it('DELETEs a task (204)', async () => {
    fetchMock.mockResolvedValueOnce(response(200, WIRE_LISTS)).mockResolvedValueOnce(response(204, undefined));
    await expect(todo.deleteTask('groceries', 't1')).resolves.toEqual({ list: { id: 'L-groc', name: 'Groceries' }, taskId: 't1', deleted: true });
    expect(call(1)[0]).toBe(`${LISTS_URL}/L-groc/tasks/t1`);
    expect(call(1)[1].method).toBe('DELETE');
    await expect(todo.deleteTask('groceries', '')).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('error handling', () => {
  it('401 clears the token and retries once; a second 401 is unauthorized', async () => {
    fetchMock.mockResolvedValueOnce(response(401, { error: { code: 'InvalidAuthenticationToken', message: 'expired' } })).mockResolvedValueOnce(response(200, WIRE_LISTS));
    await expect(todo.listLists()).resolves.toHaveLength(3);
    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValue(response(401, { error: { code: 'InvalidAuthenticationToken', message: 'expired' } }));
    await expect(todo.listLists()).rejects.toMatchObject({ status: 401, code: 'unauthorized', message: expect.stringContaining('InvalidAuthenticationToken: expired') });
  });

  it('429 waits out a short Retry-After once; a long one returns rate_limited with the delay', async () => {
    fetchMock.mockResolvedValueOnce(response(429, { error: { code: 'TooManyRequests' } }, { 'Retry-After': '3' })).mockResolvedValueOnce(response(200, WIRE_LISTS));
    await expect(todo.listLists()).resolves.toHaveLength(3);
    expect(sleep).toHaveBeenCalledWith(3000);

    fetchMock.mockResolvedValueOnce(response(429, { error: { code: 'TooManyRequests' } }, { 'Retry-After': '120' }));
    await expect(todo.listLists()).rejects.toMatchObject({ status: 429, code: 'rate_limited', retryAfterSeconds: 120 });
  });

  it('maps 403 → forbidden, 404 → not_found, 400 → validation, 5xx → 502, unreachable → network', async () => {
    fetchMock.mockResolvedValueOnce(response(403, { error: { code: 'MailboxNotEnabledForRESTAPI', message: 'no mailbox' } }));
    await expect(todo.listLists()).rejects.toMatchObject({ status: 403, code: 'forbidden', message: 'MailboxNotEnabledForRESTAPI: no mailbox' });
    fetchMock.mockResolvedValueOnce(response(200, WIRE_LISTS)).mockResolvedValueOnce(response(404, { error: { code: 'ErrorItemNotFound', message: 'gone' } }));
    await expect(todo.deleteTask('', 'nope')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    fetchMock.mockResolvedValueOnce(response(400, { error: { code: 'invalidRequest', message: 'bad field' } }));
    await expect(todo.listLists()).rejects.toMatchObject({ status: 400, code: 'validation' });
    fetchMock.mockResolvedValueOnce(response(503, 'down'));
    await expect(todo.listLists()).rejects.toMatchObject({ status: 502, code: 'microsoft_error', message: 'down' });
    fetchMock.mockResolvedValueOnce(response(200, 'not json'));
    await expect(todo.listLists()).rejects.toMatchObject({ code: 'microsoft_error' });
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(todo.listLists()).rejects.toMatchObject({ code: 'network' });
  });
});
