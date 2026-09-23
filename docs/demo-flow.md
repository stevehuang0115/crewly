# Crewly Complete Demo Flow

> End-to-end walkthrough: from `npm install` to a fully autonomous AI team producing real code.
> Every command in this document is executable against the current codebase.
>
> **Estimated time:** 10-15 minutes (including agent execution time)
> **Prerequisites:** Node.js v20+, npm v9+, jq, a C++ build toolchain for node-pty (Xcode Command Line Tools on macOS; python3, make, g++ on Linux), and at least one AI CLI authenticated (Claude Code recommended)

---

## Overview

This demo shows the 8-step journey of using Crewly:

| Step | Action | What Happens |
|------|--------|-------------|
| 1 | Install | Get Crewly on your machine |
| 2 | Initialize | Set up project structure and tools |
| 3 | Create Team | Build a 3-person AI team from a template |
| 4 | Assign Roles | Each agent gets a role-specific prompt and skillset |
| 5 | Start Team | Launch all agents in real terminal sessions |
| 6 | Assign Task | Give the team a concrete task to execute |
| 7 | Observe Collaboration | Watch agents delegate, code, and coordinate in real time |
| 8 | View Results | Inspect the actual code, tests, and docs produced |

---

## Step 1: Install Crewly

### Option A: Try without installing (recommended for demos)

```bash
npx crewly init
```

This downloads Crewly temporarily and runs the setup wizard immediately.

### Option B: Install globally

```bash
npm install -g crewly
```

**Expected output:**

```
added 150+ packages in 30s

+ crewly@1.2.3
```

### Verify installation

```bash
crewly --version
# Expected: 1.2.3 (or current version)
```

---

## Step 2: Initialize Project

Navigate to the project you want your AI team to work on (or create a fresh demo directory):

```bash
mkdir ~/crewly-demo && cd ~/crewly-demo
crewly init
```

The interactive wizard walks through 5 steps:

```
   ____                    _
  / ___|_ __ _____      _| |_   _
 | |   | '__/ _ \ \ /\ / / | | | |
 | |___| | |  __/\ V  V /| | |_| |
  \____|_|  \___| \_/\_/ |_|\__, |
                              |___/

  Welcome to Crewly! Let's get you set up.

Step 1/5: AI Provider Selection
  > Claude Code (Anthropic)     <-- select this
    Gemini CLI (Google)
    Both
    Skip

Step 2/5: Tool Detection
  jq .............. v1.7.1 ✓
  Claude Code ..... v1.x ✓

Step 3/5: Installing Skills
  Installing 22 agent skills... done ✓

Step 4/5: Choose Team Template
  > Startup Team (PM + Developer + Generalist)    <-- select this
    Code Review Team
    Content Generation Team
    Research Team
    Social Media Ops Team
    Web Dev Team
    Skip

Step 5/5: Project Setup
  Created .crewly/ directory ✓
```

### Non-interactive mode (for CI or scripted demos)

```bash
crewly init --yes --template startup-team
```

### What gets created

**Global config (`~/.crewly/`):**

```
~/.crewly/
├── config.env                          # Server port, log level, etc.
├── teams/
│   └── startup-team/
│       └── config.json                 # Team with 3 members (PM, Dev, Generalist)
├── projects.json                       # Project registry
├── skills/                             # Installed marketplace skills
└── memory/                             # Agent memory storage
```

**Project-local config (`.crewly/` in your project):**

```
crewly-demo/
└── .crewly/
    ├── docs/                           # Project knowledge docs
    ├── memory/                         # Project-scoped agent memories
    ├── tasks/                          # Task tracking
    └── teams/                          # Team assignments
```

---

## Step 3: Create Team

The `crewly init` wizard already created your team from the Startup Team template. Let's verify:

```bash
crewly start --no-browser
```

Then in another terminal, check the team via API:

```bash
curl -s http://localhost:8787/api/teams | jq '.data[0] | {name, description, memberCount: (.members | length)}'
```

**Expected output:**

