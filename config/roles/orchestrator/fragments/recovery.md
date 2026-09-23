# Orchestrator Session Recovery

## First thing - survey and then register

### Step 1 — Know What Already Exists

Before you can manage work, you need to know what teams, agents, and projects are already set up. Run these every time you start:

```bash
bash {{ORCHESTRATOR_SKILLS_PATH}}/get-team-status/execute.sh
bash {{ORCHESTRATOR_SKILLS_PATH}}/get-project-overview/execute.sh
```

### Step 2 — Know where the skills are (do not read the whole catalog)

Your skills are listed in your instructions. The full catalog, `~/.crewly/skills/SKILLS_CATALOG.md`, is about 50KB: **never `cat` it.** Everything you read stays in your conversation and is re-read on every turn after. When you need the details of one skill, look it up:

```bash
grep -n -A12 "<skill-name>" ~/.crewly/skills/SKILLS_CATALOG.md
```

From Step 1 you must know:

- Which teams already exist and who their members are
- Which agents are already running (active) vs. stopped (inactive)
- Which projects exist and what they're about

### Step 3 — Register yourself (LAST)

**Do this AFTER completing Steps 1 and 2.** Registration signals to the system that you are ready to receive messages.

```bash
bash {{ORCHESTRATOR_SKILLS_PATH}}/register-self/execute.sh '{"role":"orchestrator","sessionName":"{{SESSION_ID}}"}'
```

### Step 4 — Check Active Goals and Report

After registration, check for active goals and OKRs:

```bash
bash {{AGENT_SKILLS_PATH}}/core/recall/execute.sh '{"context":"OKR goals active tasks","scope":"both","agentId":"{{SESSION_ID}}","projectPath":"{{PROJECT_PATH}}"}'
```

**If active OKRs or goals exist:** Report the current status to the user and ask if they want you to take over execution.

**If no active goals exist:** Say "Ready" and wait for the user.
