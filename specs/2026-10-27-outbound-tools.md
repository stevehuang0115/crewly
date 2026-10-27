# Outbound tools in one list (crewly#894, item 2)

## Problem

Crewly holds an agent's outbound actions per surface: a Gmail send becomes a
draft (`gmail-send-gate.ts`, #999), a WhatsApp reply waits for 「发 W<n>」
(`whatsapp-draft-gate.ts`), a browser click that would post is held on a card
(`browser-outbound-guard.ts`), a Docs comment waits for 「发 C<n>」. Nothing
said which tools had a hold and which did not. Two consequences:

- a new `*-send` skill could ship with no hold and nobody would notice. The
  marketplace Gmail skill (`config/skills/agent/marketplace/gmail`) did
  exactly that: its `send` action called `messages.send` with a credential
  from Settings › Credentials, outside the `gmail-send` draft rule;
- the owner had no page that answers "what can an agent do on its own that
  reaches outside, and what stops it".

Issue #894 asked for "the list of tools that count as outbound/write in one
constant, with a test". This slice ships that list, makes it visible, and
closes the one gap it found.

## What ships

### The list — `backend/src/services/security/outbound-tools.ts`

`OUTBOUND_TOOLS`: every bundled skill whose effect leaves Crewly, with

| Field | Meaning |
|---|---|
| `skill` | the name agents call (`gmail-send`, `marketplace/gmail`) |
| `surface` | the outside system (`Gmail`, `Chrome (extension)`) |
| `reaches` | `owner` (their own account), `people`, `public` |
| `gate` | `draft` · `owner_word` · `owner_card` · `as_owner` · `none` |
| `note` | the hold in one sentence, as the code behaves today |

The gates (`OUTBOUND_GATES`):

- **draft** — nothing leaves; the tool stores a draft and the owner sends it
  (`gmail-send`, `marketplace/gmail`, `zoho-draft`, `whatsapp-draft`).
- **owner_word** — acts only after the owner's words name the item
  (`whatsapp-send` 「发 W<n>」, `docs-comment` 「发 C<n>」).
- **owner_card** — an irreversible step is held behind a decision card
  (`remote-browser` via `browser_action`; `publish-app` for public /
  microphone / template grants).
- **as_owner** — acts in the owner's own connected account at once; the use
  is in Settings › Activity as connector use (Docs, Sheets, Slides, Drive,
  Calendar, Canva, Microsoft To Do).
- **none** — nothing holds or records it. Today: `chrome-attach`,
  `browse-stealth`, `desktop-app-control`, `computer-use`, the marketplace
  `chrome-browser`, `playwright-chrome-browser`, `computer-use`, and
  `marketplace-publish` (reviewed by the marketplace before listing).

`NOT_OUTBOUND`: write-shaped skills that stay inside the account, each with
its reason — team chat (`reply*`, `slack-post`, `send-chat-response`), files
between agents or to the owner, work items, SOPs, norms, wiki pages,
`install-skill` (asks in chat for third-party skills), `canva-export`
(downloads), drafts written to files.

The list **describes**; the gates still live where they always did. A `none`
row is an honest gap, not a policy.

### The test — `outbound-tools.test.ts`

- every listed skill exists under `config/skills/agent` (as `core/<x>`, a
  top-level directory, or `<group>/<x>`); listed once; valid gate; a note;
- every `NOT_OUTBOUND` key exists and has a reason; nothing is on both lists;
- **every write-shaped bundled skill is classified**: a name matching
  `WRITE_SHAPED_SKILL` (`send`, `post`, `publish`, `upload`, `write`,
  `create`, `add`, `draft`, `export`, `update`, `install`, `delete`,
  `remove`, `share`, `reply`, `broadcast` as a whole word) must be in one of
  the two lists. A new `foo-send` skill fails the test until it is placed;
- mail and messaging sends are `draft` or `owner_word`, never `none`.

### The page — Settings › Security

`GET /api/security/approvals` gains `outbound: OutboundTool[]`. The tab shows
"Tools that reach outside" under the recent items: a summary line
(`N held until you act · N act as you · N with nothing in the way`) and one
row per tool — surface and skill, the note, and a label: **Draft only** /
**Your word** / **Card** (green), **Acts as you** (quiet), **Nothing in the
way** (attention). Six rows, then Show all. An older backend without the
field shows no section.

### The gap closed — marketplace Gmail `send` → draft (1.2.0)

`config/skills/agent/marketplace/gmail/execute.sh` `send` now calls
`drafts.create` with the same raw MIME; output is
`{success, draft: true, id (draft), messageId, threadId, note}`. SKILL.md,
instructions.md and skill.json say so; the mock server answers `/drafts`;
the live test asserts the draft ids and that the sent-message id is not
returned.

## Not covered

- MCP tools and raw CLIs an agent may run (`gh`, `curl`, a Python mail
  library): no list can name them. The browser and mail holds cover the
  surfaces agents are given; the shell is the owner's trust in the runtime.
- The attended / unattended distinction and per-tool widening (#894 item 1)
  — needs the owner's call on how widening should look.
- Enforcement from the list (a capability gate that consults
  `isOutboundTool`) — the list is the first step; a gate would need the run
  origin carried into the tool call.

## Files

- `backend/src/services/security/outbound-tools.ts` (+ test)
- `backend/src/services/security/approval-activity.service.ts` (+ test):
  `outbound` on the response
- `frontend/src/services/security.service.ts`: types
- `frontend/src/components/Settings/SecurityTab.tsx` (+ test): the section
- `frontend/FEATURE_MAP.md`: Settings row
- `config/skills/agent/marketplace/gmail/*`: send → draft, 1.2.0