```json
{
  "name": "Startup Team",
  "description": "PM + Developer + Generalist for rapid prototyping and MVP development.",
  "memberCount": 3
}
```

### Alternatively: create a team via the Dashboard

1. Open `http://localhost:8787` in your browser
2. Click **Teams** in the sidebar
3. Click **Create Team**
4. Fill in team name and description
5. Click **Add Member** for each agent you want

### Available templates

| Template | Members | Best For |
|----------|---------|----------|
| `startup-team` | PM + Developer + Generalist | MVPs, prototyping |
| `web-dev-team` | Frontend Dev + Backend Dev + QA | Web applications |
| `code-review-team` | Reviewer + Developer | Code quality |
| `content-generation-team` | Content Strategist + Writer | Content creation |
| `research-team` | Researcher + Analyst | Research tasks |
| `social-media-ops-team` | Social Media Manager + Designer | Social media |

---

## Step 4: Assign Roles

Each team member gets a role that determines their system prompt and available skills. The Startup Team template assigns these automatically:

| Agent | Role | Behavior | Skills |
|-------|------|----------|--------|
| **Product Manager** | `product-manager` | Defines requirements, prioritizes features, reviews deliverables | Core agent skills |
| **Developer** | `developer` | Builds features, writes tests, establishes code patterns | `code-review`, `testing`, `documentation`, `github` |
| **Generalist** | `fullstack-dev` | Fills gaps: frontend, backend, DevOps, docs | `code-review`, `testing`, `documentation`, `github` |

### View member details

```bash
curl -s http://localhost:8787/api/teams | jq '.data[0].members[] | {name, role, agentStatus, runtimeType}'
```

**Expected output:**

```json
{"name": "Product Manager", "role": "product-manager", "agentStatus": "inactive", "runtimeType": "claude-code"}
{"name": "Developer", "role": "developer", "agentStatus": "inactive", "runtimeType": "claude-code"}
{"name": "Generalist", "role": "fullstack-dev", "agentStatus": "inactive", "runtimeType": "claude-code"}
```

### Available roles (16 built-in)

| Category | Roles |
|----------|-------|
| **Management** | `product-manager`, `tpm`, `team-leader` |
| **Development** | `developer`, `frontend-developer`, `backend-developer`, `fullstack-dev`, `architect` |
| **Quality** | `qa`, `qa-engineer` |
| **Design** | `designer` |
| **Other** | `sales`, `support`, `ops`, `content-strategist` |

Role prompts live in `config/roles/<role>/prompt.md` and can be customized.

---

## Step 5: Start the Team

### From the Dashboard (recommended for demos)

1. Open `http://localhost:8787`
2. Navigate to **Teams** in the sidebar
3. Click on your **Startup Team** card
4. Click **Start Team**
5. Select the project to assign the team to
6. Watch agent statuses transition: `inactive` → `starting` → `active`

### From the CLI

If Crewly isn't running yet:

```bash
crewly start
```

**Expected output:**

```
Starting Crewly...
  Backend ......... running on port 8787
  Dashboard: http://localhost:8787

Opening browser...
```

The dashboard opens automatically. From there, start your team as described above.

### What happens behind the scenes

When you start a team:

1. **Orchestrator session** (`crewly-orc`) is created as a terminal session — this is the coordinator agent
2. **Each team member** gets their own terminal session running their chosen AI CLI (Claude Code, Gemini CLI, etc.)
3. **System prompts** are injected based on role — each agent knows their responsibilities
4. **Agent skills** (22 bash scripts) become available for inter-agent communication
5. **WebSocket connections** stream live terminal output to the dashboard

### Verify agents are running

```bash
crewly status --verbose
```

**Expected output:**

```
Crewly Status:
  Backend: running (port 8787)
  Sessions: 4 active
    crewly-orc (orchestrator) - active
    startup-team-product-manager-xxxx - active
    startup-team-developer-xxxx - active
    startup-team-generalist-xxxx - active
```

---

## Step 6: Assign a Task

