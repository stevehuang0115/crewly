/**
 * Tests for terminal-string-ops — regex-free terminal processing functions.
 *
 * @module terminal-string-ops.test
 */

import {
	stripAnsiCodes,
	stripBoxDrawing,
	stripTuiLineBorders,
	matchTuiPromptLine,
	isPromptLine,
	isAgentAtPrompt,
	containsSpinnerOrWorkingIndicator,
	containsProcessingIndicator,
	containsBusyStatusBar,
	containsRewindMode,
	containsGeminiProcessingKeywords,
	extractMarkerBlocks,
	extractChatResponseBlocks,
	extractConversationId,
	extractChatPrefix,
} from './terminal-string-ops.js';
import { RUNTIME_TYPES } from '../constants.js';

// ─── stripAnsiCodes ───────────────────────────────────────────────────────────

describe('stripAnsiCodes (state machine)', () => {
	describe('color codes', () => {
		it('should remove basic color codes', () => {
			expect(stripAnsiCodes('\x1b[31mred text\x1b[0m')).toBe('red text');
		});

		it('should remove multi-parameter color codes', () => {
			expect(stripAnsiCodes('\x1b[1;33mBold Yellow\x1b[0m')).toBe('Bold Yellow');
		});

		it('should remove 256-color codes', () => {
			expect(stripAnsiCodes('\x1b[38;5;202morange\x1b[0m')).toBe('orange');
		});
	});

	describe('cursor movement', () => {
		it('should replace cursor forward with space', () => {
			expect(stripAnsiCodes('hello\x1b[5Cworld')).toBe('hello world');
		});

		it('should replace cursor forward (zero digits) with space', () => {
			expect(stripAnsiCodes('hello\x1b[Cworld')).toBe('hello world');
		});

		it('should remove cursor up/down sequences', () => {
			expect(stripAnsiCodes('line1\x1b[1Aup')).toBe('line1up');
		});
	});

	describe('CHAT_RESPONSE marker preservation (critical)', () => {
		it('should NOT strip [C from [CHAT_RESPONSE]', () => {
			const input = '[CHAT_RESPONSE]Hello world[/CHAT_RESPONSE]';
			const result = stripAnsiCodes(input);
			expect(result).toContain('[CHAT_RESPONSE]');
			expect(result).toContain('[/CHAT_RESPONSE]');
		});

		it('should NOT strip [C from [/CHAT_RESPONSE]', () => {
			const input = 'some text [/CHAT_RESPONSE]';
			const result = stripAnsiCodes(input);
			expect(result).toContain('[/CHAT_RESPONSE]');
		});

		it('should strip orphaned [1C but preserve [CHAT_RESPONSE]', () => {
			const input = 'about[1Cyour [CHAT_RESPONSE]message here[/CHAT_RESPONSE]';
			const result = stripAnsiCodes(input);
			expect(result).toContain('[CHAT_RESPONSE]');
			expect(result).toContain('[/CHAT_RESPONSE]');
			expect(result).toContain('about your');
		});

		it('should handle CHAT_RESPONSE with ANSI codes inside', () => {
			const input = '[CHAT_RESPONSE]\x1b[1mBold\x1b[0m response[/CHAT_RESPONSE]';
			const result = stripAnsiCodes(input);
			expect(result).toBe('[CHAT_RESPONSE]Bold response[/CHAT_RESPONSE]');
		});
	});

	describe('orphaned CSI fragments', () => {
		it('should replace [1C with space (cursor forward orphan)', () => {
			expect(stripAnsiCodes('word[1Cnext')).toBe('word next');
		});

		it('should replace [22m (orphaned color reset)', () => {
			expect(stripAnsiCodes('text[22mbold')).toBe('textbold');
		});

		it('should not match [C without digits (could be part of marker text)', () => {
			const result = stripAnsiCodes('[CHAT_RESPONSE]');
			expect(result).toBe('[CHAT_RESPONSE]');
		});

		it('should remove private-mode fragments like [?25h and [?2026l', () => {
			const input = 'hello[?25h world[?2026l!';
			const result = stripAnsiCodes(input);
			expect(result).toBe('hello world!');
		});

		it('should remove escaped private-mode fragments', () => {
			const input = 'A\x1b[?25hB\x1b[?2026lC';
			const result = stripAnsiCodes(input);
			expect(result).toBe('ABC');
		});
	});

	describe('OSC sequences', () => {
		it('should remove title change sequences', () => {
			expect(stripAnsiCodes('\x1b]0;My Terminal\x07text')).toBe('text');
		});

		it('should remove hyperlink sequences', () => {
			expect(stripAnsiCodes('\x1b]8;id=123;https://example.com\x07link\x1b]8;;\x07')).toBe('link');
		});
	});

	describe('line ending normalization', () => {
		it('should normalize CR+LF to LF', () => {
			expect(stripAnsiCodes('line1\r\nline2')).toBe('line1\nline2');
		});

		it('should normalize bare CR to LF', () => {
			expect(stripAnsiCodes('line1\rline2')).toBe('line1\nline2');
		});

		it('should keep existing LF unchanged', () => {
			expect(stripAnsiCodes('line1\nline2')).toBe('line1\nline2');
		});
	});

	describe('control characters', () => {
		it('should remove null bytes', () => {
			expect(stripAnsiCodes('hel\x00lo')).toBe('hello');
		});

		it('should keep tabs', () => {
			expect(stripAnsiCodes('col1\tcol2')).toBe('col1\tcol2');
		});

		it('should keep newlines', () => {
			expect(stripAnsiCodes('line1\nline2')).toBe('line1\nline2');
		});

		it('should remove DEL character', () => {
			expect(stripAnsiCodes('hel\x7Flo')).toBe('hello');
		});
	});

	describe('complex real-world examples', () => {
		it('should clean typical Claude Code output', () => {
			const input = '\x1b[1m\x1b[32m⏺\x1b[0m Ready for tasks.\x1b[0m\r\n';
			const result = stripAnsiCodes(input);
			expect(result).toContain('Ready for tasks.');
		});

		it('should handle mixed ANSI and CHAT_RESPONSE markers', () => {
			const input = '\x1b[2K\x1b[1G[CHAT_RESPONSE]\x1b[1mProject Created\x1b[0m\ntest-project has been set up\n[/CHAT_RESPONSE]\x1b[0m';
			const result = stripAnsiCodes(input);
			expect(result).toContain('[CHAT_RESPONSE]');
			expect(result).toContain('[/CHAT_RESPONSE]');
			expect(result).toContain('Project Created');
		});

		it('should handle empty input', () => {
			expect(stripAnsiCodes('')).toBe('');
		});

		it('should handle input with no ANSI codes', () => {
			expect(stripAnsiCodes('plain text')).toBe('plain text');
		});
	});

	describe('ReDoS resistance', () => {
		it('should handle 10KB of newlines without hanging', () => {
			const input = '\n'.repeat(10000);
			const start = Date.now();
			stripAnsiCodes(input);
			const elapsed = Date.now() - start;
			expect(elapsed).toBeLessThan(100); // Should be near-instant
		});

		it('should handle pathological orphaned CSI-like input', () => {
			// This pattern would cause ReDoS with regex like /\[\d+C/g on long input
			const input = '[' + '1'.repeat(5000) + 'X'; // Not a valid CSI — should pass through
			const start = Date.now();
			stripAnsiCodes(input);
			const elapsed = Date.now() - start;
			expect(elapsed).toBeLessThan(100);
		});
	});
});

