/**
 * Scan active boards for due / overdue / stale work and send nudges.
 *
 * Delivery order:
 *   1. Resend (if configured)
 *   2. Connected Gmail (Google integration) as fallback
 */

import TaskBoard from '../models/TaskBoard.js';
import User from '../models/User.js';
import {
  sendEmail,
  isEmailConfigured,
  dueDigestTemplate,
  staleBoardTemplate,
} from '../services/email/index.js';
import { getProvider } from '../integrations/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('jobs:reminders');

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function remindedToday(date) {
  if (!date) return false;
  return new Date(date) >= startOfToday();
}

function isSunday() {
  return new Date().getDay() === 0;
}

async function deliver({ user, subject, text }) {
  if (isEmailConfigured()) {
    await sendEmail({ to: user.email, subject, text });
    return 'resend';
  }

  const google = getProvider('google');
  if (google?.isConfigured?.()) {
    try {
      await google.sendMail({
        userId: user._id,
        to: user.email,
        subject,
        body: text,
      });
      return 'gmail';
    } catch (err) {
      log.warn('Gmail nudge failed', { user: String(user._id), error: err.message });
    }
  }

  log.info('No email channel available for nudge', { user: String(user._id) });
  return 'skipped';
}

function weeklySummaryTemplate({ name, boards }) {
  const lines = boards.map(
    b =>
      `• ${b.title}: ${b.percent}%` +
      (b.nextTask ? ` — next: ${b.nextTask.title}` : '') +
      (b.isBehind ? ' (behind)' : '')
  );
  const text = [
    `Hi ${name || 'there'},`,
    '',
    'Your weekly progress on AI Tools boards:',
    '',
    ...lines,
    '',
    '— AI Tools',
  ].join('\n');
  return {
    subject: `Weekly progress: ${boards.length} active board${boards.length === 1 ? '' : 's'}`,
    text,
  };
}

export async function runReminderScan() {
  const today = startOfToday();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const staleBefore = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

  const boards = await TaskBoard.find({ status: 'active' }).limit(500);
  const byUser = new Map();

  for (const board of boards) {
    const summary = board.summary();
    const key = String(board.user);
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push({ board, summary });
  }

  let sent = 0;
  let skipped = 0;

  for (const [userId, entries] of byUser) {
    const user = await User.findById(userId).select('email name reminders');
    if (!user?.email) continue;

    const prefs = user.reminders || {};
    const dueItems = [];

    for (const { board, summary } of entries) {
      if (remindedToday(board.lastRemindedAt)) continue;

      const next = summary.nextTask;
      const dueSoon =
        next?.dueDate &&
        new Date(next.dueDate) < tomorrow &&
        new Date(next.dueDate) >= new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

      if (prefs.emailDigest !== false && (summary.isBehind || dueSoon)) {
        dueItems.push({
          board,
          boardTitle: summary.title,
          nextTaskTitle: next?.title || 'Next task',
          dueDate: next?.dueDate,
          isBehind: summary.isBehind,
        });
      } else if (
        prefs.staleNudge !== false &&
        board.updatedAt < staleBefore &&
        summary.percent < 100
      ) {
        const daysIdle = Math.floor((Date.now() - new Date(board.updatedAt)) / 86_400_000);
        const tmpl = staleBoardTemplate({
          name: user.name,
          boardTitle: summary.title,
          daysIdle,
        });
        const channel = await deliver({ user, ...tmpl });
        if (channel !== 'skipped') {
          board.lastRemindedAt = new Date();
          await board.save();
          sent += 1;
        } else skipped += 1;
      }
    }

    if (dueItems.length && prefs.emailDigest !== false) {
      const tmpl = dueDigestTemplate({ name: user.name, items: dueItems });
      const channel = await deliver({ user, ...tmpl });
      if (channel !== 'skipped') {
        for (const item of dueItems) {
          item.board.lastRemindedAt = new Date();
          await item.board.save();
        }
        sent += 1;
      } else skipped += 1;
    }

    if (prefs.weeklySummary !== false && isSunday() && entries.length) {
      const already = entries.every(({ board }) => remindedToday(board.lastRemindedAt));
      if (!already) {
        const tmpl = weeklySummaryTemplate({
          name: user.name,
          boards: entries.map(e => e.summary),
        });
        const channel = await deliver({ user, ...tmpl });
        if (channel !== 'skipped') {
          for (const { board } of entries) {
            board.lastRemindedAt = new Date();
            await board.save();
          }
          sent += 1;
        } else skipped += 1;
      }
    }
  }

  log.info('Reminder scan complete', { users: byUser.size, sent, skipped });
  return { users: byUser.size, sent, skipped };
}

export async function listDueBoards({ limit = 100 } = {}) {
  const today = startOfToday();
  const boards = await TaskBoard.find({ status: 'active' }).limit(500);
  const out = [];

  for (const board of boards) {
    const summary = board.summary();
    const next = summary.nextTask;
    if (!next) continue;

    const dueToday =
      next.dueDate &&
      new Date(next.dueDate) < new Date(today.getTime() + 86_400_000) &&
      new Date(next.dueDate) >= today;

    if (!summary.isBehind && !dueToday) continue;

    const user = await User.findById(board.user).select('email name reminders');
    if (!user) continue;
    if (user.reminders?.emailDigest === false) continue;

    out.push({
      boardId: String(board._id),
      title: summary.title,
      userEmail: user.email,
      userName: user.name,
      nextTask: next,
      isBehind: summary.isBehind,
      percent: summary.percent,
      lastRemindedAt: board.lastRemindedAt,
    });

    if (out.length >= limit) break;
  }

  return out;
}

export default { runReminderScan, listDueBoards };
