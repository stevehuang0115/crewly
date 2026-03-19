/**
 * Security Utilities
 *
 * Provides security-related validation and sanitization functions
 * for protecting against common vulnerabilities like command injection,
 * path traversal, and dangerous control sequences.
 *
 * @module security
 */

import * as path from 'path';
import * as os from 'os';

/**
 * Result of a path validation check
 */
export interface PathValidationResult {
	/** Whether the path is valid and safe */
	isValid: boolean;
	/** Error message if validation failed */
	error?: string;
	/** The normalized, absolute path if valid */
	normalizedPath?: string;
}

/**
 * Result of an input sanitization operation
 */
export interface SanitizationResult {
	/** The sanitized string */
	sanitized: string;
	/** Whether any modifications were made */
	wasModified: boolean;
	/** List of removed or modified patterns */
	removedPatterns?: string[];
}

/**
 * Characters that are dangerous in shell commands and should be escaped or removed
 * from user input that will be used in shell operations.
 */
export const SHELL_DANGEROUS_CHARS = [
	'`',  // Command substitution
	'$',  // Variable expansion / command substitution
	'\\', // Escape character
	'"',  // String delimiter
	"'",  // String delimiter
	';',  // Command separator
	'&',  // Background execution / AND operator
	'|',  // Pipe operator
	'>',  // Output redirection
	'<',  // Input redirection
	'\n', // Newline (command separator)
	'\r', // Carriage return
	'\0', // Null byte
] as const;

/**
 * Dangerous control sequences that should not be allowed in terminal input.
 * These can be used for terminal escape attacks or to manipulate terminal state.
 */
export const DANGEROUS_CONTROL_SEQUENCES = [
	'\x1b',       // ESC - Start of ANSI escape sequences
	'\x07',       // BEL - Bell character (can trigger actions)
	'\x08',       // BS - Backspace (can manipulate display)
	'\x7f',       // DEL - Delete character
	'\x9b',       // CSI - Control Sequence Introducer (8-bit)
	'\x90',       // DCS - Device Control String
	'\x9d',       // OSC - Operating System Command
	'\x9e',       // PM - Privacy Message
	'\x9f',       // APC - Application Program Command
] as const;

/**
 * Regex pattern to match ANSI escape sequences
 */
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\^_]|\x9b[0-9;]*[a-zA-Z]/g;

/**
 * Regex pattern to match Operating System Command sequences
 * These can be used to change terminal title, clipboard, etc.
 */
const OSC_PATTERN = /\x1b\](?:[0-9]+;[^\x07\x1b]*)?(?:\x07|\x1b\\)/g;

/**
 * Sanitizes a string for safe use in shell commands, specifically for
 * git commit messages. Removes or escapes characters that could be used
 * for command injection.
 *
 * @param input - The raw input string to sanitize
 * @param options - Sanitization options
 * @param options.maxLength - Maximum allowed length (default: 1000)
 * @param options.allowNewlines - Whether to allow newlines (default: true for commit messages)
 * @returns SanitizationResult with the sanitized string and metadata
 *
 * @example
 * ```typescript
 * const result = sanitizeForShell('Fix bug; rm -rf /');
 * // result.sanitized === 'Fix bug rm -rf /'
 * // result.wasModified === true
 * ```
 */
