import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { InProcessLogBuffer } from './in-process-log-buffer.js';

// Constants inlined here too — the standalone runtime owns its own values.
const CREWLY_CONSTANTS = {
  PATHS: {
    CREWLY_HOME: '.crewly',
    LOGS_DIR: 'logs',
  },
} as const;

const LOG_ROTATION_CONSTANTS = {
  SESSIONS_LOG_DIR: 'sessions',
} as const;

describe('InProcessLogBuffer', () => {
  let buffer: InProcessLogBuffer;

  beforeEach(() => {
    InProcessLogBuffer.resetInstance();
    buffer = InProcessLogBuffer.getInstance();
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      const a = InProcessLogBuffer.getInstance();
      const b = InProcessLogBuffer.getInstance();
      expect(a).toBe(b);
    });

    it('should return new instance after reset', () => {
      const a = InProcessLogBuffer.getInstance();
      InProcessLogBuffer.resetInstance();
      const b = InProcessLogBuffer.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('append', () => {
    it('should create session on first append', () => {
      expect(buffer.hasSession('test')).toBe(false);
      buffer.append('test', 'info', 'hello');
      expect(buffer.hasSession('test')).toBe(true);
    });

    it('should enforce ring buffer limit', () => {
      for (let i = 0; i < 600; i++) {
        buffer.append('test', 'info', `line ${i}`);
      }
      const output = buffer.capture('test', 600);
      const lines = output.split('\n');
      expect(lines.length).toBe(500);
      expect(lines[lines.length - 1]).toContain('line 599');
    });
  });

  describe('capture', () => {
    it('should return placeholder for empty session', () => {
      buffer.registerSession('empty');
      const output = buffer.capture('empty');
      expect(output).toContain('No output yet');
    });

    it('should return placeholder for unknown session', () => {
      const output = buffer.capture('nonexistent');
      expect(output).toContain('No output yet');
    });

    it('should format entries with timestamps', () => {
      buffer.append('test', 'info', 'hello world');
      const output = buffer.capture('test');
      expect(output).toMatch(/\[\d{2}:\d{2}:\d{2}\.\d{3}\] hello world/);
    });

    it('should prefix error and warn levels', () => {
      buffer.append('test', 'error', 'something broke');
      buffer.append('test', 'warn', 'be careful');
      buffer.append('test', 'debug', 'details');
      const output = buffer.capture('test');
      expect(output).toContain('ERROR: something broke');
      expect(output).toContain('WARN: be careful');
      expect(output).toContain('DEBUG: details');
    });

    it('should respect lines parameter', () => {
      buffer.append('test', 'info', 'line 1');
      buffer.append('test', 'info', 'line 2');
      buffer.append('test', 'info', 'line 3');
      const output = buffer.capture('test', 2);
      const lines = output.split('\n');
      expect(lines.length).toBe(2);
      expect(lines[1]).toContain('line 3');
    });
  });

  describe('session management', () => {
    it('should register empty session', () => {
      buffer.registerSession('new');
      expect(buffer.hasSession('new')).toBe(true);
      expect(buffer.capture('new')).toContain('No output yet');
    });

    it('should remove session', () => {
      buffer.append('test', 'info', 'data');
      buffer.removeSession('test');
      expect(buffer.hasSession('test')).toBe(false);
    });

    it('should list session names', () => {
      buffer.registerSession('a');
      buffer.registerSession('b');
      buffer.append('c', 'info', 'test');
      expect(buffer.getSessionNames().sort()).toEqual(['a', 'b', 'c']);
    });

    it('should clear all sessions', () => {
      buffer.registerSession('a');
      buffer.registerSession('b');
      buffer.clear();
      expect(buffer.getSessionNames()).toEqual([]);
    });
  });

  describe('EventEmitter data events', () => {
    it('should emit data event on append', () => new Promise<void>((resolve, reject) => {
      buffer.on('data', (sessionName: string, formattedLine: string) => {
        try {
          expect(sessionName).toBe('test-session');
          expect(formattedLine).toContain('hello world');
          expect(formattedLine).toMatch(/\[\d{2}:\d{2}:\d{2}\.\d{3}\] hello world/);
          resolve();
        } catch (err) { reject(err); }
      });
      buffer.append('test-session', 'info', 'hello world');
    }));

    it('should emit data event with level prefix for errors', () => new Promise<void>((resolve, reject) => {
      buffer.on('data', (sessionName: string, formattedLine: string) => {
        try {
          expect(sessionName).toBe('test-session');
          expect(formattedLine).toContain('ERROR: something broke');
          resolve();
        } catch (err) { reject(err); }
      });
      buffer.append('test-session', 'error', 'something broke');
    }));

    it('should emit data events for each append', () => {
      const events: string[] = [];
      buffer.on('data', (_session: string, line: string) => {
        events.push(line);
      });

      buffer.append('s1', 'info', 'first');
      buffer.append('s2', 'warn', 'second');

      expect(events.length).toBe(2);
      expect(events[0]).toContain('first');
      expect(events[1]).toContain('WARN: second');
    });

    it('should include session name in data event', () => {
      const sessions: string[] = [];
      buffer.on('data', (session: string) => {
        sessions.push(session);
      });

      buffer.append('agent-a', 'info', 'msg1');
      buffer.append('agent-b', 'info', 'msg2');

      expect(sessions).toEqual(['agent-a', 'agent-b']);
    });

    it('should clean up listeners on reset', () => {
      const handler = vi.fn();
      buffer.on('data', handler);

      InProcessLogBuffer.resetInstance();
      const newBuffer = InProcessLogBuffer.getInstance();
      newBuffer.append('test', 'info', 'after reset');

      // Old handler should NOT be called since instance was reset
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('file persistence', () => {
    const sessionLogsDir = path.join(
      os.homedir(),
      CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
      CREWLY_CONSTANTS.PATHS.LOGS_DIR,
      LOG_ROTATION_CONSTANTS.SESSIONS_LOG_DIR,
    );

    const testSessionName = `__test-inprocess-${Date.now()}`;

    afterEach(() => {
      // Clean up test log file
      const logPath = path.join(sessionLogsDir, `${testSessionName}.log`);
      try { fs.unlinkSync(logPath); } catch { /* may not exist */ }
    });

    it('should create a log file on registerSession', (done) => {
      buffer.registerSession(testSessionName);
      const logPath = path.join(sessionLogsDir, `${testSessionName}.log`);
      // WriteStream opens the file lazily — give it a tick to flush the header
      setTimeout(() => {
        expect(fs.existsSync(logPath)).toBe(true);
        done();
      }, 100);
    });

    it('should write log entries to disk on append', (done) => {
      buffer.registerSession(testSessionName);
      buffer.append(testSessionName, 'info', 'disk test message');
      buffer.append(testSessionName, 'error', 'disk error message');

      // WriteStream is async — give it a tick to flush
      setTimeout(() => {
        const logPath = path.join(sessionLogsDir, `${testSessionName}.log`);
        const content = fs.readFileSync(logPath, 'utf8');
        expect(content).toContain('SESSION STARTED');
        expect(content).toContain('disk test message');
        expect(content).toContain('ERROR: disk error message');
        done();
      }, 100);
    });

    it('should write SESSION ENDED marker on removeSession', (done) => {
      buffer.registerSession(testSessionName);
      buffer.append(testSessionName, 'info', 'before shutdown');
      buffer.removeSession(testSessionName);

      setTimeout(() => {
        const logPath = path.join(sessionLogsDir, `${testSessionName}.log`);
        const content = fs.readFileSync(logPath, 'utf8');
        expect(content).toContain('SESSION ENDED');
        done();
      }, 100);
    });

    it('should write RESTARTED marker when session is re-registered', (done) => {
      buffer.registerSession(testSessionName);
      buffer.append(testSessionName, 'info', 'first run');
      buffer.removeSession(testSessionName);

      // Re-register same session (simulates restart)
      setTimeout(() => {
        buffer.registerSession(testSessionName);
        buffer.append(testSessionName, 'info', 'second run');

        setTimeout(() => {
          const logPath = path.join(sessionLogsDir, `${testSessionName}.log`);
          const content = fs.readFileSync(logPath, 'utf8');
          expect(content).toContain('SESSION STARTED');
          expect(content).toContain('first run');
          expect(content).toContain('SESSION RESTARTED');
          expect(content).toContain('second run');
          done();
        }, 100);
      }, 100);
    });

    it('should include full ISO timestamp in file entries', (done) => {
      buffer.registerSession(testSessionName);
      buffer.append(testSessionName, 'info', 'timestamp check');

      setTimeout(() => {
        const logPath = path.join(sessionLogsDir, `${testSessionName}.log`);
        const content = fs.readFileSync(logPath, 'utf8');
        // File entries should have full ISO timestamp like "2026-03-18T16:01:00.000Z"
        expect(content).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z.*timestamp check/);
        done();
      }, 100);
    });
  });
});
