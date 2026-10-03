/**
 * Tests for the signal digest wiring: the Do ticket is opened as the owner,
 * with the lead's team when the project has it and without it otherwise;
 * the Slack listener hands clicks to the service.
 *
 * @module services/signal-digest/signal-digest.wiring.test
 */

import { EventEmitter } from 'events';

const mockSlack = new EventEmitter();
jest.mock('../slack/slack.service.js', () => ({ getSlackService: () => mockSlack }));
jest.mock('../core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }) },
}));

import { attachSignalDigestSlackListeners, createSignalTicket, type SignalTicketWorkflow } from './signal-digest.wiring.js';
import type { SignalDigestService } from './signal-digest.service.js';

const ticket = { project: 'CE site', title: 'Experiment: x', description: 'd', acceptance: ['a'], labels: ['experiment'], source: 'signal-digest:SD-1#1' };

describe('createSignalTicket', () => {
  it('opens a ready ticket as the owner, with the team', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'CE-1' });
    await expect(createSignalTicket({ create } as SignalTicketWorkflow, { ...ticket, team: 'team-ce' })).resolves.toEqual({ id: 'CE-1' });
    expect(create).toHaveBeenCalledWith('CE site', expect.objectContaining({ team: 'team-ce', status: 'ready', labels: ['experiment'], source: 'signal-digest:SD-1#1' }), {});
  });

  it('retries without the team when the project refuses it (400), and passes other errors on', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('team not on project'), { status: 400 }))
      .mockResolvedValueOnce({ id: 'CE-2' });
    await expect(createSignalTicket({ create } as SignalTicketWorkflow, { ...ticket, team: 'team-x' })).resolves.toEqual({ id: 'CE-2' });
    expect(create.mock.calls[1][1]).not.toHaveProperty('team');

    const missing = jest.fn().mockRejectedValue(Object.assign(new Error('Project not found'), { status: 404 }));
    await expect(createSignalTicket({ create: missing } as SignalTicketWorkflow, { ...ticket, team: 'team-x' })).rejects.toThrow('Project not found');
    expect(missing).toHaveBeenCalledTimes(1);
  });

  it('no team: one call without it', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'CE-3' });
    await createSignalTicket({ create } as SignalTicketWorkflow, ticket);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1]).not.toHaveProperty('team');
  });
});

describe('attachSignalDigestSlackListeners', () => {
  it('passes interactions to the service until detached', async () => {
    const handleInteraction = jest.fn().mockResolvedValue({ handled: true, reason: 'do' });
    const detach = attachSignalDigestSlackListeners({ handleInteraction } as unknown as SignalDigestService);
    const payload = { actions: [{ action_id: 'decision:signal:1:do' }] };
    mockSlack.emit('interaction', { payload, source: 'cloud' });
    expect(handleInteraction).toHaveBeenCalledWith(payload);
    detach();
    mockSlack.emit('interaction', { payload, source: 'cloud' });
    expect(handleInteraction).toHaveBeenCalledTimes(1);
  });
});
