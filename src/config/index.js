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

/** Railway public service hostname — traffic here is billed as egress from other services. */
function isRailwayPublicHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h.endsWith('.up.railway.app');
}

/** Normalize Qdrant REST URL (private Railway hosts always use HTTP on port 6333). */
function finalizeQdrantUrl(url) {
  try {
    const u = new URL(url.includes('://') ? url : `http://${url}`);
    if (u.hostname.endsWith('.railway.internal')) {
      u.protocol = 'http:';
      if (!u.port) u.port = '6333';
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return String(url).trim();
  }
}

/**
 * Resolve Qdrant URL preferring Railway private networking.
 *
 * Railway bills egress when the backend calls Qdrant over *.up.railway.app.
 * In production set:
 *   QDRANT_URL=http://${{vectordb.RAILWAY_PRIVATE_DOMAIN}}:6333
 * or set QDRANT_PRIVATE_URL / QDRANT_PRIVATE_DOMAIN explicitly.
 */
function resolveQdrantUrl() {
  const privateUrl = (process.env.QDRANT_PRIVATE_URL || '').trim();
  const rawUrl = (process.env.QDRANT_URL || '').trim();
  if (!privateUrl && !rawUrl) return '';

  if (privateUrl) return finalizeQdrantUrl(privateUrl);

  try {
    const u = new URL(rawUrl.includes('://') ? rawUrl : `http://${rawUrl}`);
    const host = u.hostname.toLowerCase();

    if (host.endsWith('.railway.internal')) {
      return finalizeQdrantUrl(rawUrl);
    }

    if ((isRailway || isProd) && isRailwayPublicHost(host)) {
      const privateDomain = (process.env.QDRANT_PRIVATE_DOMAIN || '').trim();
      const vectordbPublic = (process.env.RAILWAY_SERVICE_VECTORDB_URL || '').trim().toLowerCase();

      if (privateDomain) {
        console.warn(
          `⚠ QDRANT_URL uses public host ${host} — using private http://${privateDomain}:6333 to avoid egress charges`
        );
        return finalizeQdrantUrl(`http://${privateDomain}:6333`);
      }

      if (vectordbPublic && host === vectordbPublic) {
        console.error(
          `✖ QDRANT_URL points at public vectordb host (${host}). Set QDRANT_URL=http://${{vectordb.RAILWAY_PRIVATE_DOMAIN}}:6333 on the backend service to avoid egress billing.`
        );
      } else {
        console.warn(
          `⚠ QDRANT_URL uses public Railway host ${host} — set QDRANT_PRIVATE_DOMAIN=${{vectordb.RAILWAY_PRIVATE_DOMAIN}} or use a private URL to avoid egress charges`
        );
      }
    }

    return finalizeQdrantUrl(rawUrl);
  } catch {
    return rawUrl;
  }
}

function resolveQdrantApiKey() {
  return (
    process.env.QDRANT_API_KEY ||
    process.env.QDRANT__SERVICE__API_KEY ||
    ''
  ).trim();
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

    /**
     * Amortised cost of one minute of browser session, in paise.
     *
     * Not a published price — it's our Railway browser service's monthly cost
     * divided by the session-minutes it can realistically serve. Env-tunable
     * because the honest number only appears once real runs are on the graph,
     * and re-deploying to correct an accounting constant is the wrong shape of
     * fix. Read by `pricing.browserCostPaise`.
     */
    browserPaisePerMinute: num(process.env.BILLING_BROWSER_PAISE_PER_MINUTE, 10),

    /** Where "Talk to us" enquiries from the pricing page should land. */
    salesEmail: process.env.BILLING_SALES_EMAIL || 'sales@example.com',
  },

  // ─── Agentic workflows ───────────────────────────────────────
  // Executable workflows: the node canvas and browser agents. The browser half
  // needs a Chrome that speaks CDP; everything else runs in-process.
  agentic: {
    /**
     * Whether runs execute at all. Off by default in development so a checkout
     * without a browser service doesn't queue runs that can never finish.
     */
    enabled: bool(process.env.AGENTIC_ENABLED, true),

    /**
     * Where the browser comes from.
     *
     * Two providers, and the default is deliberate.
     *
     * **browserbase** (default) — a hosted browser API. You pay per
     * session-minute actually used and nothing when idle. It also hands back a
     * live view URL and a recording of every session, which are the two things
     * that make a failed browser run debuggable rather than mysterious.
     *
     * **cdp** — a Chrome you host yourself (Browserless or Steel on Railway,
     * or a local Chrome with --remote-debugging-port). Cheaper at sustained
     * volume because you're paying for a container rather than per minute, but
     * it bills whether or not anyone runs anything, and there is no recording.
     *
     * The economics decide it for most people: an idle container costs money
     * every hour of every day, and browser workflows are bursty. Self-hosting
     * only wins once you're running enough sessions to keep it busy.
     *
     * Resolution is automatic — whichever is configured — so neither has to be
     * declared explicitly. `AGENT_BROWSER_PROVIDER` forces one when both are.
     */
    browser: {
      provider: (process.env.AGENT_BROWSER_PROVIDER || '').trim().toLowerCase(),

      /**
       * Browserbase. `BROWSERBASE_PROJECT_ID` is required alongside the key —
       * the API accepts a session create without it but bills it to no project,
       * which shows up as sessions you can't find in the dashboard.
       */
      browserbase: {
        apiKey: process.env.BROWSERBASE_API_KEY || '',
        projectId: process.env.BROWSERBASE_PROJECT_ID || '',
        /** us-west-2 | us-east-1 | eu-central-1 | ap-southeast-1 */
        region: process.env.BROWSERBASE_REGION || 'us-west-2',
        /** Ad blocking cuts page weight, which cuts both latency and cost. */
        blockAds: bool(process.env.BROWSERBASE_BLOCK_ADS, true),
        /** Stealth mode. Off by default: it costs more and most pages don't need it. */
        stealth: bool(process.env.BROWSERBASE_STEALTH, false),
      },

      /**
       * Self-hosted CDP endpoint, used when `provider` resolves to `cdp`.
       *
       * On Railway that means the Browserless v2 or Steel Browser template
       * deployed as a **private** service:
       *
       *   AGENT_BROWSER_WS=ws://browserless.railway.internal:3000?token=${{browserless.TOKEN}}
       *
       * Two things bite here. The service must bind to `::` (Railway's private
       * network is IPv6), and it must never be publicly exposed — an open CDP
       * socket is remote code execution, not merely an unauthenticated API.
       */
      wsEndpoint: process.env.AGENT_BROWSER_WS || process.env.BROWSER_WS_ENDPOINT || '',
      /**
       * Some images (Steel) mint a session over REST before handing out a CDP
       * socket. Set this to that base URL; leave empty to connect straight to
       * `wsEndpoint`.
       */
      apiUrl: process.env.AGENT_BROWSER_API_URL || '',
      apiToken: process.env.AGENT_BROWSER_TOKEN || '',
      /** Hard ceiling on a single session's life. Stops a hung page billing forever. */
      maxSessionMs: num(process.env.AGENT_BROWSER_MAX_SESSION_MS, 5 * 60 * 1000),
      /** Per-navigation and per-action timeout. */
      timeoutMs: num(process.env.AGENT_BROWSER_TIMEOUT_MS, 30_000),
      viewport: {
        width: num(process.env.AGENT_BROWSER_WIDTH, 1280),
        height: num(process.env.AGENT_BROWSER_HEIGHT, 800),
      },
    },

    /** Ceiling on a whole run, browser or not. */
    maxRunMs: num(process.env.AGENT_MAX_RUN_MS, 10 * 60 * 1000),
    /** Nodes a single graph may contain. Bounds worst-case run cost. */
    maxNodes: num(process.env.AGENT_MAX_NODES, 60),
    /**
     * Bytes of a single node's output kept on the run document. Beyond this the
     * value is truncated with a marker — a 16MB Mongo document limit hit
     * mid-run loses the whole execution history, including the error you needed.
     */
    maxOutputBytes: num(process.env.AGENT_MAX_OUTPUT_BYTES, 24_000),
    /**
     * Hosts a workflow may never reach. Blocks the classic SSRF targets: cloud
     * metadata services and our own private network. Enforced by the HTTP node
     * and by every browser navigation.
     */
    blockedHosts: list(process.env.AGENT_BLOCKED_HOSTS, [
      '169.254.169.254',
      'metadata.google.internal',
      'localhost',
      '127.0.0.1',
      '::1',
    ]),
    /** Allow requests to private IP ranges. Off outside development. */
    allowPrivateNetwork: bool(process.env.AGENT_ALLOW_PRIVATE_NETWORK, !isProd),
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
  // not a crash. On Railway use private networking (see resolveQdrantUrl).
  vector: {
    url: resolveQdrantUrl(),
    apiKey: resolveQdrantApiKey(),
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
      '⚠ REDIS_URL is unset in production — reminders use a Mongo advisory lock (safe across replicas); rate limits stay per-instance. Add Railway Redis when you can.'
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
  if (config.vector.url) {
    try {
      const host = new URL(config.vector.url).hostname.toLowerCase();
      if (isRailwayPublicHost(host)) {
        console.error(
          '✖ QDRANT_URL still points at a public Railway host — vector search will bill egress. ' +
          'Set QDRANT_URL=http://${{vectordb.RAILWAY_PRIVATE_DOMAIN}}:6333 on the backend service.'
        );
      }
    } catch {
      /* invalid URL logged elsewhere */
    }
  }
}

export default config;
