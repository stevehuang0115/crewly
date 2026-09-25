# On-demand skill install (find-skill / install-skill / skill setup)

Status: implemented on `feat/skill-autoinstall` (after 1.20.130).

## Why

The owner sent a Slack voice message (an `.m4a` Audio Clip). One agent
transcribed it with `transcribe-audio`. Another, on a machine without
whisper.cpp, answered "can't transcribe, whisper.cpp isn't installed" and
stopped. The skill existed; nothing told the agent it could install what the
skill needs, and nothing could do the installing.

Wanted behaviour: when an agent lacks a capability it finds the right skill,
tells the user in one line ("I can't read this yet — installing the
transcription skill, a few minutes"), installs the skill **and its
dependencies** in the background, and when that finishes carries on by itself
and delivers the result.

## Pieces

| Piece | Where |
|---|---|
| `setup` block in `skill.json` (format + validator) | `backend/src/services/skill-setup/skill-setup-manifest.ts` |
| Idempotent setup runner (log, lock, no-sudo rule, verified downloads) | `backend/src/services/skill-setup/skill-setup-runner.service.ts` |
| Discovery: bundled + installed + registry, ranking, "official" | `backend/src/services/skill-setup/skill-discovery.service.ts` |
| Background install jobs, trust rule, completion message | `backend/src/services/skill-setup/skill-install-job.service.ts` |
| REST `/api/skill-setup` | `backend/src/controllers/skill-setup/` |
| Agent skills | `config/skills/agent/core/find-skill`, `config/skills/agent/core/install-skill` |
| CLI | `crewly skills setup <id> [--check]`; `crewly install <id>` runs setup too |
| Prompt rule | `SkillsReferenceModule.buildMissingCapability` |
| Inbound file hints | `backend/src/utils/inbound-file-hint.utils.ts`, used by the Slack bridge |
| Official skills with setup | `config/skills/agent/transcribe-audio`, `config/skills/agent/pdf-tools` |

## The `setup` manifest

Optional top-level `setup` in `skill.json`. Validated by
`validateSetupManifest` (backend, `crewly publish`, registry guard test).

```jsonc
"setup": {
  "estimatedMinutes": 6,            // quoted to the user; optional (default 3)
  "steps": [                        // performed in order; ids unique, kebab-case
    {
      "id": "ffmpeg",
      "type": "command",
      "description": "ffmpeg — decodes audio/video into 16 kHz mono WAV",
      "check": { "commands": ["ffmpeg"] },          // any of: commands (PATH lookup), paths, shell
      "install": {                                   // per OS family: darwin | debian | linux
        "darwin": { "brew": ["ffmpeg"] },            // brew / brewCask / apt / script
        "debian": { "apt": ["ffmpeg"] }
      },
      "manualHint": "Install ffmpeg with your package manager."   // shown when no recipe applies
    },
    {
      "id": "whisper-cli",
      "type": "command",
      "check": { "commands": ["whisper-cli"], "paths": ["~/.flopost/whisper/whisper-cli", "$CREWLY_HOME/bin/whisper-cli"] },
      "install": { "darwin": { "brew": ["whisper-cpp"] }, "linux": { "script": "install-whisper-cpp.sh" } }
    },
    {
      "id": "whisper-model",
      "type": "file",
      "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
      "sha256": "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
      "sizeBytes": 574041195,
      "dest": "~/.cache/whisper-models/ggml-large-v3-turbo-q5_0.bin",
      "alternatives": ["~/.flopost/whisper/ggml-large-v3-turbo-q5_0.bin"]
    },
    {
      "id": "python-packages",
      "type": "python",
      "venv": "pdf-tools",                           // $CREWLY_HOME/venv/<venv>; default = skill id
      "packages": ["pypdf>=4", "markdown>=3.5"],     // pip specifiers
      "imports": ["pypdf", "markdown"]               // import probe = the check
    }
  ]
}
```

Rules enforced by the validator:

- package names (`brew`, `apt`), command names, pip specifiers and module names
  are matched against strict patterns — no shell can hide in them;
- `script` is a bare `*.sh` file name inside the skill directory (the publish
  validator also checks it ships with the skill);
- `url` is https, `sha256` is 64 lower-case hex, `sizeBytes` a positive integer;
- `dest` / `alternatives` start with `~/` or `$CREWLY_HOME/` and contain no `..`;
- `optional: true` makes a failing step "skipped" instead of failing the setup.

`check.shell` and `install.<os>.script` are code shipped by the skill, no more
trusted than its `execute.sh`; they go through the same trust rule.

The model sha256 above is Hugging Face's LFS oid for that file
(`/api/models/ggerganov/whisper.cpp/tree/main`, also `X-Linked-Etag`), and
matches a local copy byte for byte.

## Runner

`SkillSetupRunner.runSetup({ skillId, skillDir, manifest, checkOnly?, onProgress? })`

- **Idempotent.** Each step is checked first → `satisfied` ("already
  satisfied (/opt/homebrew/bin/ffmpeg)"). Missing steps are installed and
  re-checked; `installed` is reported only when the re-check passes.
  `checkOnly` never installs, locks or logs (used by `find-skill` probes and
  `crewly skills setup --check`).
- **Files:** a copy with the right size at `dest` or an alternative satisfies
  the step (size, not sha — hashing 547 MB on every probe is too slow; the sha
  is checked when Crewly downloads). Downloads stream to `<dest>.part-<pid>`,
  hash on the way, abort after 2 min without data, and are renamed into place
  only when size and sha256 match; a mismatch deletes the temp file. Free space
  is checked first.
- **No password prompts, ever.** Children get a closed stdin. `apt-get` runs as
  root, or through `sudo -n` when sudo needs no password; otherwise the step
  fails immediately with the command the owner can run (`sudo apt-get install -y
  ffmpeg`). Homebrew is never run as root; a missing Homebrew is reported with
  its install hint. Install scripts get `CREWLY_SUDO` = `''` (root) / `sudo -n` /
  `unavailable`, plus `CREWLY_HOME`, `CREWLY_BIN_DIR`, `SKILL_DIR`.
- **PATH** for checks and installs: `$CREWLY_HOME/bin`, the process PATH, then
  Homebrew and system dirs (a backend started by launchd lacks /opt/homebrew/bin).
- **Concurrency.** Concurrent calls in one process share the same run. Across
  processes a lock file `$CREWLY_HOME/skill-setup/locks/<id>.lock` (pid +
  start time, created with `O_EXCL`) makes the second caller wait (up to 1 h);
  a lock whose pid is dead or older than 2 h is reclaimed.
- **Log:** `$CREWLY_HOME/logs/skill-setup/<id>.log` — every step, every command
  and its full output.
- **OS families:** `darwin`; `debian` (Linux with `/etc/debian_version`) uses a
  `debian` recipe, else falls back to `linux`; other Linux uses `linux`.

### whisper.cpp on Linux

`install-whisper-cpp.sh` (shipped with transcribe-audio):

1. The official release has prebuilt Ubuntu binaries
   (`whisper-bin-ubuntu-{x64,arm64}.tar.gz`). The pinned `v1.9.2` tarball is
   downloaded, checked against its GitHub asset sha256, extracted to
   `$CREWLY_HOME/opt/whisper.cpp-v1.9.2/`, and `$CREWLY_HOME/bin/whisper-cli` is
   a wrapper that sets `LD_LIBRARY_PATH` to the bundled `.so` files. A
   `whisper-cli --help` smoke test decides whether it runs (glibc).
2. Otherwise (other CPU, checksum mismatch, binary does not run) the same tag
   is built from source with cmake (static, `whisper-cli` target) and copied to
   `$CREWLY_HOME/bin`. Missing cmake / compiler are installed with apt when root
   or passwordless sudo is available; otherwise it fails naming them.

## Discovery and "official"

`GET /api/skill-setup/find?query=` merges:

1. **bundled** skills (`<package>/config/skills/agent/**`, one level of category
   dirs, not `_common/` or `marketplace/` which npm does not ship) — so
   `find-skill` works for them with no registry entry and no network;
2. **installed** marketplace skills (`~/.crewly/marketplace/skills/<id>`);
3. **registry** entries (existing `marketplace.service.fetchRegistry`: public
   GitHub registry + crewlyai.com, cached). A registry entry that describes a
   bundled skill (same id, `agent-`/`skill-` prefix, or archive path ending in
   the dir name) merges into the bundled candidate.

Ranking (`scoreSkill`): each query token (plus synonyms from
`SKILL_SETUP_CONSTANTS.QUERY_SYNONYMS` — voice/m4a/语音 → audio/transcribe, …)
takes its best match: exact id/name 10, exact tag 6, id/name contains 5,
trigger 3, tag overlap 3, description 1.5; whole query in a trigger or the
description +4; official +0.5, installed +0.25. The top 3 get a check-only
setup probe (`ready`, `setup.missing`).

**Official** = may be installed by an agent without asking:

- **bundled with Crewly**, or
- listed in an **official registry** — the public GitHub registry
  (`config/skills/registry.json` in this repo) or crewlyai.com — with
  `author` in `Crewly Team` / `crewly` / `Crewly`, or `metadata.verified: true`.

Entries from the machine-local registry (`local-registry.json`) are never
official, whatever author they claim. `fetchRegistry` now tags every item with
`registrySource` (`public` / `premium` / `local`) for this. An installed
marketplace skill is official only while the registry still lists it as such.

## install-skill: background job + completion message

`POST /api/skill-setup/install { id, resume?, approvedByOwner?, force? }`
(requester = `X-Agent-Session`):

1. resolve the skill; unknown → 404 `not_found`;
2. a job already running for it → return that job, add the requester;
3. installed and setup satisfied → `200 { state: "already-ready" }` (no job);
4. **trust rule** (below); invalid setup block → 422;
5. `202 { jobId, estimatedMinutes, next }` at once; the job then downloads the
   skill when it is not on the machine (existing `installItem`; when a premium
   archive fails, the public registry copy is tried — `fetchRegistry` keeps it
   as `fallback`, as the CLI does), runs the setup, and
6. sends each requester a `system_event` through the message queue
   (`getMessageQueueInstance().enqueue({ source: 'system_event', targetSession })`
   — the path event-bus notifications use), which wakes the agent:

```
[SKILL INSTALLED] transcribe-audio is installed and ready (job 3f9c1a2b, 4m 10s).
Setup: jq already there · ffmpeg installed · whisper-cli installed · whisper-model installed
Run it: bash /…/transcribe-audio/execute.sh (see SKILL.md next to it)
You paused: "transcribe the voice message Steve sent in #general"
Next: tell the user in one line that it is ready, then do the task you paused — now, without waiting to be asked.
```

```
[SKILL INSTALL FAILED] transcribe-audio (job 3f9c1a2b, 2s): ffmpeg: installing ffmpeg needs root (apt-get) … Ask the owner to run: sudo apt-get install -y ffmpeg — then run the setup again.
Log: ~/.crewly/logs/skill-setup/transcribe-audio.log
Next: tell the user plainly what is missing and the fix quoted above …
```

Jobs live in memory (24 h retention); `GET /api/skill-setup/jobs/:jobId`
shows progress. A backend restart mid-job loses the completion message (the
setup log and lock survive; re-running is cheap because it is idempotent).

### Trust rule

- **Official** skills install without asking, including the system
  dependencies their setup declares.
- **Third-party** → `403 owner_approval_required`: the agent must ask the owner
  in chat. After the owner says yes, `install-skill --id X --approved-by-owner
  --owner-said "<their words>"`. `approvedByOwner` is **verified** like the
  commitment-approval gate: there must be an owner-authored chat-v2 `user` row
  in the last 2 h that approves it (`containsApprovalToken`, or a short yes —
  好/可以/装/ok/yes/install — that names the skill; a question never counts).
  None → `403 owner_approval_not_found`; chat unreadable → `403
  owner_approval_unverifiable` (fail closed). The quote the agent cites travels
  as `X-Agent-Authorization` (the Gmail-send-gate pattern) and is written to
  the job log next to the verified owner message.
- The owner in the dashboard (`X-Crewly-Caller: dashboard`, no agent header)
  may install third-party skills directly.
- `crewly install` / `crewly skills setup` at a terminal are the owner.

## Agent behaviour

`SkillsReferenceModule` (every role) now carries:

> Before telling the user you cannot do something (a file you cannot read —
> audio, video, PDF —, a missing tool, or a skill that answered
> `"needsSetup": true`): find-skill → official and not ready: tell the user in
> ONE line you are installing it and roughly how long, install-skill --resume …
> → on `[SKILL INSTALLED]` do the original task; on `[SKILL INSTALL FAILED]` tell
> the user what is missing. Third-party: ask the owner first. Audio/video →
> transcribe-audio, PDFs → pdf-tools.

Skills that fail for a missing dependency say so machine-readably:

```json
{"success":false,"error":"ffmpeg is required but not installed","needsSetup":true,
 "skill":"transcribe-audio","missing":["ffmpeg"],"hint":"Run install-skill --id transcribe-audio …"}
```

(`transcribe-audio`: jq, ffmpeg, local engine with `engine:"local"`, and auto
mode with neither a local engine nor an OpenAI key. `pdf-tools`: no render
engine, no Python packages.)

### Inbound files

The Slack bridge appends one line per downloaded file after `[Slack File: …]`:

- audio/video (MIME `audio/*`, `video/*`, or m4a/mp3/wav/ogg/opus/… extension):
  `[Hint: voice/audio or video file — use the transcribe-audio skill:
  {"audioFile":"<path>"}. If it answers "needsSetup": true, … run install-skill
  --id transcribe-audio …]`
- PDF: only when the inline extraction failed or was truncated:
  `[Hint: PDF — … use the PDF reading skill (pdf-tools): {"action":"read","input":"<path>"}.]`

(chat-v2 does not accept attachments on its message endpoint yet.)

## Official skills

### transcribe-audio (bundled, 1.1.0)

Unchanged engines (local whisper.cpp, OpenAI fallback); adds the setup block,
`needsSetup` errors, `$CREWLY_HOME/bin/whisper-cli` lookup and the Linux
installer.

### pdf-tools (bundled, 1.0.0)

- `render` Markdown / HTML (one or several parts, `.pdf` parts allowed) → one PDF.
  Headless Chrome/Chromium first (`--headless=new --disable-gpu
  --no-pdf-header-footer --print-to-pdf`, no `--user-data-dir`: with one, Chrome
  153 on macOS writes the PDF and never exits; a guard stops Chrome 3 s after the
  PDF is complete), WeasyPrint as fallback. Markdown → HTML with python-markdown
  (pandoc fallback) and `style.css` (A4, CJK font stacks: PingFang/Hiragino,
  Noto CJK, YaHei). Relative images resolve via `<base href>`; nothing is written
  next to the source.
- `merge` (pypdf), `read` (pypdf; pdftotext fallback; page ranges; `textFile`
  for everything; note when there is no text layer), `info`, `check`.
- venv `$CREWLY_HOME/venv/pdf-tools` — the directory `send-pdf-to-slack`
  already used, so both share it.
- Our own code; nothing from Anthropic's proprietary pdf skill.

`core/generate-pdf` keeps its input/output shape and now delegates to pdf-tools.

## Publishing

- Public registry (`config/skills/registry.json`, read by every Crewly from
  GitHub raw): regenerated with `npx tsx scripts/generate-registry.ts`; now lists
  `transcribe-audio` and `pdf-tools` (sources outside `marketplace/` are kept once
  listed) and copies `setup` into `metadata.setup`. Goes live when this branch
  is merged to `main`.
- `crewly publish <dir>` validates the setup block (and that install scripts
  ship), copies it into the entry's `metadata.setup`, leaves tests out of the
  archive, and now writes `<id>/<file>` entries (was `<id>/<dir>/<file>`, which
  unpacked one level too deep with `strip: 1`).
- crewlyai.com premium registry / archives: see the hand-off steps in the PR
  description (manual, owner-controlled).

## Tests

- `skill-setup-manifest.test.ts`, `skill-setup-runner.service.test.ts`
  (idempotence, brew/apt/sudo/script, verified download + cleanup, python venv,
  lock sharing/waiting/stale/timeout, check-only, log),
  `skill-discovery.service.test.ts` (ranking incl. the real bundled tree,
  official rule, bundled-without-registry), `skill-install-job.service.test.ts`
  (trust rule, owner-approval verification, completion message, dedupe,
  premium→public fallback), controller/routes tests, prompt rule test,
  inbound-file hint tests, CLI `skills` / `install` tests, publish validator /
  archive tests, registry guard test.
- Skill scripts: `find-skill`, `install-skill`, `transcribe-audio`,
  `install-whisper-cpp`, `pdf-tools`, `generate-pdf` `execute.test.sh` — run
  with `</dev/null`, pass under macOS `/bin/bash` 3.2.
