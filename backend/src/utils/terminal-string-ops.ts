/**
 * Terminal string operations — regex-free replacements for terminal processing.
 *
 * Every function in this module uses only string primitives (indexOf, includes,
 * startsWith, charCodeAt, character iteration) — NO regex. This makes the
 * codebase immune to ReDoS by construction.
 *
 * @module terminal-string-ops
 */

import { RUNTIME_TYPES, type RuntimeType } from '../constants.js';

// ─── Character sets ───────────────────────────────────────────────────────────

/** Braille spinner characters used by Claude Code to indicate processing. */
const SPINNER_CHARS = new Set([
	0x280B, // ⠋
	0x2819, // ⠙
	0x2839, // ⠹
	0x2838, // ⠸
	0x283C, // ⠼
	0x2834, // ⠴
	0x2826, // ⠦
	0x2827, // ⠧
	0x2807, // ⠇
	0x280F, // ⠏
]);

/** Filled circle (⏺ U+23FA) — Claude Code working indicator. */
const WORKING_INDICATOR_CODE = 0x23FA; // ⏺

/** Box-drawing codepoints (U+2500–U+257F) plus ASCII equivalents. */
const BOX_DRAWING_MIN = 0x2500;
const BOX_DRAWING_MAX = 0x257F;
const EXTRA_BOX_CHARS = new Set([
	0x7C,   // |
	0x2B,   // +
	0x2D,   // -
	0x2550, // ═
	0x2551, // ║
	0x256D, // ╭
	0x256E, // ╮
	0x2570, // ╰
	0x256F, // ╯
]);

/** TUI border characters (vertical lines). */
const TUI_BORDER_CHARS = new Set([
	0x2502, // │
	0x2503, // ┃
	0x2551, // ║
	0x7C,   // |
]);

/** Processing status keywords (lowercased). */
const PROCESSING_KEYWORDS = [
	'thinking', 'processing', 'analyzing', 'running', 'calling', 'frosting',
];

/** Gemini CLI processing keywords (lowercased). */
const GEMINI_PROCESSING_KEYWORDS = [
	'reading', 'thinking', 'processing', 'analyzing', 'generating', 'searching',
];

// ─── Helper predicates ────────────────────────────────────────────────────────

/**
 * Check if a codepoint is a box-drawing character.
 */
function isBoxDrawing(cp: number): boolean {
	return (cp >= BOX_DRAWING_MIN && cp <= BOX_DRAWING_MAX) || EXTRA_BOX_CHARS.has(cp);
}

/**
 * Check if a codepoint is a TUI border character.
 */
function isTuiBorder(cp: number): boolean {
	return TUI_BORDER_CHARS.has(cp);
}

/**
 * Check if a codepoint is whitespace (space or tab).
 */
function isWhitespace(cp: number): boolean {
	return cp === 0x20 || cp === 0x09; // space or tab
}

// ─── stripAnsiCodes ───────────────────────────────────────────────────────────

/**
 * Strip ANSI escape codes from PTY output using a single-pass state machine.
 *
 * Handles CSI sequences, OSC sequences, single-char escapes, and orphaned
 * CSI fragments from PTY buffer boundary splits. Cursor-forward (C) sequences
 * are replaced with a space to preserve word boundaries.
 *
 * O(n) time, O(n) space. No regex.
 *
 * @param content - Raw PTY output containing ANSI codes
 * @returns Clean text with ANSI codes removed
 */
