import { buildRuntimeModelFlags, injectRuntimeFlags, isSafeModelId, isSafeReasoningEffort } from './runtime-model-flags.utils.js';

describe('runtime-model-flags', () => {
  describe('buildRuntimeModelFlags', () => {
    it('maps model + effort onto each harness flag', () => {
      expect(buildRuntimeModelFlags('claude-code', 'opus', 'high')).toEqual(['--model', 'opus', '--effort', 'high']);
      expect(buildRuntimeModelFlags('codex-cli', 'gpt-5.6-sol', 'low')).toEqual(['-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="low"']);
      expect(buildRuntimeModelFlags('gemini-cli', 'gemini-2.5-pro', 'high')).toEqual(['-m', 'gemini-2.5-pro']);
      expect(buildRuntimeModelFlags('opencode-cli', 'anthropic/claude-sonnet-4')).toEqual(['--model', 'anthropic/claude-sonnet-4']);
    });

    it('returns nothing for crewly-agent, unknown runtimes, or empty values', () => {
      expect(buildRuntimeModelFlags('crewly-agent', 'google/gemini-3-flash-preview')).toEqual([]);
      expect(buildRuntimeModelFlags('something-else', 'x')).toEqual([]);
      expect(buildRuntimeModelFlags('claude-code')).toEqual([]);
      expect(buildRuntimeModelFlags('claude-code', '', '')).toEqual([]);
    });

    it('ignores values that are not shell-safe instead of quoting them', () => {
      expect(buildRuntimeModelFlags('claude-code', 'opus; rm -rf /')).toEqual([]);
      expect(buildRuntimeModelFlags('codex-cli', 'gpt-5', 'high"; echo')).toEqual(['-m', 'gpt-5']);
      expect(isSafeModelId('claude-sonnet-4-5:latest')).toBe(true);
      expect(isSafeModelId('$(x)')).toBe(false);
      expect(isSafeReasoningEffort('xhigh')).toBe(true);
      expect(isSafeReasoningEffort('High')).toBe(false);
    });
  });

  describe('injectRuntimeFlags', () => {
    it('places flags right after the binary for every runtime', () => {
      expect(injectRuntimeFlags('claude --dangerously-skip-permissions', 'claude-code', ['--model', 'opus'])).toBe(
        'claude --model opus --dangerously-skip-permissions',
      );
      expect(injectRuntimeFlags('codex -a never -s danger-full-access', 'codex-cli', ['-m', 'gpt-5.6-sol'])).toBe(
        'codex -m gpt-5.6-sol -a never -s danger-full-access',
      );
      expect(injectRuntimeFlags('GEMINI_NO_UPDATE=1 gemini --yolo', 'gemini-cli', ['-m', 'gemini-2.5-pro'])).toBe(
        'GEMINI_NO_UPDATE=1 gemini -m gemini-2.5-pro --yolo',
      );
      expect(injectRuntimeFlags('opencode --auto', 'opencode-cli', ['--model', 'openai/gpt-5'])).toBe(
        'opencode --model openai/gpt-5 --auto',
      );
    });

    it('keeps codex resume working: flags go after the subcommand', () => {
      expect(injectRuntimeFlags('codex resume -a never -s danger-full-access abc-123', 'codex-cli', ['-m', 'gpt-5'])).toBe(
        'codex resume -m gpt-5 -a never -s danger-full-access abc-123',
      );
    });

    it('replaces a model flag that the base command already carries', () => {
      expect(injectRuntimeFlags('claude --model sonnet --dangerously-skip-permissions', 'claude-code', ['--model', 'opus'])).toBe(
        'claude --model opus --dangerously-skip-permissions',
      );
      expect(injectRuntimeFlags('codex -m gpt-4o -a never', 'codex-cli', ['-m', 'gpt-5'])).toBe('codex -m gpt-5 -a never');
      expect(injectRuntimeFlags('claude --model=sonnet --dangerously-skip-permissions', 'claude-code', ['--model', 'opus'])).toBe(
        'claude --model opus --dangerously-skip-permissions',
      );
    });

    it('falls back to the --dangerously-skip-permissions anchor, then to appending', () => {
      expect(injectRuntimeFlags('my-wrapper.sh --dangerously-skip-permissions', 'claude-code', ['--chrome'])).toBe(
        'my-wrapper.sh --chrome --dangerously-skip-permissions',
      );
      expect(injectRuntimeFlags('my-wrapper.sh', 'codex-cli', ['-m', 'gpt-5'])).toBe('my-wrapper.sh -m gpt-5');
    });

    it('is a no-op for an empty flag list', () => {
      expect(injectRuntimeFlags('claude --dangerously-skip-permissions', 'claude-code', [])).toBe('claude --dangerously-skip-permissions');
    });
  });
});