// ─── stripBoxDrawing ──────────────────────────────────────────────────────────

describe('stripBoxDrawing', () => {
	it('should strip leading box chars', () => {
		expect(stripBoxDrawing('──── hello')).toBe('hello');
	});

	it('should strip trailing box chars', () => {
		expect(stripBoxDrawing('hello ────')).toBe('hello');
	});

	it('should strip both ends', () => {
		expect(stripBoxDrawing('║ hello ║')).toBe('hello');
	});

	it('should handle mixed box and ASCII chars', () => {
		expect(stripBoxDrawing('|+- text -+|')).toBe('text');
	});

	it('should return empty for all box chars', () => {
		expect(stripBoxDrawing('────')).toBe('');
	});

	it('should handle empty string', () => {
		expect(stripBoxDrawing('')).toBe('');
	});

	it('should not strip non-box characters', () => {
		expect(stripBoxDrawing('hello world')).toBe('hello world');
	});
});

// ─── stripTuiLineBorders ──────────────────────────────────────────────────────

describe('stripTuiLineBorders', () => {
	it('should strip leading │', () => {
		expect(stripTuiLineBorders('│ hello')).toBe('hello');
	});

	it('should strip trailing │', () => {
		expect(stripTuiLineBorders('hello │')).toBe('hello');
	});

	it('should strip both ends', () => {
		expect(stripTuiLineBorders('│ hello │')).toBe('hello');
	});

	it('should strip ┃ borders', () => {
		expect(stripTuiLineBorders('┃ content ┃')).toBe('content');
	});

	it('should strip ║ borders', () => {
		expect(stripTuiLineBorders('║ text ║')).toBe('text');
	});

	it('should strip | (pipe) borders', () => {
		expect(stripTuiLineBorders('| text |')).toBe('text');
	});

	it('should handle empty string', () => {
		expect(stripTuiLineBorders('')).toBe('');
	});
});

