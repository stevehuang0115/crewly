/**
 * Outbound tools — the one list of bundled skills whose effect leaves Crewly
 * (a message reaches a person, something changes in an outside account, a
 * page is acted on), with how each one is held (crewly#894).
 *
 * Why one list: the holds are built per surface (Gmail drafts, WhatsApp
 * 「发 W<n>」, browser cards, …) and nothing said which tools had one. A new
 * `*-send` skill could ship with no hold and nobody would see it. This module
 * names every outbound tool and its gate; its test fails when a write-shaped
 * skill is added without a classification, and Settings › Security shows the
 * list to the owner (`GET /api/security/approvals` → `outbound`).
 *
 * It describes; it does not enforce. The gates live where they always did
 * (`gmail-send-gate.ts`, `whatsapp-draft-gate.ts`, `browser-outbound-guard.ts`,
 * the decision cards). A `none` gate here is an honest gap, not a policy.
 *
 * Not outbound (and so not listed): team chat and files between agents, the
 * owner's own dashboard and DM, work items, wiki and memory writes. They stay
 * inside the account; the reply audience check (#969) covers private data
 * in chat.
 *
 * @module services/security/outbound-tools
 */

/** How an outbound tool is held before its effect leaves Crewly. */
export const OUTBOUND_GATES = {
  /** Nothing leaves: the tool stores a draft in the outside system and the owner sends it */
  DRAFT: 'draft',
  /** Acts only after the owner's own words name the item (「发 W12」, 「发 C3」) */
  OWNER_WORD: 'owner_word',
  /** An irreversible step is held behind a decision card; reading and typing are not */
  OWNER_CARD: 'owner_card',
  /** Acts in the owner's own connected account at once; the use is in Settings › Activity */
  AS_OWNER: 'as_owner',
  /** Nothing holds or records it */
  NONE: 'none',
} as const;

/** One of {@link OUTBOUND_GATES}. */
export type OutboundGate = (typeof OUTBOUND_GATES)[keyof typeof OUTBOUND_GATES];

/** Who the effect reaches. */
export type OutboundReach = 'owner' | 'people' | 'public';

/** One outbound tool. */
export interface OutboundTool {
  /** Skill name as the agent calls it (`gmail-send`, `marketplace/gmail`) */
  skill: string;
  /** Outside system it acts on */
  surface: string;
  /** Who the effect can reach */
  reaches: OutboundReach;
  /** How it is held */
  gate: OutboundGate;
  /** The hold in one sentence, for the owner */
  note: string;
}

/**
 * Every bundled skill whose effect leaves Crewly, in display order.
 *
 * Keep each `note` to what the code does today. When a hold is added or
 * removed in its service, change the row in the same PR.
 */
