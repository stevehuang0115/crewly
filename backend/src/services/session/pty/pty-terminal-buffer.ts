/**
 * PTY Terminal Buffer Module
 *
 * Provides a virtual terminal buffer using @xterm/headless for parsing ANSI sequences
 * and maintaining output history with memory bounds.
 *
 * @module pty-terminal-buffer
 */

import * as XtermHeadless from '@xterm/headless';
import type { Terminal as TerminalType } from '@xterm/headless';
import {
	DEFAULT_TERMINAL_COLS,
	DEFAULT_TERMINAL_ROWS,
} from '../session-backend.interface.js';
import { PTY_CONSTANTS } from '../../../constants.js';

/**
 * Terminal buffer manager using @xterm/headless.
 *
 * This class wraps @xterm/headless to provide:
 * - ANSI sequence parsing for accurate text extraction
 * - Parsed terminal content retrieval
 * - Raw output history for replay
 * - Memory-bounded storage
 *
 * @example
 * ```typescript
 * const buffer = new PtyTerminalBuffer(120, 40);
 *
 * // Write data (including ANSI sequences)
 * buffer.write('\x1b[32mHello, World!\x1b[0m\r\n');
 *
 * // Get parsed content
 * const content = buffer.getContent(50);
 * console.log(content); // "Hello, World!"
 *
 * // Get raw history for replay
 * const history = buffer.getHistoryAsString();
 * ```
 */
export class PtyTerminalBuffer {
	/**
	 * Handles both ESM named export and CJS default export interop in tests/runtime.
	 */
	private static readonly TerminalCtor = ((XtermHeadless as unknown as {
		Terminal: new (options: Record<string, unknown>) => TerminalType;
		default?: { Terminal: new (options: Record<string, unknown>) => TerminalType };
	}).Terminal ??
		(XtermHeadless as unknown as {
			default?: { Terminal: new (options: Record<string, unknown>) => TerminalType };
		}).default?.Terminal) as new (options: Record<string, unknown>) => TerminalType;
	/**
	 * The @xterm/headless Terminal instance
	 */
	private terminal: TerminalType;

	/**
	 * Raw output history as buffer chunks
	 */
	private outputHistory: Buffer[] = [];

	/**
	 * Current total size of output history in bytes
	 */
	private currentHistorySize = 0;

	/**
	 * Maximum history size in bytes
	 */
	private readonly maxHistorySize: number;

	/**
	 * Whether the buffer has been disposed
	 */
	private disposed = false;

	/**
	 * Create a new terminal buffer.
	 *
	 * @param cols - Number of columns (width). Defaults to 80.
	 * @param rows - Number of rows (height). Defaults to 24.
	 * @param maxHistorySize - Maximum history size in bytes. Defaults to 10MB.
	 *
	 * @example
	 * ```typescript
	 * // Default size terminal
	 * const buffer1 = new PtyTerminalBuffer();
	 *
	 * // Custom size with custom history limit
	 * const buffer2 = new PtyTerminalBuffer(120, 40, 5 * 1024 * 1024);
	 * ```
	 */
	constructor(
		cols: number = DEFAULT_TERMINAL_COLS,
		rows: number = DEFAULT_TERMINAL_ROWS,
		maxHistorySize: number = PTY_CONSTANTS.DEFAULT_MAX_HISTORY_SIZE
	) {
		this.maxHistorySize = maxHistorySize;
		this.terminal = new PtyTerminalBuffer.TerminalCtor({
			cols,
			rows,
			scrollback: PTY_CONSTANTS.DEFAULT_SCROLLBACK,
			allowProposedApi: true,
		});
	}

	/**
	 * Write data to the terminal buffer.
	 *
	 * The data is written to both the xterm terminal (for parsing) and
	 * the raw history buffer (for replay).
	 *
	 * @param data - String data to write (may include ANSI sequences)
	 * @throws Error if buffer has been disposed
	 *
	 * @example
	 * ```typescript
	 * buffer.write('\x1b[32mGreen text\x1b[0m\r\n');
	 * buffer.write('Plain text\r\n');
	 * ```
	 */
	write(data: string): void {
		if (this.disposed) {
			throw new Error('Cannot write to disposed terminal buffer');
		}

		// Write to xterm for parsing
		this.terminal.write(data);

		// Append to raw history
		this.appendHistory(data);
	}

