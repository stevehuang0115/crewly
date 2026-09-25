# Contributing Skills to Crewly

This guide explains how to create, test, and submit new skills for the Crewly platform.

## What is a Skill?

A skill is a self-contained bash script with metadata that agents and orchestrators can invoke to perform specific operations. Skills communicate with the Crewly backend API and follow a standard two-file structure: `SKILL.md` (metadata + instructions) and `execute.sh`.

## Directory Structure

```
config/skills/
├── _common/
│   └── lib.sh                     # Shared library (api_call, error_exit, require_param)
├── registry.json                  # Marketplace registry manifest
├── agent/
│   ├── _common/
│   │   └── lib.sh                # Delegates to ../../_common/lib.sh
│   ├── core/                     # Core agent skills (built-in)
│   │   └── {skill-name}/
│   │       ├── SKILL.md          # Metadata (YAML frontmatter) + usage documentation
│   │       └── execute.sh        # Implementation script
│   └── marketplace/              # Extended marketplace skills
│       └── {skill-name}/
│           ├── SKILL.md
│           └── execute.sh
└── orchestrator/
    ├── _common/
    │   └── lib.sh                # Delegates to ../../_common/lib.sh
    └── {skill-name}/
        ├── SKILL.md
        └── execute.sh
```

> **Legacy layout.** Older skills use `skill.json` (metadata) + `instructions.md`
> (documentation) instead of `SKILL.md`. That layout still loads, and
> `crewly publish` still accepts it, but new skills should use `SKILL.md`.

### Where to Place Your Skill

| Type | Location | Who Uses It |
|------|----------|-------------|
| Agent core skill | `config/skills/agent/core/{name}/` | Individual agents (developers, QA, etc.) |
| Marketplace skill | `config/skills/agent/marketplace/{name}/` | Agents who install it |
| Orchestrator skill | `config/skills/orchestrator/{name}/` | Team orchestrator only |

## Naming Conventions

- **Directory name**: `kebab-case` (e.g., `report-status`, `send-message`)
- **Skill ID**: the directory name. `SKILL.md` normally has no `id` field; an explicit `id:` in the frontmatter overrides the directory name
- **Display name**: Title Case (e.g., `Report Status`, `Send Message`)

## Creating a New Skill

Every skill requires two files: `SKILL.md` and `execute.sh`.

### 1. `SKILL.md` — Metadata and documentation

`SKILL.md` is a YAML frontmatter block (the metadata) followed by the Markdown
instructions agents read (see section 3 for what the body must contain).

```markdown
---
name: My Skill
description: "What it does. Use when [trigger conditions]. For X use other-skill instead."
version: 1.0.0
category: development
skillType: claude-skill
assignableRoles:
  - developer
  - qa
triggers:
  - trigger phrase 1
  - trigger phrase 2
  - trigger phrase 3
tags:
  - tag1
  - tag2
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# My Skill

One sentence describing what the skill does.
...
```

**Frontmatter fields:**

| Field | Description |
|-------|-------------|
| `name` | Human-readable display name |
| `description` | Must include: what it does + when to use + related skills |
| `version` | Semantic version (`1.0.0`) |
| `category` | One of: `management`, `communication`, `monitoring`, `memory`, `system`, `design`, `automation`, `development`, `task-management` |
| `skillType` | `claude-skill` for bash scripts, `mcp` for MCP servers |
| `execution` | Script configuration (file, interpreter, timeoutMs) |
| `assignableRoles` | Array of roles that can use this skill |
| `triggers` | 3-5 natural language phrases for auto-discovery |
| `tags` | Searchable tags for marketplace |
| `id` | Optional. Defaults to the directory name |

`crewly publish` requires `name`, `description`, `version`, `category`, and non-empty
`assignableRoles` and `tags`; `author`, `license` and `triggers` are recommended.

**Legacy `skill.json` layout:** the same fields as JSON in `skill.json` (plus
`"id"` and `"promptFile": "instructions.md"`), with the documentation in a separate
`instructions.md`. Still accepted; if both `SKILL.md` and `skill.json` exist,
`SKILL.md` wins field by field.

**Timeout guidelines:**
- Quick operations (status check, memory lookup): `15000` (15s)
- API calls (message send, task delegate): `30000` (30s)

### 2. `execute.sh` — Implementation

```bash
#!/bin/bash
# Brief description of what this skill does
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

# Parse input
INPUT="${1:-}"
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"param1\":\"value\"}'"

# Extract parameters
PARAM1=$(echo "$INPUT" | jq -r '.param1 // empty')
PARAM2=$(echo "$INPUT" | jq -r '.param2 // "default"')

# Validate required parameters
require_param "param1" "$PARAM1"

# Build request body
BODY=$(jq -n \
  --arg param1 "$PARAM1" \
  --arg param2 "$PARAM2" \
  '{param1: $param1, param2: $param2}')

# Make API call
api_call POST "/endpoint" "$BODY"
```

**Rules:**
- Always start with `#!/bin/bash` and `set -euo pipefail`
- Always source `${SCRIPT_DIR}/../_common/lib.sh`
- Always validate input is non-empty
- Use `jq` for JSON parsing (never regex or `grep` on JSON)
- Use `require_param` for all required parameters
- Use `api_call` for all backend HTTP requests
- Return valid JSON to stdout