// ─── matchTuiPromptLine ───────────────────────────────────────────────────────

describe('matchTuiPromptLine', () => {
	it('should match simple > prompt', () => {
		expect(matchTuiPromptLine('> hello world')).toBe('hello world');
	});

	it('should match bordered > prompt', () => {
		expect(matchTuiPromptLine('│ > hello world')).toBe('hello world');
	});

	it('should match bordered > prompt with pipe', () => {
		expect(matchTuiPromptLine('| > input text')).toBe('input text');
	});

	it('should return null for lines without > prompt', () => {
		expect(matchTuiPromptLine('hello world')).toBeNull();
	});

	it('should return null for > without space', () => {
		expect(matchTuiPromptLine('>noSpace')).toBeNull();
	});

	it('should return null for empty > prompt', () => {
		expect(matchTuiPromptLine('> ')).toBeNull();
	});

	it('should handle leading whitespace', () => {
		expect(matchTuiPromptLine('   > text')).toBe('text');
	});
});

// ─── isPromptLine ─────────────────────────────────────────────────────────────

describe('isPromptLine', () => {
	describe('Claude Code', () => {
		it('should detect ❯ prompt', () => {
			expect(isPromptLine('❯', RUNTIME_TYPES.CLAUDE_CODE)).toBe(true);
		});

		it('should detect ⏵ prompt', () => {
			expect(isPromptLine('⏵', RUNTIME_TYPES.CLAUDE_CODE)).toBe(true);
		});

		it('should detect $ prompt', () => {
			expect(isPromptLine('$', RUNTIME_TYPES.CLAUDE_CODE)).toBe(true);
		});

		it('should detect ❯❯ bypass prompt', () => {
			expect(isPromptLine('❯❯ bypass permissions on (shift+tab to cycle)', RUNTIME_TYPES.CLAUDE_CODE)).toBe(true);
		});

		it('should not match > for Claude Code', () => {
			expect(isPromptLine('> text', RUNTIME_TYPES.CLAUDE_CODE)).toBe(false);
		});
	});

	describe('Gemini CLI', () => {
		it('should detect > prompt', () => {
			expect(isPromptLine('> hello', RUNTIME_TYPES.GEMINI_CLI)).toBe(true);
		});

		it('should detect ! prompt', () => {
			expect(isPromptLine('! command', RUNTIME_TYPES.GEMINI_CLI)).toBe(true);
		});

		it('should detect Type your message', () => {
			expect(isPromptLine('Type your message ...', RUNTIME_TYPES.GEMINI_CLI)).toBe(true);
		});

		it('should detect YOLO mode', () => {
			expect(isPromptLine('YOLO mode enabled', RUNTIME_TYPES.GEMINI_CLI)).toBe(true);
		});

		it('should not match ❯ for Gemini CLI', () => {
			expect(isPromptLine('❯', RUNTIME_TYPES.GEMINI_CLI)).toBe(false);
		});
	});

	describe('Codex CLI', () => {
		it('should detect › prompt', () => {
			expect(isPromptLine('› hello', RUNTIME_TYPES.CODEX_CLI)).toBe(true);
		});

		it('should not match ❯ for Codex CLI', () => {
			expect(isPromptLine('❯', RUNTIME_TYPES.CODEX_CLI)).toBe(false);
		});
	});

	describe('unknown runtime', () => {
		it('should detect ❯ prompt', () => {
			expect(isPromptLine('❯')).toBe(true);
		});

		it('should detect > prompt', () => {
			expect(isPromptLine('> text')).toBe(true);
		});
	});

	it('should return false for empty line', () => {
		expect(isPromptLine('')).toBe(false);
	});
});

