# crewly-agent

Standalone Crewly Agent executable for the OSS `crewly-agent` runtime.

It speaks a newline-delimited JSON protocol over `stdin` / `stdout`:

- `init`
- `run`
- `abort`
- `get-state`
- `shutdown`

The OSS backend manages the process through
`CrewlyAgentExternalRuntimeService` and surfaces logs through the existing
non-PTY monitoring path.

Current default OSS runtime command:

```sh
crewly-agent
```

Intended release model:

- `crewly` OSS owns orchestration, sessions, storage, and UI
- `crewly-agent` owns the agent runtime executable
- `crewly-pro` can distribute or enable `crewly-agent` without OSS importing Pro code
