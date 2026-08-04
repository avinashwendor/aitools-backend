/**
 * Build a VEVENT calendar for a task board (ICS).
 */

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatDateOnly(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function formatUtcStamp(date = new Date()) {
  const d = new Date(date);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function escapeText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/**
 * @param {object} board TaskBoard document
 * @returns {string} ICS file contents
 */
export function boardToIcs(board) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AI Tools//Task Board//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(board.title || 'AI Tools tasks')}`,
  ];

  for (const task of board.tasks || []) {
    if (!task.dueDate) continue;
    const start = formatDateOnly(task.dueDate);
    const endDate = new Date(task.dueDate);
    endDate.setUTCDate(endDate.getUTCDate() + 1);
    const end = formatDateOnly(endDate);
    const uid = `${task.taskId}@aitools`;

    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${formatUtcStamp()}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${escapeText(task.title)}`,
      `DESCRIPTION:${escapeText(`${board.title || ''} — ${task.toolSlug || ''}`)}`,
      task.status === 'done' ? 'STATUS:COMPLETED' : 'STATUS:CONFIRMED',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

export default { boardToIcs };