### Option A: Chat with the Orchestrator (Dashboard)

1. Go to the **Chat** page in the dashboard
2. Type a high-level instruction:

```
Build a simple todo API with Express.js and TypeScript.
It should have:
- GET /api/todos (list all)
- POST /api/todos (create one)
- DELETE /api/todos/:id (delete one)
Include tests and a README.
```

3. The orchestrator automatically delegates sub-tasks to the appropriate agents

### Option B: Direct task delegation (CLI)

Use the orchestrator's `delegate-task` skill to assign work directly:

```bash
# Delegate to the developer
bash config/skills/orchestrator/delegate-task/execute.sh '{
  "to": "startup-team-developer-XXXX",
  "task": "Create a REST API with Express.js and TypeScript. Implement GET /api/todos, POST /api/todos, and DELETE /api/todos/:id. Include proper TypeScript types, error handling, and a test file with at least 3 tests.",
  "priority": "high",
  "projectPath": "'$(pwd)'"
}'
```

Replace `XXXX` with the actual member ID suffix (visible in `crewly status` or the dashboard).

**Expected output:**

```json
{"success": true, "message": "Task delegated to startup-team-developer-XXXX"}
```

```bash
# Delegate docs to the PM
bash config/skills/orchestrator/delegate-task/execute.sh '{
  "to": "startup-team-product-manager-XXXX",
  "task": "Write API documentation for a todo REST API with GET /api/todos, POST /api/todos, and DELETE /api/todos/:id. Include request/response examples and error codes.",
  "priority": "normal",
  "projectPath": "'$(pwd)'"
}'
```

### Option C: From the Dashboard project view

1. Go to **Projects** → select your project
2. Create a new task with title and description
3. Assign it to a team member
4. The agent picks it up and starts working

---

## Step 7: Observe Collaboration

This is where Crewly's value becomes visible. Multiple agents work in parallel, each in their own terminal session.

### Watch live terminals (Dashboard)

1. Click the **terminal icon** next to any agent in the Teams page
2. A terminal panel slides out showing the agent's live Claude Code session
3. You see every thought, every file creation, every command — in real time

**What you'll see in the Developer's terminal:**

```
Claude Code is thinking...

I'll create a REST API with Express.js and TypeScript.

Let me start by setting up the project structure...

> Creating src/index.ts
> Creating src/types/todo.ts
> Creating src/routes/todos.ts
> Creating tests/todos.test.ts

[file content streaming in real-time...]
```

### Monitor agent status

The dashboard shows real-time status for each agent:
- **Green dot** — active and working
- **Yellow dot** — idle, waiting for tasks
- **Red dot** — stopped or errored

### Watch inter-agent communication

Agents communicate through skills. You can observe this in the logs:

```bash
crewly logs -f
```

**Example log output:**

```
[developer] Task accepted: "Create a REST API..."
[developer] Status: in_progress
[developer] Running quality gates...
[developer] Status: done - "REST API created with 3 endpoints and 5 tests"
[pm] Task accepted: "Write API documentation..."
[pm] Status: done - "API docs written with request/response examples"
```

### How collaboration works

```
                    ┌────────────────┐
                    │  Orchestrator  │
                    │  (crewly-orc)  │
                    └───────┬────────┘
                            │ delegate-task
                   ┌────────┴────────┐
                   ▼                 ▼
          ┌────────────────┐  ┌────────────────┐
          │    Developer   │  │      PM        │
          │  (writes code) │  │ (writes docs)  │
          └────────┬───────┘  └────────┬───────┘
                   │                   │
                   │  report-status    │  report-status
                   └────────┬──────────┘
                            ▼
                    ┌────────────────┐
                    │  Orchestrator  │
                    │  (aggregates)  │
                    └────────────────┘
```

1. **Orchestrator** receives the goal and breaks it into tasks
2. **Developer** gets the coding task → writes code, runs tests, reports done
3. **PM** gets the documentation task → writes docs, reports done
4. **Orchestrator** monitors progress via scheduled check-ins (every 5-15 min)
5. If an agent gets stuck, the orchestrator detects it and intervenes

