/**
 * Tests for the trigger controller — creator attribution and list projections.
 *
 * @module controllers/trigger/trigger.controller.test
 */

import type { Request, Response } from 'express';

const mockCreate = jest.fn();
const mockList = jest.fn();
const mockProject = jest.fn();

jest.mock('../../services/v3/trigger-engine.service.js', () => ({
  TriggerEngine: {
    getInstance: () => ({ create: mockCreate, list: mockList, projectLastFireAt: mockProject }),
  },
}));

jest.mock('../../services/core/storage.service.js', () => ({
  StorageService: { getInstance: () => ({ findMemberBySessionName: jest.fn() }) },
}));

import { createTrigger, listTriggers } from './trigger.controller.js';
import { ownerAuthHeaders } from '../../middleware/caller-identity.testing.js';

function mockRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

const body = {
  type: 'time',
  config: { type: 'time', cronExpression: '30 22 * * *', timezone: 'America/New_York' },
  action: { createWorkItem: { title: 'Nightly ops report', target: 'ce-owen-ad0320ab' } },
  createdBy: 'system',
  name: 'daily-ops-nightly-2230',
  maxFires: 58,
};

describe('trigger.controller createTrigger', () => {
  beforeEach(() => {
    mockCreate.mockReset().mockImplementation(async (input) => ({ id: 'new', ...input }));
  });

  it('attributes a skill call to the calling agent session, not system', async () => {
    const req = { body, headers: { 'x-agent-session': 'ce-owen-ad0320ab' } } as unknown as Request;
    const res = mockRes();
    await createTrigger(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      createdBy: 'agent',
      createdBySession: 'ce-owen-ad0320ab',
      internal: false,
      name: 'daily-ops-nightly-2230',
    }));
  });

  it('attributes a dashboard call (owner session, #999) to the owner', async () => {
    const req = { body: { ...body, createdBy: 'user' }, headers: ownerAuthHeaders() } as unknown as Request;
    await createTrigger(req, mockRes());
    const input = mockCreate.mock.calls[0][0];
    expect(input).toMatchObject({ createdBy: 'user', internal: false });
    expect(input.createdBySession).toBeUndefined();
  });

  it('rejects an unknown creator from a header-less call', async () => {
    const req = { body: { ...body, createdBy: 'bogus' }, headers: {} } as unknown as Request;
    const res = mockRes();
    await createTrigger(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('trigger.controller listTriggers', () => {
  it('adds projectedLastFireAt to capped recurring schedules only', async () => {
    mockList.mockReturnValue([
      { id: 'a', status: 'active', config: { type: 'time', cronExpression: '30 22 * * *' }, maxFires: 58 },
      { id: 'b', status: 'active', config: { type: 'time', cronExpression: '0 9 * * *' } },
      { id: 'c', status: 'cancelled', config: { type: 'time', cronExpression: '0 9 * * *' }, maxFires: 3 },
    ]);
    mockProject.mockReturnValue('2026-11-25T03:30:00.000Z');
    const res = mockRes();
    await listTriggers({ query: {} } as unknown as Request, res);
    const data = res.json.mock.calls[0][0].data;
    expect(data[0].projectedLastFireAt).toBe('2026-11-25T03:30:00.000Z');
    expect(data[1].projectedLastFireAt).toBeUndefined();
    expect(data[2].projectedLastFireAt).toBeUndefined();
    expect(mockProject).toHaveBeenCalledTimes(1);
  });
});