export function sanitizeForShell(
	input: string,
	options: { maxLength?: number; allowNewlines?: boolean } = {}
): SanitizationResult {
	const { maxLength = 1000, allowNewlines = true } = options;
	const removedPatterns: string[] = [];
	let sanitized = input;
	let wasModified = false;

	// Truncate if too long
	if (sanitized.length > maxLength) {
		sanitized = sanitized.substring(0, maxLength);
		wasModified = true;
		removedPatterns.push(`truncated from ${input.length} to ${maxLength} chars`);
	}

	// Remove null bytes
	if (sanitized.includes('\0')) {
		sanitized = sanitized.replace(/\0/g, '');
		wasModified = true;
		removedPatterns.push('null bytes');
	}

	// Handle newlines based on option
	if (!allowNewlines) {
		if (sanitized.includes('\n') || sanitized.includes('\r')) {
			sanitized = sanitized.replace(/[\r\n]+/g, ' ');
			wasModified = true;
			removedPatterns.push('newlines');
		}
	}

	// Remove backtick command substitution patterns
	const backtickPattern = /`[^`]*`/g;
	const backtickReplaced = sanitized.replace(backtickPattern, '');
	if (backtickReplaced !== sanitized) {
		sanitized = backtickReplaced;
		wasModified = true;
		removedPatterns.push('backtick command substitution');
	}

	// Remove $() command substitution
	const dollarParenPattern = /\$\([^)]*\)/g;
	const dollarParenReplaced = sanitized.replace(dollarParenPattern, '');
	if (dollarParenReplaced !== sanitized) {
		sanitized = dollarParenReplaced;
		wasModified = true;
		removedPatterns.push('$() command substitution');
	}

	// Remove shell variable expansion $VAR or ${VAR}
	const varPattern = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g;
	const varReplaced = sanitized.replace(varPattern, '');
	if (varReplaced !== sanitized) {
		sanitized = varReplaced;
		wasModified = true;
		removedPatterns.push('shell variable expansion');
	}

	// Remove dangerous shell operators (but preserve the text around them)
	const dangerousOps = [';', '&&', '||', '|', '>', '<', '>>', '<<'];
	for (const op of dangerousOps) {
		if (sanitized.includes(op)) {
			// Replace operator with space to preserve word boundaries
			sanitized = sanitized.split(op).join(' ');
			wasModified = true;
			if (!removedPatterns.includes('shell operators')) {
				removedPatterns.push('shell operators');
			}
		}
	}

	// Clean up multiple consecutive spaces (but preserve newlines if allowed)
	if (allowNewlines) {
		// Only clean up multiple spaces on the same line
		const cleanedSpaces = sanitized.replace(/[ \t]{2,}/g, ' ');
		if (cleanedSpaces !== sanitized) {
			sanitized = cleanedSpaces;
			// Don't mark as modified just for whitespace cleanup
		}
	} else {
		// Clean up all multiple whitespace
		const cleanedSpaces = sanitized.replace(/\s{2,}/g, ' ').trim();
		if (cleanedSpaces !== sanitized) {
			sanitized = cleanedSpaces;
			// Don't mark as modified just for whitespace cleanup
		}
	}

	return {
		sanitized,
		wasModified,
		removedPatterns: removedPatterns.length > 0 ? removedPatterns : undefined,
	};
}

/**
 * Sanitizes a git commit message by removing potentially dangerous characters
 * while preserving the semantic content of the message.
 *
 * @param message - The raw commit message
 * @param options - Sanitization options
 * @param options.maxLength - Maximum message length (default: 5000)
 * @returns SanitizationResult with the sanitized message
 *
 * @example
 * ```typescript
 * const result = sanitizeGitCommitMessage('feat: add feature $(whoami)');
 * // result.sanitized === 'feat: add feature'
 * ```
 */
export function sanitizeGitCommitMessage(
	message: string,
	options: { maxLength?: number } = {}
): SanitizationResult {
	const { maxLength = 5000 } = options;

	// Use shell sanitization with newlines allowed (for multi-line commit messages)
	return sanitizeForShell(message, { maxLength, allowNewlines: true });
}

/**
 * Validates that terminal input does not contain dangerous control sequences
 * that could be used for terminal escape attacks.
 *
 * @param input - The terminal input to validate
 * @param options - Validation options
 * @param options.allowBasicFormatting - Allow basic ANSI formatting codes (colors, etc.)
 * @param options.maxLength - Maximum input length (default: 10000)
 * @returns Object with isValid flag and optional error message
 *
 * @example
 * ```typescript
 * const result = validateTerminalInput('echo hello');
 * // result.isValid === true
 *
 * const result2 = validateTerminalInput('\x1b]0;malicious\x07');
 * // result2.isValid === false
 * // result2.error === 'Input contains Operating System Command sequences'
 * ```
 */
export function validateTerminalInput(
	input: string,
	options: { allowBasicFormatting?: boolean; maxLength?: number } = {}
): { isValid: boolean; error?: string } {
	const { allowBasicFormatting = false, maxLength = 10000 } = options;

	// Check length
	if (input.length > maxLength) {
		return {
			isValid: false,
			error: `Input exceeds maximum length of ${maxLength} characters`,
		};
	}

	// Check for null bytes
	if (input.includes('\0')) {
		return {
			isValid: false,
			error: 'Input contains null bytes',
		};
	}

	// Check for OSC (Operating System Command) sequences which can:
	// - Change terminal title
	// - Access clipboard
	// - Execute commands on some terminals
	// Check this BEFORE checking for ESC to give more specific error
	if (OSC_PATTERN.test(input)) {
		return {
			isValid: false,
			error: 'Input contains Operating System Command sequences',
		};
	}

	// If basic formatting is not allowed, reject any ANSI escape sequences
	if (!allowBasicFormatting && ANSI_ESCAPE_PATTERN.test(input)) {
		return {
			isValid: false,
			error: 'Input contains ANSI escape sequences',
		};
	}

	// Check for dangerous control characters (check after ANSI patterns for specific errors)
	for (const seq of DANGEROUS_CONTROL_SEQUENCES) {
		if (seq === '\x1b' && (allowBasicFormatting || ANSI_ESCAPE_PATTERN.test(input) || OSC_PATTERN.test(input))) {
			// Skip ESC if we already handled it above
			continue;
		}
		if (input.includes(seq)) {
			return {
				isValid: false,
				error: 'Input contains dangerous control sequences',
			};
		}
	}

	// If basic formatting is allowed, check for dangerous escape sequences
	// that go beyond simple color/formatting codes
	if (allowBasicFormatting) {
		// DCS (Device Control String) - can be used for Sixel injection
		if (/\x1bP[^\\]*\x1b\\/.test(input) || /\x90[^\x9c]*\x9c/.test(input)) {
			return {
				isValid: false,
				error: 'Input contains Device Control String sequences',
			};
		}

		// Check for cursor positioning that could be used to overwrite displayed content
		// to deceive users (allowed: colors, bold, etc. Disallowed: cursor movement)
		const cursorMovePattern = /\x1b\[[0-9;]*[ABCDEFGHJ]/gi;
		if (cursorMovePattern.test(input)) {
			return {
				isValid: false,
				error: 'Input contains cursor manipulation sequences',
			};
		}
	}

	return { isValid: true };
}

/**
 * Sanitizes terminal input by removing dangerous control sequences while
 * preserving safe content.
 *
 * @param input - The terminal input to sanitize
 * @param options - Sanitization options
 * @param options.preserveNewlines - Keep newline characters (default: true)
 * @param options.maxLength - Maximum output length (default: 10000)
 * @returns SanitizationResult with the sanitized input
 *
 * @example
 * ```typescript
 * const result = sanitizeTerminalInput('hello\x1b]0;title\x07world');
 * // result.sanitized === 'helloworld'
 * ```
 */
export function sanitizeTerminalInput(
	input: string,
	options: { preserveNewlines?: boolean; maxLength?: number } = {}
): SanitizationResult {
	const { preserveNewlines = true, maxLength = 10000 } = options;
	const removedPatterns: string[] = [];
	let sanitized = input;
	let wasModified = false;

	// Truncate if too long
	if (sanitized.length > maxLength) {
		sanitized = sanitized.substring(0, maxLength);
		wasModified = true;
		removedPatterns.push(`truncated from ${input.length} to ${maxLength} chars`);
	}

	// Remove null bytes
	if (sanitized.includes('\0')) {
		sanitized = sanitized.replace(/\0/g, '');
		wasModified = true;
		removedPatterns.push('null bytes');
	}

	// Remove OSC sequences
	if (OSC_PATTERN.test(sanitized)) {
		sanitized = sanitized.replace(OSC_PATTERN, '');
		wasModified = true;
		removedPatterns.push('OSC sequences');
	}

	// Remove all ANSI escape sequences
	if (ANSI_ESCAPE_PATTERN.test(sanitized)) {
		sanitized = sanitized.replace(ANSI_ESCAPE_PATTERN, '');
		wasModified = true;
		removedPatterns.push('ANSI escape sequences');
	}

	// Remove other dangerous control characters
	const controlCharPattern = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g;
	if (controlCharPattern.test(sanitized)) {
		sanitized = sanitized.replace(controlCharPattern, '');
		wasModified = true;
		removedPatterns.push('control characters');
	}

	// Handle newlines
	if (!preserveNewlines) {
		if (sanitized.includes('\n') || sanitized.includes('\r')) {
			sanitized = sanitized.replace(/[\r\n]+/g, ' ');
			wasModified = true;
			removedPatterns.push('newlines');
		}
	}

	return {
		sanitized,
		wasModified,
		removedPatterns: removedPatterns.length > 0 ? removedPatterns : undefined,
	};
}

/**
 * Validates a file path to prevent path traversal attacks.
 * Ensures the resolved path is within the allowed base directory.
 *
 * @param inputPath - The path to validate (can be relative or absolute)
 * @param baseDirectory - The allowed base directory (must be absolute)
 * @param options - Validation options
 * @param options.allowSymlinks - Whether to allow symlinks (default: false for security)
 * @returns PathValidationResult with validation status and normalized path
 *
 * @example
 * ```typescript
 * const result = validatePath('../../../etc/passwd', '/home/user/projects');
 * // result.isValid === false
 * // result.error === 'Path traversal detected'
 *
 * const result2 = validatePath('src/index.ts', '/home/user/projects');
 * // result2.isValid === true
 * // result2.normalizedPath === '/home/user/projects/src/index.ts'
 * ```
 */
export function validatePath(
	inputPath: string,
	baseDirectory: string,
	options: { allowSymlinks?: boolean } = {}
): PathValidationResult {
	const { allowSymlinks = false } = options;

	// Input validation
	if (!inputPath || typeof inputPath !== 'string') {
		return {
			isValid: false,
			error: 'Path is required and must be a string',
		};
	}

	if (!baseDirectory || typeof baseDirectory !== 'string') {
		return {
			isValid: false,
			error: 'Base directory is required and must be a string',
		};
	}

	// Base directory must be absolute
	if (!path.isAbsolute(baseDirectory)) {
		return {
			isValid: false,
			error: 'Base directory must be an absolute path',
		};
	}

	// Check for null bytes (can bypass path checks in some systems)
	if (inputPath.includes('\0') || baseDirectory.includes('\0')) {
		return {
			isValid: false,
			error: 'Path contains null bytes',
		};
	}

	// Normalize the base directory
	const normalizedBase = path.normalize(baseDirectory);

	// Resolve the input path relative to the base directory
	let resolvedPath: string;
	if (path.isAbsolute(inputPath)) {
		resolvedPath = path.normalize(inputPath);
	} else {
		resolvedPath = path.normalize(path.join(normalizedBase, inputPath));
	}

	// Check if the resolved path starts with the base directory
	// Add trailing separator to prevent partial directory name matches
	// e.g., /home/user matching /home/username
	const baseWithSep = normalizedBase.endsWith(path.sep)
		? normalizedBase
		: normalizedBase + path.sep;

	const resolvedWithSep = resolvedPath.endsWith(path.sep)
		? resolvedPath
		: resolvedPath + path.sep;

	// The resolved path must either equal the base or be a subdirectory of it
	const isWithinBase =
		resolvedPath === normalizedBase || resolvedWithSep.startsWith(baseWithSep);

	if (!isWithinBase) {
		return {
			isValid: false,
			error: 'Path traversal detected: path resolves outside the allowed directory',
		};
	}

	// Check for common path traversal patterns in the original input
	// This catches attempts that might not be caught by normalization alone
	const traversalPatterns = [
		/\.\.[\/\\]/,      // ../
		/[\/\\]\.\./,       // /..
		/^\.\.$/,          // just ..
		/%2e%2e/i,         // URL encoded ..
		/%252e%252e/i,     // Double URL encoded ..
		/\.%2e/i,          // Mixed encoding
		/%2e\./i,          // Mixed encoding
	];

	for (const pattern of traversalPatterns) {
		if (pattern.test(inputPath)) {
			return {
				isValid: false,
				error: 'Path traversal pattern detected in input',
			};
		}
	}

	// Note: Symlink checking should be done at the filesystem level
	// when actually accessing the file, as the symlink might not exist yet
	// or the check could be subject to TOCTOU (time-of-check-time-of-use) issues

	return {
		isValid: true,
		normalizedPath: resolvedPath,
	};
}

/**
 * Validates a project path ensuring it is within allowed directories
 * (user's home directory or explicitly allowed paths).
 *
 * @param projectPath - The project path to validate
 * @param allowedBasePaths - Additional allowed base paths (default: [os.homedir()])
 * @returns PathValidationResult with validation status
 *
 * @example
 * ```typescript
 * const result = validateProjectPath('/home/user/projects/myapp');
 * // result.isValid === true
 *
 * const result2 = validateProjectPath('/etc/passwd');
 * // result2.isValid === false
 * ```
 */
export function validateProjectPath(
	projectPath: string,
	allowedBasePaths?: string[]
): PathValidationResult {
	// Default to home directory if no allowed paths specified
	const basePaths = allowedBasePaths ?? [os.homedir()];

	// Input validation
	if (!projectPath || typeof projectPath !== 'string') {
		return {
			isValid: false,
			error: 'Project path is required and must be a string',
		};
	}

	// Check for null bytes
	if (projectPath.includes('\0')) {
		return {
			isValid: false,
			error: 'Path contains null bytes',
		};
	}

	// Normalize the project path
	const normalizedProjectPath = path.normalize(
		path.isAbsolute(projectPath) ? projectPath : path.resolve(projectPath)
	);

	// Check if the path is within any of the allowed base paths
	for (const basePath of basePaths) {
		const result = validatePath(normalizedProjectPath, basePath);
		if (result.isValid) {
			return {
				isValid: true,
				normalizedPath: result.normalizedPath,
			};
		}
	}

	// Also allow the current working directory
	const cwdResult = validatePath(normalizedProjectPath, process.cwd());
	if (cwdResult.isValid) {
		return {
			isValid: true,
			normalizedPath: cwdResult.normalizedPath,
		};
	}

	return {
		isValid: false,
		error: 'Project path is outside allowed directories',
	};
}

/**
 * Validates a session name to ensure it contains only safe characters.
 *
 * @param sessionName - The session name to validate
 * @param options - Validation options
 * @param options.maxLength - Maximum session name length (default: 100)
 * @returns Object with isValid flag and optional error message
 *
 * @example
 * ```typescript
 * const result = validateSessionName('my-session_123');
 * // result.isValid === true
 *
 * const result2 = validateSessionName('session; rm -rf /');
 * // result2.isValid === false
 * ```
 */
export function validateSessionName(
	sessionName: string,
	options: { maxLength?: number } = {}
): { isValid: boolean; error?: string } {
	const { maxLength = 100 } = options;

	if (!sessionName || typeof sessionName !== 'string') {
		return {
			isValid: false,
			error: 'Session name is required and must be a string',
		};
	}

	if (sessionName.length > maxLength) {
		return {
			isValid: false,
			error: `Session name exceeds maximum length of ${maxLength} characters`,
		};
	}

	// Only allow alphanumeric characters, hyphens, and underscores
	const validPattern = /^[a-zA-Z0-9_-]+$/;
	if (!validPattern.test(sessionName)) {
		return {
			isValid: false,
			error: 'Session name contains invalid characters. Only alphanumeric characters, hyphens, and underscores are allowed.',
		};
	}

	return { isValid: true };
}
