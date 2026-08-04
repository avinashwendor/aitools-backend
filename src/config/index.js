/**
 * Application Configuration
 * Every value is env-driven. Defaults are safe for local development only —
 * production must supply MONGODB_URI, JWT_SECRET and an AI provider key.
 */

import dotenv from 'dotenv';
dotenv.config();

const bool = (v, fallback = false) =>
  v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const list = (v, fallback = []) =>
  v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : fallback;

const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';
const isRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);

/** Railway MongoDB injects MONGO_URL; Atlas and local dev use MONGODB_URI. */
function resolveMongoUri() {
  return (
    process.env.MONGODB_URI ||
    process.env.MONGO_URL ||
    process.env.MONGO_URI ||
    process.env.DATABASE_URL ||
    ''
  );
}

/**
 * Builds the ordered AI provider chain.
 *
 * Two ways to configure, checked in order:
 *
 *  1. AI_PROVIDERS — a JSON array, for multi-provider failover:
 *       [{"name":"openrouter","baseUrl":"https://openrouter.ai/api/v1",
 *         "apiKey":"sk-or-…","planner":"openai/gpt-5.6-luna",
 *         "fast":"openai/gpt-5-mini","fallbacks":["openai/gpt-5-mini"]}]
 *
 *  2. The flat AI_BASE_URL / AI_API_KEY / AI_MODEL_* variables (single provider).
 *     GROQ_API_KEY is still honoured so older deployments keep working.
 *
 * Entries without an apiKey are dropped — a provider you cannot authenticate
 * against is worse than absent, because it burns a retry cycle on every call.
 */
function buildProviders() {
  const raw = process.env.AI_PROVIDERS;

  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(`✖ AI_PROVIDERS is not valid JSON: ${err.message}`);
      process.exit(1);
    }
    if (!Array.isArray(parsed)) {
      console.error('✖ AI_PROVIDERS must be a JSON array.');
      process.exit(1);
    }

    return parsed
      .map((p, i) => ({
        name: p.name || p.baseUrl || `provider-${i + 1}`,
        baseUrl: p.baseUrl || 'https://api.openai.com/v1',
        apiKey: p.apiKey ? String(p.apiKey) : '',
        plannerModel: p.planner || p.plannerModel,
        fastModel: p.fast || p.fastModel || p.planner || p.plannerModel,
        fallbackModels: Array.isArray(p.fallbacks) ? p.fallbacks : [],
        /** Providers whose models reject response_format:{type:'json_object'}. */
        noJsonMode: Boolean(p.noJsonMode),
      }))
      .filter(p => p.apiKey && p.plannerModel);
  }

  const apiKey = process.env.AI_API_KEY || process.env.GROQ_API_KEY;
  if (!apiKey) return [];

  return [{
    name: 'default',
    baseUrl: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1',
    apiKey,
    plannerModel: process.env.AI_MODEL_PLANNER || 'openai/gpt-oss-120b',
    fastModel: process.env.AI_MODEL_FAST || process.env.AI_MODEL_PLANNER || 'llama-3.3-70b-versatile',
    fallbackModels: list(process.env.AI_MODEL_FALLBACKS, []),
    noJsonMode: false,
  }];
}

