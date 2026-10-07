# Scheduled commands

The backend can run host commands on an interval. It exists for jobs that
launchd cannot do on macOS because launchd jobs cannot read `~/Desktop`
(TCC) and the backend can. The first user is the crewly-web release script.

## Safety model

- The list is read from `~/.crewly/scheduled-commands.json` and nowhere else.
  There is no API route or trigger action that adds an entry, on purpose:
  that would be arbitrary shell execution through the API.
- No file means no jobs. The feature is off unless you create the file.
- Commands run without a shell (`command` + `args`).
- Each run is **detached** (own process group, `unref`'d, output appended to
  `~/.crewly/logs/scheduled-<name>.log`). A Crewly restart does not kill a run
  in progress, so a rollout is never cut in half.
- A run never starts while the previous one is alive. That is checked by the
  pid the runner spawned and, if `lockFile` is set, by the pid inside that
  lock file (a stale pid counts as dead). Skips are logged at debug level.

## File format

```json
[
  {
    "name": "crewly-web-release",
    "cwd": "~/Desktop/projects/crewly-projects/web",
    "command": "bash",
    "args": ["scripts/release.sh", "--if-changed", "--live"],
    "intervalMinutes": 5,
    "lockFile": "~/.crewly/tmp/crewly-web-release.lock",
    "enabled": true
  }
]
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | letters, digits, `.`, `-`, `_`; unique; names the log file |
| `cwd` | yes | absolute path (`~` allowed); run is skipped with a warning if it is missing |
| `command` | yes | executable, no shell |
| `args` | no | array of strings |
| `intervalMinutes` | yes | number, minimum 1 |
| `lockFile` | no | the command's own lock file (holds a pid) |
| `enabled` | no | `false` skips the entry |

The first run happens 30 seconds after boot, then every `intervalMinutes`.
The file is read at boot: restart the backend after editing it.

## What the child gets

Each run is started with your environment plus two variables:

| Variable | Value |
|---|---|
| `CREWLY_SCHEDULER_NAME` | the entry's `name` |
| `CREWLY_SCHEDULER_CREDENTIAL` | an in-memory credential for this backend process |

The credential lets the command **deliver a note to an agent** and nothing
else. The skills' shared `api_call` (so `core/send-message`) sends it
automatically when `CREWLY_SESSION_NAME` is not set, so a script can run:

```bash
bash ~/Desktop/projects/crewly-projects/crewly/config/skills/agent/core/send-message/execute.sh \
  --to <agent-session> --message "crewly-web release: RELEASED 1.0.149"
```

- The note arrives as `[scheduler:<name>] crewly-web release: …`. The sender is
  never the owner and never an agent, so the agent cannot mistake it for either.
- It is accepted only on `POST /api/terminal/<session>/write` with
  `mode: "message"` and no `workItemId`. Typing keystrokes, a key press, a kill,
  a WorkItem hand-over and every owner-only route (tokens, approvals, deletes,
  settings …) still answer 401 (403 `scheduler_message_only` on the write route
  for anything but a plain message).
- A recipient in the middle of a turn gets the note queued, like a message from
  another agent. A paused team still refuses it.
- The credential is made in memory when the run starts. It is not written to
  `scheduled-commands.json`, to the run's log, or to any other file, and the
  backend logs only the pid. Restarting the backend invalidates it: a run that
  started before the restart gets 401 until its next run.
- `CREWLY_SESSION_NAME` wins: a command that sets it is treated as that agent
  (with its badge, if it has one), never as a scheduler.

## Reading the log

At boot the backend logs `N scheduled command(s) loaded` (N can be 0), plus one
warning per invalid entry. Each real run logs `<name> started` with its pid.

## Turn it off

- Per entry: set `"enabled": false` and restart, or delete the file.
- For the crewly-web release only: create the script's kill switch file,
  `~/.crewly/crewly-web-autodeploy.disabled`. The runner keeps spawning
  `release.sh`, which logs the kill switch and exits at once. A failed release
  also writes `~/.crewly/crewly-web-autodeploy.failed`, which pauses
  `--if-changed` runs until you remove it.