export function stripAnsiCodes(content: string): string {
	const len = content.length;
	const out: string[] = [];
	let i = 0;

	while (i < len) {
		const ch = content.charCodeAt(i);

		// ESC character (0x1B)
		if (ch === 0x1B) {
			i++;
			if (i >= len) break;

			const next = content.charCodeAt(i);

			// CSI sequence: ESC [
			if (next === 0x5B) { // [
				i++;
				// Parse CSI: optional ?, parameter bytes (0x30-0x3F), intermediate (0x20-0x2F), final (0x40-0x7E)
				const hasQuestion = i < len && content.charCodeAt(i) === 0x3F; // ?
				if (hasQuestion) i++;

				// Collect parameter + intermediate bytes
				let paramStart = i;
				while (i < len) {
					const c = content.charCodeAt(i);
					if (c >= 0x30 && c <= 0x3F) { i++; continue; } // parameter bytes (digits, ;, <=>?)
					if (c >= 0x20 && c <= 0x2F) { i++; continue; } // intermediate bytes
					break;
				}

				// Final byte
				if (i < len) {
					const final = content.charCodeAt(i);
					if (final >= 0x40 && final <= 0x7E) {
						// Cursor forward (C) → emit space
						if (!hasQuestion && final === 0x43) { // 'C'
							out.push(' ');
						}
						i++;
						continue;
					}
				}
				// Malformed CSI — skip what we consumed
				continue;
			}

			// OSC sequence: ESC ]
			if (next === 0x5D) { // ]
				i++;
				// Consume until BEL (0x07) or ST (ESC \)
				while (i < len) {
					const c = content.charCodeAt(i);
					if (c === 0x07) { i++; break; } // BEL
					if (c === 0x1B && i + 1 < len && content.charCodeAt(i + 1) === 0x5C) {
						i += 2; // ST = ESC backslash
						break;
					}
					i++;
				}
				continue;
			}

			// Other escape sequences: ESC followed by one character
			// Some are two bytes total (ESC + char), skip the next char
			if (next >= 0x20 && next <= 0x7E) {
				i++;
				// Check if there's a trailing parameter byte
				if (i < len) {
					const trailing = content.charCodeAt(i);
					if (trailing >= 0x20 && trailing <= 0x7E && trailing !== 0x5B && trailing !== 0x5D) {
						// Single trailing param (e.g., ESC ( B)
						i++;
					}
				}
			}
			continue;
		}

		// Orphaned CSI fragments: [ followed by digits then a CSI final byte
		// These occur when ESC lands in one PTY chunk and [params... in the next
		if (ch === 0x5B && i + 1 < len) { // [
			const nextCh = content.charCodeAt(i + 1);

			// [? private mode fragment
			if (nextCh === 0x3F) { // ?
				let j = i + 2;
				while (j < len) {
					const c = content.charCodeAt(j);
					if ((c >= 0x30 && c <= 0x39) || c === 0x3B) { j++; continue; } // digits or ;
					break;
				}
				if (j > i + 2 && j < len) {
					const final = content.charCodeAt(j);
					if (final >= 0x41 && final <= 0x7A) { // A-z
						i = j + 1;
						continue;
					}
				}
			}

			// [digits... followed by CSI final byte
			if (nextCh >= 0x30 && nextCh <= 0x39) { // digit
				let j = i + 1;
				let hasDigit = false;
				while (j < len) {
					const c = content.charCodeAt(j);
					if ((c >= 0x30 && c <= 0x39) || c === 0x3B) { // digit or ;
						if (c >= 0x30 && c <= 0x39) hasDigit = true;
						j++;
						continue;
					}
					break;
				}
				if (hasDigit && j < len) {
					const final = content.charCodeAt(j);
					// A-B, J, K, H, f, m are common CSI finals
					if (
						(final >= 0x41 && final <= 0x42) || // A-B
						final === 0x43 || // C (cursor forward)
						final === 0x4A || // J
						final === 0x4B || // K
						final === 0x48 || // H
						final === 0x66 || // f
						final === 0x6D    // m
					) {
						if (final === 0x43) { // C = cursor forward → space
							out.push(' ');
						}
						i = j + 1;
						continue;
					}
				}
			}
		}

		// CR+LF normalization
		if (ch === 0x0D) { // \r
			if (i + 1 < len && content.charCodeAt(i + 1) === 0x0A) { // \r\n
				out.push('\n');
				i += 2;
			} else {
				out.push('\n');
				i++;
			}
			continue;
		}

		// Remove control characters except tab (0x09) and newline (0x0A)
		if (
			(ch >= 0x00 && ch <= 0x08) ||
			ch === 0x0B || ch === 0x0C ||
			(ch >= 0x0E && ch <= 0x1F) ||
			ch === 0x7F
		) {
			i++;
			continue;
		}

		// Normal character — emit
		out.push(content[i]);
		i++;
	}

	return out.join('');
}

