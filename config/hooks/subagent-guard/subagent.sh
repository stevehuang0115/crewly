#!/usr/bin/env bash
# Crewly subagent guard (#852) — Claude Code SubagentStart / SubagentStop hook.
#
# Spec: specs/2026-10-03-subagent-guard.md
#
# Claude Code's tool hooks (PreToolUse/PostToolUse) do not say whether a call
# comes from a subagent, so Crewly cannot deny a subagent's side effects per
# call. What it can do, with the two subagent events:
#
#   SubagentStart — inject Crewly's subagent rules as additionalContext: do
#     the work yourself, report back only to the parent, never close or claim
#     WorkItems or message other agents/humans.
#   SubagentStop  — refuse, once, a "completion" from a subagent that made no
#     tool call at all (the silent no-op of #852: a fork that idled, or that
#     "delegated" its own task and exited). It is sent back with a reason;
#     a second stop is always allowed, so this can never loop.
#
# Usage: bash subagent.sh            # hook JSON on stdin
#
# Fails open: any parse error, missing transcript or missing node means
# "allow" (exit 0, no output). It reads the subagent's own transcript only to
# count tool_use blocks; nothing from stdin or the transcript is sent anywhere.

set -u

# Kill switch, independent of the control-plane guard's.
[ "${CREWLY_SUBAGENT_GUARD:-}" = "0" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0

INPUT="$(cat)"
MARKER_DIR="${CREWLY_HOME:-$HOME/.crewly}/runtime/subagent-guard"

# The program is passed through a quoted heredoc so its text needs no shell
# escaping; the hook payload arrives on node's stdin.
PROGRAM="$(cat <<'JS'
const fs = require("fs");
const path = require("path");

const START_CONTEXT = [
	"Crewly subagent rules (enforced by your parent agent's harness):",
	"- You are a subagent. Do the assigned work yourself, with your tools. Do not hand it to another agent unless your instructions say to.",
	"- Report your result only in your final message to the parent agent. Do not run report-status, complete-task, send-message, reply or any skill that closes, claims or verifies a WorkItem or messages another agent or a person. Your parent does that after checking your work.",
	"- Stay inside the files, directories and branches your instructions name.",
	"- End with evidence: the files or commits you changed, the commands you ran with their exit codes, or the exact step that blocked you and why.",
].join("\n");

const NO_OP_REASON =
	"You are stopping without having made a single tool call, so none of the assigned work has been done. " +
	"Do the task now with your tools (do not delegate it to another agent), or, if you cannot, reply with the exact reason you are blocked.";

/** Identifier check for values used in file names. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Count tool_use blocks in a Claude Code transcript (JSONL). */
function countToolUses(file) {
	let n = 0;
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.includes("tool_use")) continue;
		let entry;
		try { entry = JSON.parse(line); } catch { continue; }
		const content = entry && entry.message && entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) if (block && block.type === "tool_use") n++;
	}
	return n;
}

let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
	let input;
	try { input = JSON.parse(raw); } catch { return; }
	if (!input || typeof input !== "object") return;
	const event = input.hook_event_name;

	if (event === "SubagentStart") {
		process.stdout.write(JSON.stringify({
			hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: START_CONTEXT },
		}));
		return;
	}
	if (event !== "SubagentStop") return;
	if (input.stop_hook_active === true) return;

	const agentId = input.agent_id;
	const parentTranscript = input.transcript_path;
	if (typeof agentId !== "string" || !SAFE_ID.test(agentId)) return;
	if (typeof parentTranscript !== "string" || !parentTranscript.endsWith(".jsonl")) return;

	// <project>/<session>.jsonl  ->  <project>/<session>/subagents/agent-<id>.jsonl
	const sessionDir = parentTranscript.slice(0, -".jsonl".length);
	const transcript = path.join(sessionDir, "subagents", `agent-${agentId}.jsonl`);

	let toolUses;
	try { toolUses = countToolUses(transcript); } catch { return; }
	if (toolUses > 0) return;

	// Refuse once per subagent; the next stop goes through.
	const marker = path.join(process.env.MARKER_DIR, `${agentId}.nudged`);
	try {
		fs.mkdirSync(process.env.MARKER_DIR, { recursive: true });
		fs.writeFileSync(marker, "", { flag: "wx" });
	} catch {
		return;
	}
	process.stdout.write(JSON.stringify({ decision: "block", reason: NO_OP_REASON }));
});
JS
)"

printf '%s' "$INPUT" | MARKER_DIR="$MARKER_DIR" node -e "$PROGRAM" 2>/dev/null

exit 0