export const OUTBOUND_TOOLS: readonly OutboundTool[] = [
  // Mail
  {
    skill: 'gmail-send',
    surface: 'Gmail',
    reaches: 'people',
    gate: OUTBOUND_GATES.DRAFT,
    note: 'Leaves a draft in the owner\'s Gmail; only the owner sends it, from the Send card or Gmail itself (#999).',
  },
  {
    skill: 'marketplace/gmail',
    surface: 'Gmail',
    reaches: 'people',
    gate: OUTBOUND_GATES.DRAFT,
    note: 'The `send` action of the marketplace Gmail skill saves a draft in the bound account; it never sends (since 1.2.0).',
  },
  {
    skill: 'zoho-draft',
    surface: 'Zoho Mail',
    reaches: 'people',
    gate: OUTBOUND_GATES.DRAFT,
    note: 'Saves a draft in the Zoho mailbox; agents have no send tool for Zoho.',
  },
  // WhatsApp
  {
    skill: 'whatsapp-draft',
    surface: 'WhatsApp',
    reaches: 'people',
    gate: OUTBOUND_GATES.DRAFT,
    note: 'Saves a reply as W<n> in the inbox; nothing is sent.',
  },
  {
    skill: 'whatsapp-send',
    surface: 'WhatsApp',
    reaches: 'people',
    gate: OUTBOUND_GATES.OWNER_WORD,
    note: 'Sends one draft, and only after the owner replied 「发 W<n>」 naming it.',
  },
  // Google Workspace (the Cloud-held grant)
  {
    skill: 'docs-comment',
    surface: 'Google Docs',
    reaches: 'people',
    gate: OUTBOUND_GATES.OWNER_WORD,
    note: 'Replies, resolves and new comments are queued and posted as a batch after the owner\'s 「发 C<n>」; listing is free.',
  },
  {
    skill: 'docs-write',
    surface: 'Google Docs',
    reaches: 'owner',
    gate: OUTBOUND_GATES.AS_OWNER,
    note: 'Creates or appends to a document in the owner\'s Drive as the owner, at once.',
  },
  {
    skill: 'sheets-write',
    surface: 'Google Sheets',
    reaches: 'owner',
    gate: OUTBOUND_GATES.AS_OWNER,
    note: 'Creates a sheet or writes rows in the owner\'s Drive as the owner, at once.',
  },
  {
    skill: 'slides-create',
    surface: 'Google Slides',
    reaches: 'owner',
    gate: OUTBOUND_GATES.AS_OWNER,
    note: 'Creates a deck in the owner\'s Drive as the owner, at once.',
  },
  {
    skill: 'drive-upload',
    surface: 'Google Drive',
    reaches: 'owner',
    gate: OUTBOUND_GATES.AS_OWNER,
    note: 'Uploads a file into the owner\'s Drive as the owner, at once.',
  },
  {
    skill: 'calendar-create',
    surface: 'Google Calendar',
    reaches: 'people',
    gate: OUTBOUND_GATES.AS_OWNER,
    note: 'Creates an event at once; attendees receive the owner\'s invitation then. The skill text asks the agent to confirm first — nothing enforces it.',
  },
  // Canva and Microsoft (Cloud-held grants)
  {
    skill: 'canva-create',
    surface: 'Canva',
    reaches: 'owner',
    gate: OUTBOUND_GATES.AS_OWNER,
    note: 'Creates a design in the owner\'s Canva account at once.',
  },
  {
    skill: 'canva-upload',
    surface: 'Canva',
    reaches: 'owner',
    gate: OUTBOUND_GATES.AS_OWNER,
    note: 'Adds an asset to the owner\'s Canva media library at once.',
  },
  {
    skill: 'todo-add',
    surface: 'Microsoft To Do',
    reaches: 'owner',
    gate: OUTBOUND_GATES.AS_OWNER,
    note: 'Adds a task to one of the owner\'s lists at once.',
  },
  {
    skill: 'todo-update',
    surface: 'Microsoft To Do',
    reaches: 'owner',
    gate: OUTBOUND_GATES.AS_OWNER,
    note: 'Changes or deletes a task in one of the owner\'s lists at once.',
  },
  // Crewly Apps
  {
    skill: 'publish-app',
    surface: 'Crewly Apps',
    reaches: 'owner',
    gate: OUTBOUND_GATES.OWNER_CARD,
    note: 'A published app is private to the account. Making it public, giving it the microphone or camera, or listing it as a template is asked on a card; only the owner grants it.',
  },
  // Browsers and the desktop
  {
    skill: 'remote-browser',
    surface: 'Chrome (extension)',
    reaches: 'public',
    gate: OUTBOUND_GATES.OWNER_CARD,
    note: 'A click, key or script that would send, post, reply, pay or submit is held on a Browser card; on social and mail sites an unnamed click is held too (`browser-outbound-guard.ts`).',
  },
  {
    skill: 'chrome-attach',
    surface: 'Chrome (local, CDP)',
    reaches: 'public',
    gate: OUTBOUND_GATES.NONE,
    note: 'Drives a locally launched Chrome over the DevTools protocol; the extension guard does not see it.',
  },
  {
    skill: 'browse-stealth',
    surface: 'Browser (Playwright)',
    reaches: 'public',
    gate: OUTBOUND_GATES.NONE,
    note: 'A headless browser the agent runs itself; nothing holds a submit.',
  },
  {
    skill: 'desktop-app-control',
    surface: 'Desktop apps (CDP)',
    reaches: 'public',
    gate: OUTBOUND_GATES.NONE,
    note: 'Drives Electron apps and Chrome-based browsers over the DevTools protocol; nothing holds a send.',
  },
  {
    skill: 'computer-use',
    surface: 'macOS desktop',
    reaches: 'public',
    gate: OUTBOUND_GATES.NONE,
    note: 'Clicks and types on the owner\'s screen; the skill text says approval comes only through the harness, and nothing enforces it.',
  },
  {
    skill: 'marketplace/chrome-browser',
    surface: 'Chrome (Claude in Chrome)',
    reaches: 'public',
    gate: OUTBOUND_GATES.NONE,
    note: 'The Claude Code browser extension, not Crewly\'s; the Crewly browser guard does not see it.',
  },
  {
    skill: 'marketplace/playwright-chrome-browser',
    surface: 'Browser (Playwright MCP)',
    reaches: 'public',
    gate: OUTBOUND_GATES.NONE,
    note: 'A fallback browser driven over MCP; nothing holds a submit.',
  },
  {
    skill: 'marketplace/computer-use',
    surface: 'macOS desktop',
    reaches: 'public',
    gate: OUTBOUND_GATES.NONE,
    note: 'Native screenshot, click and type; nothing holds a send.',
  },
  // Marketplace
  {
    skill: 'marketplace/marketplace-publish',
    surface: 'Crewly Marketplace',
    reaches: 'public',
    gate: OUTBOUND_GATES.NONE,
    note: 'Submits a skill for listing; the marketplace reviews it before anyone else sees it.',
  },
];

