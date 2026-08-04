/**
 * Job queue — BullMQ when REDIS_URL is set, otherwise inline execution.
 */

import { Queue, Worker } from 'bullmq';
import config from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { runReminderScan } from './reminders.js';

const log = createLogger('jobs');

let reminderQueue = null;
let reminderWorker = null;

function redisConnection() {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  return { url };
}

export function isQueueConfigured() {
  return Boolean(process.env.REDIS_URL);
}

export async function enqueueReminderScan() {
  if (!isQueueConfigured()) {
    log.info('Running reminder scan inline (no REDIS_URL)');
    return runReminderScan();
  }

  if (!reminderQueue) {
    reminderQueue = new Queue('reminders', { connection: redisConnection() });
  }
  await reminderQueue.add('scan', {}, { removeOnComplete: 50, removeOnFail: 20 });
  return { queued: true };
}

export function startJobWorkers() {
  if (!isQueueConfigured()) {
    if (config.isProd) {
      log.warn(
        'REDIS_URL unset in production — skipping in-process reminder interval to avoid duplicate emails across replicas. Set REDIS_URL or trigger POST /api/internal/reminders/run from a single scheduler.'
      );
      return;
    }
    log.info('Job workers not started — REDIS_URL unset; reminders run on demand / cron inline');
    const hour = 60 * 60 * 1000;
    const timer = setInterval(() => {
      runReminderScan().catch(err =>
        log.warn('Inline reminder scan failed', { error: err.message })
      );
    }, hour);
    timer.unref();
    return;
  }

  reminderWorker = new Worker(
    'reminders',
    async () => runReminderScan(),
    { connection: redisConnection() }
  );

  reminderWorker.on('failed', (job, err) => {
    log.warn('Reminder job failed', { jobId: job?.id, error: err.message });
  });

  reminderQueue = reminderQueue || new Queue('reminders', { connection: redisConnection() });
  reminderQueue
    .add(
      'scan',
      {},
      {
        repeat: { every: 60 * 60 * 1000 },
        removeOnComplete: 20,
        jobId: 'reminder-hourly',
      }
    )
    .catch(err => log.warn('Failed to schedule reminder repeat', { error: err.message }));

  log.info('BullMQ reminder worker started');
}

export async function stopJobWorkers() {
  if (reminderWorker) await reminderWorker.close();
  if (reminderQueue) await reminderQueue.close();
}

export default { enqueueReminderScan, startJobWorkers, stopJobWorkers, isQueueConfigured };
