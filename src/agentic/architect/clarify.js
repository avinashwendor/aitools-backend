/**
 * Detect whether a build goal is specific enough to start placing nodes, or
 * whether the architect must pause and ask structured intake questions first.
 *
 * Vague goals like "send me the news every day" leave delivery, source and
 * topic unspecified — building from guesses produces a graph the user then
 * has to reverse-engineer. Specific goals that already name a recipient and a
 * source (or clear topic) can proceed straight to research/build.
 */

export function goalNeedsClarification(goal) {
  const g = String(goal || '').trim().toLowerCase();
  if (!g) return true;
  // Extremely short prompts almost never name destination + topic.
  if (g.length < 28) return true;

  const hasRecipient =
    /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/.test(g) ||
    /slack\s+(channel|webhook|#\w+)/.test(g) ||
    /#\w{2,}/.test(g) ||
    /discord\s+(webhook|channel)/.test(g) ||
    /telegram|whatsapp|sms\s+to/.test(g) ||
    /webhook\s+url|post\s+to\s+https?:\/\//.test(g);

  const hasSource =
    /hacker\s*news|\bhn\b|reddit|product\s*hunt|rss\b|newsapi|https?:\/\/|twitter|\bx\.com\b|youtube|github|dev\.to|lobsters|bloomberg|reuters|bbc|techcrunch/.test(
      g
    );

  const hasTopic =
    hasSource ||
    /\b(tech|ai|artificial intelligence|crypto|startup|finance|sport|politic|science|world news|top stor|headlines?)\b/.test(
      g
    );

  // Schedule alone is not enough — "every day" without where/what still needs intake.
  return !(hasRecipient && hasTopic);
}

/** Coerce model-authored option entries into plain UI labels. */
function optionLabel(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  if (typeof value === 'object') {
    return String(value.label || value.value || value.text || value.name || value.id || '').trim();
  }
  return String(value).trim();
}

/** Normalise model-authored questions into the shape ClarifyingQuestions expects. */
export function normalizeClarifyingQuestions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];

  for (let i = 0; i < list.length && out.length < 6; i++) {
    const item = list[i] || {};
    const question = String(item.question || item.prompt || '').trim().slice(0, 240);
    if (!question) continue;

    const id = String(item.id || `q${i + 1}`)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .slice(0, 40) || `q${i + 1}`;

    const options = Array.isArray(item.options)
      ? [...new Set(item.options.map(optionLabel).filter(Boolean))].slice(0, 8)
      : [];

    // Objects that stringified to "[object Object]" are useless — treat as text.
    const usableOptions = options.filter(o => o !== '[object Object]');
    const type = item.type === 'text' || usableOptions.length < 2 ? 'text' : 'choice';

    out.push({
      id,
      question,
      type,
      ...(type === 'choice' ? { options: usableOptions } : {}),
    });
  }

  return out;
}

export default { goalNeedsClarification, normalizeClarifyingQuestions };
