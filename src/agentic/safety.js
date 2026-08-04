/**
 * Egress guard for anything a workflow can point at the network.
 *
 * An agentic workflow is a URL, written by a user or composed by a model, that
 * our server fetches with our credentials and our network position. That is the
 * textbook shape of a server-side request forgery, and the two targets that
 * matter are always the same: the cloud metadata endpoint (169.254.169.254,
 * which on most providers hands out instance credentials to anyone who asks)
 * and our own private network — on Railway, `*.railway.internal`, where Mongo
 * and Redis live with no authentication beyond being unreachable.
 *
 * Both the HTTP node and every browser navigation run through here, because a
 * check on only one of them isn't a check: `browser.open` pointed at the
 * metadata service would render the credentials straight into an extract node.
 *
 * A blocklist is the honest description of what this is. It cannot survive a
 * DNS name that resolves to a private address, and defeating that properly
 * means resolving before connecting and pinning the socket to the resolved IP.
 * That is worth doing; it is not worth pretending this already does it. The
 * durable control is the one in `config.agentic.allowPrivateNetwork`, which is
 * off in production, combined with running the browser as a separate service
 * that has no reason to be on our private network at all.
 */

import config from '../config/index.js';

/** RFC1918 and friends, plus loopback and link-local. */
const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
];

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '[::1]') return true;
  // Railway's private network, and the equivalents elsewhere.
  if (host.endsWith('.railway.internal')) return true;
  if (host.endsWith('.internal') || host.endsWith('.local')) return true;
  if (PRIVATE_V4.some(re => re.test(host))) return true;

  return false;
}

export class BlockedUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedUrlError';
    this.code = 'URL_BLOCKED';
    this.status = 400;
  }
}

/**
 * Throw unless `raw` is a URL a workflow may reach.
 * @returns {URL} the parsed URL, so callers don't parse it twice
 */
export function assertUrlAllowed(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new BlockedUrlError(`"${String(raw).slice(0, 120)}" is not a valid URL.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`Only http and https are allowed — got "${url.protocol}".`);
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (config.agentic.blockedHosts.some(blocked => host === blocked.toLowerCase())) {
    throw new BlockedUrlError(`Requests to ${host} are not allowed.`);
  }

  if (isPrivateHost(host) && !config.agentic.allowPrivateNetwork) {
    throw new BlockedUrlError(
      `${host} is on a private network. Workflows can only reach the public internet.`
    );
  }

  return url;
}

/**
 * Cap a value's serialized size before it lands on a run document.
 *
 * An extract node aimed at a long page, or an HTTP node hitting an endpoint
 * that returns everything, can produce megabytes per step. Mongo's 16MB
 * document limit would then be hit *while writing the run*, which loses the
 * entire execution history — including the error that explains it. Truncating
 * at the boundary keeps the failure legible.
 */
export function capOutput(value, maxBytes = config.agentic.maxOutputBytes) {
  if (value === null || value === undefined) return value;

  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { truncated: true, reason: 'Output could not be serialized.' };
  }

  if (serialized.length <= maxBytes) return value;

  if (typeof value === 'string') {
    return `${value.slice(0, maxBytes)}\n…[truncated, ${value.length} characters total]`;
  }

  return {
    truncated: true,
    bytes: serialized.length,
    preview: `${serialized.slice(0, maxBytes)}…`,
    reason: `Output exceeded ${maxBytes} bytes and was truncated. Narrow what this step returns.`,
  };
}

/** Strip control characters and cap length on anything that becomes a log line. */
export function safeMessage(value, max = 500) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim()
    .slice(0, max);
}

export default { assertUrlAllowed, BlockedUrlError, capOutput, safeMessage };
