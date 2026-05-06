/**
 * Intent classifier rules — code-of-record per Mia spec §5 Q4.
 *
 * **Purpose**
 *
 * Centralises every keyword set and structural pattern the L0/L1/L2/L3
 * classifier consumes. Both production classifier paths
 * (`backend/src/types/intent-task.types.ts:classifyIntentLevel/Category`
 * and `backend/src/services/v3/v3-data.service.ts:classifyIntent`) read
 * from this file so a rule update lands in exactly one place.
 *
 * **Why a separate file?**
 *
 * Per Mia: "Easier review than buried regex." A reviewer auditing rule
 * coverage scans this file's exports rather than walking the classifier's
 * inline regex. Adding ZH parity to a category is a single-edit operation
 * here; in the inline shape it would be a ~10-line walk.
 *
 * **Spec source-of-truth**
 *
 * `specs/2026-05-06-intent-classifier-rules.md` (Mia, 2026-05-06).
 * Section references (§2.1, §2.2, etc.) below correspond to that doc.
 *
 * @module services/intent-task/intent-classifier.rules
 */

// ---------------------------------------------------------------------------
// §2.1 — Plurality / quantifier (HIGHEST PRECISION)
// ---------------------------------------------------------------------------

/**
 * Quantifier tokens that, when paired with a state-changing verb AND a
 * plural deliverable noun, force L1 → L2 promotion (§2.1).
 *
 * Anti-pattern guard (§3 last paragraph): quantifier alone is NOT enough.
 * "Show me all 3 statuses" stays L0 because the verb is read-only.
 * Promotion requires quantifier + state-changing verb + plural deliverable
 * noun — see {@link L2_QUANTIFIER_PROMOTERS_TRIGRAM}.
 */
