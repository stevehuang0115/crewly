/**
 * Ticket board constants (specs/ticket-loop.md, Phase 2).
 *
 * Endpoints, refresh cadence and every Chinese label the board shows, kept in
 * one place so components carry no magic values.
 *
 * @module constants/tickets.constants
 */

import type {
  TicketAcceptanceCheck,
  TicketAcceptanceSource,
  TicketBoardColumn,
  TicketKind,
  TicketPriority,
  TicketPriorityLabel,
} from '../types/ticket.types';

/** Base path of the tickets API. */
export const TICKETS_API_BASE = '/api/tickets';

/** Dashboard route of the board. */
export const TICKETS_ROUTE = '/tickets';

/** How often the board refreshes itself (ms). */
export const TICKETS_POLL_INTERVAL_MS = 15_000;

/** Delay between the last keystroke in the search box and the query (ms). */
export const TICKETS_SEARCH_DEBOUNCE_MS = 300;

/** Milliseconds in one day (auto-accept countdown). */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Columns shown on the board, in display order (`cancelled` stays hidden). */
export const TICKET_BOARD_COLUMN_ORDER: readonly TicketBoardColumn[] = [
  'idea',
  'todo',
  'in_progress',
  'blocked',
  'to_review',
  'done',
] as const;

/** Column headings. */
export const TICKET_COLUMN_LABEL: Record<TicketBoardColumn, string> = {
  idea: '想法',
  todo: '待处理',
  in_progress: '进行中',
  blocked: '阻塞',
  to_review: '待验收',
  done: '已完成',
  cancelled: '已取消',
};

/** Kind labels. */
export const TICKET_KIND_LABEL: Record<TicketKind, string> = {
  issue: '问题',
  feature: '需求',
  idea: '想法',
};

/** Kinds in display order. */
export const TICKET_KINDS: readonly TicketKind[] = ['issue', 'feature', 'idea'] as const;

/** Value of the kind filter meaning "every kind". */
export const TICKET_KIND_FILTER_ALL = 'all' as const;

/** Label of the "every kind" filter option. */
export const TICKET_KIND_FILTER_ALL_LABEL = '全部';

/** Priorities, most urgent first, with their display labels. */
export const TICKET_PRIORITY_OPTIONS: ReadonlyArray<{ value: TicketPriority; label: TicketPriorityLabel }> = [
  { value: 'urgent', label: 'P0' },
  { value: 'high', label: 'P1' },
  { value: 'normal', label: 'P2' },
  { value: 'low', label: 'P3' },
] as const;

/** Badge variant per priority label. */
export const TICKET_PRIORITY_VARIANT: Record<TicketPriorityLabel, 'error' | 'warning' | 'primary' | 'default'> = {
  P0: 'error',
  P1: 'warning',
  P2: 'primary',
  P3: 'default',
};

/** Acceptance source badge text (absent source = the owner). */
export const TICKET_ACCEPTANCE_SOURCE_LABEL: Record<TicketAcceptanceSource, string> = {
  owner: '我',
  decompose: '拆解',
  reject: '打回',
  agent: 'Agent',
};

/** Acceptance check badge text (absent check = judgment). */
export const TICKET_ACCEPTANCE_CHECK_LABEL: Record<TicketAcceptanceCheck, string> = {
  auto: '自动',
  judgment: '人工',
};

/** Human text for the origin channel. Unknown channels show as-is. */
export const TICKET_ORIGIN_CHANNEL_LABEL: Record<string, string> = {
  'slack-channel': 'Slack 频道',
  'slack-dm': 'Slack 私信',
  chat: '聊天',
  portal: '门户',
  mobile: '手机',
  'bug-button': 'Bug 按钮',
  agent: 'Agent',
  cron: '定时任务',
  mission: 'Mission',
  legacy: '旧记录',
};

/** Human text for each server refusal code. */
export const TICKET_ERROR_TEXT: Record<string, string> = {
  not_in_review: '这张单子不在待验收，不能打回',
  already_done: '这张单子已经完成了',
  open_work: '还有未完成的工作项，暂时不能验收',
  cancelled: '这张单子已取消',
  invalid: '输入无效',
};

/** Every piece of UI copy on the board. */
export const TICKET_TEXT = {
  PAGE_TITLE: '工单',
  PAGE_SUBTITLE: '你说过的每一件事都在这里',
  SEARCH_PLACEHOLDER: '搜索工单…',
  KIND_FILTER_ARIA: '类型筛选',
  REFRESH: '刷新',
  EMPTY_COLUMN: '暂无',
  EMPTY_BOARD_TITLE: '还没有工单',
  EMPTY_BOARD_DESC: '在 Slack 或聊天里说「请帮我…」，就会自动生成工单。',
  LOAD_FAILED: '加载工单失败',
  UNASSIGNED: '未分配',
  REJECT_BADGE: '打回',
  AUTO_ACCEPT_IN_DAYS: '天后自动验收',
  AUTO_ACCEPT_SOON: '即将自动验收',
  DETAIL_LOADING: '加载中…',
  TITLE_LABEL: '标题',
  SAVE: '保存',
  PRIORITY_LABEL: '优先级',
  KIND_LABEL: '类型',
  ORIGIN_LABEL: '来源',
  ASSIGNEE_LABEL: '负责人',
  DESCRIPTION_LABEL: '描述',
  REPLY_LABEL: 'Agent 的回答',
  NO_REPLY: '还没有回答',
  DISCUSSION_LABEL: '讨论',
  NO_DISCUSSION: '暂无讨论',
  ACCEPTANCE_LABEL: '验收标准',
  NO_ACCEPTANCE: '还没有验收标准',
  ACCEPTANCE_ADD_PLACEHOLDER: '新增一条验收标准…',
  ACCEPTANCE_CHECK_ARIA: '检查方式',
  ACCEPTANCE_ADD: '添加',
  ACCEPTANCE_REMOVE: '删除',
  SELF_CHECK_PASS: '自检通过',
  SELF_CHECK_FAIL: '自检未过',
  VERIFY: '验过了',
  REJECT: '打回',
  DISMISS: '不用记',
  REJECT_REASON_LABEL: '打回原因',
  REJECT_REASON_PLACEHOLDER: '哪里不对？这条会变成新的验收标准',
  REJECT_REASON_REQUIRED: '请填写打回原因',
  REJECT_CONFIRM: '确认打回',
  CANCEL: '取消',
  REJECTED_TIMES: '次打回',
  SUBMITTED_TIMES: '次提交',
} as const;