---

## Step 8: View Results

After agents complete their work, inspect the actual output.

### Check the file tree

```bash
tree src/ tests/ docs/ 2>/dev/null || ls -la src/ tests/ docs/
```

**Expected structure (example):**

```
src/
├── index.ts              # Express server entry point
├── types/
│   └── todo.ts           # TypeScript interfaces
└── routes/
    └── todos.ts          # Todo route handlers

tests/
└── todos.test.ts         # API endpoint tests

docs/
└── api-docs.md           # API documentation
```

### Run the tests

```bash
npm test
```

**Expected output:**

```
 PASS  tests/todos.test.ts
  Todo API
    GET /api/todos
      ✓ returns empty array initially (12ms)
    POST /api/todos
      ✓ creates a new todo (8ms)
    DELETE /api/todos/:id
      ✓ deletes a todo (5ms)

Tests: 3 passed, 3 total
```

### Check agent memory (what they learned)

```bash
bash config/skills/agent/core/recall/execute.sh '{
  "agentId": "startup-team-developer-XXXX",
  "context": "express api patterns",
  "projectPath": "'$(pwd)'"
}'
```

**Expected output:**

```json
{
  "success": true,
  "data": {
    "agentMemories": [
      "[best-practice] Express API pattern: use separate route files, TypeScript interfaces for all models, co-located test files..."
    ]
  }
}
```

The agent has learned patterns from this task and will apply them in future sessions.

### View from the Dashboard

1. **Projects page** — shows task progress bar (% complete)
2. **Teams page** — all agents show as idle (task done)
3. **Knowledge page** — accumulated agent memories and learnings

---

## Cleanup

When you're done with the demo:

```bash
# Graceful shutdown
crewly stop

# Force kill if needed
crewly stop --force
```

---

## Quick Reference

### Key Commands

```bash
crewly init                    # First-time setup wizard
crewly init --yes              # Non-interactive setup with defaults
crewly start                   # Start backend + open dashboard
crewly start --no-browser      # Start without opening browser
crewly status                  # Check what's running
crewly status --verbose        # Detailed status with process info
crewly logs -f                 # Follow logs in real time
crewly stop                    # Graceful shutdown
crewly install --all           # Install all agent skills
crewly search "keyword"        # Search skill marketplace
```

### Key URLs

| URL | What |
|-----|------|
| `http://localhost:8787` | Web Dashboard |
| `http://localhost:8787/health` | Backend health check |
| `ws://localhost:8787` | WebSocket (live terminal streaming) |

### Key Directories

| Path | Purpose |
|------|---------|
| `~/.crewly/` | Global config, teams, projects, memory |
| `~/.crewly/teams/` | Team configurations |
| `<project>/.crewly/` | Project-local agent state |
| `config/roles/` | Role prompts and definitions |
| `config/templates/` | Team templates |
| `config/skills/agent/` | Agent bash skills (22 scripts) |

---

## Known Issues / Notes for Presenters

1. **Agent startup time** — First-time agent activation takes 15-30 seconds as the AI CLI initializes. Subsequent starts are faster.

2. **Claude Code auth** — Ensure `claude` CLI is authenticated before the demo. Run `claude` once manually if needed.

3. **Gemini CLI trust** — If using Gemini CLI agents, ensure the project folder is trusted in `~/.gemini/trustedFolders.json` to avoid interactive prompts blocking the agent.

4. **jq required** — agent skills parse JSON with jq. Install with `brew install jq` (macOS) or `sudo apt-get install -y jq` (Linux). tmux is not required.

5. **Port conflicts** — Default port is 8787. Use `crewly start -p 9090` if the port is taken.

6. **Mixed runtimes** — You can mix AI runtimes within a team (e.g., orchestrator on Claude Code, developer on Gemini CLI). Configure per-member in the dashboard.

---

*Last updated: 2026-03-08 | Crewly v1.2.3*
