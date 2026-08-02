/**
 * Fixed-window rate limiter, backed by Redis (see `utils/redis.js`).
 *
 * The counter+window is stored in Redis (INCR + PEXPIRE NX) so the limit
 * holds across every Railway instance instead of each instance keeping its
 * own count — previously an in-process Map, which meant a user behind a
 * load balancer with N instances effectively got N times the limit.
 *
 * Fails open: if Redis is unreachable, the request is allowed through rather
 * than 500ing every request in the outage — rate limiting is a protective
 * measure, not a correctness guarantee, so degrading it beats taking the API
 * down with it.
 */

import { getRedis } from '../utils/redis.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ratelimit');

/**
 * @param {object} opts
 * @param {number} opts.windowMs
 * @param {number} opts.max
 * @param {(req)=>string} [opts.keyGenerator]
 * @param {string} [opts.message]
 */
export function rateLimit({ windowMs, max, keyGenerator, message } = {}) {
  const getKey = keyGenerator || (req => req.user?._id?.toString() || req.ip);

  return async (req, res, next) => {
    const key = `ratelimit:${req.baseUrl}:${getKey(req)}`;

    try {
      const redis = getRedis();
      const results = await redis.multi().incr(key).pexpire(key, windowMs, 'NX').exec();
      const count = Number(results[0][1]);
      const ttlSeconds = await redis.ttl(key);
      const resetSeconds = ttlSeconds >= 0 ? ttlSeconds : Math.ceil(windowMs / 1000);

      const remaining = Math.max(0, max - count);
      res.setHeader('RateLimit-Limit', max);
      res.setHeader('RateLimit-Remaining', remaining);
      res.setHeader('RateLimit-Reset', resetSeconds);

      if (count > max) {
        res.setHeader('Retry-After', resetSeconds);
        log.warn('Rate limit exceeded', { key, count, max });
        return res.status(429).json({
          success: false,
          code: 'RATE_LIMITED',
          message: message || `Too many requests. Try again in ${resetSeconds}s.`,
        });
      }

      next();
    } catch (err) {
      log.error('Rate limiter backend error — allowing request through', { error: err.message });
      next();
    }
  };
}

export default rateLimit;
