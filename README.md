# Crewly

[![GitHub stars](https://img.shields.io/github/stars/stevehuang0115/crewly.svg?style=social)](https://github.com/stevehuang0115/crewly)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/crewly.svg)](https://www.npmjs.com/package/crewly)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

**Website:** [crewlyai.com](https://crewlyai.com/)

Crewly is an open-source multi-agent orchestration platform that coordinates AI coding agents (Claude Code, Gemini CLI, Codex, OpenCode) to work together as a team. It provides a web dashboard for real-time monitoring, task management, and team coordination — all running locally on your machine.

## Features

- **Multi-agent teams** — Create teams with different roles (developer, QA, PM, orchestrator) and watch them collaborate
- **Multi-runtime support** — Use Claude Code, Gemini CLI, OpenAI Codex, or OpenCode — mix and match per agent
- **Real-time dashboard** — Monitor all agents through live terminal streams, task boards, and activity feeds
- **Skill system** — Agents coordinate through bash skills (report status, delegate tasks, manage memory)
- **Agent memory** — Persistent knowledge that agents build and share across sessions
- **Slack integration** — Optional two-way Slack bridge for team notifications
- **Local-first** — Everything runs on your machine. No data leaves your environment.

## Quick Start

```bash
# Initialize Crewly in your project (no global install needed)
npx crewly init

# Or install globally first
npm install -g crewly
crewly init

# Start the platform
crewly start
```

The `init` command walks you through provider selection, installs agent skills, and scaffolds a `.crewly/` directory. Then `crewly start` launches the backend server and opens the web dashboard. From there:

1. Create a **team** with agents assigned to roles
2. Assign the team to a **project** (any local code directory)
3. Watch agents work in real time through live terminal streams

## Prerequisites

- **Node.js** v20+ and **npm** v9+
- **At least one** AI coding CLI installed:

| Runtime | Install | Verify |
|---------|---------|--------|
| **Claude Code** (default) | `npm install -g @anthropic-ai/claude-code` | `claude --version` |
| **Gemini CLI** | `npm install -g @google/gemini-cli` | `gemini --version` |
| **Codex (OpenAI)** | `npm install -g @openai/codex` | `codex --version` |
| **OpenCode** | `npm install -g opencode-ai` | `opencode --version` |

**API keys:** Gemini CLI requires `GEMINI_API_KEY`. Codex requires an OpenAI API key. Claude Code authenticates through its own login flow. OpenCode uses whichever provider you connect via `opencode auth login` (or the `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` env vars Crewly already exports to agent sessions).

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Web Dashboard                      │
│              (React + xterm.js + WebSocket)          │
└───────────────────────┬─────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────┐
│                 Backend Server                       │
│           (Express + Socket.IO + PTY)                │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Services │ │ Scheduler│ │ Agent Registration │   │
│  │ (Storage,│ │ (Check-  │ │ (Heartbeat, Idle   │   │
│  │  Memory) │ │  ins)    │ │  Detection, Resume)│   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
└───────────────────────┬─────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
┌──────────────┐ ┌─────────────┐ ┌─────────────┐
│  Agent PTY   │ │  Agent PTY  │ │  Agent PTY  │
│  (Claude)    │ │  (Gemini)   │ │  (Codex)    │
│              │ │             │ │             │
│  Skills ◄────┤ │  Skills ◄───┤ │  Skills ◄───┤
│  Memory ◄────┤ │  Memory ◄───┤ │  Memory ◄───┤
└──────────────┘ └─────────────┘ └─────────────┘

Storage: ~/.crewly/ (global) + project/.crewly/ (per-project)
```

### How It Works

1. You create a **team** in the dashboard with agents assigned to roles
2. You assign the team to a **project** (any local code directory)
3. Crewly launches each agent as a CLI process in its own PTY session
4. Agents receive role-specific prompts and use **skills** (bash scripts) to communicate, report progress, and manage tasks
5. You monitor everything in real time through the web dashboard

## Agent Runtimes

| Runtime | Default Command | Notes |
|---------|-----------------|-------|
| **Claude Code** | `claude --dangerously-skip-permissions` | Default runtime |
| **Gemini CLI** | `gemini --yolo` | Requires `GEMINI_API_KEY` |
| **Codex (OpenAI)** | `codex -a never -s danger-full-access` | Requires OpenAI API key |
| **OpenCode** | `opencode --auto` | Any provider/model (`-m provider/model`); reads `AGENTS.md`; auth via `opencode auth login` |

You can change the default runtime or customize launch commands in **Settings**.

## CLI Commands

```bash
crewly init          # Interactive setup wizard (alias: onboard)
crewly start         # Start backend + open dashboard
crewly stop          # Stop all services and sessions
crewly status        # Show running services
crewly logs          # View aggregated logs
crewly upgrade       # Upgrade to latest version
crewly install [id]  # Install a skill from marketplace
crewly search [q]    # Search skill marketplace
crewly token         # Print the API token remote callers must send (--url: dashboard link)
```

## Configuration

Optional environment variables (`.env` file or shell):

```bash
GEMINI_API_KEY=your_key_here       # Required for Gemini CLI runtime

SLACK_BOT_TOKEN=xoxb-...           # Optional: self-hosted Slack app (see "Slack" below)
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
CREWLY_SLACK_SOURCE=cloud          # Optional: env | cloud (unset = Cloud wins when both exist)
CREWLY_SLACK_PRIMARY=1             # Optional: this instance handles DMs / unmapped channels

LOG_LEVEL=info                     # debug, info, warn, error
WEB_PORT=8787                      # Dashboard port (default: 8787)
CREWLY_BIND_HOST=0.0.0.0           # Interface to listen on (127.0.0.1 = this machine only)
CREWLY_API_TOKEN=...               # Pin the API token (otherwise generated at ~/.crewly/api-token)
```

### Slack

**One click (recommended).** Log in to Crewly Cloud (Settings → Cloud), open
Settings → Integrations → Slack and press **Connect Slack**. Slack asks you to
approve the Crewly app once; from then on every Crewly instance signed in to the
same Crewly account gets Slack automatically — team channels, and one real Slack
bot user per agent — with no tokens to copy. The instance pulls its config from
Cloud on boot and every 10 minutes (cached 0600 at
`~/.crewly/slack-cloud-config.json`); Slack events reach it through the Cloud
relay, so no Socket Mode connection is opened.

**The one manual step.** Slack only lets an app be created by an *App
Configuration Token* of a workspace member, and Crewly creates one Slack app per
agent so each agent is a real bot user (name in the member list, native `@`
mentions). Generate the token at api.slack.com/apps ("Your App Configuration
Tokens" → Generate) and paste it in Settings → Slack → Agent Identities. Cloud
keeps it refreshed. Each new agent then shows an install link you click once.

**Several instances, one workspace.** Every instance registers its teams,
channels and agents with Cloud (on boot, on team changes, every 5 min); Slack
traffic for a team channel goes to the instance running that team. Direct
messages to the Crewly bot and channels no team owns go to the **primary**
instance — the Settings toggle, or `CREWLY_SLACK_PRIMARY=1`.

**Self-hosted app.** The original path (your own Slack app, Socket Mode,
`SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` / `SLACK_SIGNING_SECRET` or the form under
Settings → Slack → Advanced) still works. `CREWLY_SLACK_SOURCE` picks the source:
`cloud` uses only the Cloud workspace, `env` uses only local tokens and never
asks Cloud, unset prefers Cloud when both exist (logged once at boot).

### Securing a server install

Crewly agents run as real shells on the host, and `POST /api/terminal/:session/write`
types into them — so the API must not be open to the network. The rules:

- **Loopback needs no token.** Requests from `127.0.0.1` / `::1` (local skills via
  `api_call`, the dashboard at `http://localhost:8787`) work with zero setup, as before.
- **Every other address must send the API token** on `/api/*`, Socket.IO and WebSocket
  connections: `Authorization: Bearer <token>`, `X-Crewly-Token: <token>`, a
  `crewly_token` cookie, or `?token=` for WebSocket handshakes. Missing/invalid → `401
  {"error":"unauthorized"}`. `X-Forwarded-For` is only honoured with `CREWLY_TRUST_PROXY=1`.
- **The token** is `CREWLY_API_TOKEN` if set, otherwise generated on first boot and stored
  (mode 0600) at `~/.crewly/api-token`. Print it with `crewly token`; `crewly token --url`
  prints a ready-to-open `http://<lan-ip>:8787/?token=…` link — the dashboard stores the
  token once and strips it from the address bar. Otherwise the dashboard asks for it the
  first time a request is refused.
- **Bind loopback only** with `CREWLY_BIND_HOST=127.0.0.1` and reach the box over SSH
  (`ssh -L 8787:localhost:8787 user@host`) or a VPN. Headless installs that bind every
  interface with neither variable set log a WARN at startup.
- **OKR approvals are owner-only.** `POST /api/missions/:id/approve|reject` require the
  token even from loopback and refuse agent sessions (`403 owner_approval_required`);
  agent PTYs never inherit `CREWLY_API_TOKEN`.
- `/health` and the static dashboard assets stay open. `POST /api/cloud/mobile-pair`
  is token-gated like everything else (it hands out the Cloud session).

## Docker

Run Crewly with a single command using Docker:

```bash
# 1. Clone the repo
git clone https://github.com/stevehuang0115/crewly.git
cd crewly

# 2. Add your API keys to .env
cp .env.example .env
# Edit .env and add ANTHROPIC_API_KEY, GEMINI_API_KEY, etc.

# 3. Start Crewly
docker compose up

# Dashboard available at http://localhost:8787
```

To mount a project directory for agents to work on, edit `docker-compose.yml` and uncomment the volume mount:

```yaml
volumes:
  - crewly_data:/home/node/.crewly
  - /path/to/your/project:/home/node/project  # <-- uncomment and edit
```

Build the image manually:

```bash
# On Apple Silicon, use --platform linux/amd64
docker build --platform linux/amd64 -t crewly .
docker run -p 8787:8787 --env-file .env crewly
```

## Development

```bash
# Clone the repository
git clone https://github.com/stevehuang0115/crewly.git
cd crewly

# Install dependencies
npm install

# Build all components (backend + frontend + CLI)
npm run build

# Start in dev mode (backend + frontend with hot-reload)
npm run dev

# Run tests
npm run test:unit
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed development guidelines.

## Demo

> Screenshots and demo video coming soon. Star the repo to get notified!

## Community

- **Bug reports & feature requests** — [GitHub Issues](https://github.com/stevehuang0115/crewly/issues)
- **Questions & discussions** — [GitHub Discussions](https://github.com/stevehuang0115/crewly/discussions)
- **Contributing** — See [CONTRIBUTING.md](CONTRIBUTING.md)

## License

[MIT](LICENSE)
