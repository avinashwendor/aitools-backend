/**
 * Keep workflow.schedule aligned with the trigger.schedule node on the canvas.
 *
 * The scheduler reads workflow.schedule; the inspector edits the trigger node.
 * Without syncing them, the header says one thing and the graph another.
 */
import { computeNextRun } from './queue.js';

const DEFAULT_HOUR = 9;

export function parseAtHour(value, fallback = DEFAULT_HOUR) {
  const hour = Number(value);
  if (!Number.isFinite(hour)) return fallback;
  return Math.min(23, Math.max(0, Math.floor(hour)));
}

/** Read schedule settings from the graph's schedule trigger, if any. */
export function scheduleFromGraph(graph) {
  const node = graph?.nodes?.find(entry => entry.type === 'trigger.schedule');
  if (!node) return null;

  return {
    every: 'day',
    atHour: parseAtHour(node.data?.values?.atHour, DEFAULT_HOUR),
    weekdaysOnly: Boolean(node.data?.values?.weekdaysOnly),
  };
}

/**
 * Copy trigger.schedule fields onto workflow.schedule.
 *
 * `enabled` is preserved unless `opts.enableWhenPresent` is true — used when
 * the architect first adds a schedule trigger.
 */
export function syncWorkflowSchedule(workflow, { enableWhenPresent = false } = {}) {
  const fromGraph = scheduleFromGraph(workflow.graph);
  if (!fromGraph) {
    workflow.schedule.enabled = false;
    workflow.schedule.nextRunAt = null;
    return workflow;
  }

  workflow.schedule.every = 'day';
  workflow.schedule.atHour = fromGraph.atHour;

  if (enableWhenPresent) {
    workflow.schedule.enabled = true;
  }

  workflow.schedule.nextRunAt = workflow.schedule.enabled
    ? computeNextRun(workflow.schedule)
    : null;

  return workflow;
}

export function formatScheduleLabel(schedule) {
  if (!schedule?.enabled) return 'Schedule off';
  const hour = parseAtHour(schedule.atHour);
  return `Daily at ${String(hour).padStart(2, '0')}:00 UTC`;
}