/**
 * Write-shaped bundled skills that are NOT outbound, with the reason. The
 * test requires every skill whose name looks like a write to be here or in
 * {@link OUTBOUND_TOOLS}, so a new one has to be classified.
 */
export const NOT_OUTBOUND: Readonly<Record<string, string>> = {
  'reply': 'team chat: the answer goes to the thread the work came from',
  'reply-channel': 'team chat: a chat channel inside the account',
  'reply-chat': 'team chat: a chat-v2 conversation inside the account',
  'send-chat-response': 'team chat: the dispatch loop\'s reply path',
  'slack-post': 'team chat: a post or DM in the team\'s own Slack workspace, under the agent\'s identity',
  'send-message': 'another agent\'s terminal on this machine',
  'send-file': 'a file to another agent of the same account, through a temporary relay',
  'share-file': 'a private download link for the owner',
  'create-task': 'a Crewly work item',
  'create-mission': 'a Crewly mission',
  'create-request': 'a Crewly request',
  'update-sop': 'the team\'s own SOP pages',
  'update-team-norm': 'the team\'s own norms',
  'standing-update': 'the agent\'s standing-answer wiki page',
  'install-skill': 'installs onto this machine; a third-party skill asks the owner in chat first',
  'canva-export': 'downloads a finished design; nothing is written to Canva',
  'marketplace/social-media-post': 'writes post drafts to a file; the owner publishes them',
  'marketplace/send-pdf-to-slack': 'team chat: uploads a PDF to a channel in the team\'s own Slack workspace',
};

/** Skill-name shape that must be classified (either list). */
export const WRITE_SHAPED_SKILL = /(^|[/-])(send|post|publish|upload|write|create|add|draft|export|update|install|delete|remove|share|reply|broadcast)([-/]|$)/;

/**
 * Whether a bundled skill's effect leaves Crewly.
 *
 * @param skill - Skill name (`gmail-send`, `marketplace/gmail`)
 * @returns True when the skill is in {@link OUTBOUND_TOOLS}
 */
export function isOutboundTool(skill: string): boolean {
  return OUTBOUND_TOOLS.some((t) => t.skill === skill);
}

/**
 * The gate of an outbound tool.
 *
 * @param skill - Skill name
 * @returns Its gate, or null for a skill that is not outbound
 */
export function outboundGateOf(skill: string): OutboundGate | null {
  return OUTBOUND_TOOLS.find((t) => t.skill === skill)?.gate ?? null;
}

/**
 * The list as the API returns it: a copy, in display order.
 *
 * @returns Outbound tools
 */
export function listOutboundTools(): OutboundTool[] {
  return OUTBOUND_TOOLS.map((t) => ({ ...t }));
}