// ─── stripBoxDrawing ──────────────────────────────────────────────────────────

/**
 * Strip box-drawing characters and decorative borders from both ends of a line.
 *
 * @param line - A single terminal line
 * @returns The line with leading/trailing box-drawing chars and whitespace removed
 */
export function stripBoxDrawing(line: string): string {
	let start = 0;
	let end = line.length;

	// Strip from start
	while (start < end) {
		const cp = line.codePointAt(start)!;
		if (isBoxDrawing(cp) || isWhitespace(cp)) {
			start += cp > 0xFFFF ? 2 : 1;
		} else {
			break;
		}
	}

	// Strip from end
	while (end > start) {
		// Walk back one codepoint
		const prevIdx = end - 1;
		const cp = line.codePointAt(prevIdx)!;
		// Handle surrogate pairs
		if (prevIdx > start && cp >= 0xDC00 && cp <= 0xDFFF) {
			const highIdx = prevIdx - 1;
			const fullCp = line.codePointAt(highIdx)!;
			if (isBoxDrawing(fullCp) || isWhitespace(fullCp)) {
				end = highIdx;
				continue;
			}
			break;
		}
		if (isBoxDrawing(cp) || isWhitespace(cp)) {
			end = prevIdx;
		} else {
			break;
		}
	}

	return line.slice(start, end);
}

// ─── stripTuiLineBorders ──────────────────────────────────────────────────────

/**
 * Strip TUI line border characters (│ ┃ ║ |) and surrounding whitespace
 * from both ends of a line.
 *
 * @param line - A single terminal line
 * @returns The line with leading/trailing border chars removed
 */
export function stripTuiLineBorders(line: string): string {
	let start = 0;
	let end = line.length;

	// Strip from start
	while (start < end) {
		const cp = line.charCodeAt(start);
		if (isTuiBorder(cp) || isWhitespace(cp)) {
			start++;
		} else {
			// Handle multi-byte border chars
			const fullCp = line.codePointAt(start)!;
			if (isTuiBorder(fullCp) || isWhitespace(fullCp)) {
				start += fullCp > 0xFFFF ? 2 : 1;
			} else {
				break;
			}
		}
	}

	// Strip from end
	while (end > start) {
		const cp = line.charCodeAt(end - 1);
		if (isTuiBorder(cp) || isWhitespace(cp)) {
			end--;
		} else {
			break;
		}
	}

	return line.slice(start, end);
}

// ─── matchTuiPromptLine ───────────────────────────────────────────────────────

/**
 * Check if a line matches the pattern of a TUI prompt line: optional border
 * chars, then > followed by content. Returns the content after > prompt or null.
 *
 * Replaces the prompt line regex.
 *
 * @param line - A single terminal line
 * @returns The content after > prompt, or null if not a prompt line
 */
export function matchTuiPromptLine(line: string): string | null {
	let i = 0;
	const len = line.length;

	// Skip leading border chars and whitespace
	while (i < len) {
		const cp = line.charCodeAt(i);
		if (isTuiBorder(cp) || isWhitespace(cp)) {
			i++;
		} else {
			break;
		}
	}

	// Check for > (greater-than followed by space)
	if (i < len && line.charCodeAt(i) === 0x3E) { // >
		i++;
		if (i < len && isWhitespace(line.charCodeAt(i))) {
			i++;
			// Skip additional whitespace
			while (i < len && isWhitespace(line.charCodeAt(i))) i++;
			if (i < len) {
				return line.slice(i);
			}
		}
	}

	return null;
}

// ─── Prompt detection ─────────────────────────────────────────────────────────

/**
 * Check if a single line looks like an agent prompt.
 *
 * Claude Code: ❯, ⏵, $ alone (or with box-drawing), or ❯❯
 * Gemini CLI:  > or ! or bordered │ >, or "Type your message" / "YOLO mode"
 * Codex CLI:   › or bordered │ ›
 *
 * @param line - A single non-empty terminal line (already stripped of ANSI)
 * @param runtimeType - The agent runtime type
 * @returns true if the line looks like a prompt
 */
