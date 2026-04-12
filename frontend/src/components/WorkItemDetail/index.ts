/**
 * WorkItem Detail Component Barrel Export
 *
 * @module components/WorkItemDetail
 */

export { WorkItemTimeline } from './WorkItemTimeline';
export { WorkItemMetrics } from './WorkItemMetrics';
export { WorkItemSummaryBar, computeWorkItemStats } from './WorkItemSummaryBar';
export type { WorkItemStatistics } from './WorkItemSummaryBar';
export type {
  WorkItem,
  WorkItemStatus,
  WorkItemType,
  WorkItemOwner,
  TimelineEvent,
  TimelineEventKind,
} from './workitem-detail.types';
export {
  getWorkItemStatusType,
  getWorkItemStatusLabel,
  getWorkItemTypeBadgeVariant,
  getWorkItemTypeLabel,
  getWorkItemOwnerLabel,
  formatRelativeTime,
  formatTimestamp,
  formatCost,
  formatTokens,
  buildTimeline,
} from './workitem-detail.types';
