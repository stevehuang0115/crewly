/**
 * Tests for OutputAnalyzer Service
 *
 * @module services/continuation/output-analyzer.service.test
 */

import { OutputAnalyzer } from './output-analyzer.service.js';

// Mock LoggerService
jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: jest.fn(() => ({
      createComponentLogger: jest.fn(() => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      })),
    })),
  },
}));

describe('OutputAnalyzer', () => {
  let analyzer: OutputAnalyzer;

  beforeEach(() => {
    OutputAnalyzer.clearInstance();
    analyzer = OutputAnalyzer.getInstance();
  });

  afterEach(() => {
    OutputAnalyzer.clearInstance();
  });

  describe('getInstance', () => {
    it('should return the same instance on multiple calls', () => {
      const instance1 = OutputAnalyzer.getInstance();
      const instance2 = OutputAnalyzer.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should create a new instance after clearInstance', () => {
      const instance1 = OutputAnalyzer.getInstance();
      OutputAnalyzer.clearInstance();
      const instance2 = OutputAnalyzer.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('detectCompletionSignals', () => {
    it('should detect task marked complete', () => {
      const output = 'Task completed successfully [complete_task]';
      const signals = analyzer.detectCompletionSignals(output);
      expect(signals.taskMarkedComplete).toBe(true);
    });

    it('should detect all tests passed', () => {
      const output = 'Test Suites: 5 passed, 0 failed\nTests: 42 passed, 0 failing';
      const signals = analyzer.detectCompletionSignals(output);
      expect(signals.testsAllPassed).toBe(true);
    });

    it('should detect build success', () => {
      const output = 'webpack compiled successfully in 2.5s';
      const signals = analyzer.detectCompletionSignals(output);
      expect(signals.buildSucceeded).toBe(true);
    });

    it('should detect vite build success', () => {
      const output = 'vite v4.5.0 built in 1.5s';
      const signals = analyzer.detectCompletionSignals(output);
      expect(signals.buildSucceeded).toBe(true);
    });

    it('should detect git commit', () => {
      const output = '[main abc1234] Fix the bug\n 3 files changed, 50 insertions(+), 20 deletions(-)';
      const signals = analyzer.detectCompletionSignals(output);
      expect(signals.commitMade).toBe(true);
    });

    it('should detect PR creation', () => {
      const output = 'Created pull request https://github.com/org/repo/pull/123';
      const signals = analyzer.detectCompletionSignals(output);
      expect(signals.prCreated).toBe(true);
    });

    it('should detect explicit done statement', () => {
      const output = 'The work is complete and done.';
      const signals = analyzer.detectCompletionSignals(output);
      expect(signals.explicitDone).toBe(true);
    });

    it('should return false for unrelated output', () => {
      const output = 'Starting the build process...';
      const signals = analyzer.detectCompletionSignals(output);
      expect(signals.taskMarkedComplete).toBe(false);
      expect(signals.testsAllPassed).toBe(false);
      expect(signals.buildSucceeded).toBe(false);
      expect(signals.commitMade).toBe(false);
      expect(signals.prCreated).toBe(false);
    });
  });

  describe('detectErrorPatterns', () => {
    it('should detect TypeScript compile errors', () => {
      const output = `error TS2339: Property 'foo' does not exist on type 'Bar'`;
      const signals = analyzer.detectErrorPatterns(output);
      expect(signals.hasError).toBe(true);
      expect(signals.errorType).toBe('compile');
    });

    it('should detect module not found errors', () => {
      const output = 'Cannot find module "@/services/api"';
      const signals = analyzer.detectErrorPatterns(output);
      expect(signals.hasError).toBe(true);
      expect(signals.errorType).toBe('compile');
      expect(signals.suggestedFix).toContain('npm install');
    });

    it('should detect test failures', () => {
      const output = 'FAIL src/components/Button.test.tsx\n  ✕ should render correctly\n  AssertionError: expected 1 to equal 2';
      const signals = analyzer.detectErrorPatterns(output);
      expect(signals.hasError).toBe(true);
      expect(signals.errorType).toBe('test');
    });

    it('should detect runtime errors', () => {
      const output = 'TypeError: Cannot read property "x" of undefined\n  at Object.<anonymous> (src/index.js:10:5)';
      const signals = analyzer.detectErrorPatterns(output);
      expect(signals.hasError).toBe(true);
      expect(signals.errorType).toBe('runtime');
    });

    it('should detect permission errors', () => {
      const output = 'EACCES: permission denied, open "/etc/passwd"';
      const signals = analyzer.detectErrorPatterns(output);
      expect(signals.hasError).toBe(true);
      expect(signals.errorType).toBe('permission');
      expect(signals.suggestedFix).toContain('permission');
    });

    it('should extract error message', () => {
      const output = 'Some text\nerror TS2339: Property "foo" does not exist\nMore context\nEven more';
      const signals = analyzer.detectErrorPatterns(output);
      expect(signals.errorMessage).toContain('error TS2339');
    });

    it('should extract stack trace', () => {
      const output = `
        Error: Something went wrong
          at Object.<anonymous> (/path/to/file.js:10:5)
          at Module._compile (internal/modules/cjs/loader.js:1085:14)
      `;
      const signals = analyzer.detectErrorPatterns(output);
      expect(signals.stackTrace).toBeDefined();
      expect(signals.stackTrace).toContain('at Object.<anonymous>');
    });

    it('should return no error for clean output', () => {
      const output = 'Everything is working fine!';
      const signals = analyzer.detectErrorPatterns(output);
      expect(signals.hasError).toBe(false);
    });
  });

  describe('detectWaitingSignals', () => {
    it('should detect waiting for input', () => {
      const output = 'Waiting for user input...';
      const signals = analyzer.detectWaitingSignals(output);
      expect(signals.waitingForInput).toBe(true);
    });

    it('should detect question ending with question mark', () => {
      const output = 'What should I do next?';
      const signals = analyzer.detectWaitingSignals(output);
      expect(signals.askingQuestion).toBe(true);
    });

    it('should detect waiting for approval', () => {
      const output = 'Ready for review. Waiting for approval.';
      const signals = analyzer.detectWaitingSignals(output);
      expect(signals.waitingForApproval).toBe(true);
    });

    it('should detect waiting for another agent', () => {
      const output = 'Blocked by team-frontend completing their task';
      const signals = analyzer.detectWaitingSignals(output);
      expect(signals.waitingForOtherAgent).toBe(true);
    });

    it('should provide waiting reason', () => {
      const output = 'Please provide the API key';
      const signals = analyzer.detectWaitingSignals(output);
      expect(signals.waitingForInput).toBe(true);
      expect(signals.waitingReason).toBe('Waiting for user input');
    });

    it('should return no waiting signals for active output', () => {
      const output = 'Building the project...\nCompiling TypeScript...\nRunning tests...';
      const signals = analyzer.detectWaitingSignals(output);
      expect(signals.waitingForInput).toBe(false);
      expect(signals.waitingForApproval).toBe(false);
      expect(signals.askingQuestion).toBe(false);
      expect(signals.waitingForOtherAgent).toBe(false);
    });
  });

  describe('detectIdleState', () => {
    it('should detect shell prompt', () => {
      const output = 'Some output here\nuser@host:~/project$ ';
      expect(analyzer.detectIdleState(output)).toBe(true);
    });

    it('should detect zsh prompt', () => {
      const output = 'Some output here\n❯ ';
      expect(analyzer.detectIdleState(output)).toBe(true);
    });

    it('should detect Claude exit', () => {
      const output = 'Claude Code exited. Goodbye!';
      expect(analyzer.detectIdleState(output)).toBe(true);
    });

    it('should detect session ended', () => {
      const output = 'Session ended normally.';
      expect(analyzer.detectIdleState(output)).toBe(true);
    });

    it('should return false for active output', () => {
      const output = 'Running npm test...\nExecuting tests...\nProcessing...';
      expect(analyzer.detectIdleState(output)).toBe(false);
    });
  });

  describe('analyze', () => {
    it('should return TASK_COMPLETE when complete_task is called', async () => {
      const output = 'Work finished. [complete_task] Task marked complete.';
      const analysis = await analyzer.analyze('test-session', output);

      expect(analysis.conclusion).toBe('TASK_COMPLETE');
      expect(analysis.confidence).toBeGreaterThanOrEqual(0.9);
      expect(analysis.recommendation).toBe('assign_next_task');
      expect(analysis.evidence).toContain('Agent called complete_task tool');
    });

    it('should return TASK_COMPLETE when tests pass and build succeeds with commit', async () => {
      const output = `
        Running tests...
        Test Suites: 10 passed, 0 failed
        Tests: 50 passed, 0 failing
        webpack compiled successfully
        [main abc1234] Complete feature implementation
        3 files changed, 100 insertions(+), 20 deletions(-)
      `;
      const analysis = await analyzer.analyze('test-session', output);

      expect(analysis.conclusion).toBe('TASK_COMPLETE');
      expect(analysis.evidence).toContain('All tests passed');
      expect(analysis.evidence).toContain('Build succeeded');
      expect(analysis.evidence).toContain('Commit made');
    });

    it('should return INCOMPLETE when tests pass but no commit', async () => {
      const output = `
        Test Suites: 10 passed, 0 failed
        Tests: 50 passed, 0 failing
        webpack compiled successfully
      `;
      const analysis = await analyzer.analyze('test-session', output);

      expect(analysis.conclusion).toBe('INCOMPLETE');
      expect(analysis.recommendation).toBe('inject_prompt');
      expect(analysis.evidence).toContain('No commit detected - may need to commit');
    });

    it('should return STUCK_OR_ERROR when errors are detected', async () => {
      const output = `
        error TS2339: Property 'foo' does not exist on type 'Bar'
          at src/components/Widget.tsx:15:10
      `;
      const analysis = await analyzer.analyze('test-session', output);

      expect(analysis.conclusion).toBe('STUCK_OR_ERROR');
      expect(analysis.recommendation).toBe('retry_with_hints');
    });

    it('should return WAITING_INPUT when agent is asking questions', async () => {
      const output = 'I need more information. What database should I use?';
      const analysis = await analyzer.analyze('test-session', output);

      expect(analysis.conclusion).toBe('WAITING_INPUT');
      expect(analysis.recommendation).toBe('notify_owner');
    });

    it('should return INCOMPLETE when session is idle', async () => {
      const output = 'Task started...\nDone with part 1.\nuser@host:~/project$ ';
      const analysis = await analyzer.analyze('test-session', output);

      expect(analysis.conclusion).toBe('INCOMPLETE');
      expect(analysis.recommendation).toBe('inject_prompt');
    });

    it('should return MAX_ITERATIONS when limit is reached', async () => {
      const output = 'Still working...';
      const analysis = await analyzer.analyze('test-session', output, {
        iterations: 10,
      });

      expect(analysis.conclusion).toBe('MAX_ITERATIONS');
      expect(analysis.confidence).toBe(1.0);
      expect(analysis.recommendation).toBe('notify_owner');
    });

    it('should include current task in analysis', async () => {
      const currentTask = {
        id: 'task-1',
        title: 'Fix the bug',
        status: 'in_progress' as const,
        path: '/path/to/task.md',
      };

      const analysis = await analyzer.analyze('test-session', 'Working on task...', {
        currentTask,
      });

      expect(analysis.currentTask).toEqual(currentTask);
    });

    it('should handle exit code 0 as incomplete', async () => {
      const params = {
        sessionName: 'test-session',
        output: 'Process finished.',
        exitCode: 0,
      };

      const analysis = await analyzer.analyzeWithParams(params);

      expect(analysis.conclusion).toBe('INCOMPLETE');
      expect(analysis.evidence).toContain('Process exited with code 0');
    });

    it('should handle non-zero exit code as error', async () => {
      const params = {
        sessionName: 'test-session',
        output: 'Process crashed.',
        exitCode: 1,
      };

      const analysis = await analyzer.analyzeWithParams(params);

      expect(analysis.conclusion).toBe('STUCK_OR_ERROR');
      expect(analysis.evidence).toContain('Process exited with code 1');
    });

    it('should return UNKNOWN for ambiguous output', async () => {
      const output = 'Processing data...';
      const analysis = await analyzer.analyze('test-session', output);

      expect(analysis.conclusion).toBe('UNKNOWN');
    });
  });

  describe('edge cases', () => {
    it('should handle empty output', async () => {
      const analysis = await analyzer.analyze('test-session', '');
      expect(analysis).toBeDefined();
      expect(analysis.conclusion).toBe('UNKNOWN');
    });

    it('should handle very long output', async () => {
      const longOutput = 'Log line\n'.repeat(10000) + 'user@host:~/project$ ';
      const analysis = await analyzer.analyze('test-session', longOutput);
      expect(analysis.conclusion).toBe('INCOMPLETE'); // Detected shell prompt
    });

    it('should prioritize explicit task completion over errors', async () => {
      const output = `
        There was a warning earlier
        error TS1234: Some error
        But then [complete_task] was called
      `;
      const analysis = await analyzer.analyze('test-session', output);
      // Task completion should win
      expect(analysis.conclusion).toBe('TASK_COMPLETE');
    });

    it('should handle mixed signals appropriately', async () => {
      const output = `
        Test Suites: 5 passed, 2 failed
        Tests: 40 passed, 3 failing
      `;
      const analysis = await analyzer.analyze('test-session', output);
      // Test failures should be detected as error
      expect(analysis.conclusion).toBe('STUCK_OR_ERROR');
      expect(analysis.evidence).toContain('Error detected: test');
    });
  });
});
