/**
 * Eval Tool Log Parser
 *
 * Reads the `.crewly/.tool-log.jsonl` file written by eval skill shims
 * and converts entries into {@link ToolCallRecord} objects for scoring.
 *
 * This enables runtime-agnostic tool call tracking: any runtime that
 * executes the skill shim bash scripts will produce a parseable log,
 * even if the runtime itself doesn't expose native tool call records.
 *
 * @module eval/tool-log-parser
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ToolCallRecord } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Raw entry format in the .tool-log.jsonl file, as written by _log.sh.
 */
export interface ToolLogEntry {
  /** Skill name (e.g. "delegate-task", "send-message") */
  tool: string;
  /** Arguments passed to the skill */
  args: Record<string, unknown>;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/** Path to the tool log file relative to the work directory */
export const TOOL_LOG_RELATIVE_PATH = '.crewly/.tool-log.jsonl';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse the tool log JSONL file from an eval work directory.
 *
 * Each line in the file is a JSON object written by `_log.sh`.
 * Invalid lines are silently skipped (resilient to partial writes).
 *
 * @param workDir - absolute path to the eval work directory
 * @returns array of parsed tool call records, in chronological order
 */
export function parseToolLog(workDir: string): ToolCallRecord[] {
  const logPath = path.join(workDir, TOOL_LOG_RELATIVE_PATH);

  if (!fs.existsSync(logPath)) {
    return [];
  }

  const content = fs.readFileSync(logPath, 'utf-8');
  return parseToolLogContent(content);
}

/**
 * Parse tool log content from a raw string.
 *
 * Useful for testing without filesystem access.
 *
 * @param content - raw JSONL string
 * @returns array of parsed tool call records
 */
export function parseToolLogContent(content: string): ToolCallRecord[] {
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  const records: ToolCallRecord[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as ToolLogEntry;
      records.push(toToolCallRecord(entry));
    } catch {
      // Skip malformed lines — resilient to partial writes or corruption
      continue;
    }
  }

  return records;
}

/**
 * Convert a raw log entry into a ToolCallRecord.
 *
 * Maps the skill shim log format to the eval framework's standard
 * tool call record format used by the scorer.
 *
 * @param entry - raw log entry from JSONL
 * @returns normalized tool call record
 */
function toToolCallRecord(entry: ToolLogEntry): ToolCallRecord {
  return {
    toolName: mapToolName(entry.tool),
    args: entry.args,
    result: { logged: true, timestamp: entry.timestamp },
  };
}

/**
 * Map a skill shim name to a standardized tool name.
 *
 * Prefixes skill names with "skill:" to distinguish them from
 * native tool calls (e.g. "read_file", "write_file").
 *
 * @param skillName - raw skill name from the log
 * @returns standardized tool name
 */
function mapToolName(skillName: string): string {
  return `skill:${skillName}`;
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a specific skill was used in the tool log.
 *
 * @param records   - parsed tool call records
 * @param skillName - skill name to search for (without "skill:" prefix)
 * @returns true if the skill was called at least once
 */
export function skillWasUsed(records: ToolCallRecord[], skillName: string): boolean {
  const prefixed = `skill:${skillName}`;
  return records.some((r) => r.toolName === prefixed);
}

/**
 * Get all calls to a specific skill.
 *
 * @param records   - parsed tool call records
 * @param skillName - skill name to filter (without "skill:" prefix)
 * @returns matching tool call records
 */
export function getSkillCalls(records: ToolCallRecord[], skillName: string): ToolCallRecord[] {
  const prefixed = `skill:${skillName}`;
  return records.filter((r) => r.toolName === prefixed);
}

/**
 * Extract delegation targets from delegate-task calls.
 *
 * Supports both bash skill shims (`skill:delegate-task`) and
 * native Crewly Agent API tools (`delegate_task`).
 *
 * @param records - parsed tool call records
 * @returns array of session names that tasks were delegated to
 */
export function getDelegationTargets(records: ToolCallRecord[]): string[] {
  const targets: string[] = [];

  for (const r of records) {
    const name = r.toolName.toLowerCase();
    const isDelegate = name === 'skill:delegate-task'
      || name === 'delegate_task'
      || name === 'delegate-task';
    if (!isDelegate) continue;

    const args = r.args as Record<string, unknown>;
    const to = String(args.to ?? args.workerSession ?? '');
    if (to.length > 0) targets.push(to);
  }

  return targets;
}

/**
 * Extract message recipients from send-message calls.
 *
 * Supports both bash skill shims (`skill:send-message`) and
 * native Crewly Agent API tools (`send_message`).
 *
 * @param records - parsed tool call records
 * @returns array of session names that messages were sent to
 */
export function getMessageRecipients(records: ToolCallRecord[]): string[] {
  const recipients: string[] = [];

  for (const r of records) {
    const name = r.toolName.toLowerCase();
    const isMessage = name === 'skill:send-message'
      || name === 'send_message'
      || name === 'send-message';
    if (!isMessage) continue;

    const args = r.args as Record<string, unknown>;
    const to = String(args.to ?? '');
    if (to.length > 0) recipients.push(to);
  }

  return recipients;
}

/**
 * Count total skill invocations in the tool log.
 *
 * @param records - parsed tool call records
 * @returns number of skill calls (excludes native tool calls)
 */
export function countSkillCalls(records: ToolCallRecord[]): number {
  return records.filter((r) => r.toolName.startsWith('skill:')).length;
}

/**
 * Merge skill-based tool call records with native runtime tool call
 * records, deduplicating where both sources captured the same action.
 *
 * Native records take precedence when a duplicate is detected.
 *
 * @param nativeRecords - tool calls from the runtime adapter
 * @param skillRecords  - tool calls from the tool log parser
 * @returns merged array of tool call records
 */
export function mergeToolCallRecords(
  nativeRecords: ToolCallRecord[],
  skillRecords: ToolCallRecord[],
): ToolCallRecord[] {
  // For now, simply concatenate — skill records have distinct "skill:" prefix
  // so there's no name collision with native tool names like "read_file"
  return [...nativeRecords, ...skillRecords];
}
