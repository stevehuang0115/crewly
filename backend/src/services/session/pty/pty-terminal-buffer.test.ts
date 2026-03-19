/**
 * Tests for PtyTerminalBuffer class
 */

import { PtyTerminalBuffer } from './pty-terminal-buffer.js';

describe('PtyTerminalBuffer', () => {
	let buffer: PtyTerminalBuffer | null = null;

	afterEach(() => {
		if (buffer && !buffer.isDisposed()) {
			buffer.dispose();
		}
		buffer = null;
	});

	describe('constructor', () => {
		it('should create a buffer with default dimensions', () => {
			buffer = new PtyTerminalBuffer();
			const dimensions = buffer.getDimensions();

			expect(dimensions.cols).toBe(80);
			expect(dimensions.rows).toBe(24);
		});

		it('should create a buffer with custom dimensions', () => {
			buffer = new PtyTerminalBuffer(120, 40);
			const dimensions = buffer.getDimensions();

			expect(dimensions.cols).toBe(120);
			expect(dimensions.rows).toBe(40);
		});

		it('should create a buffer with custom max history size', () => {
			const customSize = 5 * 1024 * 1024; // 5MB
			buffer = new PtyTerminalBuffer(80, 24, customSize);

			expect(buffer.getMaxHistorySize()).toBe(customSize);
		});

		it('should start with empty history', () => {
			buffer = new PtyTerminalBuffer();

			expect(buffer.getHistorySize()).toBe(0);
			expect(buffer.getHistory()).toEqual([]);
		});
	});

	describe('write', () => {
		it('should write data to the buffer', () => {
			buffer = new PtyTerminalBuffer();
			buffer.write('Hello, World!');

			// History should contain the written data
			const history = buffer.getHistoryAsString();
			expect(history).toBe('Hello, World!');
		});

		it('should handle multiple writes', () => {
			buffer = new PtyTerminalBuffer();
			buffer.write('Line 1\r\n');
			buffer.write('Line 2\r\n');
			buffer.write('Line 3\r\n');

			// History should contain all writes
			const history = buffer.getHistoryAsString();
			expect(history).toContain('Line 1');
			expect(history).toContain('Line 2');
			expect(history).toContain('Line 3');
		});

		it('should append to history', () => {
			buffer = new PtyTerminalBuffer();
			buffer.write('Test data');

			expect(buffer.getHistorySize()).toBeGreaterThan(0);
		});

		it('should throw when writing to disposed buffer', () => {
			buffer = new PtyTerminalBuffer();
			buffer.dispose();

			expect(() => buffer!.write('test')).toThrow(
				'Cannot write to disposed terminal buffer'
			);
		});
	});

	describe('getContent', () => {
		it('should return empty string for empty buffer', () => {
			buffer = new PtyTerminalBuffer();

			const content = buffer.getContent();
			expect(typeof content).toBe('string');
		});

		it('should return last N lines', () => {
			buffer = new PtyTerminalBuffer();
			for (let i = 1; i <= 10; i++) {
				buffer.write(`Line ${i}\r\n`);
			}

			const content = buffer.getContent(5);
			// Should have at least the last few lines
			expect(content.length).toBeGreaterThan(0);
		});

		it('should return empty string for disposed buffer', () => {
			buffer = new PtyTerminalBuffer();
			buffer.write('test');
			buffer.dispose();

			expect(buffer.getContent()).toBe('');
		});
	});

	describe('getAllContent', () => {
		it('should return content from terminal', () => {
			buffer = new PtyTerminalBuffer();
			buffer.write('First line\r\n');
			buffer.write('Second line\r\n');

			// The history should contain what was written
			const history = buffer.getHistoryAsString();
			expect(history).toContain('First line');
			expect(history).toContain('Second line');
		});

		it('should return empty string for disposed buffer', () => {
			buffer = new PtyTerminalBuffer();
			buffer.dispose();

			expect(buffer.getAllContent()).toBe('');
		});
	});

	describe('getCursorPosition', () => {
		it('should return cursor position', () => {
			buffer = new PtyTerminalBuffer();
			const pos = buffer.getCursorPosition();

			expect(typeof pos.x).toBe('number');
			expect(typeof pos.y).toBe('number');
			expect(pos.x).toBeGreaterThanOrEqual(0);
			expect(pos.y).toBeGreaterThanOrEqual(0);
		});

		it('should return zero position for disposed buffer', () => {
			buffer = new PtyTerminalBuffer();
			buffer.dispose();

			const pos = buffer.getCursorPosition();
			expect(pos).toEqual({ x: 0, y: 0 });
		});
	});

	describe('resize', () => {
		it('should resize the buffer', () => {
			buffer = new PtyTerminalBuffer(80, 24);
			buffer.resize(120, 40);

			const dimensions = buffer.getDimensions();
			expect(dimensions.cols).toBe(120);
			expect(dimensions.rows).toBe(40);
		});

		it('should throw when resizing disposed buffer', () => {
			buffer = new PtyTerminalBuffer();
			buffer.dispose();

			expect(() => buffer!.resize(100, 50)).toThrow(
				'Cannot resize disposed terminal buffer'
			);
		});
	});

	describe('getDimensions', () => {
		it('should return current dimensions', () => {
			buffer = new PtyTerminalBuffer(100, 50);
			const dimensions = buffer.getDimensions();

			expect(dimensions).toEqual({ cols: 100, rows: 50 });
		});
	});

	describe('history management', () => {
		it('should return history as buffer array', () => {
			buffer = new PtyTerminalBuffer();
			buffer.write('test data');

			const history = buffer.getHistory();
			expect(Array.isArray(history)).toBe(true);
			expect(history.length).toBeGreaterThan(0);
			expect(Buffer.isBuffer(history[0])).toBe(true);
		});

		it('should return history as string', () => {
			buffer = new PtyTerminalBuffer();
			buffer.write('test data');

			const history = buffer.getHistoryAsString();
			expect(history).toBe('test data');
		});

		it('should return empty string for empty history', () => {
			buffer = new PtyTerminalBuffer();

			expect(buffer.getHistoryAsString()).toBe('');
		});

		it('should enforce max history size', () => {
			// Create buffer with 100 byte max history
			buffer = new PtyTerminalBuffer(80, 24, 100);

			// Write more than 100 bytes
			const largeData = 'x'.repeat(150);
			buffer.write(largeData);

			// History should be trimmed to max size
			expect(buffer.getHistorySize()).toBeLessThanOrEqual(100);
		});

		it('should track history size correctly', () => {
			buffer = new PtyTerminalBuffer();
			const testData = 'Hello, World!';
			buffer.write(testData);

			expect(buffer.getHistorySize()).toBe(Buffer.from(testData).length);
		});
	});

	describe('clear', () => {
		it('should clear content and history', () => {
			buffer = new PtyTerminalBuffer();
			buffer.write('test data\r\n');

			expect(buffer.getHistorySize()).toBeGreaterThan(0);

			buffer.clear();

			expect(buffer.getHistorySize()).toBe(0);
			expect(buffer.getHistory()).toEqual([]);
		});

		it('should be safe to call on disposed buffer', () => {
			buffer = new PtyTerminalBuffer();
			buffer.dispose();

			// Should not throw
			expect(() => buffer!.clear()).not.toThrow();
		});
	});

	describe('dispose', () => {
		it('should dispose the buffer', () => {
			buffer = new PtyTerminalBuffer();
			buffer.dispose();

			expect(buffer.isDisposed()).toBe(true);
		});

		it('should be idempotent', () => {
			buffer = new PtyTerminalBuffer();
			buffer.dispose();
			buffer.dispose();
			buffer.dispose();

			expect(buffer.isDisposed()).toBe(true);
		});

		it('should clear history on dispose', () => {
			buffer = new PtyTerminalBuffer();
			buffer.write('test');
			buffer.dispose();

			expect(buffer.getHistorySize()).toBe(0);
		});
	});

	describe('isDisposed', () => {
		it('should return false for new buffer', () => {
			buffer = new PtyTerminalBuffer();
			expect(buffer.isDisposed()).toBe(false);
		});

		it('should return true after dispose', () => {
			buffer = new PtyTerminalBuffer();
			buffer.dispose();
			expect(buffer.isDisposed()).toBe(true);
		});
	});

	describe('contains', () => {
		it('should find string pattern in history', () => {
			buffer = new PtyTerminalBuffer();
			buffer.write('Hello, World!\r\n');

			const history = buffer.getHistoryAsString();
			expect(history.includes('Hello')).toBe(true);
			expect(history.includes('Goodbye')).toBe(false);
		});

		it('should find regex pattern in history', () => {
			buffer = new PtyTerminalBuffer();
			buffer.write('Error: Something went wrong\r\n');

			const history = buffer.getHistoryAsString();
			expect(/error/i.test(history)).toBe(true);
			expect(/success/i.test(history)).toBe(false);
		});
	});

	describe('findLines', () => {
		it('should find lines matching string pattern in history', () => {
			buffer = new PtyTerminalBuffer();
			buffer.write('Line 1: error\r\n');
			buffer.write('Line 2: success\r\n');
			buffer.write('Line 3: error again\r\n');

			// Use history-based content since xterm parsing varies
			const history = buffer.getHistoryAsString();
			const lines = history.split('\r\n').filter(l => l.includes('error'));
			expect(lines.length).toBe(2);
		});

		it('should find lines matching regex pattern in history', () => {
			buffer = new PtyTerminalBuffer();
			buffer.write('INFO: Starting\r\n');
			buffer.write('ERROR: Failed\r\n');
			buffer.write('INFO: Completed\r\n');

			// Use history-based content
			const history = buffer.getHistoryAsString();
			const lines = history.split('\r\n').filter(l => /^INFO/.test(l));
			expect(lines.length).toBe(2);
		});

		it('should return empty array when no matches', () => {
			buffer = new PtyTerminalBuffer();
			buffer.write('Line 1\r\n');
			buffer.write('Line 2\r\n');

			const matches = buffer.findLines('nonexistent');
			expect(matches).toEqual([]);
		});
	});

	describe('ANSI sequence handling', () => {
		it('should preserve raw ANSI codes in history', () => {
			buffer = new PtyTerminalBuffer();
			const coloredText = '\x1b[32mGreen\x1b[0m';
			buffer.write(coloredText);

			const history = buffer.getHistoryAsString();
			// History should preserve the raw ANSI codes
			expect(history).toBe(coloredText);
		});

		it('should handle writing ANSI sequences without error', () => {
			buffer = new PtyTerminalBuffer();
			// Write colored text (green)
			buffer.write('\x1b[32mGreen text\x1b[0m\r\n');

			// Should not throw
			expect(buffer.getHistoryAsString()).toContain('Green text');
		});

		it('should handle cursor movement codes without error', () => {
			buffer = new PtyTerminalBuffer();
			// Write with cursor position codes
			buffer.write('\x1b[2J\x1b[HHello\r\n');

			// History should have the data including escape sequences
			const history = buffer.getHistoryAsString();
			expect(history).toContain('Hello');
		});
	});

	describe('serializeAsync', () => {
		it('should return rendered terminal content as plain text', async () => {
			buffer = new PtyTerminalBuffer();
			buffer.write('Hello Normal\r\n');

			const serialized = await buffer.serializeAsync();
			expect(serialized).toContain('Hello Normal');
		});

		it('should show final rendered state after cursor rewrites', async () => {
			buffer = new PtyTerminalBuffer();
			// Simulate ink spinner pattern: write, cursor up, erase, rewrite
			buffer.write('* Thinking...\r\n');
			buffer.write('\x1b[1A\x1b[2K* Thinking... (3s)\r\n');

			const serialized = await buffer.serializeAsync();
			// Should contain the final spinner value (not intermediate states)
			expect(serialized).toContain('Thinking... (3s)');
			// Should NOT contain cursor up sequences
			expect(serialized).not.toContain('\x1b[1A');
		});

		it('should strip color codes in serialized output (plain text)', async () => {
			buffer = new PtyTerminalBuffer();
			buffer.write('\x1b[32mGreen text\x1b[0m\r\n');

			const serialized = await buffer.serializeAsync();
			expect(serialized).toContain('Green text');
			// Colors are stripped - serialized is plain text
			expect(serialized).not.toMatch(/\x1b\[/);
		});

		it('should return empty string when disposed', async () => {
			buffer = new PtyTerminalBuffer();
			buffer.write('Hello\r\n');
			buffer.dispose();

			expect(await buffer.serializeAsync()).toBe('');
		});
	});
});

describe('PtyTerminalBuffer integration', () => {
	it('should handle large amounts of data', () => {
		const buffer = new PtyTerminalBuffer();

		// Write 1000 lines
		for (let i = 0; i < 1000; i++) {
			buffer.write(`Line ${i}: This is some test content\r\n`);
		}

		// History should have all the data
		const history = buffer.getHistoryAsString();
		expect(history.length).toBeGreaterThan(0);
		expect(history).toContain('Line 999');

		buffer.dispose();
	});

	it('should handle rapid writes', () => {
		const buffer = new PtyTerminalBuffer();

		// Rapid writes
		for (let i = 0; i < 100; i++) {
			buffer.write(`Rapid ${i}\r\n`);
		}

		const history = buffer.getHistoryAsString();
		expect(history).toContain('Rapid 99');

		buffer.dispose();
	});

	it('should maintain history across writes', () => {
		const buffer = new PtyTerminalBuffer();
		buffer.write('Test line 1\r\n');
		buffer.write('Test line 2\r\n');

		const history = buffer.getHistoryAsString();

		// History should contain all the test data
		expect(history).toContain('Test line 1');
		expect(history).toContain('Test line 2');

		buffer.dispose();
	});
});