export function isPromptLine(line: string, runtimeType?: RuntimeType): boolean {
	const trimmed = line.trim();
	if (trimmed.length === 0) return false;

	const stripped = stripBoxDrawing(trimmed);

	const isGemini = runtimeType === RUNTIME_TYPES.GEMINI_CLI;
	const isClaudeCode = runtimeType === RUNTIME_TYPES.CLAUDE_CODE;
	const isCodex = runtimeType === RUNTIME_TYPES.CODEX_CLI;

	// Claude Code prompts
	if (!isGemini && !isCodex) {
		if (trimmed === '❯' || trimmed === '⏵' || trimmed === '$' ||
			stripped === '❯' || stripped === '⏵' || stripped === '$') {
			return true;
		}
		// ❯❯ bypass permissions prompt
		if (trimmed.startsWith('❯❯')) return true;
	}

	// Codex CLI prompts
	if (isCodex) {
		if (trimmed === '›' || trimmed.startsWith('› ') ||
			stripped === '›' || stripped.startsWith('› ')) return true;
		// Bordered > prompt (only in TUI box-drawing context)
		// stripped already has box-drawing chars removed, so if the original
		// had borders and the stripped starts with > , that's a bordered prompt
		if (trimmed !== stripped && (stripped.startsWith('> ') || stripped === '>')) return true;
	}

	// Gemini CLI prompts (and fallback for unknown runtime)
	if (!isClaudeCode && !isCodex) {
		if (trimmed === '>' || trimmed === '!' ||
			trimmed.startsWith('> ') || trimmed.startsWith('! ') ||
			stripped === '>' || stripped === '!' ||
			stripped.startsWith('> ') || stripped.startsWith('! ')) {
			return true;
		}

		// Textual prompt placeholders
		const lower = trimmed.toLowerCase();
		if (lower.includes('type your message') || lower.includes('yolo mode')) {
			return true;
		}
	}

	return false;
}

/**
 * Check if the agent appears to be at an input prompt by scanning terminal output.
 *
 * Scans the last 10 non-empty lines for prompt patterns, then checks for busy
 * indicators to distinguish idle-at-prompt from actively-processing.
 *
 * @param output - Terminal output text (already stripped of ANSI codes)
 * @param runtimeType - The agent runtime type
 * @returns true if the agent appears idle at a prompt
 */
export function isAgentAtPrompt(output: string, runtimeType?: RuntimeType): boolean {
	if (!output || typeof output !== 'string') return false;

	const tailSection = output.slice(-5000);
	const lines = tailSection.split('\n').filter(l => l.trim().length > 0);
	const linesToCheck = lines.slice(-10);

	// Check for prompt indicators
	const hasPrompt = linesToCheck.some(line => isPromptLine(line, runtimeType));
	if (hasPrompt) return true;

	// No prompt found — check if agent is still processing
	const recentText = linesToCheck.join('\n');

	// Processing with text check
	if (containsProcessingIndicator(recentText)) return false;

	// Busy status bar check
	if (containsBusyStatusBar(recentText)) return false;

	return false;
}

// ─── Processing indicator detection ───────────────────────────────────────────

/**
 * Check if text contains spinner characters or the working indicator (⏺).
 * This is the "spinner-only" check (no keyword matching).
 *
 * Replaces TERMINAL_PATTERNS.PROCESSING regex.
 *
 * @param text - Text to check
 * @returns true if any spinner/working indicator character is found
 */
export function containsSpinnerOrWorkingIndicator(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const cp = text.codePointAt(i)!;
		if (SPINNER_CHARS.has(cp) || cp === WORKING_INDICATOR_CODE) return true;
		if (cp > 0xFFFF) i++; // skip surrogate pair
	}
	return false;
}

/**
 * Check if text contains processing indicators including spinner chars,
 * working indicator (⏺), AND status keywords.
 *
 * Replaces TERMINAL_PATTERNS.PROCESSING_WITH_TEXT regex.
 *
 * @param text - Text to check
 * @returns true if any processing indicator is found
 */
export function containsProcessingIndicator(text: string): boolean {
	// Check spinner/working indicator chars
	if (containsSpinnerOrWorkingIndicator(text)) return true;

	// Check keywords (case-insensitive)
	const lower = text.toLowerCase();
	for (const keyword of PROCESSING_KEYWORDS) {
		if (lower.includes(keyword)) return true;
	}

	return false;
}

