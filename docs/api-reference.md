# Crewly API Reference

> Complete HTTP API documentation for the Crewly backend server.

---

## Overview

### Base URL

```
http://localhost:8787/api
```

The default port is `8787`. Change it with `crewly start -p <port>` or the `WEB_PORT` environment variable.

### Authentication

The Crewly API runs locally and does not require authentication. All endpoints are accessible from `localhost`.

### Response Format

All responses follow this structure:

```json
{
  "success": true,
  "data": { ... },
  "message": "Optional status message"
}
```

Error responses:

```json
{
  "success": false,
  "error": "Error description",
  "message": "Human-readable message"
}
```

### Common HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 400 | Bad request (missing/invalid parameters) |
| 404 | Resource not found |
| 409 | Conflict (e.g., session already exists) |
| 429 | Rate limited (e.g., too many event subscriptions) |
| 500 | Internal server error |

### Health Check

```bash
curl http://localhost:8787/api/health
```

```json
{ "status": "ok" }
```

---

## Table of Contents

- [Teams API](#teams-api)
- [Projects API](#projects-api)
- [Sessions API](#sessions-api)
- [Terminal API](#terminal-api)
- [Chat API](#chat-api)
- [Orchestrator API](#orchestrator-api)
- [Memory API](#memory-api)
- [Knowledge API](#knowledge-api)
- [Task Management API](#task-management-api)
- [Messaging API](#messaging-api)
- [Scheduled Messages API](#scheduled-messages-api)
- [Event Bus API](#event-bus-api)
- [Quality Gates API](#quality-gates-api)
- [Skills API](#skills-api)
- [Settings API](#settings-api)
- [Marketplace API](#marketplace-api)
- [Slack API](#slack-api)
- [System API](#system-api)

---

## Teams API

Base path: `/api/teams`

### Create Team

```
POST /api/teams
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Team name |
| `description` | string | No | Team description |

**Response** (201):

```json
{
  "success": true,
  "data": {
    "id": "a1b2c3d4",
    "name": "Dev Team",
    "description": "Main development team",
    "members": [],
    "projectIds": [],
    "createdAt": "2026-02-21T10:00:00.000Z",
    "updatedAt": "2026-02-21T10:00:00.000Z"
  }
}
```

**curl:**

```bash
curl -X POST http://localhost:8787/api/teams \
  -H "Content-Type: application/json" \
  -d '{"name": "Dev Team", "description": "Main development team"}'
```

### List Teams

```
GET /api/teams
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "a1b2c3d4",
      "name": "Dev Team",
      "members": [...],
      "projectIds": ["proj-1"]
    }
  ]
}
```

### Get Team

```
GET /api/teams/:id
```

### Update Team

```
PUT /api/teams/:id
PATCH /api/teams/:id
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | No | Updated name |
| `description` | string | No | Updated description |

### Delete Team

```
DELETE /api/teams/:id
```

### Start Team

Starts all agents in the team.

```
POST /api/teams/:id/start
```

### Stop Team

Stops all agents in the team.

```
POST /api/teams/:id/stop
```

### Get Team Workload

```
GET /api/teams/:id/workload
```

### Get Team Activity Status

```
GET /api/teams/activity-status
```

---

### Team Members

#### Add Team Member

```
POST /api/teams/:id/members
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Member display name |
| `role` | string | Yes | Role: `developer`, `qa`, `architect`, `designer`, `product-manager`, `frontend-developer`, `backend-developer`, `fullstack-dev`, `generalist`, `qa-engineer`, `tpm`, `sales`, `support` |
| `runtimeType` | string | No | `claude-code` (default), `gemini-cli`, `codex-cli` |
| `systemPrompt` | string | No | Custom system prompt (overrides role default) |
| `skillOverrides` | string[] | No | Additional skills beyond role defaults |

**Response** (201):

```json
{
  "success": true,
  "data": {
    "id": "member-1",
    "name": "Sam",
    "role": "developer",
    "sessionName": "crewly_agent_abc123",
    "agentStatus": "inactive",
    "workingStatus": "idle",
    "runtimeType": "claude-code",
    "createdAt": "2026-02-21T10:00:00.000Z"
  }
}
```

**curl:**

```bash
curl -X POST http://localhost:8787/api/teams/a1b2c3d4/members \
  -H "Content-Type: application/json" \
  -d '{"name": "Sam", "role": "developer", "runtimeType": "claude-code"}'
```

#### Update Team Member

```
PUT /api/teams/:teamId/members/:memberId
```

#### Delete Team Member

```
DELETE /api/teams/:teamId/members/:memberId
```

#### Start Team Member

Launches the agent's CLI in a PTY session.

```
POST /api/teams/:teamId/members/:memberId/start
```

#### Stop Team Member

```
POST /api/teams/:teamId/members/:memberId/stop
```

#### Get Team Member Session

```
GET /api/teams/:teamId/members/:memberId/session
```

#### Update Team Member Runtime

```
PUT /api/teams/:teamId/members/:memberId/runtime
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `runtimeType` | string | Yes | `claude-code`, `gemini-cli`, or `codex-cli` |

#### Register Member Status

Used by agents to register themselves as active.

```
POST /api/teams/members/register
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `role` | string | Yes | Agent role |
| `sessionName` | string | Yes | Agent session name |
| `claudeSessionId` | string | No | Claude session ID for resume |
| `teamMemberId` | string | No | Team member ID |

#### Report Member Ready

```
POST /api/teams/members/ready
```

#### Generate Member Context

```
GET /api/teams/:teamId/members/:memberId/context
```

#### Inject Context Into Session

```
POST /api/teams/:teamId/members/:memberId/context/inject
```

#### Refresh Member Context

```
POST /api/teams/:teamId/members/:memberId/context/refresh
```

---

### Teams Backup

#### Get Backup Status

```
GET /api/teams/backup/status
```

#### Restore From Backup

```
POST /api/teams/backup/restore
```

---

## Projects API

Base path: `/api/projects`

### Create Project

```
POST /api/projects
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Project name |
| `path` | string | Yes | Absolute path to project directory |

**Response** (201):

```json
{
  "success": true,
  "data": {
    "id": "proj-1",
    "name": "My App",
    "path": "/Users/you/my-app",
    "teams": {},
    "status": "active",
    "createdAt": "2026-02-21T10:00:00.000Z"
  }
}
```

**curl:**

```bash
curl -X POST http://localhost:8787/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name": "My App", "path": "/Users/you/my-app"}'
```

### List Projects

```
GET /api/projects
```

### Get Project

```
GET /api/projects/:id
```

### Delete Project

```
DELETE /api/projects/:id
```

### Get Project Status

```
GET /api/projects/:id/status
```

### Get Project Completion

```
GET /api/projects/:id/completion
```

### Get Project Context

```
GET /api/projects/:id/context
```

### Get Project Stats

```
GET /api/projects/:id/stats
```

### Start Project

Starts all assigned teams for the project.

```
POST /api/projects/:id/start
```

### Stop Project

```
POST /api/projects/:id/stop
```

### Restart Project

```
POST /api/projects/:id/restart
```

### Assign Teams to Project

```
POST /api/projects/:id/teams
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `teamId` | string | Yes | Team ID to assign |
| `memberIds` | string[] | No | Specific members (all if omitted) |

### Unassign Team from Project

```
DELETE /api/projects/:id/teams
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `teamId` | string | Yes | Team ID to remove |

### Assign Task to Orchestrator

Send a task description to the orchestrator for the project.

```
POST /api/projects/:projectId/assign-task
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `task` | string | Yes | Task description |

**curl:**

```bash
curl -X POST http://localhost:8787/api/projects/proj-1/assign-task \
  -H "Content-Type: application/json" \
  -d '{"task": "Build a login page with email and password fields"}'
```

### Get Project Files

```
GET /api/projects/:id/files
```

### Get File Content

```
GET /api/projects/:projectId/file-content?filePath=/path/to/file
```

### Open Project in Finder

```
POST /api/projects/:id/open-finder
```

---

### Project Specs

#### Create Spec File

```
POST /api/projects/:id/specs
```

#### Get Spec File Content

```
GET /api/projects/:id/specs
```

---

### Project Tickets

#### Create Ticket

```
POST /api/projects/:projectId/tickets
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | Yes | Ticket title |
| `description` | string | Yes | Ticket description |
| `priority` | string | No | `low`, `medium` (default), `high`, `critical` |
| `assignedTo` | string | No | Member ID |
| `labels` | string[] | No | Labels/tags |

**Response** (201):

```json
{
  "success": true,
  "data": {
    "id": "ticket-1",
    "title": "Fix login bug",
    "description": "Users can't login with special characters",
    "status": "open",
    "priority": "high",
    "assignedTo": "member-1",
    "projectId": "proj-1"
  }
}
```

#### List Tickets

```
GET /api/projects/:projectId/tickets
```

#### Get Ticket

```
GET /api/projects/:projectId/tickets/:ticketId
```

#### Update Ticket

```
PUT /api/projects/:projectId/tickets/:ticketId
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | No | Updated title |
| `description` | string | No | Updated description |
| `status` | string | No | `open`, `in_progress`, `review`, `done`, `blocked` |
| `priority` | string | No | `low`, `medium`, `high`, `critical` |
| `assignedTo` | string | No | Member ID |

#### Delete Ticket

```
DELETE /api/projects/:projectId/tickets/:ticketId
```

#### Add Subtask

```
POST /api/projects/:projectId/tickets/:ticketId/subtasks
```

#### Toggle Subtask

```
PATCH /api/projects/:projectId/tickets/:ticketId/subtasks/:subtaskId/toggle
```

---

### Project Tasks

#### Get All Tasks

```
GET /api/projects/:projectId/tasks
```

#### Get Tasks by Status

```
GET /api/projects/:projectId/tasks/status/:status
```

Status values: `open`, `in_progress`, `review`, `done`, `blocked`

#### Get Tasks by Milestone

```
GET /api/projects/:projectId/tasks/milestone/:milestoneId
```

#### Get Milestones

```
GET /api/projects/:projectId/milestones
```

#### Get Project Tasks Status

```
GET /api/projects/:projectId/tasks-status
```

---

### Project Git

#### Get Git Status

```
GET /api/projects/:projectId/git/status
```

#### Commit Changes

```
POST /api/projects/:projectId/git/commit
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | Commit message |

#### Start Auto-Commit

```
POST /api/projects/:projectId/git/auto-commit/start
```

#### Stop Auto-Commit

```
POST /api/projects/:projectId/git/auto-commit/stop
```

#### Get Commit History

```
GET /api/projects/:projectId/git/history
```

#### Create Branch

```
POST /api/projects/:projectId/git/branch
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Branch name |

#### Create Pull Request

```
POST /api/projects/:projectId/git/pull-request
```

---

### Ticket Templates

#### Create Ticket Template

```
POST /api/projects/:projectId/ticket-templates/:templateName
```

#### Get Ticket Templates

```
GET /api/projects/:projectId/ticket-templates
```

#### Get Ticket Template

```
GET /api/projects/:projectId/ticket-templates/:templateName
```

---

## Sessions API

Base path: `/api/sessions`

### List Sessions

```
GET /api/sessions
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "sessionName": "crewly-orc",
      "pid": 12345,
      "cwd": "/Users/you/my-app",
      "status": "active"
    }
  ]
}
```

### Create Session

```
POST /api/sessions
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Session name |
| `cwd` | string | No | Working directory |
| `command` | string | No | Command to run |
| `args` | string[] | No | Command arguments |
| `env` | object | No | Environment variables |

**Errors:** 409 if session already exists.

### Get Session

```
GET /api/sessions/:name
```

### Kill Session

```
DELETE /api/sessions/:name
```

### Write to Session

Send data to a session's terminal.

```
POST /api/sessions/:name/write
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `data` | string | Yes | Text to send to the session |
| `mode` | string | No | `"message"` for two-step write (writes then sends Enter) |

**curl:**

```bash
curl -X POST http://localhost:8787/api/sessions/crewly-orc/write \
  -H "Content-Type: application/json" \
  -d '{"data": "Build a login page for the app"}'
```

### Get Session Output

```
GET /api/sessions/:name/output
```

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `lines` | number | 100 | Number of output lines to return |

**Response:**

```json
{
  "output": "Last 100 lines of terminal output..."
}
```

### Get Previous Sessions

Returns sessions from a previous Crewly run that can be resumed.

A team member's session is offered only under the session name the team config binds that member to. An entry left under a member's old name (for example after a rename) is never offered, and neither startup auto-restore nor a relaunch uses it.

```
GET /api/sessions/previous
```

**Response:**

```json
{
  "success": true,
  "data": {
    "sessions": [
      {
        "name": "crewly-orc",
        "role": "orchestrator",
        "runtimeType": "claude-code",
        "hasResumeId": true
      }
    ]
  }
}
```

### Dismiss Previous Sessions

```
POST /api/sessions/previous/dismiss
```

---

## Terminal API

Base path: `/api/terminal`

Lower-level terminal access with additional features like reliable delivery.

### List Terminal Sessions

```
GET /api/terminal/sessions
```

### Check Session Exists

```
GET /api/terminal/:sessionName/exists
```

### Get Terminal Output

```
GET /api/terminal/:sessionName/output
```

### Write to Session

```
POST /api/terminal/:sessionName/write
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `data` | string | Yes | Text to write |

### Deliver Message (Reliable)

Sends a message with retry logic for reliable delivery.

```
POST /api/terminal/:sessionName/deliver
```

### Send Terminal Input

```
POST /api/terminal/:sessionName/input
```

### Send Terminal Key

```
POST /api/terminal/:sessionName/key
```

### Kill Session

```
DELETE /api/terminal/:sessionName
```

---

## Chat API

Base path: `/api/chat`

### Send Message

Send a message from the user to the orchestrator.

```
POST /api/chat/send
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | Yes | Message text |
| `conversationId` | string | No | Target conversation (auto-created if omitted) |
| `metadata` | object | No | Additional metadata |
| `forwardToOrchestrator` | boolean | No | Whether to forward to orchestrator (default: true) |

**Response** (201):

```json
{
  "success": true,
  "data": {
    "message": {
      "id": "msg-1",
      "conversationId": "conv-1",
      "from": { "type": "user", "name": "You" },
      "content": "Build a login page",
      "contentType": "text",
      "status": "sent",
      "timestamp": "2026-02-21T10:00:00.000Z"
    },
    "conversation": { "id": "conv-1", "title": "Build a login page" },
    "orchestrator": { "forwarded": true }
  }
}
```

**curl:**

```bash
curl -X POST http://localhost:8787/api/chat/send \
  -H "Content-Type: application/json" \
  -d '{"content": "Build a login page with OAuth support"}'
```

### Get Messages

```
GET /api/chat/messages?conversationId=conv-1
```

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `conversationId` | string | Yes | Conversation to fetch |
| `senderType` | string | No | Filter: `user`, `orchestrator`, `agent`, `system` |
| `contentType` | string | No | Filter: `text`, `status`, `task`, `error`, `code` |
| `limit` | number | No | Max results |
| `offset` | number | No | Pagination offset |

### Get Single Message

```
GET /api/chat/messages/:conversationId/:messageId
```

### Agent Response

Used by agents (via bash skills) to send messages back to the chat.

```
POST /api/chat/agent-response
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | Yes | Response message |
| `senderName` | string | Yes | Agent session name |
| `senderType` | string | No | Default: `agent` |
| `conversationId` | string | No | Target conversation |

### Get Chat Statistics

```
GET /api/chat/statistics
```

---

### Conversations

#### List Conversations

```
GET /api/chat/conversations
```

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `includeArchived` | boolean | false | Include archived conversations |
| `search` | string | -- | Search by title |
| `limit` | number | -- | Max results |
| `offset` | number | -- | Pagination offset |

#### Get Current Conversation

Returns the most recent active conversation (creates one if none exists).

```
GET /api/chat/conversations/current
```

#### Get Conversation

```
GET /api/chat/conversations/:id
```

#### Create Conversation

```
POST /api/chat/conversations
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | No | Conversation title |

#### Update Conversation

```
PUT /api/chat/conversations/:id
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | Yes | New title |

#### Archive Conversation

```
PUT /api/chat/conversations/:id/archive
```

#### Unarchive Conversation

```
PUT /api/chat/conversations/:id/unarchive
```

#### Delete Conversation

```
DELETE /api/chat/conversations/:id
```

#### Clear Conversation

Removes all messages but keeps the conversation.

```
POST /api/chat/conversations/:id/clear
```

---

## Orchestrator API

Base path: `/api/orchestrator`

### Setup Orchestrator

Initializes the orchestrator agent session.

```
POST /api/orchestrator/setup
```

### Stop Orchestrator

```
POST /api/orchestrator/stop
```

### Get Orchestrator Health

```
GET /api/orchestrator/health
```

### Get Orchestrator Status

```
GET /api/orchestrator/status
```

### Get Orchestrator Commands

```
GET /api/orchestrator/commands
```

### Execute Orchestrator Command

```
POST /api/orchestrator/commands/execute
```

### Send Message to Orchestrator

```
POST /api/orchestrator/messages
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | Message to send |

### Send Enter Key to Orchestrator

```
POST /api/orchestrator/messages/enter
```

### Assign Task to Orchestrator

```
POST /api/orchestrator/projects/:projectId/tasks
```

### Update Orchestrator Runtime

```
PUT /api/orchestrator/runtime
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `runtimeType` | string | Yes | `claude-code`, `gemini-cli`, or `codex-cli` |

---

## Memory API

Base path: `/api/memory`

### Remember

Store knowledge in agent or project memory.

```
POST /api/memory/remember
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agentId` | string | Yes | Agent identifier |
| `content` | string | Yes | Knowledge to store |
| `category` | string | Yes | `fact`, `pattern`, `decision`, `gotcha`, `preference`, `relationship` |
| `scope` | string | Yes | `agent` or `project` |
| `projectPath` | string | No | Required if scope is `project` |
| `metadata` | object | No | Additional metadata |

**Response:**

```json
{
  "success": true,
  "entryId": "entry-abc123"
}
```

**curl:**

```bash
curl -X POST http://localhost:8787/api/memory/remember \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "dev-1",
    "content": "Use async/await for all database queries",
    "category": "pattern",
    "scope": "project",
    "projectPath": "/Users/you/my-app"
  }'
```

### Recall

Retrieve relevant knowledge from memory.

```
POST /api/memory/recall
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agentId` | string | Yes | Agent identifier |
| `context` | string | Yes | Search context/query |
| `scope` | string | No | `agent`, `project`, or `both` (default) |
| `limit` | number | No | Max results |
| `projectPath` | string | No | Project path for project-scoped recall |

**Response:**

```json
{
  "success": true,
  "data": {
    "agentMemories": ["[pattern] Use async/await for all DB queries"],
    "projectMemories": ["[decision] Chose PostgreSQL for primary database"],
    "combined": "### From Your Experience\n- ...\n### From Project\n- ...",
    "knowledgeDocuments": [...]
  }
}
```

**curl:**

```bash
curl -X POST http://localhost:8787/api/memory/recall \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "dev-1",
    "context": "database patterns and conventions",
    "projectPath": "/Users/you/my-app"
  }'
```

### Record Learning

Record a learning or discovery during work.

```
POST /api/memory/record-learning
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agentId` | string | Yes | Agent identifier |
| `agentRole` | string | Yes | Agent role |
| `projectPath` | string | Yes | Project path |
| `learning` | string | Yes | What was learned |
| `relatedTask` | string | No | Task ID |
| `relatedFiles` | string[] | No | Related file paths |

### Get My Context

Get combined context for an agent (memories, goals, focus, daily log, learnings, knowledge docs).

```
POST /api/memory/my-context
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agentId` | string | Yes | Agent identifier |
| `agentRole` | string | Yes | Agent role |
| `projectPath` | string | Yes | Project path |

**Response:**

```json
{
  "success": true,
  "data": {
    "memories": { "agentMemories": [...], "projectMemories": [...] },
    "goals": "...",
    "focus": "...",
    "dailyLog": "...",
    "learnings": [...],
    "knowledgeDocs": { "global": [...], "project": [...] }
  }
}
```

### Goals

#### Set/Append Goal

```
POST /api/memory/goals
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `goal` | string | Yes | Goal description |
| `projectPath` | string | Yes | Project path |
| `setBy` | string | No | Who set the goal |

#### Get Goals

```
GET /api/memory/goals?projectPath=/path/to/project
```

### Focus

#### Update Focus

```
POST /api/memory/focus
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `focus` | string | Yes | Current focus description |
| `projectPath` | string | Yes | Project path |
| `updatedBy` | string | No | Who updated |

#### Get Focus

```
GET /api/memory/focus?projectPath=/path/to/project
```

### Daily Log

#### Append to Daily Log

```
POST /api/memory/daily-log
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `projectPath` | string | Yes | Project path |
| `agentId` | string | Yes | Agent ID |
| `role` | string | Yes | Agent role |
| `entry` | string | Yes | Log entry text |

#### Get Daily Log

```
GET /api/memory/daily-log?projectPath=/path/to/project
```

### Record Success / Record Failure

```
POST /api/memory/record-success
POST /api/memory/record-failure
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `projectPath` | string | Yes | Project path |
| `description` | string | Yes | What succeeded/failed |
| `teamMemberId` | string | No | Member ID |
| `context` | string | No | Additional context |
| `role` | string | No | Agent role |

---

## Knowledge API

Base path: `/api/knowledge`

Manages markdown documents with YAML frontmatter stored in `~/.crewly/docs/` (global) or `<project>/.crewly/docs/` (project-scoped).

### Create Document

```
POST /api/knowledge/documents
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | Yes | Document title |
| `content` | string | Yes | Markdown content |
| `category` | string | No | Category name |
| `scope` | string | No | `global` (default) or `project` |
| `projectPath` | string | No | Required if scope is `project` |
| `tags` | string[] | No | Tags for search |
| `createdBy` | string | No | Author |

**Response** (201):

```json
{
  "success": true,
  "data": { "id": "doc-abc123" }
}
```

**curl:**

```bash
curl -X POST http://localhost:8787/api/knowledge/documents \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Deployment Process",
    "content": "# How to Deploy\n\n1. Run tests\n2. Build\n3. Push",
    "category": "Operations",
    "tags": ["deployment", "ci-cd"],
    "scope": "project",
    "projectPath": "/Users/you/my-app"
  }'
```

### List Documents

```
GET /api/knowledge/documents
```

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `scope` | string | `global` or `project` |
| `projectPath` | string | Project path (for project scope) |
| `category` | string | Filter by category |
| `search` | string | Search by title/content |

### Get Document

```
GET /api/knowledge/documents/:id?scope=global
```

### Update Document

```
PUT /api/knowledge/documents/:id
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | No | Updated title |
| `content` | string | No | Updated content |
| `category` | string | No | Updated category |
| `tags` | string[] | No | Updated tags |
| `scope` | string | Yes | `global` or `project` |
| `projectPath` | string | No | Required for project scope |
| `updatedBy` | string | No | Editor |

### Delete Document

```
DELETE /api/knowledge/documents/:id?scope=global
```

### List Categories

```
GET /api/knowledge/categories?scope=global
```

---

## Task Management API

Base path: `/api/task-management`

### Create Task

```
POST /api/task-management/create
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `projectPath` | string | Yes | Project directory |
| `title` | string | Yes | Task title |
| `description` | string | Yes | Task description |
| `priority` | string | No | `low`, `medium`, `high` |
| `targetRole` | string | No | Role best suited for this task |

### Assign Task

```
POST /api/task-management/assign
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `taskPath` | string | Yes | Path to task file |
| `sessionName` | string | Yes | Agent session to assign to |

### Complete Task

```
POST /api/task-management/complete
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `taskPath` | string | Yes | Path to task file |
| `sessionName` | string | Yes | Agent session name |

### Block Task

```
POST /api/task-management/block
```

### Unblock Task

```
POST /api/task-management/unblock
```

### Read Task

```
POST /api/task-management/read-task
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `taskPath` | string | Yes | Path to task file |

### Take Next Task

Agent takes the next available task matching its role.

```
POST /api/task-management/take-next
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionName` | string | Yes | Agent session name |
| `role` | string | Yes | Agent role |
| `projectPath` | string | Yes | Project path |

### Sync Task Status

```
POST /api/task-management/sync
```

### Get Team Progress

```
GET /api/task-management/team-progress
```

### Start Task Execution

```
POST /api/task-management/start-execution
```

### Recover Abandoned Tasks

```
POST /api/task-management/recover-abandoned-tasks
```

### Request Review

```
POST /api/task-management/request-review
```

### Create Tasks from Config

```
POST /api/tasks/create-from-config
```

### Get In-Progress Tasks

```
GET /api/in-progress-tasks
```

---

## Messaging API

Base path: `/api/messaging`

Message queue for orchestrator communication.

### Get Queue Status

```
GET /api/messaging/queue/status
```

**Response:**

```json
{
  "success": true,
  "data": {
    "pendingCount": 2,
    "isProcessing": true,
    "currentMessage": { ... },
    "totalProcessed": 45,
    "totalFailed": 1,
    "historyCount": 46
  }
}
```

### Get Pending Messages

```
GET /api/messaging/queue/messages
```

### Get Message History

```
GET /api/messaging/queue/history
```

### Get Message by ID

```
GET /api/messaging/queue/messages/:messageId
```

### Cancel Message

```
DELETE /api/messaging/queue/messages/:messageId
```

### Clear Queue

```
DELETE /api/messaging/queue
```

---

## Scheduled Messages API

Base path: `/api/scheduled-messages`

### Create Scheduled Message

```
POST /api/scheduled-messages
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Schedule name |
| `targetTeam` | string | Yes | Team ID |
| `targetProject` | string | No | Project ID |
| `message` | string | Yes | Message content |
| `delayAmount` | number | Yes | Interval amount |
| `delayUnit` | string | Yes | `seconds`, `minutes`, `hours` |
| `isRecurring` | boolean | No | Repeat on interval (default: false) |

**Response** (201):

```json
{
  "success": true,
  "data": {
    "id": "sched-1",
    "name": "Standup Check",
    "targetTeam": "team-1",
    "message": "What are you working on?",
    "delayAmount": 30,
    "delayUnit": "minutes",
    "isRecurring": true,
    "isActive": true,
    "nextRun": "2026-02-21T10:30:00.000Z"
  }
}
```

### List Scheduled Messages

```
GET /api/scheduled-messages
```

### Get Scheduled Message

```
GET /api/scheduled-messages/:id
```

### Update Scheduled Message

```
PUT /api/scheduled-messages/:id
```

### Delete Scheduled Message

```
DELETE /api/scheduled-messages/:id
```

### Toggle Scheduled Message

```
POST /api/scheduled-messages/:id/toggle
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `isActive` | boolean | No | Set active/inactive (toggles if omitted) |

### Run Scheduled Message Now

Triggers the message immediately regardless of schedule.

```
POST /api/scheduled-messages/:id/run
```

---

## Event Bus API

Base path: `/api/events`

Subscribe to real-time events about agent status changes.

### Create Subscription

```
POST /api/events/subscribe
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `eventType` | string/string[] | Yes | Event type(s): `agent:status_changed`, `agent:idle`, `agent:busy`, `agent:active`, `agent:inactive` |
| `filter` | object | No | Filter criteria |
| `filter.sessionName` | string | No | Filter by session |
| `filter.memberId` | string | No | Filter by member |
| `filter.teamId` | string | No | Filter by team |
| `subscriberSession` | string | Yes | Session to notify |
| `oneShot` | boolean | No | Auto-delete after first match |
| `ttlMinutes` | number | No | Auto-expire after N minutes |
| `messageTemplate` | string | No | Custom notification template |

**Response** (201):

```json
{
  "success": true,
  "data": {
    "id": "sub-1",
    "eventType": "agent:status_changed",
    "subscriberSession": "crewly-orc",
    "oneShot": false,
    "createdAt": "2026-02-21T10:00:00.000Z"
  }
}
```

**Errors:** 429 if subscription limit reached.

### Delete Subscription

```
DELETE /api/events/subscribe/:subscriptionId
```

### List Subscriptions

```
GET /api/events/subscriptions
```

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `subscriberSession` | string | Filter by subscriber session |

### Get Subscription

```
GET /api/events/subscriptions/:subscriptionId
```

---

## Quality Gates API

Base path: `/api/quality-gates`

### Check Quality Gates

Run quality gate checks against a project directory.

```
POST /api/quality-gates/check
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `projectPath` | string | Yes | Absolute path to project |

**Response:**

```json
{
  "success": true,
  "data": {
    "passed": true,
    "results": [
      {
        "name": "build",
        "passed": true,
        "required": true,
        "duration": 3200,
        "output": "Build successful",
        "exitCode": 0
      },
      {
        "name": "test",
        "passed": true,
        "required": true,
        "duration": 5100,
        "output": "All tests passed",
        "exitCode": 0
      }
    ]
  }
}
```

**curl:**

```bash
curl -X POST http://localhost:8787/api/quality-gates/check \
  -H "Content-Type: application/json" \
  -d '{"projectPath": "/Users/you/my-app"}'
```

---

## Skills API

Base path: `/api/skills`

### List Skills

```
GET /api/skills
```

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `category` | string | Filter by category |
| `type` | string | Filter by skill type |
| `enabled` | boolean | Filter enabled/disabled |

### Get Skill

```
GET /api/skills/:id
```

### Match Skills

Find skills matching a natural language query.

```
GET /api/skills/match?query=image+generation
```

### Get Skills by Role

```
GET /api/skills/role/:roleId
```

### Refresh Skills

Reload skills from the filesystem.

```
POST /api/skills/refresh
```

### Create Skill

```
POST /api/skills
```

### Update Skill

```
PUT /api/skills/:id
```

### Delete Skill

```
DELETE /api/skills/:id
```

### Execute Skill

```
POST /api/skills/:id/execute
```

### Enable/Disable Skill

```
PUT /api/skills/:id/enable
PUT /api/skills/:id/disable
```

### Check MCP Status

Check which MCP servers are installed.

```
GET /api/skills/mcp-status
```

---

## Settings API

Base path: `/api/settings`

### Get Settings

```
GET /api/settings
```

**Response:**

```json
{
  "success": true,
  "data": {
    "general": {
      "defaultRuntime": "claude-code",
      "autoStartOrchestrator": true,
      "checkInIntervalMinutes": 30,
      "maxConcurrentAgents": 10,
      "verboseLogging": false,
      "autoResumeOnRestart": true,
      "agentIdleTimeoutMinutes": 30,
      "runtimeCommands": {
        "claude-code": "claude --dangerously-skip-permissions",
        "gemini-cli": "gemini --yolo",
        "codex-cli": "codex --full-auto"
      }
    },
    "chat": {
      "showRawTerminalOutput": false,
      "enableTypingIndicator": true,
      "maxMessageHistory": 100,
      "autoScrollToBottom": true,
      "showTimestamps": true
    },
    "skills": {
      "skillsDirectory": "~/.crewly/skills",
      "enableBrowserAutomation": false,
      "enableScriptExecution": true,
      "skillExecutionTimeoutMs": 15000
    }
  }
}
```

### Update Settings

```
PUT /api/settings
```

Supports partial updates -- only send the fields you want to change.

### Validate Settings

```
POST /api/settings/validate
```

### Reset Settings

```
POST /api/settings/reset
POST /api/settings/reset/:section
```

### Export / Import Settings

```
POST /api/settings/export
POST /api/settings/import
```

---

### Role Management

Base path: `/api/settings/roles`

#### List Roles

```
GET /api/settings/roles
```

#### Get Role

```
GET /api/settings/roles/:id
```

Returns role with full prompt content.

#### Get Default Role

```
GET /api/settings/roles/default
```

#### Create Role

```
POST /api/settings/roles
```

#### Update Role

```
PUT /api/settings/roles/:id
```

#### Delete Role

Only user-created roles can be deleted.

```
DELETE /api/settings/roles/:id
```

#### Set Default Role

```
POST /api/settings/roles/:id/set-default
```

#### Reset Built-in Role

```
POST /api/settings/roles/:id/reset
```

#### Check Role Override

```
GET /api/settings/roles/:id/has-override
```

#### Assign/Remove Skills from Role

```
POST /api/settings/roles/:id/skills
DELETE /api/settings/roles/:id/skills
```

#### Refresh Roles

Reload roles from disk.

```
POST /api/settings/roles/refresh
```

---

## Marketplace API

Base path: `/api/marketplace`

### List Items

```
GET /api/marketplace
```

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `type` | string | Filter: `skill`, `model`, `role` |
| `search` | string | Search by name/description |

### Get Item

```
GET /api/marketplace/:id
```

### List Installed Items

```
GET /api/marketplace/installed
```

### List Available Updates

```
GET /api/marketplace/updates
```

### Install Item

```
POST /api/marketplace/:id/install
```

### Uninstall Item

```
POST /api/marketplace/:id/uninstall
```

### Update Item

```
POST /api/marketplace/:id/update
```

### Refresh Registry

Force refresh the marketplace registry cache.

```
POST /api/marketplace/refresh
```

---

## Slack API

Base path: `/api/slack`

### Get Slack Status

```
GET /api/slack/status
```

### Connect to Slack

```
POST /api/slack/connect
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `botToken` | string | Yes | `xoxb-...` bot token |
| `appToken` | string | Yes | `xapp-...` app-level token |
| `signingSecret` | string | Yes | Signing secret |

### Disconnect from Slack

```
POST /api/slack/disconnect
```

### Send Slack Message

```
POST /api/slack/send
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel` | string | Yes | Channel ID |
| `text` | string | Yes | Message text |
| `threadTs` | string | No | Thread timestamp for replies |

### Send Notification

```
POST /api/slack/notify
```

### Upload Image to Slack

```
POST /api/slack/upload-image
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `filePath` | string | Yes | Local path to image file |
| `channel` | string | Yes | Channel ID |
| `title` | string | No | Image title |

### Upload File to Slack

```
POST /api/slack/upload-file
```

### Get Slack Config

```
GET /api/slack/config
```

Returns sanitized Slack configuration (tokens are masked).

---

### Slack Threads

Base path: `/api/slack-threads`

#### Register Agent Thread

```
POST /api/slack-threads/register-agent
```

---

## System API

Base path: `/api/system`

### Get System Health

```
GET /api/system/health
```

### Get System Metrics

```
GET /api/system/metrics
```

### Get System Configuration

```
GET /api/system/config
```

### Update System Configuration

```
PATCH /api/system/config
```

### Create Default Config

```
POST /api/system/config/default
```

### Get System Logs

```
GET /api/system/logs
```

### Get Alerts

```
GET /api/system/alerts
```

### Update Alert Condition

```
PATCH /api/system/alerts/:conditionId
```

### Restart Server

```
POST /api/system/restart
```

### Get Local IP Address

Returns the machine's local IP (useful for mobile access / QR codes).

```
GET /api/system/local-ip
```

### Query SOPs

Search Standard Operating Procedures.

```
POST /api/system/sops/query
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | Yes | Search query |

### Get Claude Status

```
GET /api/system/claude-status
```

---

### Error Tracking

Base path: `/api/errors`

#### Track Error

```
POST /api/errors
```

#### Get Errors

```
GET /api/errors
```

#### Get Error

```
GET /api/errors/:errorId
```

#### Get Error Stats

```
GET /api/errors/stats
```

#### Clear Errors

```
DELETE /api/errors
```

---

### Scheduler

Base path: `/api/schedule`

#### Schedule Check

```
POST /api/schedule
```

#### Get Scheduled Checks

```
GET /api/schedule
```

#### Cancel Scheduled Check

```
DELETE /api/schedule/:id
```

#### Restore Scheduled Checks

```
POST /api/schedule/restore
```

---

### Assignments

Base path: `/api/assignments`

#### Get Assignments

```
GET /api/assignments
```

#### Update Assignment

```
PATCH /api/assignments/:id
```

---

### Message Delivery Logs

Base path: `/api/message-delivery-logs`

#### Get Delivery Logs

```
GET /api/message-delivery-logs
```

#### Clear Delivery Logs

```
DELETE /api/message-delivery-logs
```

---

### Self-Improvement

Base path: `/api/self-improvement`

#### Create Improvement Plan

```
POST /api/self-improvement/plan
```

#### Execute Improvement Plan

```
POST /api/self-improvement/execute
```

#### Get Improvement Status

```
GET /api/self-improvement/status
```

#### Cancel Improvement

```
POST /api/self-improvement/cancel
```

#### Rollback Improvement

```
POST /api/self-improvement/rollback
```

#### Get Improvement History

```
GET /api/self-improvement/history
```

---

### Factory (Claude Instances)

Base path: `/api/factory`

#### Get Claude Instances

```
GET /api/factory/claude-instances
```

#### Get Usage Stats

```
GET /api/factory/usage
```

#### SSE Stream

Server-Sent Events for real-time Claude instance updates.

```
GET /api/factory/sse
```

#### Health Check

```
GET /api/factory/health
```

---

### Monitoring

Base path: `/api/monitoring`

Currently reserved for future monitoring endpoints.

---

### Browse Directories

```
GET /api/directories
```

Used by the dashboard for folder selection dialogs.

---

### Config Files

```
GET /api/config/:fileName
```

Returns the content of a config file by name.

---

## WebSocket Events

Crewly uses Socket.IO for real-time updates. Connect to `ws://localhost:8787`.

### Key Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `terminal:output` | Server → Client | Live terminal output from agent sessions |
| `agent:status` | Server → Client | Agent status changes |
| `team:update` | Server → Client | Team data updates |
| `project:update` | Server → Client | Project data updates |
| `chat:message` | Server → Client | New chat messages |
| `task:update` | Server → Client | Task status changes |

---

## Data Types Reference

### AgentStatus

```typescript
type AgentStatus = 'inactive' | 'starting' | 'started' | 'active' | 'suspended' | 'activating';
```

### WorkingStatus

```typescript
type WorkingStatus = 'idle' | 'in_progress';
```

### RuntimeType

```typescript
type RuntimeType = 'claude-code' | 'gemini-cli' | 'codex-cli';
```

### TicketStatus

```typescript
type TicketStatus = 'open' | 'in_progress' | 'review' | 'done' | 'blocked';
```

### TicketPriority

```typescript
type TicketPriority = 'low' | 'medium' | 'high' | 'critical';
```

### MemoryCategory

```typescript
type MemoryCategory = 'fact' | 'pattern' | 'decision' | 'gotcha' | 'preference' | 'relationship';
```

### KnowledgeScope

```typescript
type KnowledgeScope = 'global' | 'project';
```

### EventType

```typescript
type EventType = 'agent:status_changed' | 'agent:idle' | 'agent:busy' | 'agent:active' | 'agent:inactive';
```

### Role

```typescript
type Role = 'orchestrator' | 'developer' | 'frontend-developer' | 'backend-developer' |
  'fullstack-dev' | 'architect' | 'qa' | 'qa-engineer' | 'designer' |
  'product-manager' | 'generalist' | 'tpm' | 'sales' | 'support';
```

---

*Last updated: 2026-02-21 | Crewly v1.0.7 | Verified against backend source code*
