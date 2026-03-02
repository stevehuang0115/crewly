/**
 * Terminal output utilities for processing PTY output.
 *
 * Provides functions for stripping ANSI escape codes and deduplicating
 * chat responses from orchestrator terminal output.
 *
 * @module terminal-output-utils
 */

/**
 * Strip ANSI escape codes from PTY output for reliable pattern matching.
 *
 * Delegates to the regex-free state-machine implementation in terminal-string-ops.
 * Handles color codes, cursor movements, OSC sequences, and other control
 * characters. Cursor forward movements are replaced with spaces to preserve
 * word boundaries in rendered output.
 *
 * @param content - Raw PTY output containing ANSI codes
 * @returns Clean text with ANSI codes removed
 */
export { stripAnsiCodes } from './terminal-string-ops.js';

/**
 * Generate a hash key for a chat response to detect duplicates.
 *
 * Normalizes whitespace and truncates to create a consistent key
 * for the same logical response content.
 *
 * @param conversationId - The conversation this response belongs to
 * @param content - The response content to hash
 * @returns A string key for deduplication
 */
export function generateResponseHash(conversationId: string, content: string): string {
	const normalized = content.replace(/\s+/g, ' ').trim();
	return `${conversationId}:${normalized.substring(0, 200)}`;
}

/**
 * Manages a set of recent response hashes for deduplication.
 * Uses a circular eviction strategy to bound memory usage.
 */
export class ResponseDeduplicator {
	private recentHashes = new Set<string>();
	private readonly maxSize: number;

	/**
	 * @param maxSize - Maximum number of hashes to track before evicting oldest
	 */
	constructor(maxSize: number = 20) {
		this.maxSize = maxSize;
	}

	/**
	 * Check if a response is a duplicate and track it if not.
	 *
	 * @param hash - The response hash to check
	 * @returns true if the response is a duplicate, false if it's new
	 */
	isDuplicate(hash: string): boolean {
		if (this.recentHashes.has(hash)) {
			return true;
		}
		this.recentHashes.add(hash);
		if (this.recentHashes.size > this.maxSize) {
			const first = this.recentHashes.values().next().value;
			if (first !== undefined) {
				this.recentHashes.delete(first);
			}
		}
		return false;
	}

	/** Clear all tracked hashes */
	clear(): void {
		this.recentHashes.clear();
	}

	/** Current number of tracked hashes */
	get size(): number {
		return this.recentHashes.size;
	}
}