	/**
	 * Get parsed terminal content.
	 *
	 * This extracts the visible text from the terminal buffer, with ANSI
	 * sequences parsed and removed. The result is the actual displayed text.
	 *
	 * @param maxLines - Maximum number of lines to retrieve. Defaults to 100.
	 * @returns Parsed terminal content as a string
	 *
	 * @example
	 * ```typescript
	 * const content = buffer.getContent(50);
	 * console.log('Last 50 lines:', content);
	 * ```
	 */
	getContent(maxLines = 100): string {
		if (this.disposed) {
			return '';
		}

		const activeBuffer = this.terminal.buffer.active;
		const lines: string[] = [];

		// Calculate starting line
		const totalLines = activeBuffer.length;
		const startLine = Math.max(0, totalLines - maxLines);

		// Extract lines
		for (let i = startLine; i < totalLines; i++) {
			const line = activeBuffer.getLine(i);
			if (line) {
				// translateToString(true) trims trailing whitespace
				lines.push(line.translateToString(true));
			}
		}

		return lines.join('\n');
	}

	/**
	 * Get all available terminal content.
	 *
	 * @returns All parsed terminal content
	 */
	getAllContent(): string {
		if (this.disposed) {
			return '';
		}

		const activeBuffer = this.terminal.buffer.active;
		return this.getContent(activeBuffer.length);
	}

	/**
	 * Get the current cursor position.
	 *
	 * @returns Object with x (column) and y (row) cursor position
	 */
	getCursorPosition(): { x: number; y: number } {
		if (this.disposed) {
			return { x: 0, y: 0 };
		}

		const activeBuffer = this.terminal.buffer.active;
		return {
			x: activeBuffer.cursorX,
			y: activeBuffer.cursorY,
		};
	}

	/**
	 * Resize the terminal buffer.
	 *
	 * @param cols - New number of columns
	 * @param rows - New number of rows
	 * @throws Error if buffer has been disposed
	 *
	 * @example
	 * ```typescript
	 * buffer.resize(120, 40);
	 * ```
	 */
	resize(cols: number, rows: number): void {
		if (this.disposed) {
			throw new Error('Cannot resize disposed terminal buffer');
		}

		this.terminal.resize(cols, rows);
	}

	/**
	 * Get current terminal dimensions.
	 *
	 * @returns Object with cols and rows
	 */
	getDimensions(): { cols: number; rows: number } {
		return {
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		};
	}

	/**
	 * Get raw output history as buffer chunks.
	 *
	 * This returns the raw bytes written to the buffer, including ANSI
	 * sequences. Useful for replaying the session.
	 *
	 * @returns Array of Buffer chunks representing raw output
	 *
	 * @example
	 * ```typescript
	 * const chunks = buffer.getHistory();
	 * const totalSize = chunks.reduce((sum, b) => sum + b.length, 0);
	 * ```
	 */
	getHistory(): Buffer[] {
		return [...this.outputHistory];
	}

	/**
	 * Get raw output history as a single string.
	 *
	 * This concatenates all history chunks and returns them as a string.
	 * The result includes ANSI sequences and can be used for replay.
	 *
	 * @returns Complete raw output history as a string
	 *
	 * @example
	 * ```typescript
	 * const history = buffer.getHistoryAsString();
	 * // Can be written to another terminal for replay
	 * otherTerminal.write(history);
	 * ```
	 */
	getHistoryAsString(): string {
		if (this.outputHistory.length === 0) {
			return '';
		}
		return Buffer.concat(this.outputHistory).toString('utf8');
	}

