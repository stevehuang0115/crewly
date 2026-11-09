---
id: common-writing-for-agents
version: 1
createdAt: 2026-10-13T00:00:00Z
updatedAt: 2026-10-13T00:00:00Z
createdBy: system
type: norm
role: all
category: quality
priority: 8
title: Writing for Agents
description: How to word skills, prompts, roles and SOPs so agents act on them at low context cost
triggers:
  - write skill
  - write prompt
  - skill description
  - author sop
  - role prompt
  - steering text
tags:
  - authoring
  - prompts
  - skills
# Rule metadata (#877): what this rule prevents, where seen, when to re-test
prevents: "none recorded as an incident — skills and norms were written for human readers (long prose, vague verbs, no examples); borrowed from mattpocock/skills, enforced by the skill lint"
seenOn: "unknown (2026-10)"
reviewBy: 2027-01-31
source: https://github.com/stevehuang0115/crewly/pull/1277
---

# Writing for Agents

Long form: mattpocock/skills `writing-for-agents`. Skill descriptions and always-loaded steering text cost context on every turn. Check new text against these six points. `skill-lint` (config/skills/_conventions) enforces the mechanical ones.

1. **Pointer wording decides when material is read.** Front-load the leading word of a description. One trigger per branch; synonyms of one trigger are one branch written twice. Cut identity the body already carries.
2. **End every step on a completion criterion.** The agent must be able to tell done from not-done. The best criteria are checkable and exhaustive ("the command exits 0", not "make sure it works").
3. **Say what to do, not what to avoid.** A prohibition puts the forbidden behavior into context and makes it more available. Prefer "Run the check, then report its exit code" over "NEVER report without checking".
4. **Do not restate the environment.** A doc that copies `package.json` scripts or config is a cache that goes stale. Cache only what cannot be found by looking; point to the file otherwise.
5. **Hunt no-ops.** If the model already does it by default, the sentence costs load and changes nothing. Keep a sentence only if removing it would change behavior (the same test for #877 rule cleanup).
6. **Keep emphasis rare.** Capitals and HARD RULE lose force when everything has them.

## Example (real skill: `agent/core/publish-app`)

Before (612 chars, why-it-works history and edge cases in the pointer):

> Publish a small web app (HTML/JS) you wrote to https://apps.crewlyai.com/<appId> so the owner can open it on their phone. Creates the app the first time, uploads a new version each time after (same app for the same directory), supports rollback, and can post an "Open app" card to the owner (...). Can ask the owner to make an app public, or to publish it as a template on the Crewly Marketplace (...). The owner's edits, comments on elements, and anonymous visitors' submissions on a public app, come back to you as an [APP CHANGES] message.

After (under 200 chars, one trigger, detail moves to the SKILL.md body):

> Publish an HTML/JS app you wrote to apps.crewlyai.com so the owner can open it on their phone. Also: new version, rollback, make public.