// ─── isAgentAtPrompt ──────────────────────────────────────────────────────────

describe('isAgentAtPrompt', () => {
	it('should return true when prompt is in last lines', () => {
		const output = 'line1\nline2\n❯ ';
		expect(isAgentAtPrompt(output, RUNTIME_TYPES.CLAUDE_CODE)).toBe(true);
	});

	it('should return false for empty input', () => {
		expect(isAgentAtPrompt('', RUNTIME_TYPES.CLAUDE_CODE)).toBe(false);
	});

	it('should return false for null input', () => {
		expect(isAgentAtPrompt(null as unknown as string)).toBe(false);
	});

	it('should detect Gemini prompt', () => {
		const output = 'some output\n> ';
		expect(isAgentAtPrompt(output, RUNTIME_TYPES.GEMINI_CLI)).toBe(true);
	});
});

// ─── containsSpinnerOrWorkingIndicator ────────────────────────────────────────

describe('containsSpinnerOrWorkingIndicator', () => {
	it('should detect spinner ⠋', () => {
		expect(containsSpinnerOrWorkingIndicator('loading ⠋')).toBe(true);
	});

	it('should detect spinner ⠹', () => {
		expect(containsSpinnerOrWorkingIndicator('⠹ working')).toBe(true);
	});

	it('should detect working indicator ⏺', () => {
		expect(containsSpinnerOrWorkingIndicator('⏺ Processing')).toBe(true);
	});

	it('should return false for no indicators', () => {
		expect(containsSpinnerOrWorkingIndicator('regular text')).toBe(false);
	});

	it('should return false for empty string', () => {
		expect(containsSpinnerOrWorkingIndicator('')).toBe(false);
	});
});

// ─── containsProcessingIndicator ──────────────────────────────────────────────

describe('containsProcessingIndicator', () => {
	it('should detect spinner chars', () => {
		expect(containsProcessingIndicator('⠋ loading')).toBe(true);
	});

	it('should detect working indicator', () => {
		expect(containsProcessingIndicator('⏺ done')).toBe(true);
	});

	it('should detect "thinking" keyword (case-insensitive)', () => {
		expect(containsProcessingIndicator('Thinking about...')).toBe(true);
	});

	it('should detect "processing" keyword', () => {
		expect(containsProcessingIndicator('Processing request')).toBe(true);
	});

	it('should detect "analyzing" keyword', () => {
		expect(containsProcessingIndicator('analyzing data')).toBe(true);
	});

	it('should detect "running" keyword', () => {
		expect(containsProcessingIndicator('Running tests')).toBe(true);
	});

	it('should detect "calling" keyword', () => {
		expect(containsProcessingIndicator('calling API')).toBe(true);
	});

	it('should return false for regular text', () => {
		expect(containsProcessingIndicator('hello world')).toBe(false);
	});
});

// ─── containsBusyStatusBar ────────────────────────────────────────────────────

describe('containsBusyStatusBar', () => {
	it('should detect "esc to interrupt"', () => {
		expect(containsBusyStatusBar('esc to interrupt')).toBe(true);
	});

	it('should detect case-insensitive "ESC TO INTERRUPT"', () => {
		expect(containsBusyStatusBar('ESC TO INTERRUPT')).toBe(true);
	});

	it('should detect with extra whitespace', () => {
		expect(containsBusyStatusBar('esc   to   interrupt')).toBe(true);
	});

	it('should detect embedded in other text', () => {
		expect(containsBusyStatusBar('some prefix esc to interrupt some suffix')).toBe(true);
	});

	it('should return false for partial match', () => {
		expect(containsBusyStatusBar('esc to nowhere')).toBe(false);
	});

	it('should return false for "esc" alone', () => {
		expect(containsBusyStatusBar('esc')).toBe(false);
	});

	it('should return false for empty string', () => {
		expect(containsBusyStatusBar('')).toBe(false);
	});

	it('should require whitespace between words', () => {
		expect(containsBusyStatusBar('esctointerrupt')).toBe(false);
	});
});

