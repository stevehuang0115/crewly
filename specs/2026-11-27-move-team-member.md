# Move an agent to another team

CREW-1309. Until now a team could only gain a new member or delete one, so
splitting a team meant new agents with no memory. A move keeps the agent.

Not `specs/2026-10-12-team-move.md`, which moves a whole team to another
machine.

## Interface

- `POST /api/teams/:fromTeamId/members/:memberId/move` `{ toTeamId, allowLead?, asLead? }`
  — the owner or the orchestrator; other callers are refused.
- Orchestrator skill `move-team-member --member <name|session> --to <team>
  [--from <team>] [--as-lead] [--allow-lead]`.
- Service: `services/team/team-member-move.service.ts`.

## The member entry

The target stores the same entry: id, name, role, session name, runtime, model
and reasoning settings. Exceptions, all fields that pointed into the old team:

- `agentId` is pinned from the source team **before** the write. A member
  stored without one would otherwise get an id derived from the target's name
  and lose its memory.
- `parentMemberId` / `subordinateIds` are dropped; on a hierarchical target the
  member is placed under its lead.
- In the prompt, only the generated sentence `You are N, a R on the T team.`
  is renamed. Custom prompt text is kept as written.

Agent and memory directories are keyed by session name and are not touched.

## What follows the member

| Record | Rule |
|--------|------|
| Work items | Open ones aimed at the member whose `metadata.teamId` is the old team |
| Triggers (followups, watchers) | Old-team triggers aimed at the member, waking one of its moved work items, or created by it with no other target |
| Cron tasks | The member's tasks move to the new team's store (same ids); orchestrator tasks naming the old team for it are renamed |
| Owner decisions | Open ones the member asked, except cards about the team itself (model tier changes) |
| Session restore state | `teamId` |
| Prompt file | Written under the new team, removed from the old one |

Stays with the old team: its team-spec triggers (a warning names any aimed at
the member), finished work, activity and delegation history, `metadata.origin`
(where a request came from), the team's wiki, norms and SOPs. Requests have no
team field. Team channel rosters follow the `team-saved` event.

## Refusals

Checked before any write: unknown source, target or member; same team; target
already lists the member; archived target; the orchestrator team or agent; a
temporary member (its headcount and expiry belong to the old team); the source
lead, unless the target already names it lead, `allowLead` is set, or
`asLead` leaves the source another lead; a member
that is **busy or starting**. A running idle member can be moved: the result
says `restartRequired`, because its session still holds the old context. The
move never stops or starts a session. A session whose activity cannot be read
counts as busy.

## Leading the target (`asLead`)

After the move the member is made THE lead of the target through
`applyTeamLead`, the code behind `set-team-lead`: former target leads are
replaced (named in `warnings`) and on a hierarchical team report to the new
lead. The role is not changed. A source lead then moves without `allowLead`
while the source **currently has another lead**; the sole lead still needs it.
If the lead change fails the member stays moved, `leadOfTarget` is false and a
warning says to run `set-team-lead`.

## Empty teams

`POST /api/teams` accepts `members: []` (the array and the name stay
required), so a target can be created before anyone is moved into it. A
hierarchical team still needs a lead at creation. An empty team has no lead;
starting it starts nothing; its Slack channel, when one is auto-created,
gets its members from the first move whose roster sync sees them.

## Consistency

- Moves run one at a time.
- The target config is written first, then the source. If the source write
  fails, the target write is undone. If the undo fails too, the error names the
  team that must be cleaned up. The member is never lost.
- Both configs are read again afterwards: a status write that read the old team
  before the move could save the old member list over it. This narrows the
  window; team writes have no cross-team lock.
- Record updates run after the move. One that fails is reported in `warnings`
  and does not undo the move.

## Next start

The start reads the team from storage, so the member gets the new team's lead,
teammates and charter. If the new team works in another project, the session
starts in that folder, and the runtime may not resume the previous
conversation. Memory is unaffected; the result warns.
