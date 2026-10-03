/**
 * Run timeline components (specs/2026-10-03-autonomy-metrics.md §UI).
 *
 * @module components/TraceTimeline
 */

export { TraceTimeline, TRACE_TIMELINE_MAX_POLL_MS, TRACE_TIMELINE_POLL_MS } from './TraceTimeline';
export type { TraceTimelineProps } from './TraceTimeline';
export { MetricsStrip, metricTiles, outcomeTone } from './MetricsStrip';
export type { MetricsStripProps } from './MetricsStrip';
export { TimelineGroupRow, groupTitle, groupMeta } from './TimelineGroupRow';
export type { TimelineGroupRowProps } from './TimelineGroupRow';
export * from './traceFormat';
