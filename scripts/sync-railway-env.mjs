#!/usr/bin/env node
/**
 * Push backend/.env values to the linked Railway service.
 * Usage (from backend/):
 *   railway login
 *   railway link          # pick your backend service
 *   node scripts/sync-railway-env.mjs
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');

const PROD_FRONTEND = 'https://aitools-frontned-production.up.railway.app';
const PROD_BACKEND = 'https://aitools-backend-production.up.railway.app';

function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i === -1) continue;
    const key = trimmed.slice(0, i).trim();
    let val = trimmed.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function sanitizeProviders(raw) {
  if (!raw) return '';
  let providers;
  try {
    providers = JSON.parse(raw);
  } catch {
    console.error('✖ AI_PROVIDERS in .env is not valid JSON');
    process.exit(1);
  }
  if (!Array.isArray(providers)) {
    console.error('✖ AI_PROVIDERS must be a JSON array');
    process.exit(1);
  }
  const cleaned = providers.filter(p => {
    const key = p.apiKey ? String(p.apiKey) : '';
    if (!key || key.includes('REPLACE_WITH')) return false;
    return Boolean(p.planner || p.plannerModel);
  });
  return JSON.stringify(cleaned);
}

function railway(args) {
  const res = spawnSync('npx', ['--yes', '@railway/cli', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || '').trim();
    console.error(err || `railway ${args.join(' ')} failed`);
    process.exit(res.status || 1);
  }
  return (res.stdout || '').trim();
}

let env;
try {
  env = parseEnv(readFileSync(envPath, 'utf8'));
} catch {
  console.error(`✖ Missing ${envPath} — copy .env.example and fill it in first.`);
  process.exit(1);
}

const mongoUri = env.MONGODB_URI || env.MONGO_URL || env.MONGO_URI;
if (!mongoUri) {
  console.error('✖ MONGODB_URI is required in .env');
  process.exit(1);
}

const jwtSecret =
  env.JWT_SECRET && env.JWT_SECRET.length >= 32 && !env.JWT_SECRET.startsWith('change-me')
    ? env.JWT_SECRET
    : randomBytes(48).toString('base64');

const encryptionKey =
  env.INTEGRATION_ENCRYPTION_KEY && env.INTEGRATION_ENCRYPTION_KEY.length >= 32
    ? env.INTEGRATION_ENCRYPTION_KEY
    : randomBytes(32).toString('hex');

const internalSecret =
  env.INTERNAL_API_SECRET && env.INTERNAL_API_SECRET.length >= 24
    ? env.INTERNAL_API_SECRET
    : randomBytes(32).toString('hex');

const corsOrigins = env.CORS_ORIGINS
  ? env.CORS_ORIGINS
  : `${PROD_FRONTEND},http://localhost:5173,http://localhost:4173`;

const googleRedirect =
  env.GOOGLE_REDIRECT_URI && !env.GOOGLE_REDIRECT_URI.includes('localhost')
    ? env.GOOGLE_REDIRECT_URI
    : env.GOOGLE_CLIENT_ID
      ? `${PROD_BACKEND}/api/integrations/google/callback`
      : env.GOOGLE_REDIRECT_URI || '';

const aiProviders = sanitizeProviders(env.AI_PROVIDERS);
if (!aiProviders || aiProviders === '[]') {
  console.error('✖ No valid AI providers in AI_PROVIDERS');
  process.exit(1);
}

const pairs = [
  ['NODE_ENV', 'production'],
  ['MONGODB_URI', mongoUri],
  ['JWT_SECRET', jwtSecret],
  ['JWT_EXPIRES_IN', env.JWT_EXPIRES_IN || '7d'],
  ['AI_PROVIDERS', aiProviders],
  ['AI_TEMPERATURE', env.AI_TEMPERATURE || '0.35'],
  ['AI_MAX_TOKENS', env.AI_MAX_TOKENS || '4096'],
  ['AI_TIMEOUT_MS', env.AI_TIMEOUT_MS || '45000'],
  ['AI_RATE_LIMIT_WINDOW_MS', env.AI_RATE_LIMIT_WINDOW_MS || '60000'],
  ['AI_RATE_LIMIT_MAX', env.AI_RATE_LIMIT_MAX || '20'],
  ['CORS_ORIGINS', corsOrigins],
  ['INTEGRATION_ENCRYPTION_KEY', encryptionKey],
  ['INTERNAL_API_SECRET', internalSecret],
];

if (env.TAVILY_API_KEY) pairs.push(['TAVILY_API_KEY', env.TAVILY_API_KEY]);
if (env.TAVILY_MONTHLY_CREDIT_CAP) pairs.push(['TAVILY_MONTHLY_CREDIT_CAP', env.TAVILY_MONTHLY_CREDIT_CAP]);
if (env.REDIS_URL) pairs.push(['REDIS_URL', env.REDIS_URL]);
if (env.QDRANT_URL) pairs.push(['QDRANT_URL', env.QDRANT_URL]);
if (env.QDRANT_API_KEY) pairs.push(['QDRANT_API_KEY', env.QDRANT_API_KEY]);
if (env.GOOGLE_CLIENT_ID) pairs.push(['GOOGLE_CLIENT_ID', env.GOOGLE_CLIENT_ID]);
if (env.GOOGLE_CLIENT_SECRET) pairs.push(['GOOGLE_CLIENT_SECRET', env.GOOGLE_CLIENT_SECRET]);
if (googleRedirect) pairs.push(['GOOGLE_REDIRECT_URI', googleRedirect]);
if (env.RESEND_API_KEY) pairs.push(['RESEND_API_KEY', env.RESEND_API_KEY]);
if (env.EMAIL_FROM) pairs.push(['EMAIL_FROM', env.EMAIL_FROM]);
if (env.BILLING_SALES_EMAIL) pairs.push(['BILLING_SALES_EMAIL', env.BILLING_SALES_EMAIL]);

if (!env.INTEGRATION_ENCRYPTION_KEY) {
  console.log('Generated INTEGRATION_ENCRYPTION_KEY (save to .env to keep stable across syncs)');
}
if (!env.INTERNAL_API_SECRET) {
  console.log('Generated INTERNAL_API_SECRET (save to .env to keep stable across syncs)');
}
if (!env.REDIS_URL) {
  console.warn(
    '⚠ REDIS_URL unset — reminders use Mongo lock across replicas. Add Railway Redis for shared rate limits.'
  );
}

console.log('Checking Railway auth…');
railway(['whoami']);

const args = ['variables', '--set'];
for (const [key, value] of pairs) {
  args.push(`${key}=${value}`);
}

console.log(`Setting ${pairs.length} variables on the linked Railway service…`);
railway(args);

console.log('✓ Railway variables synced. Redeploy if the service is still crash-looping.');
console.log(
  `  Reminder cron (optional with Redis): POST ${PROD_BACKEND}/api/internal/reminders/run`
);
console.log('  Header: x-internal-secret: <INTERNAL_API_SECRET>');