/**
 * Check if text contains the "esc to interrupt" busy status bar.
 *
 * Replaces TERMINAL_PATTERNS.BUSY_STATUS_BAR regex.
 * Manually matches "esc" then whitespace then "to" then whitespace then "interrupt".
 *
 * @param text - Text to check
 * @returns true if the busy status bar text is found
 */
export function containsBusyStatusBar(text: string): boolean {
	const lower = text.toLowerCase();
	let idx = 0;

	while (true) {
		idx = lower.indexOf('esc', idx);
		if (idx === -1) return false;

		let pos = idx + 3;

		// Skip whitespace (at least one required)
		if (pos >= lower.length || !isWhitespaceChar(lower.charCodeAt(pos))) {
			idx++;
			continue;
		}
		while (pos < lower.length && isWhitespaceChar(lower.charCodeAt(pos))) pos++;

		// Match "to"
		if (pos + 2 > lower.length || lower[pos] !== 't' || lower[pos + 1] !== 'o') {
			idx++;
			continue;
		}
		pos += 2;

		// Skip whitespace (at least one required)
		if (pos >= lower.length || !isWhitespaceChar(lower.charCodeAt(pos))) {
			idx++;
			continue;
		}
		while (pos < lower.length && isWhitespaceChar(lower.charCodeAt(pos))) pos++;

		// Match "interrupt"
		const target = 'interrupt';
		if (pos + target.length > lower.length) {
			idx++;
			continue;
		}
		let matched = true;
		for (let k = 0; k < target.length; k++) {
			if (lower[pos + k] !== target[k]) { matched = false; break; }
		}
		if (matched) return true;

		idx++;
	}
}

/**
 * Check if a character code is whitespace (space, tab, newline, carriage return).
 */
function isWhitespaceChar(cp: number): boolean {
	return cp === 0x20 || cp === 0x09 || cp === 0x0A || cp === 0x0D;
}

/**
 * Check if text contains Claude Code's Rewind mode.
 *
 * Replaces TERMINAL_PATTERNS.REWIND_MODE regex.
 * Checks for "Rewind" then "Restore the code" appearing after it.
 *
 * @param text - Text to check
 * @returns true if Rewind mode is detected
 */
export function containsRewindMode(text: string): boolean {
	const rewindIdx = text.indexOf('Rewind');
	if (rewindIdx === -1) return false;
	return text.indexOf('Restore the code', rewindIdx + 6) !== -1;
}

/**
 * Check if text contains Gemini CLI processing keywords.
 *
 * Replaces inline Gemini keyword regex in sendMessageWithRetry.
 *
 * @param text - Text to check
 * @returns true if any Gemini processing keyword is found
 */
export function containsGeminiProcessingKeywords(text: string): boolean {
	const lower = text.toLowerCase();
	for (const keyword of GEMINI_PROCESSING_KEYWORDS) {
		if (lower.includes(keyword)) return true;
	}
	return false;
}

// ─── Marker extraction ────────────────────────────────────────────────────────

/** A block extracted from terminal output bounded by open/close tags. */
export interface MarkerBlock {
	/** The content between the open and close tags (trimmed) */
	content: string;
	/** Start index of the open tag in the original buffer */
	startIndex: number;
	/** End index (exclusive) of the close tag in the original buffer */
	endIndex: number;
}

/**
 * Extract all marker blocks bounded by open/close tag pairs from a buffer.
 *
 * Replaces NOTIFY/SLACK_NOTIFY marker regex patterns.
 *
 * @param buf - The text buffer to search
 * @param openTag - Opening tag string (e.g., "[NOTIFY]")
 * @param closeTag - Closing tag string (e.g., "[/NOTIFY]")
 * @returns Array of extracted marker blocks
 */
export function extractMarkerBlocks(buf: string, openTag: string, closeTag: string): MarkerBlock[] {
	const results: MarkerBlock[] = [];
	let searchStart = 0;

	while (true) {
		const openIdx = buf.indexOf(openTag, searchStart);
		if (openIdx === -1) break;

		const contentStart = openIdx + openTag.length;
		const closeIdx = buf.indexOf(closeTag, contentStart);
		if (closeIdx === -1) break;

		const content = buf.slice(contentStart, closeIdx).trim();
		const endIndex = closeIdx + closeTag.length;

		results.push({ content, startIndex: openIdx, endIndex });
		searchStart = endIndex;
	}

	return results;
}

