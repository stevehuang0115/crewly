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
