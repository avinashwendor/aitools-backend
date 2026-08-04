/**
 * Google Calendar + Gmail OAuth adapter.
 */

import config from '../config/index.js';
import Integration from '../models/Integration.js';
import { encryptSecret, decryptSecret, signOAuthState } from './crypto.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('integrations:google');

let googleApisPromise = null;

/** Deferred — googleapis is ~200MB on disk and unused when Google OAuth is off. */
async function loadGoogleApis() {
  if (!googleApisPromise) {
    googleApisPromise = import('googleapis').then(mod => mod.google);
  }
  return googleApisPromise;
}

export const id = 'google';
export const label = 'Google Calendar & Gmail';
export const authType = 'oauth2';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.send',
  'openid',
  'email',
  'profile',
];

export function isConfigured() {
  return Boolean(config.integrations?.google?.clientId && config.integrations?.google?.clientSecret);
}

async function oauthClient(redirectUri) {
  const googleApis = await loadGoogleApis();
  const { clientId, clientSecret, redirectUri: defaultRedirect } = config.integrations.google;
  return new googleApis.auth.OAuth2(clientId, clientSecret, redirectUri || defaultRedirect);
}

export async function connect({ userId }) {
  if (!isConfigured()) {
    const err = new Error('Google OAuth is not configured on this server');
    err.status = 503;
    throw err;
  }
  const client = await oauthClient();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: signOAuthState(String(userId)),
  });
  return { url };
}

export async function handleCallback({ code, userId }) {
  const client = await oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const googleApis = await loadGoogleApis();
  const oauth2 = googleApis.oauth2({ version: 'v2', auth: client });
  const me = await oauth2.userinfo.get();

  const doc = await Integration.findOneAndUpdate(
    { user: userId, provider: id },
    {
      $set: {
        accessTokenEnc: encryptSecret(tokens.access_token),
        refreshTokenEnc: tokens.refresh_token
          ? encryptSecret(tokens.refresh_token)
          : undefined,
        scopes: tokens.scope ? String(tokens.scope).split(' ') : SCOPES,
        externalAccountId: me.data.id,
        email: me.data.email,
        status: 'connected',
        lastError: null,
        meta: { picture: me.data.picture || null },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Keep existing refresh token if Google didn't re-issue one
  if (!tokens.refresh_token && doc.refreshTokenEnc) {
    /* already kept via undefined omit — re-fetch if we wiped it */
  }

  if (!tokens.refresh_token) {
    const existing = await Integration.findOne({ user: userId, provider: id });
    if (existing?.refreshTokenEnc && !doc.refreshTokenEnc) {
      doc.refreshTokenEnc = existing.refreshTokenEnc;
      await doc.save();
    }
  }

  return doc;
}

async function getAuthedClient(userId) {
  const integration = await Integration.findOne({
    user: userId,
    provider: id,
    status: 'connected',
  });
  if (!integration?.accessTokenEnc) {
    const err = new Error('Google is not connected');
    err.status = 404;
    throw err;
  }

  const client = await oauthClient();
  client.setCredentials({
    access_token: decryptSecret(integration.accessTokenEnc),
    refresh_token: integration.refreshTokenEnc
      ? decryptSecret(integration.refreshTokenEnc)
      : undefined,
  });

  client.on('tokens', async tokens => {
    try {
      const patch = {};
      if (tokens.access_token) patch.accessTokenEnc = encryptSecret(tokens.access_token);
      if (tokens.refresh_token) patch.refreshTokenEnc = encryptSecret(tokens.refresh_token);
      if (Object.keys(patch).length) {
        await Integration.updateOne({ _id: integration._id }, { $set: patch });
      }
    } catch (err) {
      log.warn('Failed to persist refreshed Google tokens', { error: err.message });
    }
  });

  return { client, integration };
}

/**
 * Push board tasks with due dates into Google Calendar as all-day events.
 * @param {object} board
 * @param {Record<string,string>} [existingEventIds] taskId → Google event id
 */
export async function push(board, existingEventIds = {}) {
  const googleApis = await loadGoogleApis();
  const { client } = await getAuthedClient(board.user);
  const calendar = googleApis.calendar({ version: 'v3', auth: client });
  const results = [];

  for (const task of board.tasks || []) {
    if (!task.dueDate || task.status === 'done') continue;
    const day = new Date(task.dueDate);
    const dateStr = day.toISOString().slice(0, 10);
    const end = new Date(day);
    end.setDate(end.getDate() + 1);
    const endStr = end.toISOString().slice(0, 10);

    const event = {
      summary: `[AI Tools] ${task.title}`,
      description: `From board: ${board.title}\nTool: ${task.toolSlug}`,
      start: { date: dateStr },
      end: { date: endStr },
    };

    const existingId = existingEventIds[task.taskId];
    try {
      if (existingId) {
        await calendar.events.patch({
          calendarId: 'primary',
          eventId: existingId,
          requestBody: event,
        });
        results.push({ taskId: task.taskId, eventId: existingId, updated: true });
      } else {
        const created = await calendar.events.insert({
          calendarId: 'primary',
          requestBody: event,
        });
        results.push({ taskId: task.taskId, eventId: created.data.id, updated: false });
      }
    } catch (err) {
      log.warn('Calendar push failed for task', {
        taskId: task.taskId,
        error: err.message,
      });
      // Stale event id — create fresh next time
      if (existingId) {
        try {
          const created = await calendar.events.insert({
            calendarId: 'primary',
            requestBody: event,
          });
          results.push({ taskId: task.taskId, eventId: created.data.id, updated: false });
        } catch (err2) {
          log.warn('Calendar re-insert also failed', { taskId: task.taskId, error: err2.message });
        }
      }
    }
  }

  return results;
}

export async function pull() {
  return { supported: false };
}

/**
 * Send a plain-text email via the user's Gmail (for due nudges).
 */
export async function sendMail({ userId, to, subject, body }) {
  const googleApis = await loadGoogleApis();
  const { client, integration } = await getAuthedClient(userId);
  const gmail = googleApis.gmail({ version: 'v1', auth: client });
  const from = integration.email || to;

  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  const encoded = Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded },
  });

  return { ok: true };
}

export default {
  id,
  label,
  authType,
  isConfigured,
  connect,
  handleCallback,
  push,
  pull,
  sendMail,
};
