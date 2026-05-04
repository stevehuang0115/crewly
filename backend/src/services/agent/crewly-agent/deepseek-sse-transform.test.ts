/**
 * Tests for DeepSeek SSE Transform.
 *
 * Coverage:
 * - parseSseBlock: well-formed reasoning chunks, plain content (no reasoning),
 *   `[DONE]` sentinel, malformed JSON resilience, multi-line blocks.
 * - teeAndParse: passthrough body identical to source, reasoning accumulation
 *   across chunks, parser error isolation from consumer.
 */

import { describe, it, expect } from '@jest/globals';
import { parseSseBlock, teeAndParse } from './deepseek-sse-transform.js';

/**
 * Helper to build a ReadableStream<Uint8Array> from a list of string chunks.
 * Each chunk becomes one stream queue entry — useful to simulate SSE arriving
 * in arbitrary network packet boundaries.
 */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i >= chunks.length) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(chunks[i]!));
			i++;
		},
	});
}

/**
 * Drain a ReadableStream<Uint8Array> into a single decoded string.
 */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let out = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		out += decoder.decode(value, { stream: true });
	}
	out += decoder.decode();
	return out;
}

describe('parseSseBlock', () => {
	it('extracts reasoning_content from a single delta chunk', () => {
		const block = 'data: {"choices":[{"delta":{"reasoning_content":"Let me think..."}}]}';
		expect(parseSseBlock(block)).toBe('Let me think...');
	});

	it('returns empty string when delta has only content (no reasoning)', () => {
		const block = 'data: {"choices":[{"delta":{"content":"answer"}}]}';
		expect(parseSseBlock(block)).toBe('');
	});

	it('returns null for [DONE] sentinel', () => {
		expect(parseSseBlock('data: [DONE]')).toBeNull();
	});

	it('handles multi-line block with multiple data: lines', () => {
		const block = [
			'data: {"choices":[{"delta":{"reasoning_content":"step 1 "}}]}',
			'data: {"choices":[{"delta":{"reasoning_content":"step 2"}}]}',
		].join('\n');
		expect(parseSseBlock(block)).toBe('step 1 step 2');
	});

	it('skips malformed JSON without throwing', () => {
		const block = 'data: {not valid json';
		expect(parseSseBlock(block)).toBe('');
	});

	it('skips non-data: lines (e.g. event:, id:)', () => {
		const block = [
			'id: abc',
			'event: chunk',
			'data: {"choices":[{"delta":{"reasoning_content":"x"}}]}',
		].join('\n');
		expect(parseSseBlock(block)).toBe('x');
	});

	it('returns empty string for empty data payload', () => {
		expect(parseSseBlock('data:')).toBe('');
		expect(parseSseBlock('data: ')).toBe('');
	});

	it('handles delta with both content and reasoning_content (returns only reasoning)', () => {
		const block =
			'data: {"choices":[{"delta":{"content":"answer","reasoning_content":"thought"}}]}';
		expect(parseSseBlock(block)).toBe('thought');
	});
});

describe('teeAndParse', () => {
	it('passthroughBody yields exactly the source bytes', async () => {
		const source = [
			'data: {"choices":[{"delta":{"reasoning_content":"r1"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
			'data: [DONE]\n\n',
		];
		const expected = source.join('');
		const stream = streamOf(source);
		const parsed = teeAndParse(stream);
		const got = await drain(parsed.passthroughBody);
		expect(got).toBe(expected);
	});

	it('accumulates reasoning_content across multiple chunks', async () => {
		const source = [
			'data: {"choices":[{"delta":{"reasoning_content":"alpha "}}]}\n\n',
			'data: {"choices":[{"delta":{"reasoning_content":"beta "}}]}\n\n',
			'data: {"choices":[{"delta":{"reasoning_content":"gamma"}}]}\n\n',
			'data: [DONE]\n\n',
		];
		const stream = streamOf(source);
		const parsed = teeAndParse(stream);
		await drain(parsed.passthroughBody);
		// Wait one microtask cycle for parser branch to finish draining.
		// Parser branch runs in the same event loop but completes async; the
		// consumer drain above ensures backpressure has cleared.
		await new Promise((r) => setImmediate(r));
		expect(parsed.getReasoning()).toBe('alpha beta gamma');
	});

	it('handles SSE chunks split across packet boundaries', async () => {
		// Simulate a single SSE event arriving in two TCP packets.
		const source = [
			'data: {"choices":[{"delta":{"reaso',
			'ning_content":"split"}}]}\n\n',
			'data: [DONE]\n\n',
		];
		const stream = streamOf(source);
		const parsed = teeAndParse(stream);
		await drain(parsed.passthroughBody);
		await new Promise((r) => setImmediate(r));
		expect(parsed.getReasoning()).toBe('split');
	});

	it('isDrained becomes true after [DONE] sentinel is parsed', async () => {
		const source = ['data: {"choices":[{"delta":{"content":"x"}}]}\n\n', 'data: [DONE]\n\n'];
		const stream = streamOf(source);
		const parsed = teeAndParse(stream);
		expect(parsed.isDrained()).toBe(false);
		await drain(parsed.passthroughBody);
		await new Promise((r) => setImmediate(r));
		expect(parsed.isDrained()).toBe(true);
	});

	it('returns empty reasoning when stream contains no reasoning_content', async () => {
		const source = [
			'data: {"choices":[{"delta":{"content":"plain answer"}}]}\n\n',
			'data: [DONE]\n\n',
		];
		const stream = streamOf(source);
		const parsed = teeAndParse(stream);
		await drain(parsed.passthroughBody);
		await new Promise((r) => setImmediate(r));
		expect(parsed.getReasoning()).toBe('');
	});
});
