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

function loadExtractor() {
  if (!extractorPromise) {
    extractorPromise = import('@huggingface/transformers')
      .then(({ pipeline }) => pipeline('feature-extraction', config.vector.embeddingModel))
      .catch(err => {
        extractorPromise = null; // allow a retry on the next call
        throw err;
      });
  }
  return extractorPromise;
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

export default { embed, embedBatch, isEmbeddingConfigured };
