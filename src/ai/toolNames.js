/**
 * Detecting a tool named in prose that isn't the tool a stage is bound to.
 *
 * This exists because of a specific failure. The planner picked Glide for a
 * mobile-app stage, `validateGraph`-style slug validation rejected it (Glide is
 * not in the catalog), and the JSON repair round-trip did the literal minimum:
 * it changed `toolSlug` to a slug that *is* in the catalog and left the title,
 * the rationale, the summary and every tip still describing Glide. The user was
 * shown "Build the App (Glide — Mobile-First, No-Code)" with a Lovable chip, a
 * Lovable link, and a Lovable playbook. Nothing in the pipeline compared the
 * words to the binding.
 *
 * So the check has to cover two populations:
 *
 *   - catalog tools, which we can enumerate exactly, and
 *   - well-known products that are NOT in the catalog, which is the population
 *     the model reaches for precisely when the catalog cannot serve the goal —
 *     i.e. exactly when this failure happens.
 *
 * The hard part is that several real tool names are ordinary English words:
 * Make, Rows, Motion, Gamma, Attention, Cursor, Descript. A case-insensitive
 * substring match on those turns "make sure you export" into a false report,
 * and a check that cries wolf gets switched off. Two rules keep it honest:
 * ambiguous names must match with their real capitalisation, and a match at the
 * start of a sentence is ignored, because capitalisation there carries no
 * information.
 */

/**
 * Products that could plausibly BE a stage's primary tool — the ones a stage
 * would be bound to if the model could have its way. Not a catalog, not a
 * recommendation list: a detector vocabulary.
 *
 * The membership test is deliberately narrow: "could this product do the whole
 * job of a stage instead of the tool that is bound?" Only then does naming it
 * in the stage's own title or rationale mean the prose and the binding
 * disagree.
 *
 * This is why Stripe, Firebase, Supabase, Twilio and Google Sheets are NOT
 * here, and must not be added. A stage bound to Adalo that says "collect fees
 * with the built-in Stripe integration" is describing what Adalo does — Stripe
 * cannot build an app, so it was never a competing binding. Treating those as
 * conflicts made the check reject correct plans, which is how a useful
 * validator turns into one somebody disables.
 */
export const OFF_CATALOG_TOOL_NAMES = [
  // No-code / low-code app builders — the gap that produced this module.
  'Glide', 'Adalo', 'FlutterFlow', 'Bubble', 'Softr', 'Thunkable', 'Draftbit',
  'Bravo Studio', 'AppSheet', 'Backendless', 'Buildfire', 'GoodBarber',
  // Adjacent AI products outside our catalog.
  'Bard', 'Copilot Studio', 'Poe', 'Mistral', 'Grok',
  'Stable Diffusion', 'Leonardo', 'Sora', 'Veo', 'Kling',
  'Eleven Labs', 'Play.ht', 'Resemble',
  // Site, store and doc builders.
  'Webflow', 'Framer', 'Wix', 'Squarespace', 'WordPress', 'Shopify',
  'Carrd', 'Coda',
];

/**
 * Names that are also ordinary words. Matching these needs the product's own
 * capitalisation, and never at a sentence boundary.
 */
const AMBIGUOUS = new Set([
  'make', 'rows', 'motion', 'gamma', 'attention', 'cursor', 'descript',
  'claude', 'pika', 'runway', 'suno', 'udio', 'harvey', 'consensus',
  'elicit', 'ideogram', 'buffer', 'bubble', 'framer', 'poe', 'grok', 'veo',
]);

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does `name` appear in `text` as a product reference?
 *
 * @param {string} text
 * @param {string} name
 * @returns {boolean}
 */
function mentions(text, name) {
  const ambiguous = AMBIGUOUS.has(name.toLowerCase());
  const flags = ambiguous ? 'g' : 'gi';
  const re = new RegExp(`(^|[^\\w-])(${escape(name)})([^\\w-]|$)`, flags);

  let match;
  while ((match = re.exec(text)) !== null) {
    if (!ambiguous) return true;

    // Capitalisation at the start of a sentence says nothing about whether the
    // word is a product, so those matches are discarded rather than reported.
    const before = text.slice(0, match.index + match[1].length).trimEnd();
    const atSentenceStart = before === '' || /[.!?:;—–-]$/.test(before);
    if (!atSentenceStart) return true;
  }
  return false;
}

/**
 * Tool names present in `text` that are not `boundName`.
 *
 * @param {string} text            the prose to scan (title, why, summary, a tip)
 * @param {string} boundName       the tool the stage is actually bound to
 * @param {object} [opts]
 * @param {string[]} [opts.catalogNames]  every tool name in the catalog
 * @param {string[]} [opts.allowed]       additional names this text may name
 *   legitimately (an external tool the stage declares, or a named gap)
 * @returns {string[]} offending names, deduped, in the order found
 */
export function foreignToolNames(text, boundName, { catalogNames = [], allowed = [] } = {}) {
  const haystack = String(text || '');
  if (!haystack.trim()) return [];

  const permitted = new Set(
    [boundName, ...allowed].filter(Boolean).map(n => String(n).toLowerCase())
  );

  const vocabulary = [...new Set([...catalogNames, ...OFF_CATALOG_TOOL_NAMES])];

  const hits = [];
  for (const name of vocabulary) {
    if (permitted.has(name.toLowerCase())) continue;
    // A permitted multi-word name subsumes its parts: a stage bound to "Glide"
    // may of course say "Glide Tables".
    if ([...permitted].some(p => name.toLowerCase().includes(p) || p.includes(name.toLowerCase()))) continue;
    if (mentions(haystack, name)) hits.push(name);
  }

  return hits;
}

export default { foreignToolNames, OFF_CATALOG_TOOL_NAMES };
