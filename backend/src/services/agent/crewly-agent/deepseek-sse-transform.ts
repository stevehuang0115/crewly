/**
 * DeepSeek SSE Transform — extracts `reasoning_content` from DeepSeek-R1 streaming responses.
 *
 * **Why this exists:**
 * DeepSeek-R1 (`deepseek-reasoner`) returns chain-of-thought as `delta.reasoning_content`
 * inside each SSE chunk. The Vercel AI SDK's @ai-sdk/openai chat-completions parser
 * (3.0.41) accumulates `reasoning_tokens` into `usage.reasoningTokens` (correct billing
 * surface) but **does not** map `reasoning_content` text to any content-part or
 * `reasoningText` field. Result: users pay for reasoning tokens but the reasoning
 * text is silently dropped.
 *
 * **What this module does:**
 * - Pure stream transformer: takes a DeepSeek SSE response body, tees it,
 *   passes one branch through unchanged (for AI SDK to consume normally),
 *   and parses the other branch to extract reasoning_content into an
 *   accumulator string.
 * - Zero dependency on AI SDK internals — operates only on the raw SSE byte
 *   stream that AI SDK is about to consume.
 *
 * **Architectural note (Sam memo reconciliation):**
 * Earlier scope memo referenced wrapping a "PR #425 translator output" layer.
 * Verified: PR #425 is the frontend Settings UI fix; no Crewly-owned translator
 * exists. The only seam Crewly owns between DeepSeek and the AI SDK is the
 * `createOpenAI({ fetch })` upstream hook in model-manager.ts. This module is
 * the body of that hook.
 *
 * **DeepClaude pattern reference (read-only):**
 * Reasoning-content extraction approach borrowed conceptually from public
 * DeepClaude pattern (HTTP proxy that splits R1 reasoning from final answer).
 * **No code, no fork, no dependency** — pattern reference only, per Anthropic
 * ToS guardrail flagged by Arch.
 *
 * @module services/agent/crewly-agent/deepseek-sse-transform
 */

/**
 * Shape of a single SSE `data:` payload from DeepSeek's chat-completions endpoint.
 * Only the fields we read are typed; the rest is left open.
 */
interface DeepseekSseChunk {
	choices?: Array<{
		delta?: {
			content?: string;
			reasoning_content?: string;
		};
		finish_reason?: string | null;
	}>;
}

/**
 * Result of teeing and parsing a DeepSeek SSE body.
 *
 * - `passthroughBody` is the un-tampered byte stream that should be handed
 *   to the consumer (AI SDK) as the response body.
 * - `getReasoning()` returns the accumulated reasoning_content text once
 *   the underlying stream has fully drained. Calling it before drain
 *   returns whatever has been parsed so far.
 */
export interface ParsedDeepseekSse {
	passthroughBody: ReadableStream<Uint8Array>;
	getReasoning(): string;
	/** True once the parser has seen the SSE `[DONE]` sentinel or stream end. */
	isDrained(): boolean;
}

/**
 * Parse a single SSE event-block (one or more `data:` lines + a blank line).
 *
 * Returns the accumulated reasoning_content string from this block, or
 * empty string if the block had no reasoning content. Returns `null` if
 * the block is the `[DONE]` sentinel.
 *
 * @param block - One SSE event block (between blank-line delimiters)
 * @returns reasoning_content string, or `null` if `[DONE]`
 */
export function parseSseBlock(block: string): string | null {
	const lines = block.split('\n');
	let reasoning = '';
	for (const line of lines) {
		if (!line.startsWith('data:')) continue;
		const payload = line.slice(5).trim();
		if (!payload) continue;
		if (payload === '[DONE]') return null;
		try {
			const chunk = JSON.parse(payload) as DeepseekSseChunk;
			const r = chunk.choices?.[0]?.delta?.reasoning_content;
			if (typeof r === 'string') {
				reasoning += r;
			}
		} catch {
			// Malformed JSON — skip silently; AI SDK consumer will surface
			// any real error itself when it parses the same chunk.
		}
	}
	return reasoning;
}

/**
 * Tee a DeepSeek SSE response body and parse one branch for reasoning_content
 * while passing the other branch through to the AI SDK consumer unchanged.
 *
 * The parser runs as a fire-and-forget background reader on the cloned stream.
 * It accumulates reasoning text into an internal buffer that the caller can
 * read via `getReasoning()` after the consumer has drained the passthrough.
 *
 * **Stream safety:**
 * - The tee is symmetric: backpressure on the consumer branch does not
 *   stall the parser branch (and vice versa) thanks to ReadableStream.tee()
 *   internal buffering.
 * - Parser errors are caught and logged but never propagated to the consumer.
 *
 * @param body - Raw SSE response body from DeepSeek
 * @returns Object with passthrough body and reasoning accumulator
 */
export function teeAndParse(body: ReadableStream<Uint8Array>): ParsedDeepseekSse {
	const [consumerBranch, parserBranch] = body.tee();
	let reasoning = '';
	let drained = false;

	// Background reader: drain parserBranch, parse SSE, accumulate reasoning.
	// Errors are swallowed — consumer branch is independent and unaffected.
	void (async () => {
		const reader = parserBranch.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				// SSE event blocks are delimited by blank lines (\n\n).
				let blankIdx: number;
				while ((blankIdx = buffer.indexOf('\n\n')) >= 0) {
					const block = buffer.slice(0, blankIdx);
					buffer = buffer.slice(blankIdx + 2);
					const result = parseSseBlock(block);
					if (result === null) {
						drained = true;
					} else if (result) {
						reasoning += result;
					}
				}
			}
			// Flush trailing partial block (if SSE source ended mid-block — defensive)
			if (buffer.trim()) {
				const result = parseSseBlock(buffer);
				if (result && result !== null) reasoning += result;
			}
		} catch (err) {
			// Parser failures must not break consumer flow — log and exit.
			// eslint-disable-next-line no-console
			console.warn('[DeepSeek SSE Transform] parser branch error (consumer unaffected):', err);
		} finally {
			drained = true;
			try {
				reader.releaseLock();
			} catch {
				/* already released */
			}
		}
	})();

	return {
		passthroughBody: consumerBranch,
		getReasoning: () => reasoning,
		isDrained: () => drained,
	};
}
