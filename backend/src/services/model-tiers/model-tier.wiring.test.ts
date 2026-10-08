/**
 * Tests for the model-tier wiring (crewly#1173): registers the card handler
 * and installs the running service.
 */

import * as os from 'os';
import { getModelTierService, setModelTierService } from './model-tier.service.js';
import { startModelTiers } from './model-tier.wiring.js';

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
