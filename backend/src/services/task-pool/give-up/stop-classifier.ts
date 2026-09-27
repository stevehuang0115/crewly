/**
 * Stop classifier (#841): decide whether a worker that stopped should be
 * pushed to retry with a different approach, or handed to a human.
 *
 * Deterministic pattern rules, English and Chinese, no LLM. The dangerous
 * mistake is a false RETRY: auto-retrying a copyright, spending or
 * owner-decision stop pushes an agent past a human decision. So:
 *
 * 1. EXCLUSIONS are checked first and always win. Any hit escalates, even if
 *    the same message also says "can't" ("I can't, it needs your card").
 * 2. A dependency wait escalates (it is not a give-up).
 * 3. A feasibility give-up ("can't / impossible / 做不到") with no exclusion
 *    retries.
 * 4. Anything else escalates ("unknown"): when unsure, never retry.
 *
 * Completions are stricter (a finished task must never be turned into a
 * failure): a completion is a give-up only when the give-up is the OUTCOME,
 * i.e. there is a feasibility cue AND no delivery evidence (a PR/issue URL, a
 * commit SHA, a findings/specs path, or success words such as done / fixed /
 * merged / 完成). Otherwise the completion is left alone (`none`).
 *
 * Pinned by real, scrubbed stop messages in `__fixtures__/stop-messages.json`.
 *
 * @module services/task-pool/give-up/stop-classifier
 */

/** Where the stop text came from. */
export type StopSource = 'complete' | 'block' | 'fail';

/** What to do with the stop. */
export type StopDecision = 'retry' | 'escalate' | 'none';

/** Why. The first nine are the exclusion list (never retried). */
export type StopCategory =
  | 'permission'
  | 'legal'
  | 'money'
  | 'owner_decision'
  | 'safety'
  | 'quota'
  | 'destructive'
  | 'external_action'
  | 'privacy'
  | 'environment'
  | 'dependency'
  | 'feasibility'
  | 'unknown'
  | 'delivered';

/** The classifier's verdict. */
export interface StopVerdict {
  decision: StopDecision;
  category: StopCategory;
  /** Names of the rules that matched, for the audit trail. */
  rules: string[];
}

/** One named pattern. */
interface Rule {
  name: string;
  re: RegExp;
}

/**
 * Exclusion rules, in the order categories are reported (most specific
 * concern first: legal/safety/privacy before credentials). Deliberately broad:
 * an over-match here costs a human a look (false escalate), never a skipped
 * human decision (false retry).
 */
