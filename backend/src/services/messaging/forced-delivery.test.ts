/**
 * Tests for in-process forced delivery (#1024).
 */

jest.mock('../session/index.js', () => ({
  getSessionBackendSync: jest.fn(() => null),
  createSessionCommandHelper: jest.fn(),
}));
jest.mock('../agent/crewly-agent/in-process-runtime-registry.js', () => ({
  getInProcessRuntime: jest.fn(() => undefined),
}));
jest.mock('./spend-capped-delivery.js', () => ({ queueIfSpendCapped: jest.fn(() => null) }));
jest.mock('./drain-queued-delivery.js', () => ({ queueIfRestartDraining: jest.fn(() => null) }));

import { deliverForcedMessage } from './forced-delivery.js';
import { TuiInputGuardError } from '../session/tui-input-guard.js';
import { getSessionBackendSync, createSessionCommandHelper } from '../session/index.js';

describe('deliverForcedMessage', () => {
  const noGates = {
    queueIfRestartDraining: () => null,
    queueIfSpendCapped: () => null,
  };

  it('writes into the PTY when there is no in-process runtime', async () => {
    const write = jest.fn().mockResolvedValue(undefined);
    const r = await deliverForcedMessage('crewly-orc', 'hello', { ...noGates, getInProcessRuntime: () => undefined, writeToPty: () => write });
    expect(r).toEqual({ status: 'delivered', inProcess: false });
    expect(write).toHaveBeenCalledWith('hello');
  });

  it('hands the message to a ready in-process runtime', async () => {
    const handleMessage = jest.fn().mockResolvedValue(undefined);
    const r = await deliverForcedMessage('a', 'hi', { ...noGates, getInProcessRuntime: () => ({ isReady: () => true, handleMessage }) });
    expect(r).toEqual({ status: 'delivered', inProcess: true });
    expect(handleMessage).toHaveBeenCalledWith('hi');
  });

  it('reports an in-process runtime that is not ready', async () => {
    const r = await deliverForcedMessage('a', 'hi', { ...noGates, getInProcessRuntime: () => ({ isReady: () => false, handleMessage: jest.fn() }) });
    expect(r.status).toBe('not-found');
  });

  it('reports a session that does not exist', async () => {
    const r = await deliverForcedMessage('ghost', 'hi', { ...noGates, getInProcessRuntime: () => undefined, writeToPty: () => null });
    expect(r.status).toBe('not-found');
  });

  it('queues during the restart drain, before the spend cap and the write', async () => {
    const write = jest.fn();
    const capped = jest.fn();
    const r = await deliverForcedMessage('a', 'hi', {
      queueIfRestartDraining: () => ({ success: true, queued: true, restartDrain: true, message: '[RESTART_DRAIN] queued' }),
      queueIfSpendCapped: capped,
      writeToPty: () => write,
    });
    expect(r).toEqual({ status: 'queued', reason: 'restart-drain', message: '[RESTART_DRAIN] queued' });
    expect(capped).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('queues for a capped agent', async () => {
    const r = await deliverForcedMessage('a', 'hi', {
      queueIfRestartDraining: () => null,
      queueIfSpendCapped: () => ({ success: true, queued: true, spendCapped: true, message: '[SPEND_CAP] queued' }),
    });
    expect(r).toMatchObject({ status: 'queued', reason: 'spend-cap' });
  });

  it('reports text it did not type (input guard) and other failures without throwing', async () => {
    const guarded = await deliverForcedMessage('a', 'hi', {
      ...noGates,
      getInProcessRuntime: () => undefined,
      writeToPty: () => async () => {
        throw new TuiInputGuardError('before-write', { state: 'foreign', text: 'x', lineCount: 1 } as never);
      },
    });
    expect(guarded.status).toBe('input-not-ours');
    const failed = await deliverForcedMessage('a', 'hi', {
      ...noGates,
      getInProcessRuntime: () => undefined,
      writeToPty: () => async () => {
        throw new Error('pty gone');
      },
    });
    expect(failed).toEqual({ status: 'failed', error: 'pty gone' });
  });

  it('uses the live session backend by default', async () => {
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    (getSessionBackendSync as jest.Mock).mockReturnValue({ getSession: () => ({}) });
    (createSessionCommandHelper as jest.Mock).mockReturnValue({ sendMessage });
    const r = await deliverForcedMessage('crewly-orc', 'notice');
    expect(r).toEqual({ status: 'delivered', inProcess: false });
    expect(sendMessage).toHaveBeenCalledWith('crewly-orc', 'notice');
  });
});