const config = {
  nodeEnv,
  isProd,
  port: num(process.env.PORT, 5002),

  mongoUri: resolveMongoUri(),
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  corsOrigins: list(process.env.CORS_ORIGINS, [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:4173',
  ]),

  // Pagination defaults
  defaultPageSize: num(process.env.DEFAULT_PAGE_SIZE, 12),
  maxPageSize: num(process.env.MAX_PAGE_SIZE, 50),

  // ─── AI ────────────────────────────────────────────────────
  ai: {
    /**
     * Ordered provider chain. Each entry is an independent OpenAI-compatible
     * endpoint with its own key and model names.
     *
     * A single provider is a single point of failure: an exhausted token pack
     * or an unfunded account returns 429/401 for EVERY model it offers, so
     * model-level fallback alone cannot recover. Falling through to the next
     * provider can.
     *
     * Configure with AI_PROVIDERS as a JSON array, or with the flat
     * AI_BASE_URL / AI_API_KEY / AI_MODEL_* variables for a single provider.
     */
    providers: buildProviders(),

    temperature: num(process.env.AI_TEMPERATURE, 0.35),
    maxTokens: num(process.env.AI_MAX_TOKENS, 4096),
    timeoutMs: num(process.env.AI_TIMEOUT_MS, 45000),
    maxRetries: num(process.env.AI_MAX_RETRIES, 2),

    /** Retrieval */
    retrievalCandidates: num(process.env.AI_RETRIEVAL_CANDIDATES, 32),

    /** Workflow shape guardrails */
    minStages: num(process.env.AI_MIN_STAGES, 3),
    maxStages: num(process.env.AI_MAX_STAGES, 6),

    /** Response cache */
    cacheTtlMs: num(process.env.AI_CACHE_TTL_MS, 30 * 60 * 1000),
    cacheMaxEntries: num(process.env.AI_CACHE_MAX, 500),

    /** Conversation memory */
    memoryTurns: num(process.env.AI_MEMORY_TURNS, 8),
    memoryTtlDays: num(process.env.AI_MEMORY_TTL_DAYS, 30),

    /** Per-user rate limit for AI endpoints */
    rateLimitWindowMs: num(process.env.AI_RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMax: num(process.env.AI_RATE_LIMIT_MAX, 20),

    verbose: bool(process.env.AI_VERBOSE, !isProd),
  },

  // ─── Billing / credits ───────────────────────────────────────
  // The subscription layer is plan-and-credit based with no payment gateway
  // wired up yet: plans are assigned from the admin panel, and the pricing
  // page collects upgrade intent. Everything below is about *measuring* cost,
  // which has to be right regardless of how the money eventually arrives.
  billing: {
    /**
     * Fixed conversion for turning published USD token prices into the rupee
     * figures the admin dashboard reports. Deliberately not a live FX lookup —
     * historical cost rows must not move under you when the rupee does.
     * Ledger rows store the rupees computed at write time.
     */
    usdToInr: num(process.env.BILLING_USD_TO_INR, 88),

    /** Tavily list price per search credit, in USD. */
    searchCreditUsd: num(process.env.BILLING_SEARCH_CREDIT_USD, 0.008),

    /**
     * Days of ledger history kept. Aggregates for the admin charts are read
     * from this collection, so it needs to outlive the reporting window
     * comfortably — 400 days covers a full year plus comparison headroom.
     */
    ledgerRetentionDays: num(process.env.BILLING_LEDGER_RETENTION_DAYS, 400),

    /**
     * When true, a user who runs out of credits is warned but not blocked.
     * Useful for a launch period where you'd rather eat the cost than have
     * the product hard-stop on someone mid-evaluation.
     */
    softLimits: bool(process.env.BILLING_SOFT_LIMITS, false),

    /** Where "Talk to us" enquiries from the pricing page should land. */
    salesEmail: process.env.BILLING_SALES_EMAIL || 'sales@example.com',
  },

  // ─── Integrations & email ──────────────────────────────────
  integrations: {
    /** 64-char hex preferred. Rotating JWT must not invalidate OAuth tokens. */
    encryptionKey: process.env.INTEGRATION_ENCRYPTION_KEY || '',
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirectUri:
        process.env.GOOGLE_REDIRECT_URI ||
        `http://localhost:${num(process.env.PORT, 5002)}/api/integrations/google/callback`,
    },
  },
  email: {
    resendApiKey: process.env.RESEND_API_KEY || '',
    from: process.env.EMAIL_FROM || 'AI Tools <noreply@example.com>',
  },
  /** Shared secret for n8n / internal due-boards webhook. */
  internalApiSecret: process.env.INTERNAL_API_SECRET || '',

  // ─── Vector search (Qdrant) ──────────────────────────────────
  // Optional — same pattern as the AI provider chain: absent config means the
  // feature is cleanly disabled (pure-BM25 retrieval, no semantic memory),
  // not a crash. Point QDRANT_URL at Railway's Qdrant template in production.
  vector: {
    url: process.env.QDRANT_URL || '',
    apiKey: process.env.QDRANT_API_KEY || '',
    embeddingModel: process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2',
    dimensions: num(process.env.EMBEDDING_DIMENSIONS, 384),
  },

  // ─── Web search (Tavily) ─────────────────────────────────────
  search: {
    tavilyApiKey: process.env.TAVILY_API_KEY || '',
    // Leaves headroom on the free 1,000/mo credit pool rather than running it
    // to zero and hard-failing mid-month.
    monthlyCreditCap: num(process.env.TAVILY_MONTHLY_CREDIT_CAP, 900),
    cacheTtlMs: num(process.env.WEB_SEARCH_CACHE_TTL_MS, 6 * 60 * 60 * 1000),
  },

  logLevel: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
};

// ─── Startup validation ──────────────────────────────────────
const missing = [];
if (!config.mongoUri) missing.push('MONGODB_URI (or MONGO_URL)');
if (!config.jwtSecret) missing.push('JWT_SECRET');

if (missing.length) {
  console.error(`\n✖ Missing required environment variables: ${missing.join(', ')}\n`);

  if (isRailway) {
    console.error(
      '  Railway → backend service → Variables:\n' +
      '    MONGODB_URI=${{MongoDB.MONGO_URL}}   (or your Atlas connection string)\n' +
      '    JWT_SECRET=<openssl rand -base64 48>\n' +
      '    NODE_ENV=production\n'
    );
  } else {
    console.error('  Copy backend/.env.example to backend/.env and fill them in.\n');
  }

  process.exit(1);
}

if (isProd) {
  if (config.jwtSecret.length < 32) {
    console.error('✖ JWT_SECRET must be at least 32 characters in production.');
    process.exit(1);
  }
  if (!config.ai.providers?.length) {
    console.warn('⚠ No AI providers configured — AI chat and workflow features will be disabled.');
  }
  if (!process.env.REDIS_URL) {
    console.warn(
      '⚠ REDIS_URL is unset in production — reminder jobs run in-process per replica and may duplicate emails. Add the Railway Redis plugin.'
    );
  }
  if (!config.integrations.encryptionKey) {
    console.warn(
      '⚠ INTEGRATION_ENCRYPTION_KEY is unset — OAuth tokens and ICS feeds fall back to JWT_SECRET. Generate with: openssl rand -hex 32'
    );
  }
  if (!config.internalApiSecret) {
    console.warn('⚠ INTERNAL_API_SECRET is unset — /api/internal/due-boards will return 503.');
  }
}

export default config;
