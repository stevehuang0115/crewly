/**
 * Expert Profile Module Tests
 *
 * @module services/ai/prompt-modules/expert-profile.module.test
 */

import { ExpertProfileModule } from './expert-profile.module.js';
import type { ModuleConfig } from './prompt-module.interface.js';

describe('ExpertProfileModule', () => {
  const mod = new ExpertProfileModule();

  it('should have correct priority (2.5 — between Soul and RoleBoundary)', () => {
    expect(mod.priority).toBe(2.5);
    expect(mod.name).toBe('expert-profile');
    expect(mod.compactable).toBe(true);
  });

  it('should not include when expertId is not set', () => {
    expect(mod.shouldInclude({} as ModuleConfig)).toBe(false);
    expect(mod.shouldInclude({ expertId: '' } as ModuleConfig)).toBe(false);
  });

  it('should include when expertId is set', () => {
    expect(mod.shouldInclude({ expertId: 'first-principles' } as ModuleConfig)).toBe(true);
  });

  it('should return empty string for non-existent expert', async () => {
    const result = await mod.build({
      expertId: 'non-existent-expert-xyz',
      projectRoot: '/tmp/no-such-project',
    } as ModuleConfig);
    expect(result).toBe('');
  });

  it('should sanitize expertId to prevent path traversal', async () => {
    const result = await mod.build({
      expertId: '../../../etc/passwd',
      projectRoot: '/tmp',
    } as ModuleConfig);
    expect(result).toBe('');
  });
});
