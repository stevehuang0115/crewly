/**
 * Classifier for messages an agent wants to send to another company's Crewly
 * account over a shared channel (crewly#1543 slice 5).
 *
 * Deterministic and conservative: it looks for shapes, not meaning, and when
 * a shape could be internal it says so. Three verdicts:
 *
 * - `plain`: nothing internal-looking; may go out once the link's trial is over.
 * - `internal`: may carry internal information (paths, contact details, money,
 *   internal links, connector or wiki content, …): held for the owner.
 * - `refused`: never leaves the account, not even with the owner's approval
 *   from a card: secrets / token-shaped strings, children's personal data, and
 *   anything written right after the agent read another person's connector.
 *   The owner can still write such a message himself from Team Chat.
 *
 * @module services/shared-channel/shared-channel-classifier
 */

import { SHARED_CHANNEL_CONSTANTS } from '../../constants.js';
import { redactSecretsWithCount } from '../../utils/secret-redactor.js';
import { PII_PATTERNS } from '../wiki/wiki-redaction.js';

/** Overall verdict. */
export type SharedSendVerdict = 'plain' | 'internal' | 'refused';

/** Why a message is internal or refused. */
export type SharedSendFindingCode =
  | 'secret'
  | 'children_data'
  | 'private_person_data'
  | 'owner_connector'
  | 'children_mention'
  | 'file_path'
  | 'email'
  | 'phone'
  | 'id_number'
  | 'money'
  | 'internal_url'
  | 'internal_ref'
  | 'wiki_memory'
  | 'confidential'
  | 'code_block'
  | 'long_text';

/** One reason, with words for the agent and the owner. */
export interface SharedSendFinding {
  code: SharedSendFindingCode;
  /** One short English line ("an email address") */
  reason: string;
}

/** Result of {@link classifySharedSend}. */
export interface SharedSendClassification {
  verdict: SharedSendVerdict;
  /** Every reason found, refusals first (empty for `plain`) */
  findings: SharedSendFinding[];
}

/** What the harness knows about the sender beyond the text. */
export interface SharedSendContext {
  /**
   * People (ids) whose connector grants the sending agent read recently
   * (the #969 private-source tracker). The owner's id here means the owner's
   * own connectors; anyone else's means their private data.
   */
  recentPeople?: string[];
  /** The owner's person id (default `owner`) */
  ownerId?: string;
}

/** Codes that make a message unsendable from an agent. */
const REFUSAL_CODES: ReadonlySet<SharedSendFindingCode> = new Set(['secret', 'children_data', 'private_person_data']);

/** Words that mean children or students (the SteamFun rule: children's data never leaves the account). */
const CHILD_RE =
  /\b(?:child(?:ren)?|kids?|students?|pupils?|minors?|sons?|daughters?|toddlers?|teens?|teenagers?|campers?|learners?|parents?)\b|孩子|儿童|学生|小朋友|家长|未成年/i;
/** Personal details that, next to a child word, make the message children's data. */
const CHILD_DETAIL_RE =
  /\b\d{1,2}\s?(?:years?[\s-]old|yo|y\/o)\b|\bage[sd]?\s*:?\s*\d{1,2}\b|\d{1,2}\s?岁|\bgrade\s*\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)\s+grade\b|年级|\bbirthday\b|\bdate of birth\b|\bDOB\b|生日|\baddress\b|住址|\bmedical\b|\ballerg|\bdiagnos|病|过敏|\bgrades?\b|\bscores?\b|成绩/i;

