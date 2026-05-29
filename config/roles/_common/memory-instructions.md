## Memory Management — Build Your Knowledge Over Time

You have MCP tools that let you store and retrieve knowledge that persists across sessions. **Use them proactively** — they make you more effective over time.

### Available Memory Tools

- **`remember`** — Store knowledge for future reference
  - Required: `content`, `category` (pattern/decision/gotcha/fact/preference/relationship), `scope` (agent/project)
  - **Always pass**: `teamMemberId` (your Session Name) and `projectPath` (your Project Path from the Identity section)

- **`recall`** — Retrieve relevant knowledge from your memory
  - Required: `context` (what you're working on or looking for)
  - **Always pass**: `teamMemberId` (your Session Name) and `projectPath` (your Project Path from the Identity section)

- **`record_learning`** — Quickly jot down a learning while working
  - Required: `learning` (what you learned)
  - **Always pass**: `teamMemberId` (your Session Name) and `projectPath` (your Project Path from the Identity section)

- **`wiki-query`** — Search the LLM-wiki (v2.1) for SOPs, runbooks, decisions, patterns, customer/people pages
  - Required: `vault` (absolute path; see `wiki-instructions.md` for the per-topic vault picker), `query`
  - Optional: `topK` (default 5)
  - **Replaces the legacy `query-knowledge` skill (retired 2026-05-27)** — the OSS migration script moved every doc, SOP, runbook into the appropriate wiki vault; query the wiki, not the old `.crewly/docs/` / `.crewly/knowledge/` stores

### When to Use Memory Tools

**On session startup** (before doing any work):
1. Call `recall` with context describing your role and current project to load previous knowledge
2. Review what comes back — it may contain important gotchas, patterns, or unfinished work
3. Note: `recall` and `get-my-context` now automatically include relevant knowledge documents

**During work** — call `remember` when you:
- Discover a code pattern or convention in the project (category: `pattern`, scope: `project`)
- Make or learn about an architectural decision (category: `decision`, scope: `project`)
- Find a gotcha, bug, or workaround (category: `gotcha`, scope: `project`)
- Learn something useful for your role (category: `fact`, scope: `agent`)
- Note your own working style (category: `preference`, scope: `agent`)
- Note cross-agent user preferences (category: `user_preference`, scope: `project`)

**Before process-oriented tasks** (deployment, setup, incident response):
- **Query the wiki** with `wiki-query` against the right vault (global vault for cross-team SOPs, team vault for team-norms, project vault for project-specific runbooks — see `wiki-instructions.md`)
- These documents contain step-by-step procedures your team has documented; the LLM-wiki has fully replaced the legacy `query-knowledge`/`.crewly/docs/` storage as of 2026-05-27

**Before answering questions** about deployment, architecture, past decisions, or infrastructure:
- **Always call `recall` first** to check stored knowledge before answering from scratch
- Knowledge documents are automatically included in recall results

**When finishing a task** — call `record_learning` with:
- What was done and what was learned
- Any gotchas or patterns discovered
- What's left unfinished (if anything)

### Error Learning Protocol (Mandatory)

When you hit an error and successfully resolve it:
1. Immediately call `record_learning` with the exact error and fix.
2. If the fix is reusable, call `remember` with scope `project` so other agents inherit it.
3. Include environment context (OS/runtime/dependency) to avoid repeat debugging loops.

### Key Rules

1. **Always pass `teamMemberId` and `projectPath`** — without these, memory can't be saved or retrieved correctly
2. **Be specific in content** — "Use async/await for all DB queries in this project" is better than "use async"
3. **Use `recall` liberally** — it's cheap and often surfaces useful context
4. **Store project knowledge with `scope: project`** so other agents can benefit
5. **Store personal knowledge with `scope: agent`** for role-specific learnings
6. **Store shared user preferences with `scope: project` + `category: user_preference`**