export const EXCLUSION_RULES: ReadonlyArray<{ category: Exclude<StopCategory, 'dependency' | 'feasibility' | 'unknown' | 'delivered'>; rules: Rule[] }> = [
  {
    category: 'quota',
    rules: [
      { name: 'quota:usage-limit', re: /usage limit|rate[- ]?limit|\b429\b|quota|too many requests|limit (was )?reached|credits? (exhausted|ran out)|out of credits/i },
      { name: 'quota:zh', re: /额度|限额|配额|限流/ },
    ],
  },
  {
    category: 'legal',
    rules: [
      { name: 'legal:copyright', re: /copyright|copyrighted|licen[cs]e|legal|lawyer|lawsuit|trademark|terms of (service|use)|\bdmca\b|infring/i },
      { name: 'legal:zh', re: /版权|许可证|授权协议|法律|律师|诉讼|侵权|商标|条款/ },
    ],
  },
  {
    category: 'safety',
    rules: [
      { name: 'safety:refuse', re: /unsafe|safety|harmful|dangerous|malware|exploit|refus(e|ed|ing)|won'?t (do|reproduce|write|help)|will not (do|reproduce)|not (comfortable|appropriate)|ethic/i },
      { name: 'safety:zh', re: /安全|危险|有害|拒绝|不合适|伦理|道德|不做/ },
    ],
  },
  {
    category: 'privacy',
    rules: [
      { name: 'privacy:pii', re: /personal (data|information)|\bpii\b|private (information|data|messages?)|privacy|phone number|home address|\bssn\b|someone'?s (private|personal)|\bdox/i },
      { name: 'privacy:zh', re: /隐私|个人信息|手机号|住址|身份证/ },
    ],
  },
  {
    category: 'destructive',
    rules: [
      { name: 'destructive:data', re: /\bdelet(e|ing)\b|\bdrop (the )?(table|database|data|db)\b|truncate|wipe|rm -rf|force[- ]?push|irreversible|can'?t be undone/i },
      { name: 'destructive:prod', re: /production|\bprod\b|deploy(ment)? to (prod|live)|\brelease\b|go live|rotat(e|ing) (all |the )?(secrets?|keys|credentials|tokens)/i },
      { name: 'destructive:zh', re: /删除|删库|清空|强推|生产(环境|域)?|上线|发布版本|轮换|不可逆|redeploy/ },
    ],
  },
  {
    category: 'external_action',
    rules: [
      { name: 'external:send', re: /send (an |the )?e-?mail|e-?mail (the |a )?(customer|client|user)|reply to (the )?(customer|client)|post (it )?(publicly|on x|on twitter|on linkedin|to the channel|to slack)|\btweet\b|publish (a |the )?post|message (the )?(customer|client|users)|contact (the )?(customer|client)|outreach/i },
      { name: 'external:zh', re: /发邮件|发帖|发推|发布到|联系客户|私信|群发|外联/ },
    ],
  },
  {
    category: 'money',
    rules: [
      { name: 'money:spend', re: /\bpay(ing|ment|s)?\b|\bpaid\b|purchase|\bbuy\b|credit card|\bcard\b|billing|invoice|subscription|subscribe|upgrade (the |your )?(plan|tier)|paid plan|budget|\bspend|\bcosts? money|pricing|\$\s?\d/i },
      { name: 'money:zh', re: /付费|付款|花钱|购买|信用卡|订阅|预算|费用|扣款|充值|升级套餐|定价|价格/ },
    ],
  },
  {
    category: 'permission',
    rules: [
      { name: 'permission:access', re: /permission|access denied|forbidden|unauthori[sz]ed|\b40[13]\b|read-only|not a member|no access|lacks? access/i },
      { name: 'permission:credential', re: /credential|api[ _-]?keys?|\btokens?\b|password|passcode|\b2fa\b|oauth|ssh key|secret|log ?in|logging in|logged[ -]?(in|out)|sign(ed|ing)?[ -]?in|re-?login|authenticat|your account/i },
      { name: 'permission:zh', re: /权限|凭证|凭据|登录|登陆|密码|授权|密钥|令牌|账号/ },
    ],
  },
  {
    category: 'owner_decision',
    rules: [
      { name: 'owner:your-call', re: /your (call|decision|approval|go[- ]?ahead|sign[- ]?off|answers?|input)|needs? (a |an |the )?(approval|decision|sign[- ]?off|owner|human|steve)|waiting (on|for) (you|your|steve|the owner|approval|a decision)|awaiting (approval|confirmation|your)/i },
      { name: 'owner:choice', re: /which (option|one|path|way|approach) (do you|should)|should i\b|do you want|want me to|(option|path) \(?[ab]\)?.*(option|path) \(?[bc]\)?|\(a\).{0,200}\(b\)|needs_alignment|alignment request|out of scope|scope (change|decision|call)|pick the (fix )?scope|clarif/i },
      { name: 'owner:zh', re: /拍板|你定|你来定|等你|需要你|请你|确认一下|选哪|要不要|范围|对齐|你决定|你回/ },
    ],
  },
  {
    category: 'environment',
    rules: [
      { name: 'environment:resource', re: /disk (is )?full|no space left|enospc|out of memory|\boom\b/i },
      { name: 'environment:network', re: /network (is )?(down|unreachable|error)|econnrefused|etimedout|enotfound|\bdns\b|offline|outage|service unavailable|bad gateway|\b50[0234]\b|server error/i },
      { name: 'environment:tool', re: /command not found|not installed|enoent|no such file or directory|binary (is )?missing/i },
      { name: 'environment:zh', re: /磁盘(满|已满)|空间不足|网络|断网|服务不可用|未安装|找不到命令|内存不足/ },
    ],
  },
];

/** Waiting on other work: not a give-up, and not for this classifier to retry. */
export const DEPENDENCY_RULES: Rule[] = [
  { name: 'dependency:wait', re: /waiting (on|for) (the )?(dependency|dependencies|#\d+|pr\b|another|other (work|agent|team)|[a-z]+-[a-z]+)|blocked by (#\d+|pr\b|the dependency|wi\b|work ?item)|depends on #?\w+/i },
  { name: 'dependency:zh', re: /等待依赖|依赖.{0,6}(完成|合并)|等.{0,8}(合并|完成)后/ },
];

/**
 * Feasibility give-up cues. Written to swallow the verb that follows
 * ("can't be done", "无法完成") so the delivery check below never mistakes
 * the give-up phrase itself for a success word.
 */
export const FEASIBILITY_RULES: Rule[] = [
  { name: 'feasibility:cannot', re: /(can'?t|cannot|can not|couldn'?t|could not|unable to|not able to)( be)?( \w+){0,2}/gi },
  { name: 'feasibility:impossible', re: /(impossible|not possible|not feasible|infeasible|no way to|not achievable|won'?t work|does(n'?t| not) work|beyond what('?s| is) possible)( to)?( \w+){0,2}/gi },
  { name: 'feasibility:give-up', re: /(giv(e|ing) up|gave up|give it up|stopping here)/gi },
  { name: 'feasibility:zh', re: /(做不到|无法|不可能|没办法|放弃|实现不了|搞不定|行不通|破不了)[^\s，。,.;；]{0,6}/g },
];

/** Evidence that a completion delivered something. */
export const DELIVERY_RULES: Rule[] = [
  { name: 'delivered:url', re: /https?:\/\/\S*(github\.com\/\S+\/(pull|issues|commit)\/|\/pr\/)|\bPR #?\d+|\bpull request #?\d+|#\d{2,}\b/i },
  { name: 'delivered:sha', re: /\b[0-9a-f]{7,40}\b/ },
  { name: 'delivered:path', re: /(findings|specs)\/[\w./-]+|\b[\w-]+\/[\w./-]+\.(md|json|ts|tsx|js|sh|py|txt|csv|pdf|html)\b|\bLog: \S+/i },
  { name: 'delivered:words', re: /\b(done|fixed|merged|verified|shipped|passed|pass|completed|implemented|delivered|landed|pushed|opened|created|published|posted|updated|added|wrote|written|recorded|found|checked|reviewed|sent|logged|reported|flagged|documented|saved|summari[sz]ed|listed|covered|confirmed)\b/i },
  { name: 'delivered:zh', re: /完成|已修复|已合并|已上线|已提交|搞定|通过|写好|已发|记好|建好|改好/ },
];

/** Cap on how much text is classified (and later stored). */
export const MAX_STOP_TEXT = 4000;

/**
 * Names of the rules in a set that match the text.
 *
 * @param text - Text to test
 * @param rules - Rule set
 * @returns Matching rule names
 */
function matching(text: string, rules: ReadonlyArray<Rule>): string[] {
  return rules.filter((r) => {
    r.re.lastIndex = 0;
    const hit = r.re.test(text);
    r.re.lastIndex = 0;
    return hit;
  }).map((r) => r.name);
}

/**
 * First exclusion category the text hits, with its rule names.
 *
 * @param text - Stop text
 * @returns The category and rules, or null
 */
export function findExclusion(text: string): { category: StopCategory; rules: string[] } | null {
  for (const group of EXCLUSION_RULES) {
    const hits = matching(text, group.rules);
    if (hits.length > 0) return { category: group.category, rules: hits };
  }
  return null;
}

/**
 * Remove the give-up phrases, so a success word inside one ("can't be done")
 * is not read as delivery.
 *
 * @param text - Stop text
 * @returns The text with feasibility phrases blanked
 */
function withoutGiveUpPhrases(text: string): string {
  let out = text;
  for (const r of FEASIBILITY_RULES) {
    r.re.lastIndex = 0;
    out = out.replace(r.re, ' ');
    r.re.lastIndex = 0;
  }
  return out.replace(/\bnot (done|fixed|merged|verified|shipped|passed|completed|delivered)\b/gi, ' ');
}

/**
 * Classify why a worker stopped.
 *
 * @param text - The stop text: completion summary, block reason or failure error
 * @param source - Which path the stop came through
 * @returns retry | escalate | none, with the category and matched rules
 *
 * @example
 * ```typescript
 * classifyStop("The record can't be beaten with this model.", 'block');
 * // { decision: 'retry', category: 'feasibility', rules: ['feasibility:cannot'] }
 * classifyStop("I can't, it needs your card.", 'block');
 * // { decision: 'escalate', category: 'money', ... }
 * ```
 */
export function classifyStop(text: string | null | undefined, source: StopSource): StopVerdict {
  const t = (text ?? '').slice(0, MAX_STOP_TEXT);
  const feasibility = matching(t, FEASIBILITY_RULES);
  const exclusion = findExclusion(t);

  if (source === 'complete') {
    // A completion is only a give-up when giving up is the outcome.
    if (feasibility.length === 0) return { decision: 'none', category: 'delivered', rules: [] };
    const delivered = matching(withoutGiveUpPhrases(t), DELIVERY_RULES);
    if (delivered.length > 0) return { decision: 'none', category: 'delivered', rules: delivered };
    if (exclusion) return { decision: 'escalate', category: exclusion.category, rules: exclusion.rules };
    const dependency = matching(t, DEPENDENCY_RULES);
    if (dependency.length > 0) return { decision: 'escalate', category: 'dependency', rules: dependency };
    return { decision: 'retry', category: 'feasibility', rules: feasibility };
  }

  if (exclusion) return { decision: 'escalate', category: exclusion.category, rules: exclusion.rules };
  const dependency = matching(t, DEPENDENCY_RULES);
  if (dependency.length > 0) return { decision: 'escalate', category: 'dependency', rules: dependency };
  if (feasibility.length > 0) return { decision: 'retry', category: 'feasibility', rules: feasibility };
  return { decision: 'escalate', category: 'unknown', rules: [] };
}