export const QUANTIFIER_TOKENS = {
  /** EN: both/all/every/each + numeric + numeric-words. */
  en: /\b(both|all|every|each|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i,
  /** ZH: 这两/三/四/五/.../多个/所有/全部/每个/几个. */
  zh: /(两|三|四|五|六|七|八|九|十|这两|这三|多个|所有|全部|每个|几个)/,
} as const;

/**
 * Plural deliverable noun tokens that, paired with a quantifier + state-
 * changing verb, force L2 promotion (§2.1).
 *
 * The ZH measure-words (份/个/张/篇/段/章/项/条) double as deliverable-noun
 * proxies because Chinese uses measure-words in lieu of pluralisation.
 */
export const DELIVERABLE_NOUN_TOKENS = {
  en: /\b(docs?|specs?|files?|reports?|tasks?|prs?|tickets?|issues?|services?|modules?|components?|features?|tests?|migrations?|scripts?)\b/i,
  /**
   * ZH: 文档/文件/规范 + measure-words (份/个/张/篇/段/章/项/条). Combined
   * because Chinese parses noun + measure-word as the deliverable proxy.
   */
  zh: /(文档|文件|规范|份|个|张|篇|段|章|项|条|条目|笔记)/,
} as const;

/**
 * Quantifier-trigram tokens (§2.1 + §3 anti-pattern guard).
 *
 * **Implementation note:** rather than constraining token order in a
 * single regex, the classifier checks all three axes (quantifier +
 * state-change verb + deliverable noun) for presence within the same
 * input. This handles all natural orderings (VERB-QUANT-NOUN as in
 * "create three reports" / "做这两份 md 文档"; QUANT-NOUN-VERB as in
 * "three reports to make" / "三份报告要做"; QUANT-VERB-NOUN; etc.)
 * without explosion of permutations.
 *
 * The anti-promotion guard in `classifyIntentLevel` ensures
 * "Show me all 3 statuses" stays L0 by checking that the verb axis is
 * NOT exclusively read-only ({@link L0_READ_VERB_PATTERN}) before
 * promoting on this trigram.
 */
export const L2_QUANTIFIER_TRIGRAM = {
  /**
   * EN: requires all three axes — quantifier + state-change verb +
   * deliverable noun — present in the input. Order-agnostic.
   *
   * The exposed regex matches the QUANTIFIER axis only; the consumer
   * checks the other two axes via the helper below.
   */
  en: /\b(both|all|every|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i,
  /** ZH quantifier axis. */
  zh: /(两|三|四|五|六|七|八|九|十|这两|这三|多个|所有|全部|每个|几个)/,
} as const;

/**
 * State-change verb axis for the quantifier-trigram. Distinct from
 * {@link ACTION_VERB_EN}/{@link ACTION_VERB_ZH} because the trigram
 * specifically excludes ambiguous-shape verbs (e.g. `run`, `check`)
 * that are common in read-only contexts.
 */
export const L2_TRIGRAM_STATE_CHANGE_VERB = {
  en: /\b(make|build|create|implement|add|write|update|delete|deploy|migrate|refactor|design|review|fix|configure|prepare|draft|publish|release|ship|launch|generate)\b/i,
  zh: /(做(?!了|过|得|的|出|不到|不了|不下|不来|不出)|写|搞定|做完|完成|实现|添加|创建|构建|搭建|设计|部署|发布|上线|分析|审查|评审|编排|调研|规划|优化|重构|修复|改写|编写|起草|拆分|准备)/,
} as const;

/**
 * Plural-deliverable axis for the quantifier-trigram. Mirrors
 * {@link DELIVERABLE_NOUN_TOKENS} but kept distinct so a future tuning
 * of "what counts as deliverable in a trigram context" doesn't drift.
 */
export const L2_TRIGRAM_DELIVERABLE = {
  en: /\b(docs?|specs?|files?|reports?|tasks?|prs?|tickets?|issues?|services?|modules?|components?|features?|tests?|migrations?|scripts?)\b/i,
  zh: /(份|个|张|篇|段|章|项|条|条目|文档|文件|规范|报告|任务|md|md\s*文档|计划|spec)/i,
} as const;

// ---------------------------------------------------------------------------
// §2.2 — Multi-artifact / file-creation triggers
// ---------------------------------------------------------------------------

/**
 * Doc/spec creation triggers (§2.2 row 1). These promote to L2 even with
 * a tiny verb because authoring a doc is multi-step by nature.
 */
export const L2_DOC_CREATION_TRIGGER = {
  en: /\b(spec|specification|design\s+doc|rfc|brief|writeup|whitepaper|markdown\s+doc|md\s+doc)\b/i,
  zh: /(规范|设计文档|草稿|说明文档|md\s*文档|markdown\s*文档|笔记|白皮书|说明书)/,
} as const;

/**
 * File-with-extension reference (§2.2 row 2). Any path with extension
 * promotes to L2 unless the verb is read-only — the read-only guard is
 * applied at the classifier level, not here, because read-only verbs are
 * a separate axis (see {@link L0_READ_VERB_PATTERN}).
 */
export const L2_FILE_EXTENSION_TRIGGER = /\b\w+\.(md|markdown|ts|tsx|js|jsx|py|sql|json|yml|yaml|sh|tf|java|go|rb|rs|cpp|c|h|toml|ini|conf|css|scss|html|xml|csv)\b/i;

/**
 * PR / commit / branch artifact (§2.2 row 3). Order-agnostic — both
 * "open a PR" (VERB-NOUN) and "PR to open" (NOUN-VERB) match, with the
 * VERB-NOUN form being far more common.
 */
export const L2_PR_ARTIFACT_TRIGGER = {
  en: /\b(?:(pr|pull\s+request|commit|branch|merge)\b.{0,30}?\b(open|create|raise|file|prepare|draft|push|cut|land)|(open|create|raise|file|prepare|draft|push|cut|land)\b.{0,30}?\b(pr|pull\s+request|commit|branch|merge))\b/i,
  zh: /(pr|pull\s+request|提交|分支|合并|merge).{0,12}?(开|提|准备|起草|推送|落地|创建|发起)|(开|提|准备|起草|推送|落地|创建|发起).{0,12}?(pr|pull\s+request|提交|分支|合并|merge)/i,
} as const;

/**
 * Migration / schema (§2.2 row 4).
 */
export const L2_MIGRATION_TRIGGER = {
  en: /\b(migration|schema|seed|fixture|backfill)\b/i,
  zh: /(迁移|建表|改表|回填|数据迁移|表结构)/,
} as const;

// ---------------------------------------------------------------------------
// §2.3 — Verb–noun pair signaling system-level work
// ---------------------------------------------------------------------------

/**
 * Build/implement + system-noun (§2.3 row 1). The canonical L2 shape —
 * pre-existing in the EN classifier; ZH parity is the new contribution.
 */
export const L2_BUILD_SYSTEM_NOUN = {
  en: /\b(implement|build|create|develop|design|architect|refactor)\b.{0,40}?\b(feature|system|service|module|component|pipeline|workflow|framework|infrastructure)\b/i,
  zh: /(实现|构建|创建|搭建|设计|架构|重构|开发|编写|做).{0,15}?(功能|系统|服务|模块|组件|流水线|工作流|框架|基础设施|架构|平台|工具)/,
} as const;

/**
 * Deploy/migrate + env-noun (§2.3 row 2).
 */
export const L2_DEPLOY_ENV_NOUN = {
  en: /\b(deploy|migrate|upgrade|provision)\b.{0,40}?\b(to|from|environment|server|cluster|staging|production)\b/i,
  zh: /(部署|迁移|升级|发布|上线).{0,15}?(到|从|环境|服务器|集群|预发|生产|测试环境|正式环境)/,
} as const;

/**
 * End-to-end / full-stack scope (§2.3 row 3).
 */
export const L2_E2E_SCOPE = {
  en: /\b(end[- ]?to[- ]?end|full[- ]?stack|e2e|integration)\b.{0,30}?\b(test|setup|implementation|implement)\b/i,
  zh: /(端到端|全栈|完整|整套|完整链路).{0,12}?(测试|搭建|实现|实施|部署)/,
} as const;

/**
 * Coordinate / orchestrate (§2.3 row 4). Single-token signal — by the
 * time someone says "coordinate", the work is multi-agent by definition.
 */
export const L2_COORDINATE = {
  en: /\b(coordinate|orchestrate|delegate|parallelize|fan\s*out)\b/i,
  zh: /(协调|编排|分发|拆分|并行|分派|分配|统筹)/,
} as const;

// ---------------------------------------------------------------------------
// §2.4 — Conjunction of distinct verbs / numbered list
// ---------------------------------------------------------------------------

/**
 * Sequenced verbs (§2.4 row 1). "X then Y" / "X 然后 Y".
 */
export const L2_SEQUENCED_VERBS = {
  en: /\b(then|and\s+then|after\s+that|next|followed\s+by|subsequently)\b/i,
  zh: /(然后|接着|之后|再|随后|继而|紧接着)/,
} as const;

/**
 * Numbered/bulleted list (§2.4 row 3). Two or more numbered items in the
 * same input is structurally L2.
 */
/**
 * Numbered list trigger. Matches "1. … 2. …" / "(1) … (2) …" / "① … ②".
 * The `\s?` after the marker is OPTIONAL because Chinese-encoded numbered
 * lists ("①修复 ②测试") have no whitespace between the marker and the
 * content.
 */
export const L2_NUMBERED_LIST = /(?:^|\s)(?:1\.|\(1\)|①)\s?.{0,200}?(?:^|\s)(?:2\.|\(2\)|②)/s;

// ---------------------------------------------------------------------------
// §2.5 — Cross-system context-pivot (catches "oss重启了 你现在再做这个")
// ---------------------------------------------------------------------------

/**
 * Restart/recovery + redirect (§2.5). Status-update clause followed by a
 * directive that references prior multi-step context. The "this/这个"
 * referent points to a prior plan the classifier can't resolve, but the
 * SHAPE is reliable enough to promote.
 */
export const L2_CROSS_SYSTEM_PIVOT = {
  en: /\b(restart(ed)?|back|up|live|running|recovered)\b.{0,40}?\b(now|then|so|please)?\s*(do|run|continue|resume|proceed|kick\s+off|pick\s+up)\b/i,
  /**
   * ZH: status-clause (重启/回来/上线/跑起来/好了/恢复) + ≤16-char gap +
   * directive prefix (现在/那/你?) + (再/继续/接着/开始) + verb (做/搞/跑/继续).
   */
  zh: /(重启|回来|上线|跑起来|好了|恢复|恢复了|起来了|连上).{0,16}?(现在|那|你)?\s*(再|继续|接着|开始|重新).{0,8}?(做|搞|跑|继续|执行|开始|处理|完成)/,
} as const;

// ---------------------------------------------------------------------------
// §2.6 — Sprint / OKR / time-budget markers (L3 candidates)
// ---------------------------------------------------------------------------

/**
 * Sprint / milestone / epic markers (§2.6 row 1). These are L3 CANDIDATES
 * — combined with §2.3 they classify L3; alone they classify L2.
 */
export const L3_SPRINT_OKR_MARKERS = {
  en: /\b(sprint|milestone|epic|okr|kr\d?)\b/i,
  zh: /(冲刺|迭代|里程碑|目标|kr\d?|季度目标|年度目标)/i,
} as const;

/**
 * Multi-day timebox (§2.6 row 2). Time markers like "this week" /
 * "by Friday" / "这周" / "下周" combined with a verb suggest sprint-level
 * scope.
 */
export const L3_TIMEBOX_MARKERS = {
  en: /\b(this\s+week|by\s+(eod|friday|monday|tuesday|wednesday|thursday|sunday|saturday|tomorrow|tonight)|next\s+sprint|tonight|overnight|by\s+end\s+of\s+(day|week|sprint))\b/i,
  zh: /(这周|本周|今天|今晚|过夜|周末|下周|明天前|月底|季度内|本季度|这个月|下个月)/,
} as const;

/**
 * Deliver / ship verbs (§2.6 row 3). Distinct from §2.3 deploy axis —
 * "ship" / "上线" carry a sprint-completion semantic.
 */
export const L3_DELIVER_SHIP_VERBS = {
  en: /\b(ship|deliver|launch|release|land|execute)\b/i,
  zh: /(发布|上线|交付|搞定|完成|拿下|落地|执行)/,
} as const;

// ---------------------------------------------------------------------------
// §1.2 — Read verbs (anti-promotion guard for §2.1)
// ---------------------------------------------------------------------------

/**
 * Read-only / status-lookup verbs. If the only verb in the input is a
 * read verb, do NOT promote even if a quantifier is present
 * (§3 last paragraph: "Show me all 3 statuses" stays L0).
 */
export const L0_READ_VERB_PATTERN = {
  en: /\b(show|list|get|check|find|count|describe|explain|view|see|look\s+at|what|where|when|who|which|how|is|are|does|do|status|version|health|uptime)\b/i,
  zh: /(查看|查询|展示|列出|看一下|看看|多少|什么|哪|是否|有没有|状态|版本|健康|启动时间)/,
} as const;

// ---------------------------------------------------------------------------
// Action verb pattern (used by isActionableIntent)
// ---------------------------------------------------------------------------

/**
 * EN action verb pattern. Used as a positive signal for actionability
 * when no non-actionable pattern matches. Pre-existing — kept here to
 * keep all classifier inputs in one file.
 */
export const ACTION_VERB_EN = /\b(fix|build|create|deploy|implement|add|update|delete|remove|write|read|check|test|run|make|send|set\s+up|configure|install|download|upload|convert|transform|generate|export|import|refactor|migrate|upgrade|optimize|search|find|move|copy|rename|clean\s*up|set|start|stop|restart|enable|disable|schedule|assign|delegate|review|audit|analyze|investigate|research|explore|design|plan|document|monitor|track|debug|trace|patch|revert|rollback|merge|push|pull|commit|release|publish|integrate|connect|disconnect|setup|tear\s*down|provision|scale|backup|restore)\b/i;

/**
 * ZH action verb pattern. Mirrors §2.3 + §2.6 verb sets plus the canonical
 * Chinese imperatives Mia called out in the spec preamble (§0 root cause
 * 1): 做/写/搞/搞定/重启/检查 etc.
 *
 * **Strictness on dual-use verbs (Mia 2026-05-06):** the bare imperatives
 * 做 and 搞 are conversational-filler-ambiguous (做了 = "did already",
 * 搞砸 = "messed up", 搞不定 = "can't do"). To follow Mia's
 * stricter-promotion default ("false-negative is fixable; false-positive
 * over-decomposes"), we use negative lookaheads on those two so the
 * completed/denial forms don't match. Other actionable forms (做完, 搞定,
 * 做+deliverable) are explicit fall-through tokens further in the pattern.
 *
 * The companion {@link NON_ACTIONABLE_PATTERNS_ZH} set includes
 * sentence-shape filters for "I just did X" / "I can't do X" cases that
 * the lookahead alone cannot catch — both layers together produce the
 * stricter behaviour Mia asked for.
 */
// Issue #472 (Arch nit on PR #471): symmetry fix on the bare-做
// negative-lookahead list. 搞 already excluded its mistake/botched
// suffixes (砸|错|乱|糊涂); 做 only excluded completed/denial suffixes
// (了|过|得|的|出|不到|不了|不下|不来|不出) and missed the parallel
// mistake suffixes (错|坏|废). Operational risk: a user typing
// "做错了" / "做坏了" / "做废了" matched the bare 做 token and reached
// the L2 promoter. Symmetric coverage closes the gap.
export const ACTION_VERB_ZH = /(做(?!了|过|得|的|出|错|坏|废|不到|不了|不下|不来|不出)|写(?!不出|不来)|搞(?!砸|错|不定|不动|不了|乱|糊涂)|搞定|做完|完成|重启|启动|停止|关闭|检查|查看|查询|修复|修\b|改|改写|编写|起草|添加|删除|移除|部署|上线|发布|创建|实现|构建|搭建|设计|分析|审查|评审|编排|调研|规划|计划|制定|优化|重构|拆分|分发|分派|协调|分配|统筹|集成|配置|安装|更新|升级|迁移|回填|监控|跟踪|追踪|调试|跑|执行|处理|准备|提交|合并|推送|拉取|发版|交付|落地|拿下|测试|审计|评估|排查|审核|审定)/;

// ---------------------------------------------------------------------------
// Non-actionable patterns — ZH parity additions
// ---------------------------------------------------------------------------

/**
 * Non-actionable ZH patterns that should be filtered out by
 * `isActionableIntent` before classification (§3 filtered rows).
 *
 * Exported as an array for composition with the existing EN
 * NON_ACTIONABLE_PATTERNS in `intent-task.types.ts`.
 */
export const NON_ACTIONABLE_PATTERNS_ZH: RegExp[] = [
  // Greetings / pleasantries (§3 row 12)
  /^(你好|您好|嗨|早上好|下午好|晚上好|早|晚安|再见|拜拜|多谢|谢谢|感谢)\s*[。！!]?$/,
  // Pure acknowledgements (§3 row 7)
  /^(好的|好|知道了|收到|嗯|嗯嗯|哦|哦哦|明白|明白了|可以|行|对|没问题|稍等|马上|马上来|好啊|好哒)\s*[。！!]?$/,
  // Opinion / discussion (§3 row 8: 我觉得 / 也许)
  /^(我觉得|我认为|我感觉|也许|可能|可能我|或许|大概|应该|觉得)/,
  // FYI / status-share (§3 row 9: 我刚 push 了)
  // Allow optional whitespace between 我刚/已经 and the past-tense verb so
  // "我刚 push 了" / "我已经 merge 完了" etc. all match.
  /^我\s*(刚|已经|已|刚刚)\s*(做了|完成|搞定|push|merge|提交|推送|部署|更新|修复|发布)/i,
  /^(做完了|完成了|已完成|刚完成|刚刚搞定)/,
  // Apology / confirmation (§3 row 10)
  /^(抱歉|不好意思|对不起|确认|确认了|没事|没关系|没什么)/,

  // Mia stricter-default 2026-05-06: dual-use verb conversational-filler
  // forms. These run BEFORE classification so a message like "做了" /
  // "搞砸了" / "做不到" cannot reach the L2 promoter. Catches the cases
  // the verb-level negative lookahead alone misses (e.g. when the
  // problematic form is mid-sentence rather than verb-tail).
  //
  // (a) "I/we did X already" — completed action, not a directive.
  /^(?:我们?\s*)?(?:刚|已经|已|刚刚|早就)?\s*(?:做了|搞了|做完了|搞完了|搞定了|完成了|弄完了|弄好了|做过了|搞过了)/,
  // (b) "(I) can't do X" — capability denial, not a directive.
  /^.{0,20}?(做不到|做不了|做不下来|做不出来|搞不定|搞不动|搞不了|完不成|弄不了|没做完|没搞定)/,
  // (c) Short message ending in a botched/error verb (搞砸/搞错).
  // Issue #472: parallel mistake-form coverage. 搞 had 砸|错|乱|糊涂;
  // 做 needs the parallel 错|坏|废 forms so a user message like "做错了" /
  // "做坏了" / "做废了" is filtered before the L2 promoter sees it.
  /^.{0,30}?(搞砸|搞错|搞乱|搞糊涂|做错|做坏|做废|做糟)(?:了|过)?\s*[。！？!?]?$/,
];

// ---------------------------------------------------------------------------
// Length floors
// ---------------------------------------------------------------------------

/**
 * Length floors for L2 promotion when no rule fires. ZH has no spaces, so
 * word-count alone under-estimates message density — char-count is the
 * complementary axis.
 */
export const L2_LENGTH_FLOORS = {
  /** EN/space-tokenised word count above which the message is L2. */
  wordCount: 35,
  /** Total character count above which the message is L2 (catches ZH). */
  charCount: 80,
} as const;

// ---------------------------------------------------------------------------
// Category — ZH parity extensions (§2.3 lookup tables)
// ---------------------------------------------------------------------------

/**
 * Category-specific keyword sets. Each category combines an EN pattern
 * with a ZH pattern; the classifier matches if EITHER fires.
 *
 * Exported as a structured object so the consumer code reads
 * `CATEGORY_KEYWORDS.debugging.zh.test(input)` rather than digging into
 * nested ternaries.
 *
 * Order is significant — see `classifyIntentCategory` in
 * `intent-task.types.ts`. The most-specific categories run first.
 */
export const CATEGORY_KEYWORDS = {
  debugging: {
    en: /\b(fix|bug|error|crash|broken|issue|debug|trace|stack\s*trace|exception|segfault|panic|hang|leak|regression|flaky)\b/i,
    zh: /(修复|修\b|改bug|bug|报错|崩溃|出错|故障|异常|挂了|内存泄漏|泄漏|不工作|有问题|错了|挂死|死循环|跑不起来)/i,
  },
  deployment: {
    // Bug A v0 (2026-05-06): added `ship|publish` for backward
    // compatibility with v3-data.service.test.ts which pins
    // "Ship the new feature" → deployment. Pre-Bug-A the v3-data
    // classifier had its own deploy regex with these tokens; the
    // delegation rolls them in here so the pre-existing assertion
    // still passes after consolidation.
    en: /\b(deploy|ship|publish|staging|production|docker|kubernetes|k8s|helm|terraform|ansible|nginx|container|image|rollback|rollout)\b/i,
    zh: /(部署|上线|发布|发版|预发|生产|生产环境|预发环境|镜像|容器|回滚|灰度|滚动发布)/,
  },
  release: {
    en: /\b(release)\b/i,
    zh: /(发版|release)/i,
  },
  ciCdContext: {
    en: /\b(ci|cd)\b/i,
    zh: /(持续集成|持续交付|流水线|ci|cd)/i,
  },
  ciCdAction: {
    en: /\b(pipeline|build|run|trigger|fix)\b/i,
    zh: /(流水线|构建|运行|触发|修复)/,
  },
  review: {
    en: /\b(review|pr\b|pull\s+request|code\s+review|audit|approve|reject|lgtm)\b/i,
    zh: /(审查|评审|审核|review|代码审查|代码评审|pr\b|拉取请求|批准|驳回|通过)/i,
  },
  research: {
    en: /\b(research|investigate|explore|analyze|compare|evaluate|benchmark|measure|profile|survey|study)\b/i,
    zh: /(研究|调查|分析|评估|对比|评测|基准测试|测量|画像|调研|考察|学习|探索)/,
  },
  planning: {
    en: /\b(plan|roadmap|strategy|design|architect|spec|specification|rfc|proposal|estimate|prioritize|schedule|timeline|milestone)\b/i,
    zh: /(规划|路线图|战略|策略|设计|架构|规范|提案|估算|优先级|时间表|时间线|里程碑|计划|方案|蓝图)/,
  },
  communication: {
    en: /\b(message|notify|slack|email|communicate|tell\s|announce|broadcast|ping|alert|report\s+to|inform|update\s+the\s+team)\b/i,
    zh: /(告诉|问|通知|发消息|转告|通报|告知|联系|沟通|喊一下|跟.{0,4}说|@|私信|群发)/,
  },
  codeChange: {
    en: /\b(implement|code|write|add|update|modify|refactor|create|build|develop|rename|move|copy|delete|remove|clean\s*up|optimize|improve|enhance|extend|extract|inline|merge|split|convert|transform|generate|scaffold|bootstrap|set\s*up|configure|install|integrate|connect|wire|hook\s*up|enable|disable|restart|reboot)\b/i,
    // CJK note: \b doesn't behave correctly between two CJK chars in JS,
    // so the bare-verb tokens (做/写/改/加) use negative lookaheads to
    // exclude their non-imperative suffixes rather than relying on \b.
    // Mia stricter-default: 做(?!了|过|得|的|出) excludes 做了/做过/做得/
    // 做的/做出 — the conversational/completed forms.
    // Issue #472: parallel symmetry fix — 做(?!...|错|坏|废|...) so the
    // codeChange category doesn't fire on "做错" / "做坏" / "做废" forms.
    zh: /(实现|添加|创建|开发|编写|搭建|新增|修改|更新|更改|重构|删除|移除|优化|增强|扩展|抽取|内联|合并|拆分|转换|生成|脚手架|配置|安装|集成|连接|启用|禁用|改成|改名|改完|改造|改一下|改个|做(?!了|过|得|的|出|错|坏|废|不到|不了)|写(?!不出|不来)|搞(?!砸|错|不定|不动|不了|乱|糊涂)|去掉|去除|加上|加入|加进|重启|启动)/,
  },
  query: {
    en: /\b(what|where|when|who|which|how|show|list|get|status|check|find|search|look\s*up|count|describe|explain)\b/i,
    zh: /(什么|哪里|哪|何时|谁|哪个|怎么|怎样|展示|列出|看|看看|查看|查询|状态|检查|查找|搜索|查阅|多少|描述|解释|说明)/,
  },
} as const;
