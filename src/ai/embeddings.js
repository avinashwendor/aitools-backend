/**
 * Google Gemini embeddings (HTTP) — no local ONNX model.
 *
 * Used for: catalog tool vectors (admin write / empty-store fill), dense
 * tool search queries, and cross-session memory facts. Every caller must
 * treat failure as "semantic search unavailable" — BM25 still works.
 *
 * Requires GEMINI_API_KEY (Google AI Studio). Free-tier input is $0 with
 * rate limits; see https://ai.google.dev/gemini-api/docs/pricing
 */

import config from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ai:embeddings');

const EMBED_URL =
  'https://generativelanguage.googleapis.com/v1beta/models';

let lastOk = false;

/** Host-safe label for logs — never prints tokens or paths. */
export function embeddingModelLabel() {
  return config.vector.embeddingModel;
}

export function isEmbeddingModelReady() {
  return lastOk;
}

/** Embeddings need an API key; Qdrant is checked separately by vectorStore. */
export const isEmbeddingConfigured = () => Boolean(config.vector.embeddingApiKey);

function l2Normalize(values) {
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return values.map(v => v / norm);
}

/**
 * Pre-flight one embed so catalog sync fails fast if the key/model is bad.
 */
export async function warmupEmbeddings() {
  if (!isEmbeddingConfigured()) {
    return { ok: false, reason: 'GEMINI_API_KEY not set' };
  }
  try {
    const vector = await embed('warmup ping');
    if (!vector) return { ok: false, reason: 'embed returned null' };
    return { ok: true, model: config.vector.embeddingModel, dimensions: vector.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * @param {string} text
 * @returns {Promise<number[]|null>} unit-normalised embedding, or null on failure
 */
export async function embed(text) {
  const clean = String(text || '').trim();
  if (!clean) return null;

  const apiKey = config.vector.embeddingApiKey;
  if (!apiKey) {
    log.warn('Embedding skipped — GEMINI_API_KEY not set');
    return null;
  }

  const model = config.vector.embeddingModel;
  const dimensions = config.vector.dimensions;

  try {
    const res = await fetch(`${EMBED_URL}/${encodeURIComponent(model)}:embedContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text: clean.slice(0, 8000) }] },
        outputDimensionality: dimensions,
        taskType: 'RETRIEVAL_DOCUMENT',
      }),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = body?.error?.message || res.statusText || `HTTP ${res.status}`;
      throw new Error(message);
    }

    const values = body?.embedding?.values;
    if (!Array.isArray(values) || !values.length) {
      throw new Error('Gemini embed response missing embedding.values');
    }

    // Required when outputDimensionality < 3072 (Google docs).
    const vector = l2Normalize(values);
    lastOk = true;
    return vector;
  } catch (err) {
    lastOk = false;
    log.warn('Embedding failed — semantic search will fall back to lexical-only', {
      model,
      error: err.message,
    });
    return null;
  }
}

/**
 * Query-side embed (same model/dims; taskType differs for retrieval quality).
 * Falls back to document embed if the API rejects the task type.
 */
export async function embedQuery(text) {
  const clean = String(text || '').trim();
  if (!clean) return null;

  const apiKey = config.vector.embeddingApiKey;
  if (!apiKey) return null;

  const model = config.vector.embeddingModel;
  const dimensions = config.vector.dimensions;

  try {
    const res = await fetch(`${EMBED_URL}/${encodeURIComponent(model)}:embedContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text: clean.slice(0, 8000) }] },
        outputDimensionality: dimensions,
        taskType: 'RETRIEVAL_QUERY',
      }),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Older keys / models may not accept taskType — fall back.
      return embed(clean);
    }

    const values = body?.embedding?.values;
    if (!Array.isArray(values) || !values.length) return embed(clean);

    lastOk = true;
    return l2Normalize(values);
  } catch {
    return embed(clean);
  }
}

/** Embeds a batch sequentially — free-tier RPM is the limiter, not GPU. */
export async function embedBatch(texts) {
  const results = [];
  for (const text of texts) results.push(await embed(text));
  return results;
}

export default {
  embed,
  embedQuery,
  embedBatch,
  isEmbeddingConfigured,
  isEmbeddingModelReady,
  warmupEmbeddings,
  embeddingModelLabel,
};