// ─── Chat response extraction ─────────────────────────────────────────────────

/** A legacy [CHAT_RESPONSE] block with optional embedded conversation ID. */
export interface ChatResponseBlock {
	/** Optional conversation ID from [CHAT_RESPONSE:convId] */
	conversationId: string | null;
	/** The response content between tags */
	content: string;
	/** Start index of the open tag in the original buffer */
	startIndex: number;
	/** End index (exclusive) of the close tag in the original buffer */
	endIndex: number;
}

/**
 * Extract all [CHAT_RESPONSE]...[/CHAT_RESPONSE] blocks from a buffer.
 * Handles the optional :conversationId suffix: [CHAT_RESPONSE:abc123].
 *
 * Replaces the CHAT_RESPONSE regex pattern.
 *
 * @param buf - The text buffer to search
 * @returns Array of extracted chat response blocks
 */
export function extractChatResponseBlocks(buf: string): ChatResponseBlock[] {
	const results: ChatResponseBlock[] = [];
	const openPrefix = '[CHAT_RESPONSE';
	const closeTag = '[/CHAT_RESPONSE]';
	let searchStart = 0;

	while (true) {
		const openIdx = buf.indexOf(openPrefix, searchStart);
		if (openIdx === -1) break;

		let pos = openIdx + openPrefix.length;

		// Parse optional :conversationId
		let conversationId: string | null = null;
		if (pos < buf.length && buf.charCodeAt(pos) === 0x3A) { // :
			pos++;
			const closeBracket = buf.indexOf(']', pos);
			if (closeBracket === -1) break;
			conversationId = buf.slice(pos, closeBracket) || null;
			pos = closeBracket + 1;
		} else if (pos < buf.length && buf.charCodeAt(pos) === 0x5D) { // ]
			pos++;
		} else {
			// Malformed — skip past this occurrence
			searchStart = openIdx + openPrefix.length;
			continue;
		}

		// Find close tag
		const closeIdx = buf.indexOf(closeTag, pos);
		if (closeIdx === -1) break;

		const content = buf.slice(pos, closeIdx).trim();
		const endIndex = closeIdx + closeTag.length;

		results.push({ conversationId, content, startIndex: openIdx, endIndex });
		searchStart = endIndex;
	}

	return results;
}

// ─── Conversation ID extraction ───────────────────────────────────────────────

/**
 * Extract conversation ID from a [CHAT:convId] marker in text.
 *
 * Replaces CHAT_ROUTING_CONSTANTS.CONVERSATION_ID_PATTERN regex.
 *
 * @param text - Text to search
 * @returns The conversation ID or null if not found
 */
export function extractConversationId(text: string): string | null {
	const marker = '[CHAT:';
	const idx = text.indexOf(marker);
	if (idx === -1) return null;

	const start = idx + marker.length;
	const end = text.indexOf(']', start);
	if (end === -1) return null;

	const id = text.slice(start, end);
	return id.length > 0 ? id : null;
}

/**
 * Extract and remove the [CHAT:convId] prefix from a message.
 *
 * Replaces the CHAT prefix regex.
 *
 * @param message - Message that may start with [CHAT:...]
 * @returns Object with the prefix length (0 if no prefix) and the content after prefix
 */
export function extractChatPrefix(message: string): { prefixLength: number; content: string } {
	if (!message.startsWith('[CHAT:')) {
		return { prefixLength: 0, content: message };
	}

	const closeBracket = message.indexOf(']');
	if (closeBracket === -1) {
		return { prefixLength: 0, content: message };
	}

	let afterBracket = closeBracket + 1;
	// Skip whitespace after ]
	while (afterBracket < message.length && isWhitespaceChar(message.charCodeAt(afterBracket))) {
		afterBracket++;
	}

	return {
		prefixLength: afterBracket,
		content: message.slice(afterBracket),
	};
}
