/**
 * Tests for the model-tier wiring (crewly#1173): registers the card handler
 * and installs the running service.
 */

import * as os from 'os';
import { getModelTierService, setModelTierService } from './model-tier.service.js';
import { createIdleRestarter, startModelTiers } from './model-tier.wiring.js';

describe('startModelTiers', () => {
  afterEach(() => {
    getModelTierService()?.stop();
    setModelTierService(null);
  });

  it('registers the model_tier_change handler and installs the service', () => {
    const register = jest.fn();
    const decisions = { askPrebuilt: jest.fn(), get: jest.fn() };
    const service = startModelTiers({ crewlyHome: os.tmpdir(), decisions: decisions as never, sendToAgent: jest.fn(), register });
    expect(register).toHaveBeenCalledWith('model_tier_change', service);
    expect(getModelTierService()).toBe(service);
  });
});

describe('createIdleRestarter', () => {
  const item = (target: string, status: string) => ({ id: `wi-${status}`, target, status }) as never;
  const make = (over: Partial<Parameters<typeof createIdleRestarter>[0]> = {}) => {
    const relaunch = jest.fn(async () => true);
    const restart = createIdleRestarter({
      isLive: () => true,
      isBusy: async () => false,
      workItems: async () => [],
      relaunch,
      ...over,
    });
    return { restart, relaunch };
  };

  it('restarts a running, idle member', async () => {
    const { restart, relaunch } = make();
    await expect(restart('mkt-ella')).resolves.toBe('restarted');
    expect(relaunch).toHaveBeenCalledWith('mkt-ella');
  });

  it('never stops a member mid-turn or holding claimed work', async () => {
    for (const over of [
      { isBusy: async () => true },
      { isBusy: async () => Promise.reject(new Error('unknown')) },
      { workItems: async () => [item('mkt-ella', 'running')] },
      { workItems: async () => [item('mkt-ella', 'accepted')] },
      { workItems: async () => Promise.reject(new Error('pool down')) },
    ]) {
      const { restart, relaunch } = make(over);
      await expect(restart('mkt-ella')).resolves.toBe('busy');
      expect(relaunch).not.toHaveBeenCalled();
    }
  });

  it('ignores other members\' work and settled work', async () => {
    const { restart } = make({ workItems: async () => [item('mkt-sam', 'running'), item('mkt-ella', 'verified')] });
    await expect(restart('mkt-ella')).resolves.toBe('restarted');
  });

  it('leaves a stopped member alone and reports a failed relaunch', async () => {
    const stopped = make({ isLive: () => false });
    await expect(stopped.restart('mkt-ella')).resolves.toBe('not_running');
    expect(stopped.relaunch).not.toHaveBeenCalled();
    const failing = make({ relaunch: jest.fn(async () => false) });
    await expect(failing.restart('mkt-ella')).resolves.toBe('failed');
  });
});
