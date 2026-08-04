/**
 * Transactional email via Resend. No-ops cleanly when RESEND_API_KEY is unset.
 */

import { Resend } from 'resend';
import config from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('email');

let client = null;

function getClient() {
  if (!config.email?.resendApiKey) return null;
  if (!client) client = new Resend(config.email.resendApiKey);
  return client;
}

export function isEmailConfigured() {
  return Boolean(config.email?.resendApiKey);
}

export async function sendEmail({ to, subject, text, html }) {
  const resend = getClient();
  if (!resend) {
    log.info('Email skipped (RESEND_API_KEY unset)', { to, subject });
    return { skipped: true };
  }

  const { data, error } = await resend.emails.send({
    from: config.email.from,
    to: Array.isArray(to) ? to : [to],
    subject,
    text,
    html: html || undefined,
  });

  if (error) {
    log.warn('Resend send failed', { error: error.message || error });
    throw new Error(error.message || 'Failed to send email');
  }

  return { id: data?.id, skipped: false };
}

export function dueDigestTemplate({ name, items }) {
  const lines = items.map(
    i =>
      `• ${i.boardTitle}: ${i.nextTaskTitle}` +
      (i.dueDate ? ` (due ${new Date(i.dueDate).toLocaleDateString('en-IN')})` : '') +
      (i.isBehind ? ' — behind' : '')
  );
  const text = [
    `Hi ${name || 'there'},`,
    '',
    'Here is what is due on your AI Tools boards:',
    '',
    ...lines,
    '',
    'Open your tasks: continue where you left off in the app.',
    '',
    '— AI Tools',
  ].join('\n');

  return {
    subject: `You have ${items.length} task${items.length === 1 ? '' : 's'} waiting`,
    text,
  };
}

export function staleBoardTemplate({ name, boardTitle, daysIdle }) {
  const text = [
    `Hi ${name || 'there'},`,
    '',
    `Your board "${boardTitle}" has been quiet for ${daysIdle} day${daysIdle === 1 ? '' : 's'}.`,
    'A short session today keeps the momentum.',
    '',
    '— AI Tools',
  ].join('\n');

  return {
    subject: `Still working on ${boardTitle}?`,
    text,
  };
}

export default { sendEmail, isEmailConfigured, dueDigestTemplate, staleBoardTemplate };