// ─── containsRewindMode ──────────────────────────────────────────────────────

describe('containsRewindMode', () => {
	it('should detect Rewind mode', () => {
		expect(containsRewindMode('Rewind\nSome text\nRestore the code')).toBe(true);
	});

	it('should detect Rewind mode on same line', () => {
		expect(containsRewindMode('Rewind Restore the code')).toBe(true);
	});

	it('should return false without Rewind', () => {
		expect(containsRewindMode('Restore the code')).toBe(false);
	});

	it('should return false without Restore the code', () => {
		expect(containsRewindMode('Rewind mode')).toBe(false);
	});

	it('should return false for empty string', () => {
		expect(containsRewindMode('')).toBe(false);
	});

	it('should handle Restore before Rewind (wrong order)', () => {
		expect(containsRewindMode('Restore the code then Rewind')).toBe(false);
	});
});

// ─── containsGeminiProcessingKeywords ─────────────────────────────────────────

describe('containsGeminiProcessingKeywords', () => {
	it('should detect "reading"', () => {
		expect(containsGeminiProcessingKeywords('reading file')).toBe(true);
	});

	it('should detect "thinking" (case-insensitive)', () => {
		expect(containsGeminiProcessingKeywords('Thinking...')).toBe(true);
	});

	it('should detect "generating"', () => {
		expect(containsGeminiProcessingKeywords('generating response')).toBe(true);
	});

	it('should detect "searching"', () => {
		expect(containsGeminiProcessingKeywords('searching codebase')).toBe(true);
	});

	it('should return false for unrelated text', () => {
		expect(containsGeminiProcessingKeywords('hello world')).toBe(false);
	});
});

// ─── extractMarkerBlocks ──────────────────────────────────────────────────────

describe('extractMarkerBlocks', () => {
	it('should extract a single block', () => {
		const buf = 'before [NOTIFY]hello world[/NOTIFY] after';
		const blocks = extractMarkerBlocks(buf, '[NOTIFY]', '[/NOTIFY]');
		expect(blocks).toHaveLength(1);
		expect(blocks[0].content).toBe('hello world');
	});

	it('should extract multiple blocks', () => {
		const buf = '[NOTIFY]first[/NOTIFY] gap [NOTIFY]second[/NOTIFY]';
		const blocks = extractMarkerBlocks(buf, '[NOTIFY]', '[/NOTIFY]');
		expect(blocks).toHaveLength(2);
		expect(blocks[0].content).toBe('first');
		expect(blocks[1].content).toBe('second');
	});

	it('should provide correct startIndex and endIndex', () => {
		const buf = 'prefix [NOTIFY]content[/NOTIFY] suffix';
		const blocks = extractMarkerBlocks(buf, '[NOTIFY]', '[/NOTIFY]');
		expect(blocks[0].startIndex).toBe(7);
		expect(blocks[0].endIndex).toBe(31);
	});

	it('should trim content', () => {
		const buf = '[NOTIFY]  trimmed  [/NOTIFY]';
		const blocks = extractMarkerBlocks(buf, '[NOTIFY]', '[/NOTIFY]');
		expect(blocks[0].content).toBe('trimmed');
	});

	it('should return empty array for no matches', () => {
		const blocks = extractMarkerBlocks('no markers here', '[NOTIFY]', '[/NOTIFY]');
		expect(blocks).toHaveLength(0);
	});

	it('should handle unclosed tags', () => {
		const buf = '[NOTIFY]incomplete content';
		const blocks = extractMarkerBlocks(buf, '[NOTIFY]', '[/NOTIFY]');
		expect(blocks).toHaveLength(0);
	});

	it('should handle content with newlines', () => {
		const buf = '[NOTIFY]line1\nline2\nline3[/NOTIFY]';
		const blocks = extractMarkerBlocks(buf, '[NOTIFY]', '[/NOTIFY]');
		expect(blocks[0].content).toBe('line1\nline2\nline3');
	});

	it('should work with SLACK_NOTIFY tags', () => {
		const buf = '[SLACK_NOTIFY]{"type":"alert"}[/SLACK_NOTIFY]';
		const blocks = extractMarkerBlocks(buf, '[SLACK_NOTIFY]', '[/SLACK_NOTIFY]');
		expect(blocks).toHaveLength(1);
		expect(blocks[0].content).toBe('{"type":"alert"}');
	});
});

