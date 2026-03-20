# Getting Started with Crewly

> Set up your first AI agent team in under 5 minutes.

Crewly is an open-source platform that coordinates AI coding agents (Claude Code, Gemini CLI, Codex) to work together as a team. You get a real-time web dashboard to watch agents work, assign tasks, and manage projects -- all running locally on your machine.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick Start (5 Minutes)](#quick-start-5-minutes)
- [Core Concepts](#core-concepts)
- [Common Tasks](#common-tasks)
- [Configuration](#configuration)
- [CLI Reference](#cli-reference)
- [Troubleshooting](#troubleshooting)
- [Next Steps](#next-steps)

---

## Prerequisites

### Required

- **Node.js v20+** and **npm v9+**
  ```bash
  # Check your versions
  node --version   # Should print v20.x or higher
  npm --version    # Should print 9.x or higher
  ```

- **At least one AI coding CLI** installed and authenticated:

  | Runtime | Install Command | Verify | Auth |
  |---------|----------------|--------|------|
  | **Claude Code** (recommended) | `npm install -g @anthropic-ai/claude-code` | `claude --version` | Run `claude` once to authenticate |
  | **Gemini CLI** | `npm install -g @google/gemini-cli` | `gemini --version` | Set `GEMINI_API_KEY` env variable |
  | **Codex (OpenAI)** | `npm install -g @openai/codex` | `codex --version` | Set OpenAI API key |

  > Claude Code is the default runtime. If you don't have a preference, start with Claude Code.

### Optional

- **tmux** -- Crewly uses tmux for agent session management. It's usually pre-installed on macOS and Linux. Check with `tmux -V`.
- **Slack app** -- For two-way Slack notifications. See [Configuration](#configuration) for setup.

---

## Installation

### Option A: Try instantly (no global install)

```bash
npx crewly onboard
```

This downloads Crewly temporarily and runs the setup wizard.

### Option B: Install globally (recommended)

```bash
npm install -g crewly
crewly onboard
```

The `onboard` command walks you through a 4-step setup:

1. **Choose your AI provider** -- Claude Code, Gemini CLI, or both
2. **Install tools** -- Crewly checks if your chosen CLI is installed and offers to install it
3. **Install agent skills** -- Downloads the skill pack that agents use to communicate, report status, and manage tasks
4. **Done** -- You're ready to start

```
$ crewly onboard

Welcome to Crewly! Let's get you set up.

Step 1/4: Which AI coding assistant do you use?
  > Claude Code (Anthropic)
    Gemini CLI (Google)
    Both
    Skip

Step 2/4: Installing tools...
  ✓ Claude Code v1.0.x detected

Step 3/4: Installing agent skills...
  [1/22] accept-task
  [2/22] check-quality-gates
  ...
  ✓ All skills installed

Step 4/4: You're all set!
  Next steps:
    cd your-project/
    crewly start
```

---

## Quick Start (5 Minutes)

### Step 1: Start Crewly

Navigate to any project directory and start Crewly:

```bash
cd ~/my-project
crewly start
```

This does three things:
1. Starts the backend server on port `8787`
2. Sets up the orchestrator agent in the background
3. Opens the web dashboard in your browser

```
$ crewly start

🚀 Starting Crewly...
✓ Backend server running on port 8787
✓ Orchestrator session initialized
✓ Dashboard: http://localhost:8787

Press Ctrl+C to stop.
```

> Use `crewly start --no-browser` to skip opening the browser automatically.

### Step 2: Create a Team

In the dashboard, click **Teams** in the sidebar, then **Create Team**.

<!-- TODO: Screenshot of Teams page with Create Team button -->

Fill in:
- **Team name**: e.g., "My Dev Team"
- **Description**: optional

Then **Add Members** to the team:

| Field | Example | Description |
|-------|---------|-------------|
| Name | "Sam" | Display name for this agent |
| Role | "developer" | Determines the agent's prompt and behavior |

Available roles include: `developer`, `qa`, `frontend-developer`, `backend-developer`, `fullstack-dev`, `architect`, `designer`, `product-manager`, `generalist`, and more.

<!-- TODO: Screenshot of Add Member modal -->

### Step 3: Create a Project

Click **Projects** in the sidebar, then **Create Project**.

- **Project name**: e.g., "My App"
- **Path**: the absolute path to your project directory (e.g., `/Users/you/my-project`)

### Step 4: Assign Team to Project

Open your project and assign your team. This connects agents to the codebase they'll work on.

<!-- TODO: Screenshot of project detail with team assignment -->

### Step 5: Start Your Agents

Once a team is assigned to a project, click **Start** on a team member. Crewly launches the agent's CLI in its own terminal session.

You can now:
- **Watch the live terminal** -- see exactly what each agent is doing in real time
- **Send input** -- type into an agent's terminal to guide it
- **View the activity feed** -- see status updates, task completions, and agent communications

<!-- TODO: Screenshot of live terminal streaming -->

That's it! Your agents are working. The orchestrator automatically coordinates tasks, and agents use their skills to report progress and collaborate.

---

## Core Concepts

### Teams

A **team** is a group of AI agents that work together. Each team has:
- A name and description
- One or more **members** (agents with assigned roles)
- An optional **orchestrator** that coordinates the team

Teams are stored in `~/.crewly/teams.json`.

### Agents

An **agent** is an AI coding assistant running in its own terminal session. Each agent has:
- A **role** (developer, QA, PM, etc.) that shapes its behavior via a system prompt
- A **runtime** (Claude Code, Gemini CLI, or Codex) that determines which AI model powers it
- A **session** (a tmux terminal) where it executes commands
- Access to **skills** (bash scripts for communication and coordination)
- **Memory** that persists across sessions

Agent statuses: `inactive` → `starting` → `active` → `suspended`

### Roles

A **role** defines what an agent does. Roles come with pre-written system prompts that instruct the agent on its responsibilities. Crewly includes 14 built-in roles:

| Role | Purpose |
|------|---------|
| `developer` | General software development |
| `frontend-developer` | Frontend/UI development |
| `backend-developer` | Backend/API development |
| `fullstack-dev` | End-to-end development |
| `architect` | System architecture and technical design |
| `qa` / `qa-engineer` | Quality assurance and testing |
| `designer` | Design work |
| `product-manager` | Product management and planning |
| `generalist` | General-purpose tasks |
| `orchestrator` | Coordinates other agents (auto-created) |
| `tpm` | Technical program management |
| `sales` | Sales and customer engagement |
| `support` | Customer support |

Role prompts live in `config/roles/<role>/prompt.md`.

### Skills

**Skills** are bash scripts that agents call to perform actions. They're the communication backbone of Crewly. Examples:

| Skill | What It Does |
|-------|-------------|
| `report-status` | Tell the orchestrator "I'm done" or "I'm blocked" |
| `accept-task` | Accept a task assignment |
| `complete-task` | Mark a task as finished |
| `recall` | Search agent memory for relevant context |
| `remember` | Store knowledge for future sessions |
| `get-team-status` | Check what other agents are working on |
| `check-quality-gates` | Run build/test/lint checks before completing |
| `query-knowledge` | Search the knowledge base for docs and SOPs |
| `heartbeat` | Send a "still alive" signal to the backend |

Skills live in `config/skills/agent/`. Each skill has an `execute.sh` script, `skill.json` metadata, and `instructions.md` documentation.

Install skills with:
```bash
crewly install --all
```

### Projects

A **project** maps to a directory on your machine. When you assign a team to a project, agents get context about the codebase and work within that directory. Projects track:
- Tasks (open, in-progress, done, blocked)
- Progress metrics
- Associated team

Project data lives in `~/.crewly/projects.json`.

### Orchestrator

The **orchestrator** is a special agent (`crewly-orc`) that automatically starts when you run `crewly start`. It:
- Coordinates work across team members
- Delegates tasks to the right agent based on role and availability
- Monitors agent health via heartbeats
- Manages the task queue

You can chat with the orchestrator directly through the **Chat** page in the dashboard.

### Memory

Agents have persistent memory that survives across sessions:

- **Agent memory** -- personal knowledge specific to one agent (stored with `remember` skill)
- **Project memory** -- shared knowledge available to all agents on a project (stored with `scope: project`)
- **Knowledge base** -- markdown documents with YAML frontmatter, searchable via `query-knowledge`

Memory is stored in the filesystem:
- Global: `~/.crewly/`
- Per-project: `<project-path>/.crewly/`

---

## Common Tasks

### Create a Team via Dashboard

1. Open `http://localhost:8787`
2. Navigate to **Teams** in the sidebar
3. Click **Create Team**
4. Add a name and description
5. Click **Add Member** for each agent:
   - Set a name, choose a role, select a runtime
6. Save the team

### Assign a Task

Tasks can be assigned through the dashboard:
1. Go to **Projects** → select your project
2. Create a new task with a title and description
3. Assign it to a team member
4. The agent picks it up and starts working

Or chat with the orchestrator:
1. Go to **Chat**
2. Type a request like: "Build a login page for the app"
3. The orchestrator delegates to the appropriate agent

### Check Agent Status

**From the dashboard**:
- The **Teams** page shows each agent's status (active, idle, working)
- Click an agent to see their live terminal output

**From the CLI**:
```bash
crewly status
```
```
Crewly Status:
  Backend: running (port 8787)
  Sessions: 3 active
    crewly-orc (orchestrator) - active
    dev-1 (developer) - active
    qa-1 (qa) - active
```

### View Logs

```bash
# View recent logs
crewly logs

# Follow logs in real time
crewly logs -f

# Show more lines
crewly logs -n 200
```

### Stop Crewly

```bash
# Graceful shutdown
crewly stop

# Force kill if something is stuck
crewly stop --force
```

### Install Marketplace Skills

```bash
# Search for skills
crewly search image

# Install a specific skill
crewly install skill-nano-banana

# Install all agent skills
crewly install --all
```

---

## Configuration

### Environment Variables

Create a `.env` file in your project root or set these in your shell:

```bash
# AI Provider Keys
GEMINI_API_KEY=your_key_here           # Required for Gemini CLI runtime

# Slack Integration (optional)
# Import config/slack-app-manifest.json into your Slack app at api.slack.com
# Required bot scopes: chat:write, files:read, files:write, app_mentions:read,
#   channels:history, groups:history, im:history, mpim:history, users:read
# Note: files:read is required for downloading files shared by users (#216)
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...

# Server Settings
WEB_PORT=8787                          # Dashboard port (default: 8787)
LOG_LEVEL=info                         # debug, info, warn, error
```

### Global Config

Crewly stores global configuration in `~/.crewly/`:

```
~/.crewly/
├── config.env          # Port, intervals, global settings
├── teams.json          # Team definitions
├── projects.json       # Project definitions
├── docs/               # Knowledge base documents
├── skills/             # Installed marketplace skills
└── memory/             # Agent memory storage
```

### Per-Project Config

Each project can have its own `.crewly/` directory:

```
my-project/
├── .crewly/
│   ├── docs/           # Project-specific knowledge docs
│   └── memory/         # Project-scoped agent memories
├── src/
└── package.json
```

### Agent Runtimes

You can configure which runtime each agent uses in the dashboard Settings, or when adding team members:

| Runtime | Default Command | Notes |
|---------|----------------|-------|
| Claude Code | `claude --dangerously-skip-permissions` | Default. No API key needed (uses Claude auth). |
| Gemini CLI | `gemini --yolo` | Requires `GEMINI_API_KEY` |
| Codex (OpenAI) | `codex --full-auto` | Requires OpenAI API key |

You can mix runtimes within a team -- e.g., orchestrator on Claude, developer on Gemini.

---

## CLI Reference

```
Usage: crewly <command> [options]

Commands:
  onboard              Interactive setup wizard (run this first)
  start                Start backend server and open dashboard
  stop                 Stop all services and agent sessions
  status               Show running services and agent sessions
  logs                 View aggregated logs from all services
  upgrade              Upgrade Crewly to the latest version
  search [query]       Search the skill marketplace
  install [id]         Install a skill from the marketplace

Start Options:
  -p, --port <port>    Dashboard port (default: 8787)
  --no-browser         Don't open browser automatically
  --auto-upgrade       Auto-upgrade before starting

Stop Options:
  --force              Force kill all processes

Status Options:
  --verbose            Show detailed process info

Logs Options:
  -f, --follow         Follow log output in real time
  -n, --lines <num>    Number of lines to show (default: 50)

Search Options:
  --type <type>        Filter by type: skill, model, role

Install Options:
  --all                Install all available agent skills

Examples:
  crewly onboard                  # First-time setup
  crewly start                    # Start with defaults
  crewly start -p 3000            # Use custom port
  crewly start --no-browser       # Start without opening browser
  crewly status --verbose         # Detailed status
  crewly logs -f                  # Tail logs
  crewly install --all            # Install all skills
  crewly search "image"           # Find image-related skills
```

---

## Troubleshooting

### "Port 8787 is already in use"

Another process is using the default port. Either stop it or use a different port:

```bash
# Option 1: Stop the existing Crewly instance
crewly stop

# Option 2: Use a different port
crewly start -p 9090
```

### "No agent skills installed"

You'll see a warning on startup if skills aren't installed. Fix it:

```bash
crewly install --all
```

Or re-run the setup wizard:

```bash
crewly onboard
```

### Agents Show as "Inactive"

Agents need to be started manually after creating a team. In the dashboard:
1. Go to **Teams**
2. Click on your team
3. Click **Start** next to each agent

If an agent keeps going inactive, check:
- Is the AI CLI installed? (`claude --version`, `gemini --version`)
- Is the API key set? (check `.env` or environment variables)
- Check the logs: `crewly logs -f`

### Dashboard Won't Open

```bash
# Check if the server is actually running
crewly status

# If running but browser didn't open, go manually to:
# http://localhost:8787

# If not running, check for port conflicts
crewly start --no-browser
```

### "tmux not found"

Install tmux:

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt install tmux

# Fedora
sudo dnf install tmux
```

### Agent Appears Stuck

If an agent seems unresponsive:

1. Check the live terminal in the dashboard -- the agent may be waiting for input
2. Try sending input through the terminal interface
3. Crewly has auto-continuation built in -- it detects stuck states and auto-resumes with configurable max iterations
4. As a last resort, stop and restart the agent from the dashboard

### Build Errors on Installation

If `npm install -g crewly` fails with native module errors (usually `node-pty`):

```bash
# macOS: Install Xcode command line tools
xcode-select --install

# Linux: Install build essentials
sudo apt install build-essential python3

# Then retry
npm install -g crewly
```

### Cannot Connect to Agent Runtime

```bash
# Verify Claude Code is authenticated
claude --version
claude  # Run once to complete login flow

# Verify Gemini CLI has API key
echo $GEMINI_API_KEY  # Should print your key
gemini --version
```

---

## Next Steps

Now that you're up and running:

- **Explore the Dashboard** -- Try all the views: Teams, Projects, Chat, Knowledge, Marketplace
- **Chat with the Orchestrator** -- Use the Chat page to give high-level instructions. The orchestrator will delegate to your agents.
- **Add Knowledge** -- Use the Knowledge page to add docs, SOPs, and architecture notes that agents can reference
- **Install More Skills** -- Browse the marketplace with `crewly search` and install specialized skills
- **Connect Slack** -- Set up the Slack integration for team notifications (see [Configuration](#configuration))
- **Read the [Contributing Guide](../CONTRIBUTING.md)** -- If you want to contribute to Crewly or build custom skills

### Getting Help

- **GitHub Issues** -- [github.com/stevehuang0115/crewly/issues](https://github.com/stevehuang0115/crewly/issues)
- **GitHub Discussions** -- [github.com/stevehuang0115/crewly/discussions](https://github.com/stevehuang0115/crewly/discussions)
- **Website** -- [crewlyai.com](https://crewlyai.com)

---

*Last updated: 2026-02-21 | Crewly v1.0.7*
