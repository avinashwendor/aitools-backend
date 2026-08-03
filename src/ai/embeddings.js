/**
 * Local, in-process embeddings.
 *
 * Runs a small open-source model (default: Xenova/all-MiniLM-L6-v2, 384-dim)
 * directly in the Node process via @huggingface/transformers — no external
 * API key, no rate limit, no per-call cost. The trade-off is a larger boot
 * (model download + ONNX load, cached to disk after the first run) and a bit
 * of CPU per embed call, which is a fine trade for this app's volume
 * (catalog entries on write, compacted summaries on compaction — not
 * per-message).
 *
 * Embeddings are entirely optional infrastructure: every caller must treat a
 * failure here (model can't load, out of memory) as "semantic search
 * unavailable," never as a request-breaking error — BM25 retrieval works
 * fine without this.
 */

import config from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ai:embeddings');

let extractorPromise = null;
let modelReady = false;

/** Host-safe label for logs — never prints tokens or paths. */
export function embeddingModelLabel() {
  return config.vector.embeddingModel;
}

function loadExtractor() {
  if (!extractorPromise) {
    const started = Date.now();
    log.info('Loading embedding model (first run downloads ONNX weights — can take 1-2 min on Railway)', {
      model: config.vector.embeddingModel,
      dimensions: config.vector.dimensions,
    });

    extractorPromise = import('@huggingface/transformers')
      .then(({ pipeline }) => pipeline('feature-extraction', config.vector.embeddingModel))
      .then(extractor => {
        modelReady = true;
        log.info('Embedding model ready', {
          model: config.vector.embeddingModel,
          ms: Date.now() - started,
        });
        return extractor;
      })
      .catch(err => {
        extractorPromise = null;
        modelReady = false;
        log.error('Embedding model failed to load — vector sync and semantic search disabled', {
          model: config.vector.embeddingModel,
          error: err.message,
          ms: Date.now() - started,
        });
        throw err;
      });
  }
  return extractorPromise;
}

/** Pre-load the model so the first catalog upsert doesn't fail in parallel. */
export async function warmupEmbeddings() {
  if (!isEmbeddingConfigured()) return { ok: false, reason: 'QDRANT_URL not set' };
  try {
    await loadExtractor();
    await embed('warmup ping');
    return { ok: true, model: config.vector.embeddingModel };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function isEmbeddingModelReady() {
  return modelReady;
}

export const isEmbeddingConfigured = () => Boolean(config.vector.url);

/**
 * @param {string} text
 * @returns {Promise<number[]|null>} a unit-normalised embedding, or null if
 *   embeddings aren't usable right now (caller should fall back to BM25-only).
 */
export async function embed(text) {
  const clean = String(text || '').trim();
  if (!clean) return null;

  try {
    const extractor = await loadExtractor();
    const output = await extractor(clean, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  } catch (err) {
    log.warn('Embedding failed — semantic search will fall back to lexical-only', { error: err.message });
    return null;
  }
}

/** Embeds a batch sequentially — small volumes (catalog writes), no need for GPU batching. */
export async function embedBatch(texts) {
  const results = [];
  for (const text of texts) results.push(await embed(text));
  return results;
}

export default {
  embed,
  embedBatch,
  isEmbeddingConfigured,
  isEmbeddingModelReady,
  warmupEmbeddings,
  embeddingModelLabel,
};
