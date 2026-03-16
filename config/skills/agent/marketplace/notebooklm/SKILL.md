---
name: NotebookLM
description: Interact with Google NotebookLM to create notebooks, add sources, and generate audio overviews. Requires NotebookLM MCP server to be configured.
version: 0.1.0
category: research
skillType: mcp-skill
assignableRoles:
  - researcher
  - developer
  - generalist
  - fullstack-dev
  - qa
  - qa-engineer
triggers:
  - notebooklm
  - notebook lm
  - create notebook
  - audio overview
  - research notebook
tags:
  - notebooklm
  - research
  - audio
  - notebook
  - google
  - mcp
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# NotebookLM Skill

Interact with Google NotebookLM to create research notebooks, add source materials, and generate audio overviews.

## Status: Planned

This skill requires a NotebookLM MCP server to be configured before use. It is not yet fully operational.

## Setup Requirements

1. Install and configure a NotebookLM MCP server (e.g., `notebooklm-mcp`)
2. Add the MCP server to your Claude Code configuration:
   ```json
   {
     "mcpServers": {
       "notebooklm": {
         "command": "npx",
         "args": ["notebooklm-mcp"],
         "env": {
           "GOOGLE_API_KEY": "your-api-key"
         }
       }
     }
   }
   ```
3. Verify the MCP server is running and accessible

## Usage Patterns

### Create a Notebook
Create a new NotebookLM notebook for a research topic:
```bash
bash execute.sh '{"action":"create","title":"Project Research"}'
```

### Add Sources
Add documents or URLs as sources to an existing notebook:
```bash
bash execute.sh '{"action":"add-source","notebookId":"...","sourceUrl":"https://example.com/doc"}'
```

### Generate Audio Overview
Generate an audio overview from notebook sources:
```bash
bash execute.sh '{"action":"audio-overview","notebookId":"..."}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | One of: `create`, `add-source`, `audio-overview`, `query` |
| `title` | For create | Title for the new notebook |
| `notebookId` | For non-create | ID of the target notebook |
| `sourceUrl` | For add-source | URL of the source to add |
| `query` | For query | Question to ask about notebook sources |