	/**
	 * Flush pending writes to the headless terminal.
	 * @xterm/headless processes write() asynchronously. This ensures
	 * all queued data has been processed before reading terminal state.
	 *
	 * @returns Promise that resolves when all pending writes are processed
	 */
	flush(): Promise<void> {
		if (this.disposed) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			// Write an empty string with callback — the callback fires after
			// all previously queued writes have been processed.
			this.terminal.write('', () => resolve());
		});
	}

	/**
	 * Serialize the current terminal visual state as plain text.
	 *
	 * Unlike getHistoryAsString() which returns the raw byte stream (including
	 * cursor movement sequences that cause corruption at different dimensions),
	 * this returns the rendered visual state — the final text as displayed after
	 * all cursor movements and erases have been processed by the headless terminal.
	 *
	 * Must be called after flush() to ensure all pending writes are processed.
	 * Colors are not preserved in the serialized output, but live streaming
	 * output will have full color support.
	 *
	 * @returns Terminal visual state as plain text safe for replay at any dimensions
	 */
	serialize(): string {
		if (this.disposed) {
			return '';
		}

		return this.getContent(this.terminal.buffer.active.length + this.terminal.rows);
	}

	/**
	 * Flush pending writes and return the serialized terminal visual state.
	 * Convenience method combining flush() + serialize().
	 *
	 * @returns Promise resolving to terminal visual state as plain text
	 */
	async serializeAsync(): Promise<string> {
		await this.flush();
		return this.serialize();
	}

	/**
	 * Get the current history size in bytes.
	 *
	 * @returns Current history size in bytes
	 */
	getHistorySize(): number {
		return this.currentHistorySize;
	}

	/**
	 * Get the maximum history size in bytes.
	 *
	 * @returns Maximum history size in bytes
	 */
	getMaxHistorySize(): number {
		return this.maxHistorySize;
	}

	/**
	 * Clear the terminal buffer and history.
	 *
	 * This resets the terminal to its initial state and clears all history.
	 *
	 * @example
	 * ```typescript
	 * buffer.clear();
	 * ```
	 */
	clear(): void {
		if (this.disposed) {
			return;
		}

		this.outputHistory = [];
		this.currentHistorySize = 0;
		this.terminal.reset();
	}

	/**
	 * Dispose the terminal buffer and release resources.
	 *
	 * After disposal, the buffer cannot be used anymore.
	 */
	dispose(): void {
		if (this.disposed) {
			return;
		}

		this.disposed = true;
		this.outputHistory = [];
		this.currentHistorySize = 0;
		this.terminal.dispose();
	}

	/**
	 * Check if the buffer has been disposed.
	 *
	 * @returns true if disposed
	 */
	isDisposed(): boolean {
		return this.disposed;
	}

	/**
	 * Append data to the raw history buffer.
	 *
	 * This maintains the memory bound by trimming old data when necessary.
	 *
	 * @param data - String data to append
	 */
	private appendHistory(data: string): void {
		const buf = Buffer.from(data, 'utf8');
		this.outputHistory.push(buf);
		this.currentHistorySize += buf.length;

		// Trim if exceeds max size
		while (this.currentHistorySize > this.maxHistorySize && this.outputHistory.length > 0) {
			const removed = this.outputHistory.shift();
			if (removed) {
				this.currentHistorySize -= removed.length;
			}
		}
	}

	/**
	 * Search for a pattern in the terminal content.
	 *
	 * @param pattern - String or RegExp pattern to search for
	 * @returns true if pattern is found
	 *
	 * @example
	 * ```typescript
	 * if (buffer.contains('error')) {
	 *   console.log('Error found in output');
	 * }
	 * ```
	 */
	contains(pattern: string | RegExp): boolean {
		const content = this.getAllContent();
		if (typeof pattern === 'string') {
			return content.includes(pattern);
		}
		return pattern.test(content);
	}

	/**
	 * Get lines matching a pattern.
	 *
	 * @param pattern - String or RegExp pattern to match
	 * @returns Array of matching lines
	 *
	 * @example
	 * ```typescript
	 * const errors = buffer.findLines(/error/i);
	 * ```
	 */
	findLines(pattern: string | RegExp): string[] {
		const content = this.getAllContent();
		const lines = content.split('\n');

		return lines.filter((line) => {
			if (typeof pattern === 'string') {
				return line.includes(pattern);
			}
			return pattern.test(line);
		});
	}
}
