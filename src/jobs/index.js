/**
 * Job queue — BullMQ when REDIS_URL is set, otherwise Mongo-locked inline scan.
 */

import { Queue, Worker } from 'bullmq';
import config from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { runReminderScan } from './reminders.js';
import { tryAcquireLock } from './lock.js';
import { pruneAllExpiredSessions } from '../ai/memory.js';

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

async function runHourlyMaintenance() {
  await runReminderScan();
  try {
    const pruned = await pruneAllExpiredSessions();
    if (pruned > 0) log.info('Pruned expired sessions', { pruned });
  } catch (err) {
    log.warn('Session prune failed', { error: err.message });
  }
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
  const hour = 60 * 60 * 1000;

  if (!isQueueConfigured()) {
    log.info(
      config.isProd
        ? 'REDIS_URL unset — reminder/prune interval uses Mongo advisory lock (single runner across replicas)'
        : 'Job workers using inline interval (no REDIS_URL)'
    );
    const timer = setInterval(() => {
      tryAcquireLock('reminders:hourly', hour - 60_000)
        .then(acquired => {
          if (!acquired) {
            log.debug('Reminder lock held by another replica — skipping');
            return null;
          }
          return runHourlyMaintenance();
        })
        .catch(err => log.warn('Inline reminder scan failed', { error: err.message }));
    }, hour);
    timer.unref();
    // Kick once shortly after boot so digests aren't delayed a full hour.
    setTimeout(() => {
      tryAcquireLock('reminders:boot', 5 * 60_000)
        .then(acquired => (acquired ? runHourlyMaintenance() : null))
        .catch(() => {});
    }, 45_000).unref?.();
    return;
  }

  reminderWorker = new Worker(
    'reminders',
    async () => runHourlyMaintenance(),
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
        repeat: { every: hour },
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