// ─── extractChatResponseBlocks ────────────────────────────────────────────────

describe('extractChatResponseBlocks', () => {
	it('should extract simple CHAT_RESPONSE block', () => {
		const buf = '[CHAT_RESPONSE]Hello world[/CHAT_RESPONSE]';
		const blocks = extractChatResponseBlocks(buf);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].content).toBe('Hello world');
		expect(blocks[0].conversationId).toBeNull();
	});

	it('should extract CHAT_RESPONSE with conversation ID', () => {
		const buf = '[CHAT_RESPONSE:conv-123]Hello[/CHAT_RESPONSE]';
		const blocks = extractChatResponseBlocks(buf);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].content).toBe('Hello');
		expect(blocks[0].conversationId).toBe('conv-123');
	});

	it('should extract multiple blocks', () => {
		const buf = '[CHAT_RESPONSE]first[/CHAT_RESPONSE] [CHAT_RESPONSE:c2]second[/CHAT_RESPONSE]';
		const blocks = extractChatResponseBlocks(buf);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].conversationId).toBeNull();
		expect(blocks[1].conversationId).toBe('c2');
	});

	it('should provide correct indices', () => {
		const buf = 'prefix [CHAT_RESPONSE]content[/CHAT_RESPONSE] suffix';
		const blocks = extractChatResponseBlocks(buf);
		expect(blocks[0].startIndex).toBe(7);
	});

	it('should handle empty conversation ID', () => {
		const buf = '[CHAT_RESPONSE:]content[/CHAT_RESPONSE]';
		const blocks = extractChatResponseBlocks(buf);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].conversationId).toBeNull();
	});

	it('should trim content', () => {
		const buf = '[CHAT_RESPONSE]  trimmed  [/CHAT_RESPONSE]';
		const blocks = extractChatResponseBlocks(buf);
		expect(blocks[0].content).toBe('trimmed');
	});

	it('should return empty for no matches', () => {
		const blocks = extractChatResponseBlocks('no markers');
		expect(blocks).toHaveLength(0);
	});
});

// ─── extractConversationId ────────────────────────────────────────────────────

describe('extractConversationId', () => {
	it('should extract conversation ID', () => {
		expect(extractConversationId('[CHAT:conv-abc-123] Hello')).toBe('conv-abc-123');
	});

	it('should return null for no marker', () => {
		expect(extractConversationId('no chat marker here')).toBeNull();
	});

	it('should return null for empty ID', () => {
		expect(extractConversationId('[CHAT:]')).toBeNull();
	});

	it('should return null for unclosed marker', () => {
		expect(extractConversationId('[CHAT:abc')).toBeNull();
	});

	it('should find first occurrence', () => {
		expect(extractConversationId('prefix [CHAT:first] then [CHAT:second]')).toBe('first');
	});
});

// ─── extractChatPrefix ────────────────────────────────────────────────────────

describe('extractChatPrefix', () => {
	it('should extract chat prefix and content', () => {
		const result = extractChatPrefix('[CHAT:conv-123] Hello world');
		expect(result.prefixLength).toBe(16);
		expect(result.content).toBe('Hello world');
	});

	it('should handle no prefix', () => {
		const result = extractChatPrefix('Hello world');
		expect(result.prefixLength).toBe(0);
		expect(result.content).toBe('Hello world');
	});

	it('should handle prefix without content', () => {
		const result = extractChatPrefix('[CHAT:abc]');
		expect(result.prefixLength).toBe(10);
		expect(result.content).toBe('');
	});

	it('should skip whitespace after prefix', () => {
		const result = extractChatPrefix('[CHAT:id]   content');
		expect(result.content).toBe('content');
	});

	it('should handle unclosed bracket', () => {
		const result = extractChatPrefix('[CHAT:abc no bracket');
		expect(result.prefixLength).toBe(0);
		expect(result.content).toBe('[CHAT:abc no bracket');
	});
});
