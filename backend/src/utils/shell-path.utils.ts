/**
 * Paths as they must be written in text a bash shell will read.
 *
 * On Windows, agent sessions run Git for Windows' bash. A Windows path typed
 * into it loses its backslashes (`"C:\Users\me"` inside double quotes, or
 * unquoted, becomes `C:Usersme`), and a `PATH` entry with a drive colon is
 * split in two. These helpers produce the spellings bash keeps intact. On
 * macOS and Linux every helper returns its input unchanged.
 *
 * @module utils/shell-path
 */

/** `C:\...` or `C:/...` */
const DRIVE_PATH = /^([A-Za-z]):[\\/]/;

/**
 * A path as an argument or inside a prompt: forward slashes, drive letter kept.
 *
 * `C:/Users/me/x.json` is read correctly by bash, by Windows programs started
 * from it (node, claude) and by `bash C:/…/execute.sh`.
 *
 * @param file - Absolute or relative path
 * @param platform - Platform (default: this process's)
 * @returns The path with `/` separators on Windows; unchanged elsewhere
 *
 * @example
 * ```typescript
 * toShellPath('C:\\Users\\me\\.crewly\\a.json', 'win32'); // 'C:/Users/me/.crewly/a.json'
 * toShellPath('/home/me/a.json', 'linux'); // '/home/me/a.json'
 * ```
 */
export function toShellPath(file: string, platform: NodeJS.Platform = process.platform): string {
	return platform === 'win32' ? file.replace(/\\/g, '/') : file;
}

/**
 * A directory as one entry of bash's `PATH` on Windows: `/c/Program Files/nodejs`.
 *
 * MSYS bash separates `PATH` entries with `:`, so `C:\x` would be read as the
 * two entries `C` and `\x`.
 *
 * @param dir - Directory
 * @param platform - Platform (default: this process's)
 * @returns The MSYS form on Windows; unchanged elsewhere
 *
 * @example
 * ```typescript
 * toShellPathEntry('C:\\Program Files\\nodejs', 'win32'); // '/c/Program Files/nodejs'
 * ```
 */
export function toShellPathEntry(dir: string, platform: NodeJS.Platform = process.platform): string {
	if (platform !== 'win32') return dir;
	const slashed = dir.replace(/\\/g, '/');
	const drive = DRIVE_PATH.exec(dir);
	return drive ? `/${drive[1].toLowerCase()}/${slashed.slice(3)}` : slashed;
}

/** A Windows absolute path inside running text: drive, `:\`, then everything up to whitespace or a quote. */
const WINDOWS_PATH_IN_TEXT = /(?<![A-Za-z0-9])([A-Za-z]):\\([^\s"'`<>|*?]*)/g;

/**
 * Rewrite every Windows absolute path in a text to its bash-safe spelling.
 *
 * Crewly builds agent-facing text (prompts, skill catalogs, the lines it
 * types into a session) in well over a hundred places with `path.join`,
 * which yields backslashes on Windows. An agent that copies
 * `bash C:\crewly\config\skills\x/execute.sh` into Git Bash runs
 * `C:crewlyconfigskillsx/execute.sh`. Rather than convert at each of those
 * places, the text is normalised where it leaves Crewly for an agent.
 *
 * Limit: a path with a space is only rewritten up to the space (the rest is
 * not recognisably part of it). Unquoted, such a path does not work in a
 * shell on any platform.
 *
 * @param text - Text bound for an agent's shell or prompt
 * @param platform - Platform (default: this process's)
 * @returns The text with `C:\a\b` written as `C:/a/b` on Windows; unchanged elsewhere
 *
 * @example
 * ```typescript
 * windowsPathsToShell('bash D:\\crewly\\config\\skills\\orchestrator/send-message/execute.sh', 'win32');
 * // 'bash D:/crewly/config/skills/orchestrator/send-message/execute.sh'
 * ```
 */
export function windowsPathsToShell(text: string, platform: NodeJS.Platform = process.platform): string {
	if (platform !== 'win32' || !text.includes(':\\')) return text;
	return text.replace(WINDOWS_PATH_IN_TEXT, (_m, drive: string, rest: string) => `${drive}:/${rest.replace(/\\/g, '/')}`);
}
