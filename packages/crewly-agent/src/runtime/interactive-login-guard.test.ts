/**
 * Tests for the interactive harness login guard of bash_exec.
 */

import { describe, it, expect } from 'vitest';
import { HARNESS_LOGIN_SKILL_PATH, checkInteractiveLoginCommand, detectInteractiveLogin } from './interactive-login-guard.js';

describe('detectInteractiveLogin', () => {
  it.each([
    ['claude setup-token', 'claude setup-token'],
    ['~/.local/bin/claude setup-token', 'claude setup-token'],
    ['cd ~ && claude setup-token 2>&1 | tee /tmp/x', 'claude setup-token'],
    ['script -q /dev/null claude setup-token', 'claude setup-token'],
    ["tmux send-keys -t login 'claude setup-token' Enter", 'claude setup-token'],
    ['claude /login', 'claude /login'],
    ['claude "/login"', 'claude /login'],
    ['echo /login | claude', 'claude /login'],
    ["printf '/login\\n' | ~/.local/bin/claude", 'claude /login'],
    ['claude auth login', 'claude auth login'],
    ['claude auth login --email someone@example.com', 'claude auth login'],
    ['claude login', 'claude auth login'],
    ['codex login', 'codex login'],
    ['codex login --device-auth', 'codex login'],
    ['nohup codex login --device-auth > /tmp/l.log 2>&1 &', 'codex login'],
    ['agy login', 'agy login'],
    ['antigravity auth login', 'agy login'],
  ])('%s', (command, label) => {
    expect(detectInteractiveLogin(command)).toBe(label);
  });

  it.each([
    'claude auth status',
    'claude --version',
    'claude -p "summarise the repo"',
    'codex login status',
    'codex exec "fix the test"',
    'cat backend/src/services/harness/claude-config.utils.ts',
    'grep -rn setup-token backend/src/services/harness/login-rules.ts',
    'bash config/skills/orchestrator/harness-login/execute.sh --harness claude',
    'ls ~/.claude',
    'echo login',
    '',
  ])('allows %s', (command) => {
    expect(detectInteractiveLogin(command)).toBeNull();
  });
});

describe('checkInteractiveLoginCommand', () => {
  it('explains why and names the skill', () => {
    const message = checkInteractiveLoginCommand('claude setup-token');
    expect(message).toContain('`claude setup-token` is an interactive login');
    expect(message).toContain('stale');
    expect(message).toContain(HARNESS_LOGIN_SKILL_PATH);
    expect(message).toContain('Do not retry');
  });

  it('returns null for ordinary commands', () => {
    expect(checkInteractiveLoginCommand('npm run build')).toBeNull();
  });
});
