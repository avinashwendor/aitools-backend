import config from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('http');

/**
 * Error deliberately raised by application code. `isOperational` marks it as
 * safe to show the client — anything without that flag is treated as a bug and
 * its message is withheld in production.
 */
export class ApiError extends Error {
  constructor(statusCode, message, errors = []) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

export const notFound = (req, res, next) => {
  next(new ApiError(404, `Route ${req.originalUrl} not found`));
};

export const errorHandler = (err, req, res, _next) => {
  let statusCode = err.statusCode || err.status || 500;
  let message = err.message || 'Internal Server Error';
  let errors = err.errors || [];
  let operational = err.isOperational === true;

  // ─── Normalise known error shapes ──────────────────────────
  if (err.name === 'ValidationError' && err.errors) {
    statusCode = 400;
    message = 'Validation failed';
    operational = true;
    errors = Object.values(err.errors).map(e => ({ field: e.path, message: e.message }));
  }

  if (err.code === 11000) {
    statusCode = 400;
    operational = true;
    const field = Object.keys(err.keyValue || { field: 'Field' })[0];
    message = `${field.charAt(0).toUpperCase() + field.slice(1)} already exists`;
  }

  if (err.name === 'CastError') {
    statusCode = 400;
    operational = true;
    message = 'Invalid ID format';
  }

  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    statusCode = 401;
    operational = true;
    message = 'Your session has expired. Please sign in again.';
  }

  // A rejected browser origin is a client problem, not a server fault.
  if (/not allowed by cors/i.test(err.message || '')) {
    statusCode = 403;
    operational = true;
    message = 'Origin not allowed.';
  }

  // Body-parser rejecting malformed JSON.
  if (err.type === 'entity.parse.failed') {
    statusCode = 400;
    operational = true;
    message = 'Request body is not valid JSON.';
  }

  if (statusCode < 500) operational = true;

  // ─── Log with full detail, always ──────────────────────────
  const logMeta = { status: statusCode, path: req.originalUrl, id: req.id };
  if (statusCode >= 500) {
    log.error(err.message, { ...logMeta, stack: err.stack });
  } else {
    log.warn(err.message, logMeta);
  }

  // ─── Respond with only what the client should see ──────────
  // An unexpected 500 can carry driver internals, file paths or query
  // fragments in its message, so it is replaced outside development.
  const safeMessage =
    operational || !config.isProd
      ? message
      : 'Something went wrong on our end. Please try again.';

  res.status(statusCode).json({
    success: false,
    message: safeMessage,
    ...(errors.length ? { errors } : {}),
    ...(req.id ? { requestId: req.id } : {}),
    ...(config.isProd ? {} : { stack: err.stack }),
  });
};
