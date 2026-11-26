---
name: Request Permanent Seat (TL)
description: "Ask the owner for a permanent member on your team. One owner card (Approve / Not now) with your reason and the evidence Crewly adds: temporary members of that role opened in the last 14 days, how often you kept work because no member fit, and the roster size. Nothing changes until the owner approves."
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - team-leader
triggers:
  - request seat
  - permanent member
  - headcount used up
  - the team needs another member
tags:
  - agent
  - management
  - team
  - capacity
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Request Permanent Seat (TL Version)

Use this when the temporary headcount is used up, or the same need keeps coming back (the third temporary member of one role in 14 days is the signal; `add-temp-member` tells you). A permanent seat is the owner's decision.

## Usage

```bash
bash {{TL_SKILLS_PATH}}/request-seat/execute.sh --role developer --reason "client work needs a second developer every week; three temporary ones this month"
bash {{TL_SKILLS_PATH}}/request-seat/execute.sh --role designer --reason "..." --name "Kai"
```

## Parameters

| Flag | JSON field | Required | Description |
|------|-----------|----------|-------------|
| `--role` | `role` | Yes | A known working role. Lead roles are refused |
| `--reason` / `-r` | `reason` | Yes | What work keeps needing this seat. The owner reads this line: plain words, no ids |
| `--name` / `-n` | `name` | No | Name for the permanent member |
| `--team` / `-g` | `teamId` | No | Your team id. Default: your own team |

## What the owner sees

One card, in the team's channel: "<You> asks for a permanent <role> on <team>", your reason, and three lines Crewly computes itself (do not repeat them in the reason): temporary members of that role opened in the last 14 days, how many times you recorded "no member fits" in the last 14 days, and how many members the team has now. Buttons: **Approve** / **Not now**. Without an answer in 7 days it counts as "Not now".

## What happens next

- **Approve**: when a temporary member of that role is on the team, it becomes permanent (same session, work and memory). Otherwise a new member is added; it starts when you assign it work. You get a `[SEAT REQUEST]` note with its session name.
- **Not now** (or no answer): nothing changes. The same role cannot be requested again for 14 days (`seat_recently_declined`); keep using temporary members within the headcount.
- One open request per role (`seat_request_open`). Do not message the owner about it as well; the card is the request.

## Output

`{"success":true,"data":{"requested":true,"decisionId":"D-12","note":"One card went to the owner (D-12). Nothing changes until the owner approves; you will be told the answer. ..."}}`

## Related Skills

- `add-temp-member` — hands for now, within the temporary headcount
- `delegate-task --no-member-fits` — record work you kept because no member could take it (counted on the card)
