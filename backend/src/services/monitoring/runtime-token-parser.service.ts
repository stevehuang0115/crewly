/**
 * Runtime Token Parser Service
 *
 * Parses token usage data from terminal output of different AI CLI runtimes.
 * Each runtime (Claude Code, Gemini CLI, Codex CLI) has a distinct output
 * format for reporting token consumption. This service extracts structured
 * token data from those formats.
 *
 * @module services/monitoring/runtime-token-parser.service
 */

/** Parsed token usage data from runtime output */
export interface ParsedTokenUsage {
  /** Number of input/prompt tokens consumed */
  inputTokens: number;
  /** Number of output/completion tokens generated */
  outputTokens: number;
  /** Total cost in USD (if reported by the runtime) */
  cost?: number;
  /** Model identifier (if reported by the runtime) */
  model?: string;
  /** Which runtime produced this data */
  runtime: 'claude-code' | 'gemini-cli' | 'codex-cli';
}

/**
 * Parse Claude Code terminal output for token usage data.
 *
 * Claude Code reports token usage in several formats:
 * - Status line: "↑ 15234 ↓ 3456" or "15234↑ 3456↓"
 * - Summary: "Total: 15,234 input / 3,456 output tokens"
 * - Cost line: "Total cost: $0.05" or "Cost: $0.0523"
 * - Compact: "tokens: 15234 in, 3456 out"
 *
 * @param output - Raw terminal output from Claude Code session
 * @returns Parsed token usage or null if no token data found
 */
export function parseClaudeCodeTokens(output: string): ParsedTokenUsage | null {
  // Pattern 1: "Total: X input / Y output tokens" or "X input, Y output"
  const summaryPattern = /(\d[\d,]*)\s*input\s*[/,]\s*(\d[\d,]*)\s*output/i;
  const summaryMatch = output.match(summaryPattern);
  if (summaryMatch) {
    const inputTokens = parseInt(summaryMatch[1].replace(/,/g, ''), 10);
    const outputTokens = parseInt(summaryMatch[2].replace(/,/g, ''), 10);
    if (inputTokens > 0 || outputTokens > 0) {
      const result: ParsedTokenUsage = { inputTokens, outputTokens, runtime: 'claude-code' };
      const costMatch = output.match(/(?:total\s+)?cost[:\s]+\$?([\d.]+)/i);
      if (costMatch) {
        result.cost = parseFloat(costMatch[1]);
      }
      return result;
    }
  }

  // Pattern 2: Arrow notation "↑ 15234 ↓ 3456" or "15234↑ 3456↓"
  const arrowPattern1 = /↑\s*(\d[\d,]*)\s*↓\s*(\d[\d,]*)/;
  const arrowMatch1 = output.match(arrowPattern1);
  if (arrowMatch1) {
    return {
      inputTokens: parseInt(arrowMatch1[1].replace(/,/g, ''), 10),
      outputTokens: parseInt(arrowMatch1[2].replace(/,/g, ''), 10),
      runtime: 'claude-code',
    };
  }

  const arrowPattern2 = /(\d[\d,]*)↑\s*(\d[\d,]*)↓/;
  const arrowMatch2 = output.match(arrowPattern2);
  if (arrowMatch2) {
    return {
      inputTokens: parseInt(arrowMatch2[1].replace(/,/g, ''), 10),
      outputTokens: parseInt(arrowMatch2[2].replace(/,/g, ''), 10),
      runtime: 'claude-code',
    };
  }

  // Pattern 3: "tokens: X in, Y out" or "tokens: X in / Y out"
  const compactPattern = /tokens[:\s]+(\d[\d,]*)\s*in\s*[/,]\s*(\d[\d,]*)\s*out/i;
  const compactMatch = output.match(compactPattern);
  if (compactMatch) {
    return {
      inputTokens: parseInt(compactMatch[1].replace(/,/g, ''), 10),
      outputTokens: parseInt(compactMatch[2].replace(/,/g, ''), 10),
      runtime: 'claude-code',
    };
  }

  return null;
}

/**
 * Parse Gemini CLI terminal output for token usage data.
 *
 * Gemini CLI reports token usage in formats like:
 * - "Input tokens: 1234, Output tokens: 456"
 * - "Cost for this turn: $0.0012 (Input: 1234 tokens, Output: 456 tokens)"
 * - "Tokens used: 1234 input, 456 output"
 * - "prompt_tokens: 1234, completion_tokens: 456"
 *
 * @param output - Raw terminal output from Gemini CLI session
 * @returns Parsed token usage or null if no token data found
 */
