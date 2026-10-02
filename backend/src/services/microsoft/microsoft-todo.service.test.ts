/**
 * Tests for MicrosoftTodoService — list resolution by id / name / default,
 * Graph request shapes (lists, tasks, add, patch, delete), trimming, and the
 * 401 / 403 / 404 / 429 handling.
 *
 * @module services/microsoft/microsoft-todo.service.test
 */

import { MicrosoftTodoService, cleanStepTitles, noteText, pickList, pickStep, toDueDateTime, toImportance, toList, toStep, toTask } from './microsoft-todo.service.js';
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

  it('toStep / cleanStepTitles / pickStep handle task steps', () => {
    expect(toStep({ id: 's1', displayName: 'Eggs', isChecked: true })).toEqual({ id: 's1', title: 'Eggs', checked: true });
    expect(toStep({})).toEqual({ id: '', title: '', checked: false });
    expect(cleanStepTitles([' a ', '', 'b'])).toEqual(['a', 'b']);
    expect(cleanStepTitles(undefined)).toEqual([]);
    expect(cleanStepTitles(['x'.repeat(300)])[0]).toHaveLength(255);
    const steps = [{ id: 's1', title: 'Eggs', checked: false }, { id: 's2', title: 'Milk', checked: false }, { id: 's3', title: 'milk', checked: true }];
    expect(pickStep(steps, 's2').id).toBe('s2');
    expect(pickStep(steps, ' EGGS ').id).toBe('s1');
    expect(() => pickStep(steps, 'Milk')).toThrow(/Several steps/);
    expect(() => pickStep(steps, 'Ham')).toThrow(/No step called "Ham"/);
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
    expect(Object.fromEntries(url.searchParams)).toEqual({ $top: '100', $filter: "status ne 'completed'", $expand: 'checklistItems' });

    fetchMock.mockResolvedValueOnce(response(200, WIRE_LISTS)).mockResolvedValueOnce(response(200, { value: [] }));
    await todo.listTasks({ includeCompleted: true });
    const all = new URL(call(3)[0]);
    expect(all.pathname).toBe('/v1.0/me/todo/lists/L-default/tasks');
    expect(Object.fromEntries(all.searchParams)).toEqual({ $top: '50', $expand: 'checklistItems' });
  });

  it('shows each task\'s steps; a task without steps looks as before', async () => {
    fetchMock.mockResolvedValueOnce(response(200, WIRE_LISTS)).mockResolvedValueOnce(
      response(200, {
        value: [
          { id: 't1', title: 'Costco', status: 'notStarted', checklistItems: [{ id: 's1', displayName: 'Eggs', isChecked: true }, { id: 's2', displayName: 'Milk', isChecked: false }] },
          { id: 't2', title: 'Call Ann', status: 'notStarted', checklistItems: [] },
        ],
      }),
    );
    const out = await todo.listTasks();
    expect(out.tasks).toEqual([
      { id: 't1', title: 'Costco', status: 'notStarted', steps: [{ id: 's1', title: 'Eggs', checked: true }, { id: 's2', title: 'Milk', checked: false }] },
      { id: 't2', title: 'Call Ann', status: 'notStarted' },
    ]);
  });

  it('falls back to the plain request when Graph refuses the step expand', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, WIRE_LISTS))
      .mockResolvedValueOnce(response(400, { error: { code: 'BadRequest', message: 'expand not supported' } }))
      .mockResolvedValueOnce(response(200, { value: [{ id: 't1', title: 'Milk', status: 'notStarted' }] }));
    await expect(todo.listTasks()).resolves.toMatchObject({ tasks: [{ id: 't1', title: 'Milk', status: 'notStarted' }] });
    expect(new URL(call(2)[0]).searchParams.get('$expand')).toBeNull();
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

  it('adds a task with steps: one POST per step, in order, after the task', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, WIRE_LISTS))
      .mockResolvedValueOnce(response(201, { id: 't9', title: 'Costco', status: 'notStarted' }))
      .mockResolvedValueOnce(response(201, { id: 's1', displayName: 'Eggs', isChecked: false }))
      .mockResolvedValueOnce(response(201, { id: 's2', displayName: 'Milk', isChecked: false }))
      .mockResolvedValueOnce(response(201, { id: 's3', displayName: 'Bread', isChecked: false }));
    const out = await todo.addTask({ title: 'Costco', steps: ['Eggs', ' Milk ', '', 'Bread'] });
    expect(out).toEqual({
      list: { id: 'L-default', name: 'Tasks' },
      task: {
        id: 't9',
        title: 'Costco',
        status: 'notStarted',
        steps: [
          { id: 's1', title: 'Eggs', checked: false },
          { id: 's2', title: 'Milk', checked: false },
          { id: 's3', title: 'Bread', checked: false },
        ],
      },
    });
    expect(JSON.parse(call(1)[1].body as string)).toEqual({ title: 'Costco' });
    for (const [i, name] of [[2, 'Eggs'], [3, 'Milk'], [4, 'Bread']] as const) {
      expect(call(i)[0]).toBe(`${LISTS_URL}/L-default/tasks/t9/checklistItems`);
      expect(call(i)[1].method).toBe('POST');
      expect(JSON.parse(call(i)[1].body as string)).toEqual({ displayName: name });
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('reports a step that failed instead of failing the created task', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, WIRE_LISTS))
      .mockResolvedValueOnce(response(201, { id: 't9', title: 'Costco', status: 'notStarted' }))
      .mockResolvedValueOnce(response(201, { id: 's1', displayName: 'Eggs', isChecked: false }))
      .mockResolvedValueOnce(response(403, { error: { code: 'Forbidden', message: 'no' } }));
    const out = await todo.addTask({ title: 'Costco', steps: ['Eggs', 'Milk'] });
    expect(out.task.steps).toEqual([{ id: 's1', title: 'Eggs', checked: false }]);
    expect(out.failedSteps).toEqual([{ step: 'Milk', error: 'Forbidden: no' }]);
  });

  it('rejects too many steps before calling Graph', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `s${i}`);
    await expect(todo.addTask({ title: 'x', steps: many })).rejects.toMatchObject({ code: 'validation' });
    await expect(todo.updateTask({ taskId: 't1', addSteps: many })).rejects.toMatchObject({ code: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adds, checks, unchecks and removes steps on an existing task without touching the task', async () => {
    const TASK_URL = `${LISTS_URL}/L-default/tasks/t1`;
    fetchMock
      .mockResolvedValueOnce(response(200, WIRE_LISTS))
      .mockResolvedValueOnce(response(200, { id: 't1', title: 'Costco', status: 'notStarted' }))
      .mockResolvedValueOnce(
        response(200, {
          value: [
            { id: 's1', displayName: 'Eggs', isChecked: false },
            { id: 's2', displayName: 'Milk', isChecked: true },
            { id: 's3', displayName: 'Bread', isChecked: false },
          ],
        }),
      )
      .mockResolvedValueOnce(response(201, { id: 's4', displayName: 'Butter', isChecked: false }))
      .mockResolvedValueOnce(response(200, { id: 's1', displayName: 'Eggs', isChecked: true }))
      .mockResolvedValueOnce(response(200, { id: 's2', displayName: 'Milk', isChecked: false }))
      .mockResolvedValueOnce(response(204, undefined))
      .mockResolvedValueOnce(
        response(200, {
          value: [
            { id: 's1', displayName: 'Eggs', isChecked: true },
            { id: 's2', displayName: 'Milk', isChecked: false },
            { id: 's4', displayName: 'Butter', isChecked: false },
          ],
        }),
      );
    const out = await todo.updateTask({ taskId: 't1', addSteps: ['Butter'], checkSteps: ['eggs'], uncheckSteps: ['s2'], removeSteps: ['Bread'] });
    expect(out.task).toEqual({
      id: 't1',
      title: 'Costco',
      status: 'notStarted',
      steps: [
        { id: 's1', title: 'Eggs', checked: true },
        { id: 's2', title: 'Milk', checked: false },
        { id: 's4', title: 'Butter', checked: false },
      ],
    });
    // Only step changes: the task is read (GET), never PATCHed, and no task is created.
    expect(call(1)).toEqual([TASK_URL, expect.objectContaining({ method: 'GET' })]);
    expect(call(2)[0]).toBe(`${TASK_URL}/checklistItems`);
    expect([call(3)[1].method, JSON.parse(call(3)[1].body as string)]).toEqual(['POST', { displayName: 'Butter' }]);
    expect([call(4)[0], call(4)[1].method, JSON.parse(call(4)[1].body as string)]).toEqual([`${TASK_URL}/checklistItems/s1`, 'PATCH', { isChecked: true }]);
    expect([call(5)[0], JSON.parse(call(5)[1].body as string)]).toEqual([`${TASK_URL}/checklistItems/s2`, { isChecked: false }]);
    expect([call(6)[0], call(6)[1].method]).toEqual([`${TASK_URL}/checklistItems/s3`, 'DELETE']);
    expect(fetchMock.mock.calls.filter(([url, init]) => url === `${LISTS_URL}/L-default/tasks` && (init as RequestInit).method === 'POST')).toHaveLength(0);
  });

  it('PATCHes the task and then changes steps when both are given', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, WIRE_LISTS))
      .mockResolvedValueOnce(response(200, { id: 't1', title: 'Costco', status: 'completed' }))
      .mockResolvedValueOnce(response(200, { value: [] }))
      .mockResolvedValueOnce(response(201, { id: 's1', displayName: 'Eggs', isChecked: false }))
      .mockResolvedValueOnce(response(200, { value: [{ id: 's1', displayName: 'Eggs', isChecked: false }] }));
    const out = await todo.updateTask({ taskId: 't1', complete: true, addSteps: ['Eggs'] });
    expect(call(1)[1].method).toBe('PATCH');
    expect(out.task).toEqual({ id: 't1', title: 'Costco', status: 'completed', steps: [{ id: 's1', title: 'Eggs', checked: false }] });
  });

  it('an unknown step changes nothing', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, WIRE_LISTS))
      .mockResolvedValueOnce(response(200, { id: 't1', title: 'Costco', status: 'notStarted' }))
      .mockResolvedValueOnce(response(200, { value: [{ id: 's1', displayName: 'Eggs', isChecked: false }] }));
    await expect(todo.updateTask({ taskId: 't1', addSteps: ['Butter'], checkSteps: ['Ham'] })).rejects.toMatchObject({ code: 'not_found' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
