/**
 * Schedules page (route `/triggers`) constants: thresholds, page sizes and
 * every label the page shows, so components carry no magic values.
 *
 * @module constants/schedules.constants
 */

/** Dashboard route (kept as `/triggers` so existing links keep working). */
export const SCHEDULES_ROUTE = '/triggers';

/** Nav label for the page. */
export const SCHEDULES_NAV_LABEL = 'Schedules';

/** A recurring schedule with this many runs left or fewer shows a renew warning. */
export const SCHEDULE_EXPIRY_WARN_REMAINING = 7;

/** History rows per page. */
export const SCHEDULE_HISTORY_PAGE_SIZE = 20;

/** How often the nav badge refreshes its count (ms). */
export const SCHEDULE_BADGE_POLL_MS = 60_000;

/** The EventBus subscriber the reconciler uses — harness-internal. */
export const RECONCILER_SUBSCRIBER = '__reconciler__';

/** Auto-generated follow-up names (`followup:<8 hex>`) are not human names. */
export const AUTO_FOLLOWUP_NAME_PATTERN = /^followup:[0-9a-f]{8}$/i;

/** Session name of the orchestrator. */
export const ORCHESTRATOR_SESSION = 'crewly-orc';

/** Short labels for common IANA timezones. */
export const TIMEZONE_SHORT_LABEL: Record<string, string> = {
  'America/New_York': 'ET',
  'America/Detroit': 'ET',
  'America/Toronto': 'ET',
  'America/Chicago': 'CT',
  'America/Denver': 'MT',
  'America/Phoenix': 'MT',
  'America/Los_Angeles': 'PT',
  'America/Vancouver': 'PT',
  'Asia/Shanghai': '北京时间',
  'Asia/Hong_Kong': '香港时间',
  'Asia/Taipei': '台北时间',
  'Asia/Tokyo': '东京时间',
  'Europe/London': '伦敦时间',
  UTC: 'UTC',
  'Etc/UTC': 'UTC',
};

/** Chinese weekday names, index = cron day-of-week (0 = Sunday). */
export const WEEKDAY_LABEL: readonly string[] = ['日', '一', '二', '三', '四', '五', '六'];

/** Every label on the page. */
export const SCHEDULE_TEXT = {
  PAGE_TITLE: '定时任务',
  PAGE_SUBTITLE: '团队按时自动去做的事，以及等着提醒你的事',
  TAB_SCHEDULED: '定时任务',
  TAB_REMINDERS: '提醒',
  TAB_HISTORY: '历史',
  SHOW_SYSTEM: '显示系统任务',
  REFRESH: '刷新',
  NEW: '新建',
  ENGINE_STOPPED: '定时引擎没有在运行，定时任务暂时不会触发。',
  EMPTY_SCHEDULED_TITLE: '还没有定时任务',
  EMPTY_SCHEDULED_BODY: '让负责人帮你设一个，比如「每天 22:30 发运营日报」，它会出现在这里。',
  EMPTY_REMINDERS_TITLE: '没有待触发的提醒',
  EMPTY_REMINDERS_BODY: '一次性的跟进提醒、等待某个事件的提醒会显示在这里。',
  EMPTY_HISTORY_TITLE: '没有历史记录',
  EMPTY_HISTORY_BODY: '已经结束或取消的任务会归档到这里。',
  HIDDEN_SYSTEM_HINT: (n: number) => `另有 ${n} 个系统任务已隐藏`,
  OTHER_TEAM: '其他',
  ORCHESTRATOR: 'Orchestrator',
  NEXT_RUN: '下次',
  LAST_RUN: '上次',
  NEVER_RUN: '还没运行过',
  RUNS: (count: number) => `已运行 ${count} 次`,
  RUNS_OF: (count: number, max: number) => `已运行 ${count}/${max} 次`,
  REMAINING: (n: number) => `还剩 ${n} 次`,
  EXPIRING_SOON: '快到期，需要续',
  ENDS_AROUND: (date: string) => `约 ${date} 停止`,
  PAUSED: '已暂停',
  RUNS_AS: '执行人',
  TEAM: '团队',
  SCHEDULE: '时间',
  RAW_CRON: 'Cron',
  CREATED_BY: '创建人',
  CREATED_AT: '创建于',
  DESCRIPTION: '内容',
  NO_DESCRIPTION: '没有详细说明',
  RESULT_OK: '成功',
  RESULT_SKIPPED: '跳过（上一次的还没做完）',
  RESULT_FAILED: '失败',
  HEADS_UP_SENT: '已提醒负责人续期',
  PAUSE: '暂停',
  RESUME: '恢复',
  CANCEL: '取消任务',
  DELETE: '删除',
  CANCEL_CONFIRM_TITLE: '取消这个定时任务？',
  CANCEL_CONFIRM_BODY: '取消后不会再触发，也不能恢复。需要时可以让负责人重新设置。',
  DELETE_CONFIRM_TITLE: '删除记录？',
  DELETE_CONFIRM_BODY: '这条记录会被永久删除。',
  WAITING_EVENTS: '等待事件',
  ONE_SHOT: '一次性提醒',
  WHEN_EVENT: (event: string) => `当 ${event} 发生时`,
  HISTORY_SUMMARY: (n: number) => `${n} 条已结束的记录`,
  EXPAND: '展开',
  COLLAPSE: '收起',
  PREV_PAGE: '上一页',
  NEXT_PAGE: '下一页',
  PAGE_OF: (page: number, pages: number) => `${page} / ${pages}`,
  STATUS_CANCELLED: '已取消',
  STATUS_EXHAUSTED: '已跑完',
  SYSTEM_CHIP: '系统',
  CRON_TASK_CHIP: '团队 cron',
  ID: 'ID',
} as const;

/** Labels for who created a trigger. */
export const CREATOR_LABEL: Record<string, string> = {
  user: '你',
  orchestrator: 'Orchestrator',
  agent: '成员',
  mission: '目标（Mission）',
  'delegate-task': '派活兜底检查',
  system: '系统',
};
