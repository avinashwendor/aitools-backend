/**
 * Structured logger.
 * Emits single-line JSON in production (ingestible by Datadog/CloudWatch/Loki)
 * and human-readable coloured output in development.
 */

import config from '../config/index.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

const COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
  dim: '\x1b[2m',
};

function emit(level, scope, message, meta) {
  if (LEVELS[level] < threshold) return;

  if (config.isProd) {
    process.stdout.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        scope,
        message,
        ...(meta && Object.keys(meta).length ? { meta } : {}),
      }) + '\n'
    );
    return;
  }

  const color = COLORS[level] || '';
  const time = new Date().toISOString().slice(11, 23);
  const metaStr =
    meta && Object.keys(meta).length
      ? ` ${COLORS.dim}${JSON.stringify(meta)}${COLORS.reset}`
      : '';
  console.log(
    `${COLORS.dim}${time}${COLORS.reset} ${color}${level.toUpperCase().padEnd(5)}${COLORS.reset} ` +
    `${COLORS.dim}[${scope}]${COLORS.reset} ${message}${metaStr}`
  );
}

/** Create a scoped logger, e.g. `const log = createLogger('ai:planner')`. */
export function createLogger(scope) {
  return {
    debug: (msg, meta) => emit('debug', scope, msg, meta),
    info: (msg, meta) => emit('info', scope, msg, meta),
    warn: (msg, meta) => emit('warn', scope, msg, meta),
    error: (msg, meta) => emit('error', scope, msg, meta),
    /** Times an async operation and logs its duration. */
    async time(msg, fn, meta = {}) {
      const start = Date.now();
      try {
        const result = await fn();
        emit('debug', scope, `${msg} ✓`, { ...meta, ms: Date.now() - start });
        return result;
      } catch (err) {
        emit('error', scope, `${msg} ✗ ${err.message}`, { ...meta, ms: Date.now() - start });
        throw err;
      }
    },
  };
}

export default createLogger('app');