/** A long run of letters and digits without spaces: an API key, a hash, a session token. */
const LONG_TOKEN_RE = /(?<![A-Za-z0-9_\-+/=])(?=[A-Za-z0-9_\-+/=]*\d)(?=[A-Za-z0-9_\-+/=]*[A-Za-z])[A-Za-z0-9_\-+/=]{32,}(?![A-Za-z0-9_\-+/=])/g;
/** A canonical UUID (held as an internal reference, not refused as a token). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A credential in a link's query string. */
const URL_SECRET_PARAM_RE = /[?&#](?:k|key|api_?key|token|access_token|auth|sig|signature|code|secret|password)=[^\s&#]{8,}/i;

/** Absolute, home and relative file paths, and file names with a typical extension. */
const PATH_RES: readonly RegExp[] = [
  /(?:^|[\s(["'`])(?:~\/|\/(?:Users|home|opt|etc|var|tmp|private|root|srv|mnt|Volumes)\/)\S*/,
  /(?:^|[\s(["'`])\.{1,2}\/[\w.@-]+/,
  /\b[A-Za-z]:\\[\w\\. -]+/,
  /\b[\w-]+\.(?:ts|tsx|js|mjs|json|md|env|ya?ml|sh|py|csv|tsv|xlsx?|docx?|pptx?|pdf|sqlite|db|log|key|pem)\b/i,
];
/** Money amounts and money talk. */
const MONEY_RE =
  /[$€£¥]\s?\d|\b\d[\d,.]*\s?(?:k|m)?\s?(?:USD|EUR|GBP|CNY|RMB|HKD|SGD|CAD|AUD|dollars?|euros?|bucks)\b|\d\s?(?:元|万|块)|\b(?:price|pricing|invoice|revenue|salary|salaries|budget|discount|payment|payroll|margin|profit)s?\b|价格|报价|工资|预算|收入/i;
/** Hosts only this machine or this account can reach. */
const INTERNAL_URL_RE =
  /\b(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[\w-]+\.(?:local|lan|internal|corp|intranet|home\.arpa))\b|\b(?!www\.)[\w-]+\.crewlyai\.com\b|\bcrewlyai\.com\/(?:portal|api)\b/i;
/** Ticket / decision ids and Crewly session names. */
const INTERNAL_REF_RE = /\b(?:[A-Z][A-Z0-9]{1,9}|D)-\d{1,6}\b|\bcrewly-[a-z0-9][a-z0-9-]*\b|\bwork ?items?\b|\[(?:CHAT|DECISION|TASK|REMOTE)[:\]]/;
/** Wiki, memory and notes. */
const WIKI_RE = /\[\[[^\]]+\]\]|\b(?:wiki|llm-curated|knowledge base|handover|MEMORY\.md|our notes|my notes|meeting notes)\b|知识库|笔记|备忘/i;
/** Content of a connector (mail, Drive, calendar, chat apps). */
const CONNECTOR_RE =
  /\b(?:gmail|inbox|e-?mail thread|google (?:drive|docs?|sheets?|slides|calendar)|drive folder|spreadsheet|calendar|whatsapp|canva|slack (?:dm|thread|channel|message))\b|邮箱|收件箱|日历|表格/i;
/** Words that label something as not for outsiders. */
const CONFIDENTIAL_RE = /\b(?:internal|confidential|private|proprietary|nda|do not share|don't share)\b|内部|机密|保密/i;

const FINDING_TEXT: Readonly<Record<SharedSendFindingCode, string>> = {
  secret: 'a secret or token-shaped string',
  children_data: "children's personal data",
  private_person_data: "someone else's private data (you read their connector just before)",
  owner_connector: "content from the owner's connectors (mail, Drive, calendar, chat)",
  children_mention: 'something about children or students',
  file_path: 'a file path or file name',
  email: 'an email address',
  phone: 'a phone number',
  id_number: 'an ID number',
  money: 'money (amounts, prices, budgets)',
  internal_url: 'an internal link (this machine, a private network, or Crewly internal hosts)',
  internal_ref: 'internal references (ticket ids, session names, ids)',
  wiki_memory: 'wiki, memory or notes content',
  confidential: 'something marked internal or confidential',
  code_block: 'a code block',
  long_text: 'a long message',
};

/**
 * Whether any match of a global PII pattern is in the text.
 *
 * @param name - PII pattern name (`email`, `phone`, `cn_id_number`)
 * @param text - Text
 * @returns True when it matches
 */
function piiHit(name: string, text: string): boolean {
  const p = PII_PATTERNS.find((x) => x.name === name);
  if (!p) return false;
  p.regex.lastIndex = 0;
  const hit = p.regex.test(text);
  p.regex.lastIndex = 0;
  return hit;
}

/**
 * Whether the text holds a secret or token-shaped string. UUIDs are not
 * counted (they are message and object ids, held as internal references).
 *
 * @param text - Text
 * @returns True for a secret
 */
export function hasSecretShape(text: string): boolean {
  if (redactSecretsWithCount(text).count > 0) return true;
  if (URL_SECRET_PARAM_RE.test(text)) return true;
  LONG_TOKEN_RE.lastIndex = 0;
  for (const m of text.matchAll(LONG_TOKEN_RE)) {
    if (!UUID_RE.test(m[0])) return true;
  }
  return false;
}

/**
 * Classify one outgoing message. Pure; never throws.
 *
 * @param text - The message as the agent wrote it
 * @param ctx - What the harness knows about the sender
 * @returns The verdict and every reason found
 *
 * @example
 * ```typescript
 * classifySharedSend('Thanks, see you Tuesday!').verdict; // 'plain'
 * classifySharedSend('Mail me at a@b.co').verdict;          // 'internal'
 * classifySharedSend('key: sk-abcdefghijklmnopqrstuvwxyz').verdict; // 'refused'
 * ```
 */
export function classifySharedSend(text: string, ctx: SharedSendContext = {}): SharedSendClassification {
  const codes = new Set<SharedSendFindingCode>();
  const t = String(text ?? '');
  const ownerId = ctx.ownerId ?? 'owner';
  const people = (ctx.recentPeople ?? []).filter(Boolean);

  // Refusals.
  if (hasSecretShape(t)) codes.add('secret');
  if (people.some((p) => p !== ownerId)) codes.add('private_person_data');
  const email = piiHit('email', t);
  const phone = piiHit('phone', t);
  const idNumber = piiHit('cn_id_number', t);
  const child = CHILD_RE.test(t);
  if (child && (email || phone || idNumber || CHILD_DETAIL_RE.test(t))) codes.add('children_data');

  // Holds.
  if (people.includes(ownerId) || CONNECTOR_RE.test(t)) codes.add('owner_connector');
  if (child && !codes.has('children_data')) codes.add('children_mention');
  if (PATH_RES.some((re) => re.test(t))) codes.add('file_path');
  if (email) codes.add('email');
  if (phone) codes.add('phone');
  if (idNumber) codes.add('id_number');
  if (MONEY_RE.test(t)) codes.add('money');
  if (INTERNAL_URL_RE.test(t)) codes.add('internal_url');
  if (INTERNAL_REF_RE.test(t) || /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(t)) codes.add('internal_ref');
  if (WIKI_RE.test(t)) codes.add('wiki_memory');
  if (CONFIDENTIAL_RE.test(t)) codes.add('confidential');
  if (t.includes('```')) codes.add('code_block');
  if (t.length > SHARED_CHANNEL_CONSTANTS.CLASSIFIER_LONG_TEXT_CHARS) codes.add('long_text');

  const ordered = [...codes].sort((a, b) => Number(REFUSAL_CODES.has(b)) - Number(REFUSAL_CODES.has(a)));
  const findings = ordered.map((code) => ({ code, reason: FINDING_TEXT[code] }));
  const verdict: SharedSendVerdict = ordered.some((c) => REFUSAL_CODES.has(c)) ? 'refused' : ordered.length > 0 ? 'internal' : 'plain';
  return { verdict, findings };
}

/**
 * The reasons as one phrase ("an email address; money (amounts, prices, budgets)").
 *
 * @param findings - Findings
 * @param only - Restrict to these verdict classes
 * @returns Joined reasons ('' when none)
 */
export function describeFindings(findings: readonly SharedSendFinding[], only: 'refused' | 'all' = 'all'): string {
  return findings
    .filter((f) => only === 'all' || REFUSAL_CODES.has(f.code))
    .map((f) => f.reason)
    .join('; ');
}
