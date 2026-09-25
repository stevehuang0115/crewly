/**
 * Tests for picking a bundle's runtime.
 */

import { resolveBundleRuntime } from './bundle-runtime.js';

describe('resolveBundleRuntime', () => {
  it('an explicit runtime wins', () => {
    expect(resolveBundleRuntime({ recommended: 'crewly-agent', requested: 'codex-cli', orcHarness: 'claude-code', hasDeepseekKey: true })).toBe('codex-cli');
  });

  it('crewly-agent when recommended and a DeepSeek key is set (hosted server)', () => {
    expect(resolveBundleRuntime({ recommended: 'crewly-agent', orcHarness: 'claude-code', hasDeepseekKey: true })).toBe('crewly-agent');
  });

  it("falls back to the orchestrator's harness on the owner's own machine", () => {
    expect(resolveBundleRuntime({ recommended: 'crewly-agent', orcHarness: 'claude-code', hasDeepseekKey: false })).toBe('claude-code');
    expect(resolveBundleRuntime({ recommended: 'claude-code', orcHarness: 'codex-cli', hasDeepseekKey: false })).toBe('codex-cli');
  });

  it('keeps a coding harness that equals the orchestrator one', () => {
    expect(resolveBundleRuntime({ recommended: 'codex-cli', orcHarness: 'codex-cli', hasDeepseekKey: false })).toBe('codex-cli');
  });

  it('uses the recommendation when nothing is known about the machine', () => {
    expect(resolveBundleRuntime({ recommended: 'crewly-agent', orcHarness: null, hasDeepseekKey: false })).toBe('crewly-agent');
  });
});
