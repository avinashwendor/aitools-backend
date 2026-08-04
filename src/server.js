import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import mongoose from 'mongoose';
import crypto from 'crypto';

import config from './config/index.js';
import routes from './routes/index.js';
import createMcpRouter from './mcp/index.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';
import { rateLimit } from './middleware/rateLimit.js';
import { getCatalog, warmVectorIndex } from './ai/catalog.js';
import { createLogger } from './utils/logger.js';
import { startJobWorkers, stopJobWorkers } from './jobs/index.js';
import { startAgentWorkers, stopAgentWorkers } from './agentic/queue.js';
import { closeEventBus } from './agentic/events.js';

const log = createLogger('server');
const app = express();

// Behind a proxy/load balancer, trust X-Forwarded-For so rate limiting and
// logging see the real client address.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ─── Security & transport ────────────────────────────────────
app.use(
  helmet({
    // The API serves JSON to a separate origin; CSP belongs on the frontend host.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin requests and curl have no Origin header.
      if (!origin) return callback(null, true);
      if (config.corsOrigins.includes(origin)) return callback(null, true);
      log.warn('Blocked CORS origin', { origin });
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);

app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ─── Request context & logging ───────────────────────────────
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomBytes(6).toString('hex');
  res.setHeader('X-Request-Id', req.id);

  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
    log[level](`${req.method} ${req.originalUrl} ${res.statusCode}`, { ms, id: req.id });
  });

  next();
});

// Broad safety net against abuse; the AI routes add a tighter per-user cap.
app.use(
  '/api',
  rateLimit({
    windowMs: 60_000,
    max: 300,
    keyGenerator: req => req.ip,
  })
);
// MCP sits outside /api — same IP safety net.
app.use(
  '/mcp',
  rateLimit({
    windowMs: 60_000,
    max: 120,
    keyGenerator: req => req.ip,
  })
);

// ─── Routes ──────────────────────────────────────────────────
app.use('/api', routes);
// Short MCP URL for clients (same handlers as /api/mcp)
app.use('/mcp', createMcpRouter());

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'AI Tools API',
    version: '2.0.0',
    health: '/api/health',
  });
});

app.use(notFound);
app.use(errorHandler);

// ─── Boot ────────────────────────────────────────────────────
let server;

/**
 * Connect with bounded backoff. A database that is briefly unreachable at boot
 * (rolling restart, DNS warm-up, a laptop that changed networks) shouldn't
 * crash-loop the process — but a genuinely misconfigured URI still fails fast.
 */
async function connectMongo({ attempts = 5 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await mongoose.connect(config.mongoUri, {
        serverSelectionTimeoutMS: 10_000,
        maxPoolSize: 20,
      });
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      const backoff = Math.min(2 ** attempt * 500, 8_000);
      log.warn(`MongoDB unreachable, retrying in ${backoff}ms`, {
        attempt,
        of: attempts,
        error: err.message.split('\n')[0].slice(0, 120),
      });
      await new Promise(r => setTimeout(r, backoff));
    }
  }
}

async function start() {
  log.info('Connecting to MongoDB…');
  await connectMongo();
  log.info('MongoDB connected');

  // Warm the retrieval index so the first user request isn't the one that
  // pays for building it.
  try {
    const catalog = await getCatalog({ force: true });
    log.info('Retrieval index warm', {
      tools: catalog.tools.length,
      categories: catalog.categories.length,
    });

    const vector = await warmVectorIndex();
    if (vector.configured === false) {
      log.info('Vector search unavailable', { reason: vector.reason });
    } else if (vector.ok === false) {
      log.error('Vector store not populated — semantic search will use BM25 only', vector);
    } else {
      log.info('Vector store ready', {
        succeeded: vector.succeeded,
        attempted: vector.attempted,
        ms: vector.ms,
      });
    }
  } catch (err) {
    log.warn('Could not warm retrieval index', { error: err.message });
  }

  server = app.listen(config.port, () => {
    log.info(`Server listening on :${config.port}`, { env: config.nodeEnv });
    startJobWorkers();
    startAgentWorkers();
  });
}

// ─── Graceful shutdown ───────────────────────────────────────
async function shutdown(signal) {
  log.info(`Received ${signal}, shutting down…`);

  const force = setTimeout(() => {
    log.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
  force.unref();

  try {
    await stopJobWorkers().catch(() => {});
    // Stop taking new runs before closing the HTTP server, so a run that is
    // mid-flight gets the remaining shutdown window to finish and write its
    // terminal state rather than being cut off at `running`.
    await stopAgentWorkers().catch(() => {});
    await closeEventBus().catch(() => {});
    await new Promise(resolve => (server ? server.close(resolve) : resolve()));
    await mongoose.connection.close(false);
    log.info('Shutdown complete');
    process.exit(0);
  } catch (err) {
    log.error('Error during shutdown', { error: err.message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', err => {
  log.error('Unhandled rejection', { error: err?.message, stack: err?.stack });
});

process.on('uncaughtException', err => {
  log.error('Uncaught exception — exiting', { error: err?.message, stack: err?.stack });
  process.exit(1);
});

start().catch(err => {
  log.error('Failed to start server', { error: err.message, stack: err.stack });
  process.exit(1);
});

export default app;
