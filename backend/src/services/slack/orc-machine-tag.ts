/**
 * Which machine's orchestrator wrote a post.
 *
 * Every machine's orchestrator posts through the same workspace bot and
 * opens with the same `[Orc]` tag, so on an account with several machines
 * the owner could not tell which one was speaking (two `[Orc]` replies in
 * one thread, 2026-11-26). With more than one machine on the account the
 * tag carries the machine: `[Orc · mac-mini]`.
 *
 * Pure functions only.
 *
 * @module services/slack/orc-machine-tag
 */

/** The tag an orchestrator post opens with (reply-slack adds it; agents also write it). */
const ORC_TAG = /^\[orc\](?=\s|$)/i;

/** An orchestrator tag, with or without a machine. */
const ANY_ORC_TAG = /^\[orc(?:\s·\s[^\]\n]{1,64})?\](?=\s|$)/i;

/**
 * A machine's name as shown to the owner: the device name without a local
 * network suffix (`mac-mini.lan` → `mac-mini`), on one line, without `]`.
 *
 * @param deviceName - The machine's device name
 * @returns Short name ('' when there is none)
 */
export function shortMachineName(deviceName: string | null | undefined): string {
  return String(deviceName ?? '')
    .replace(/[\]\r\n]/g, ' ')
    .trim()
    .replace(/\.(lan|local|localdomain|home)$/i, '')
    .slice(0, 40)
    .trim();
}

/**
 * Put the machine into the orchestrator tag a post opens with.
 *
 * @param text - Post text
 * @param deviceName - This machine's device name
 * @param machineCount - Machines on the account (this one included)
 * @returns The text, with `[Orc]` → `[Orc · <machine>]` when the account has several machines
 *
 * @example
 * ```typescript
 * tagOrcWithMachine('[Orc] 收到。', 'mac-mini.lan', 3); // '[Orc · mac-mini] 收到。'
 * tagOrcWithMachine('[Orc] ok', 'mac-mini.lan', 1);     // '[Orc] ok'
 * ```
 */
export function tagOrcWithMachine(text: string, deviceName: string | null | undefined, machineCount: number): string {
  if (typeof text !== 'string' || machineCount < 2 || !ORC_TAG.test(text)) return text;
  const machine = shortMachineName(deviceName);
  if (!machine) return text;
  return text.replace(ORC_TAG, (tag) => `${tag.slice(0, -1)} · ${machine}]`);
}

/**
 * Whether a post opens with an orchestrator tag (`[Orc]` or `[Orc · machine]`).
 *
 * @param text - Post text
 * @returns True for an orchestrator post
 */
export function startsWithOrcTag(text: string): boolean {
  return ANY_ORC_TAG.test(String(text ?? '').trimStart());
}

/** What the tag needs to know about this machine and its account. */
export interface OrcMachineInfo {
  /** This machine's device name */
  deviceName: string | null;
  /** Machines on the account, this one included */
  machineCount: number;
}

let machineSource: (() => OrcMachineInfo | null) | null = null;

/**
 * Tell the tag where this machine's name and the account's machine count
 * come from (the Slack instance registry). Null clears it.
 *
 * @param source - Reads the current values; must not throw
 */
export function setOrcMachineSource(source: (() => OrcMachineInfo | null) | null): void {
  machineSource = source;
}

/**
 * {@link tagOrcWithMachine} with this machine's own values. Never throws;
 * without a source (or on any failure) the text is returned as it is.
 *
 * @param text - Post text
 * @returns The text, tagged when the account has several machines
 */
export function applyOrcMachineTag(text: string): string {
  try {
    const info = machineSource?.();
    return info ? tagOrcWithMachine(text, info.deviceName, info.machineCount) : text;
  } catch {
    return text;
  }
}