**Shared library functions (`_common/lib.sh`):**

| Function | Usage | Description |
|----------|-------|-------------|
| `api_call METHOD endpoint [body]` | `api_call POST "/teams" "$JSON"` | HTTP request to `CREWLY_API_URL/api{endpoint}`. Returns response on success, JSON error on stderr + exit 1 on failure. |
| `error_exit message` | `error_exit "Missing input"` | Prints `{"error":"message"}` to stderr and exits 1. |
| `require_param name value` | `require_param "teamId" "$TEAM_ID"` | Exits with error if value is empty. |

**Environment variables available:**
- `CREWLY_API_URL` — Backend URL (default: `http://localhost:8787`)
- `CREWLY_SESSION_NAME` — Current agent session name (sent as `X-Agent-Session` header)

### 3. The `SKILL.md` body — Documentation

Everything after the closing `---` of the frontmatter:

```markdown
# My Skill

One sentence describing what the skill does.

## Usage

\```bash
bash config/skills/agent/core/my-skill/execute.sh '{"param1":"value","param2":"optional"}'
\```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `param1` | Yes | What this parameter does |
| `param2` | No | Description (default: `"default"`) |

## Examples

### Example 1: Basic usage
\```bash
bash config/skills/agent/core/my-skill/execute.sh '{"param1":"hello"}'
\```
Expected output:
\```json
{"success": true, "data": {"result": "hello processed"}}
\```

### Example 2: With optional params
\```bash
bash config/skills/agent/core/my-skill/execute.sh '{"param1":"hello","param2":"world"}'
\```

## Output

JSON object with:
- `success` — boolean indicating operation result
- `data` — response payload

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `Missing required parameter: param1` | param1 not provided | Include param1 in JSON input |
| `curl failed with exit code N` | Backend not running | Start the Crewly backend |

## Related Skills

- `other-skill` — for a different use case
- `complementary-skill` — often used together with this skill
```

**Documentation requirements:**
- Working usage example with real parameter values
- Parameters table (Required, Name, Description)
- At least 2 examples showing different scenarios
- Output section describing response format
- Error handling table for common failures
- Related skills list

## Testing Your Skill

### 1. Manual testing

```bash
# Ensure the backend is running
curl -s http://localhost:8787/api/health | jq .

# Test with valid input
bash config/skills/agent/core/my-skill/execute.sh '{"param1":"test"}'

# Test error handling - missing required param
bash config/skills/agent/core/my-skill/execute.sh '{}' 2>&1

# Test error handling - no input
bash config/skills/agent/core/my-skill/execute.sh 2>&1
```

### 2. Validation checklist

- [ ] `SKILL.md` starts with a valid YAML frontmatter block (`crewly publish <dir> --dry-run` checks it)
- [ ] `execute.sh` is executable (`chmod +x execute.sh`)
- [ ] Script exits cleanly on missing input
- [ ] All required parameters are validated with `require_param`
- [ ] Output is valid JSON on success
- [ ] Error output is valid JSON on stderr
- [ ] No hardcoded URLs (uses `CREWLY_API_URL`)
- [ ] Instructions include working examples

### 3. ShellCheck

```bash
shellcheck config/skills/agent/core/my-skill/execute.sh
```

## Common Gotchas

1. **`set -euo pipefail` + `grep`**: `grep` returns exit code 1 when no match is found, which kills the script under `pipefail`. Use `grep -c ... || true` or `grep ... || :` when no-match is acceptable.

2. **JSON multiline text**: When passing multiline text, write to a temp file and use `--text-file` pattern instead of JSON.stringify (which escapes `\n` to literal backslash-n).

3. **Relative paths**: Always use `${SCRIPT_DIR}` for relative paths. Agents may run from any working directory.

4. **`jq` default values**: Use `// empty` for required params (enables `require_param` to catch it) and `// "default"` for optional params.

## Submitting via Pull Request

1. Create your skill in the appropriate directory
2. Verify `SKILL.md` and `execute.sh` are present and valid (`crewly publish <dir> --dry-run`)
3. Run manual tests to confirm functionality
4. Run `shellcheck` on your `execute.sh`
5. Create a PR with a clear description:

```
feat: add {skill-name} skill for {agents|orchestrator}

- What: brief description of what the skill does
- Why: what problem it solves or workflow it enables
- Testing: how you tested it
```

### PR Checklist

- [ ] `SKILL.md` and `execute.sh` present (or legacy `skill.json` + `instructions.md` + `execute.sh`)
- [ ] Frontmatter has a valid `category` and 3+ `triggers`; the directory name is a unique kebab-case id
- [ ] `execute.sh` sources `_common/lib.sh` and uses `set -euo pipefail`
- [ ] The `SKILL.md` body has Usage, Parameters, Examples, Error Handling sections
- [ ] `execute.sh` is executable (`chmod +x`)
- [ ] ShellCheck passes with no errors
- [ ] Manual testing confirms success and error paths work
- [ ] No secrets or credentials hardcoded in any file
