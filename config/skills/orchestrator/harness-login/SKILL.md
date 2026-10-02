---
name: Harness Login
description: "Log a coding harness (Claude Code, Codex) in, or switch its account, when the owner asks. Crewly keeps the login alive in its own terminal, DMs the owner the link in the thread they asked in, types the code they paste back into the login, and reports success itself. Never run claude setup-token / claude /login / codex login in bash."
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - relogin claude
  - login claude
  - login codex
  - switch claude account
  - claude login link
  - 重新登录
  - 登录 claude
  - 换个账号登录
  - 登录链接
tags:
  - harness
  - login
  - claude
  - codex
  - account
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Harness Login

The owner asks you to log Claude Code or Codex in again, or to use a different
account ("帮我重新登陆 claude code", "换个账号", "send me the login link").

```bash
bash config/skills/orchestrator/harness-login/execute.sh --harness claude
bash config/skills/orchestrator/harness-login/execute.sh --harness codex --switch-account
bash config/skills/orchestrator/harness-login/execute.sh --harness claude --account work
```

`--account <name>` signs in another of the owner's **own** Claude Code accounts
("login claude work"): it gets its own config dir and login, and agents move to
it when an earlier runtime in their fallback order runs out (chain entry
`claude-code@work`). Nothing is restarted. Add only Claude Code accounts that
the owner owns; never use it for another person's account.

## What happens

1. Crewly starts the harness's own login command in a terminal it keeps alive
   (`claude setup-token` for Claude, `codex login --device-auth` for Codex) —
   even when the harness is still logged in, because the owner asked.
2. The owner gets the link (and Codex's one-time code) in Slack, in the thread
   they asked in.
3. Claude: the owner pastes the code shown after authorizing straight back into
   that thread. Crewly types it into the login. Codex needs nothing pasted.
4. Crewly tells the owner in one line when it worked (and restarts the agents
   on that harness so they use the new login), or when it failed.

The skill returns at once:

```json
{"success":true,"status":"started","harnessId":"claude-code","displayName":"Claude Code","dmAvailable":true,"next":"…"}
```

**After that, say nothing more about this login.** Do not repeat the link, do
not say "I've sent it", do not write a status report. The flow speaks for
itself. If `dmAvailable` is false, follow `next` (Slack is down: tell the owner
in one line to finish it in Setup).

## Rules

- **Never** run `claude setup-token`, `claude /login`, `claude auth login`,
  `codex login` or an Antigravity (`agy`) login in bash. The process dies when
  the tool call returns, so every code the owner pastes is stale (2026-09-26).
  The bash tool refuses these commands.
- Only when the owner asked. The backend checks that an owner message from the
  last 30 minutes asks for this login; otherwise it answers
  `owner_request_not_found`. Do not start logins on your own.
- `antigravity` answers `no_link_login` (it uses a Gemini API key, entered in
  Setup); Gemini CLI is enterprise-only. Pass the message on in one line.
- The owner can also just write 「重新登录 claude」 / 「换个账号登录 codex」 /
  `relogin claude` / `login claude@work` in your DM — Crewly handles that without you.

## Errors

| reason | meaning |
|---|---|
| `orchestrator_only` | Only the orchestrator may call this |
| `owner_request_not_found` | No recent owner message asks for this login |
| `owner_request_unverifiable` | The owner's chat history could not be read |
| `unknown_harness` | Use claude, codex or antigravity |
| `no_link_login` | The harness has no link login (Antigravity, Gemini) |
| `invalid_account` | Account names are 1–32 lower-case letters, digits, `-` or `_` |
