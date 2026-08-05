import { Router } from 'express';
import mongoose from 'mongoose';
import config from '../config/index.js';
import { getCatalog, getVectorStoreHealth } from '../ai/catalog.js';
import { isLLMAvailable, getProviderStatus } from '../ai/llm.js';
import { getStats } from '../ai/telemetry.js';
import { getCacheStats } from '../ai/cache.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import authRoutes from './authRoutes.js';
import toolRoutes from './toolRoutes.js';
import commentRoutes from './commentRoutes.js';
import adminRoutes from './adminRoutes.js';
import chatRoutes from './chatRoutes.js';
import categoryRoutes from './categoryRoutes.js';
import taskRoutes from './taskRoutes.js';
import billingRoutes from './billingRoutes.js';
import apiKeyRoutes from './apiKeyRoutes.js';
import createMcpRouter from '../mcp/index.js';
import shareRoutes from './shareRoutes.js';
import integrationRoutes from './integrationRoutes.js';
import internalRoutes from './internalRoutes.js';
import agentRoutes from './agentRoutes.js';

const router = Router();

// Liveness — is the process up.
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'API is running',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
  });
});

// Readiness — can we actually serve traffic (DB reachable, catalog indexed,
// AI configured). Returns 503 so orchestrators can hold traffic back.
router.get('/health/ready', async (req, res) => {
  const dbState = mongoose.connection.readyState; // 1 = connected
  let catalogSize = 0;
  let catalogOk = false;

  try {
    const catalog = await getCatalog();
    catalogSize = catalog.tools.length;
    catalogOk = catalogSize > 0;
  } catch {
    catalogOk = false;
  }

  const { getRedis, isRedisConfigured } = await import('../utils/redis.js');
  const redis = getRedis();
  const redisMode = isRedisConfigured() && !redis.isMemoryFallback ? 'redis' : 'memory';
  let redisOk = redisMode === 'memory';
  if (redisMode === 'redis') {
    try {
      const pong = await redis.ping();
      redisOk = pong === 'PONG' || pong === 'pong';
    } catch {
      redisOk = false;
    }
  }

  const queueMode = process.env.REDIS_URL ? 'bullmq' : 'in-process';
  const mongoHost = (() => {
    try {
      return new URL(config.mongoUri).hostname;
    } catch {
      return null;
    }
  })();

  const ready = dbState === 1 && catalogOk && (redisMode === 'memory' || redisOk);

  res.status(ready ? 200 : 503).json({
    success: ready,
    checks: {
      database: dbState === 1 ? 'up' : 'down',
      mongoHost: mongoHost || 'unset',
      catalog: catalogOk ? `${catalogSize} tools indexed` : 'empty',
      ai: isLLMAvailable() ? 'configured' : 'not configured',
      redis: redisOk ? redisMode : 'down',
      queue: queueMode,
    },
    timestamp: new Date().toISOString(),
  });
});

// Vector store diagnostic — Qdrant reachability, collection point counts, embedding model.
router.get('/health/vector', async (req, res) => {
  const health = await getVectorStoreHealth();
  const ok = health.configured === false || health.ok === true;
  res.status(ok ? 200 : 503).json({
    success: ok,
    data: health,
    timestamp: new Date().toISOString(),
  });
});

// AI observability — latency percentiles, token spend, cache efficiency and
// error rate per pipeline stage. Admin-only: it reveals cost and model routing.
router.get('/health/ai', authenticate, requireAdmin, async (req, res) => {
  const [cacheStats, llmStats] = await Promise.all([getCacheStats(), getStats()]);
  res.json({
    success: true,
    data: {
      configured: isLLMAvailable(),
      // Ordered failover chain, with any provider currently benched for an
      // exhausted quota or a rejected key flagged as unavailable.
      providers: getProviderStatus(),
      cache: cacheStats,
      ...llmStats,
    },
  });
});

// Mount routes
router.use('/auth', authRoutes);
router.use('/tools', toolRoutes);
router.use('/comments', commentRoutes);
router.use('/admin', adminRoutes);
router.use('/chat', chatRoutes);
router.use('/categories', categoryRoutes);
router.use('/tasks', taskRoutes);
router.use('/billing', billingRoutes);
router.use('/api-keys', apiKeyRoutes);
router.use('/mcp', createMcpRouter());
router.use(shareRoutes);
router.use('/integrations', integrationRoutes);
router.use('/internal', internalRoutes);
router.use('/agents', agentRoutes);

export default router;

