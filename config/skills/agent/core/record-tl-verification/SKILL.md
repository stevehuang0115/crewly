---
name: Record TL Verification
description: A team leader's marker that a code PR in a CI-less private repo was verified at its exact head; the merge guard needs it next to a green local gate record.
version: 1.0.0
category: development
skillType: claude-skill
assignableRoles:
  - team-leader
triggers:
  - record tl verification
  - verify code pr without ci
  - tl marker for merge
tags:
  - merge
  - guard
  - review
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Record TL Verification

For a repo with `"codePrs": true` in `config/hooks/destructive-git-guard/local-gates.json` (today: crewly-web), a PR with non-content files merges without CI only when (1) `record-local-gate` recorded a passing run at the PR head and (2) a team leader verified that same head. This skill is (2).

```bash
bash config/skills/agent/core/record-tl-verification/execute.sh --repo stevehuang0115/crewly-web --pr 266 --summary "read the diff, gate green at head, behaviour checked"
```

It refuses unless: the repo is enabled for code PRs; your session has role `team-leader` in a team config; a passing gate record exists at the PR's current head; and you are not the session that ran that gate (GitHub cannot tell agents apart, so the gate runner stands in for the author). It writes `pr-<N>-<sha>.tl.json` with the SHA, your session, the gate runner and your one-line summary; the guard prints both sessions when it accepts.

A new commit changes the head: gate and marker must both be redone. Verify by reading the diff and the gate result, not by trusting the author's report.

## Limits

The marker is a file, so like the guard it is a speed bump, not a boundary: the role check reads team configs and `CREWLY_SESSION_NAME`, which a determined session could fake.
