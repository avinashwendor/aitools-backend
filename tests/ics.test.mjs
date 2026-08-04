import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { boardToIcs } from '../src/tasks/ics.js';
import { signCalendarToken, verifyCalendarToken } from '../src/integrations/crypto.js';

describe('ICS export', () => {
  test('emits VEVENT rows for tasks with due dates', () => {
    const ics = boardToIcs({
      title: 'Newsletter launch',
      tasks: [
        {
          taskId: 't1',
          title: 'Write draft',
          toolSlug: 'chatgpt',
          dueDate: new Date('2026-08-10T00:00:00Z'),
          status: 'todo',
        },
        { taskId: 't2', title: 'No date', toolSlug: 'x', dueDate: null, status: 'todo' },
      ],
    });

    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, /SUMMARY:Write draft/);
    assert.match(ics, /UID:t1@aitools/);
    assert.doesNotMatch(ics, /No date/);
  });
});

describe('calendar token', () => {
  test('round-trips board and user ids', () => {
    const token = signCalendarToken('507f1f77bcf86cd799439011', '507f191e810c19729de860ea');
    const verified = verifyCalendarToken(token);
    assert.equal(verified.boardId, '507f1f77bcf86cd799439011');
    assert.equal(verified.userId, '507f191e810c19729de860ea');
    assert.equal(verifyCalendarToken('bad.token.here'), null);
  });
});

describe('oauth state', () => {
  test('signs and verifies user id', async () => {
    const { signOAuthState, verifyOAuthState } = await import('../src/integrations/crypto.js');
    const state = signOAuthState('507f191e810c19729de860ea');
    const verified = verifyOAuthState(state);
    assert.equal(verified.userId, '507f191e810c19729de860ea');
    assert.equal(verifyOAuthState('forged.state'), null);
  });
});
