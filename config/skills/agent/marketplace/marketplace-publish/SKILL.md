---
name: Marketplace Publish
description: Package and submit skills to the Crewly marketplace. Validates, archives, and submits for review to both local and remote registries.
version: 1.0.0
category: automation
skillType: claude-skill
assignableRoles:
  - developer
  - backend-developer
  - fullstack-dev
  - architect
  - generalist
triggers:
  - publish skill
  - submit skill
  - marketplace publish
  - package skill
  - share skill
tags:
  - marketplace
  - publish
  - submit
  - package
  - skills
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Marketplace Publish

Package and submit skills to the Crewly marketplace. This skill handles validation, archiving, and submission to both local and remote registries.

## Actions

### `validate` — Check a skill directory before publishing

```bash
bash {{AGENT_SKILLS_PATH}}/marketplace/marketplace-publish/execute.sh '{"action":"validate","skillPath":"{{PROJECT_PATH}}/config/skills/agent/my-skill"}'
```

Returns `valid: true/false` with any errors and warnings.

### `publish` — Package and submit to local marketplace

```bash
bash {{AGENT_SKILLS_PATH}}/marketplace/marketplace-publish/execute.sh '{"action":"publish","skillPath":"{{PROJECT_PATH}}/config/skills/agent/my-skill"}'
```

This creates a tar.gz archive and submits it to the local Crewly backend for review. The skill becomes available in the local marketplace once approved.

### `publish-remote` — Submit to both local and remote registries

```bash
bash {{AGENT_SKILLS_PATH}}/marketplace/marketplace-publish/execute.sh '{"action":"publish-remote","skillPath":"{{PROJECT_PATH}}/config/skills/agent/my-skill"}'
```

Publishes to the local backend AND to the remote registry at crewlyai.com, making the skill available to all Crewly users.

### `list-submissions` — View submission status

```bash
bash {{AGENT_SKILLS_PATH}}/marketplace/marketplace-publish/execute.sh '{"action":"list-submissions"}'
```

Filter by status:
```bash
bash {{AGENT_SKILLS_PATH}}/marketplace/marketplace-publish/execute.sh '{"action":"list-submissions","status":"pending"}'
```

## Skill Directory Requirements

A valid skill directory must contain:
- `skill.json` — Metadata with id (kebab-case), name, description, version (semver), category, assignableRoles, tags
- `execute.sh` — Executable bash script (the skill's entry point)
- `instructions.md` — Usage documentation for the agent

## When to Use

- **After creating a new skill** — validate and publish it to share with the team
- **After updating a skill** — bump the version and re-publish
- **To share capabilities** — publish skills that other agents or teams can benefit from
- **To check quality** — validate a skill before committing it

## Output

JSON response with publish status, including submission ID for tracking.