export function parseGeminiCliTokens(output: string): ParsedTokenUsage | null {
  // Pattern 1: "Input tokens: X, Output tokens: Y" or "Input: X tokens, Output: Y tokens"
  const ioPattern = /input(?:\s+tokens)?[:\s]+(\d[\d,]*)\s*(?:tokens)?\s*[,;]\s*output(?:\s+tokens)?[:\s]+(\d[\d,]*)/i;
  const ioMatch = output.match(ioPattern);
  if (ioMatch) {
    const result: ParsedTokenUsage = {
      inputTokens: parseInt(ioMatch[1].replace(/,/g, ''), 10),
      outputTokens: parseInt(ioMatch[2].replace(/,/g, ''), 10),
      runtime: 'gemini-cli',
    };
    const costMatch = output.match(/cost[^$]*\$?([\d.]+)/i);
    if (costMatch) {
      result.cost = parseFloat(costMatch[1]);
    }
    return result;
  }

  // Pattern 2: "prompt_tokens: X, completion_tokens: Y" (API-style)
  const apiPattern = /prompt_tokens[:\s]+(\d[\d,]*)\s*[,;]\s*completion_tokens[:\s]+(\d[\d,]*)/i;
  const apiMatch = output.match(apiPattern);
  if (apiMatch) {
    return {
      inputTokens: parseInt(apiMatch[1].replace(/,/g, ''), 10),
      outputTokens: parseInt(apiMatch[2].replace(/,/g, ''), 10),
      runtime: 'gemini-cli',
    };
  }

  // Pattern 3: "Tokens used: X input, Y output"
  const usedPattern = /tokens?\s+used[:\s]+(\d[\d,]*)\s*input\s*[,;]\s*(\d[\d,]*)\s*output/i;
  const usedMatch = output.match(usedPattern);
  if (usedMatch) {
    return {
      inputTokens: parseInt(usedMatch[1].replace(/,/g, ''), 10),
      outputTokens: parseInt(usedMatch[2].replace(/,/g, ''), 10),
      runtime: 'gemini-cli',
    };
  }

  return null;
}

/**
 * Parse Codex CLI terminal output for token usage data.
 *
 * Codex CLI reports token usage in formats like:
 * - "Tokens: 1234 prompt + 456 completion = 1690 total"
 * - "prompt_tokens=1234 completion_tokens=456"
 * - "Usage: 1234 input, 456 output"
 *
 * @param output - Raw terminal output from Codex CLI session
 * @returns Parsed token usage or null if no token data found
 */
export function parseCodexCliTokens(output: string): ParsedTokenUsage | null {
  // Pattern 1: "Tokens: X prompt + Y completion" or "X prompt, Y completion"
  const promptCompPattern = /(\d[\d,]*)\s*prompt\s*[+,]\s*(\d[\d,]*)\s*completion/i;
  const promptCompMatch = output.match(promptCompPattern);
  if (promptCompMatch) {
    return {
      inputTokens: parseInt(promptCompMatch[1].replace(/,/g, ''), 10),
      outputTokens: parseInt(promptCompMatch[2].replace(/,/g, ''), 10),
      runtime: 'codex-cli',
    };
  }

  // Pattern 2: "prompt_tokens=X completion_tokens=Y"
  const eqPattern = /prompt_tokens\s*=\s*(\d[\d,]*)\s+completion_tokens\s*=\s*(\d[\d,]*)/i;
  const eqMatch = output.match(eqPattern);
  if (eqMatch) {
    return {
      inputTokens: parseInt(eqMatch[1].replace(/,/g, ''), 10),
      outputTokens: parseInt(eqMatch[2].replace(/,/g, ''), 10),
      runtime: 'codex-cli',
    };
  }

  // Pattern 3: "Usage: X input, Y output"
  const usagePattern = /usage[:\s]+(\d[\d,]*)\s*input\s*[,;]\s*(\d[\d,]*)\s*output/i;
  const usageMatch = output.match(usagePattern);
  if (usageMatch) {
    return {
      inputTokens: parseInt(usageMatch[1].replace(/,/g, ''), 10),
      outputTokens: parseInt(usageMatch[2].replace(/,/g, ''), 10),
      runtime: 'codex-cli',
    };
  }

  return null;
}

/**
 * Parse terminal output for token usage data from any supported runtime.
 *
 * Tries all runtime parsers in order and returns the first match.
 * The runtime type hint narrows the search for efficiency.
 *
 * @param output - Raw terminal output
 * @param runtimeType - Runtime type hint to try first
 * @returns Parsed token usage or null if no token data found
 */
export function parseRuntimeTokens(
  output: string,
  runtimeType?: 'claude-code' | 'gemini-cli' | 'codex-cli'
): ParsedTokenUsage | null {
  if (!output || output.trim().length === 0) return null;

  // Try the hinted runtime first for efficiency
  const parsers: Array<(output: string) => ParsedTokenUsage | null> = [];

  switch (runtimeType) {
    case 'claude-code':
      parsers.push(parseClaudeCodeTokens, parseGeminiCliTokens, parseCodexCliTokens);
      break;
    case 'gemini-cli':
      parsers.push(parseGeminiCliTokens, parseClaudeCodeTokens, parseCodexCliTokens);
      break;
    case 'codex-cli':
      parsers.push(parseCodexCliTokens, parseClaudeCodeTokens, parseGeminiCliTokens);
      break;
    default:
      parsers.push(parseClaudeCodeTokens, parseGeminiCliTokens, parseCodexCliTokens);
  }

  for (const parser of parsers) {
    const result = parser(output);
    if (result) return result;
  }

  return null;
}
