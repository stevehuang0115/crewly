/**
 * Read the end of a log file without the `tail` command.
 *
 * `tail -n N "<file>" 2>/dev/null || echo "No logs"` needs a POSIX shell and
 * `tail`; neither exists under cmd.exe on Windows.
 *
 * @module cli/utils/tail-file
 */
import fs from 'fs';

/** Text returned when the file is missing or unreadable (what the old shell fallback printed). */
export const NO_LOGS_TEXT = 'No logs';

/** At most this many bytes are read from the end of the file. */
export const TAIL_MAX_BYTES = 1024 * 1024;

/**
 * The last lines of a text file.
 *
 * @param file - Log file
 * @param lines - How many lines to return
 * @returns The lines joined with `\n` ('' for an empty file), or {@link NO_LOGS_TEXT} when it cannot be read
 *
 * @example
 * ```typescript
 * tailFile('/home/me/.crewly/logs/communication.log', 20);
 * ```
 */
export function tailFile(file: string, lines: number): string {
	let fd: number | null = null;
	try {
		fd = fs.openSync(file, 'r');
		const size = fs.fstatSync(fd).size;
		const length = Math.min(size, TAIL_MAX_BYTES);
		if (length === 0 || lines <= 0) return '';
		const buffer = Buffer.alloc(length);
		fs.readSync(fd, buffer, 0, length, size - length);
		const all = buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
		// A read that started mid-file begins with a partial line: drop it.
		if (length < size) all.shift();
		return all.slice(-lines).join('\n');
	} catch {
		return NO_LOGS_TEXT;
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {
				// already closed
			}
		}
	}
}

/**
 * The command that follows files as they grow: `tail -f`, or PowerShell's
 * `Get-Content -Wait` on Windows.
 *
 * @param files - Files to follow
 * @param platform - Platform (default: this process's)
 * @returns Executable and arguments for `spawn`
 */
export function followCommand(files: readonly string[], platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
	if (platform !== 'win32') return { command: 'tail', args: ['-f', ...files] };
	const list = files.map((f) => `'${f.replace(/'/g, "''")}'`).join(',');
	return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', `Get-Content -LiteralPath ${list} -Tail 10 -Wait`] };
}
