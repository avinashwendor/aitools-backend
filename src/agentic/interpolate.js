/**
 * `{{ node.path }}` templating for node fields.
 *
 * Deliberately not Handlebars, which is what the node-based reference used.
 * Handlebars compiles templates into functions, and the templates here are
 * written by end users (and, worse, by a model composing a workflow from a
 * chat message) then stored and executed on our servers. A substitution engine
 * that only ever *reads* a path off a plain object has no code path that can
 * execute anything, which makes the whole class of template-injection bugs
 * structurally impossible rather than merely unlikely.
 *
 * What it supports:
 *
 *   {{ open_1.title }}              a dotted path off a node's output
 *   {{ http_1.data.items[0].id }}   array indexing
 *   {{ trigger.body.email }}        the run's seed payload
 *   {{ llm_1.json | json }}         filters, applied left to right
 *   {{ maybe.missing | default: — }}
 *
 * A path that resolves to nothing becomes an empty string rather than the
 * literal `undefined`, and one that lands on an object or array is JSON-encoded
 * so it survives being dropped into prose.
 */

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Keys that would let a crafted path walk into the prototype chain. */
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Walk a dotted/bracketed path off `root`.
 * Returns undefined the moment the path leaves an object, rather than throwing —
 * a typo in a template should render blank, not kill a run nine steps in.
 */
export function getByPath(root, path) {
  const keys = String(path)
    .replace(/\[(\w+)\]/g, '.$1')
    .split('.')
    .map(k => k.trim())
    .filter(Boolean);

  let current = root;
  for (const key of keys) {
    if (BLOCKED_KEYS.has(key)) return undefined;
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

/** Filters usable after a `|` in a placeholder. */
const FILTERS = {
  json: value => JSON.stringify(value ?? null, null, 2),
  upper: value => String(value ?? '').toUpperCase(),
  lower: value => String(value ?? '').toLowerCase(),
  trim: value => String(value ?? '').trim(),
  first: value => (Array.isArray(value) ? value[0] : value),
  count: value => (Array.isArray(value) ? value.length : value ? 1 : 0),
  /** `{{ x | default: n/a }}` — everything after the colon is the literal. */
  default: (value, arg) => (value === undefined || value === null || value === '' ? arg : value),
};

function render(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Substitute placeholders in one string.
 *
 * @param {string} text
 * @param {object} scope  `{ [nodeId]: output, trigger: payload }`
 */
export function interpolate(text, scope) {
  if (typeof text !== 'string' || !text.includes('{{')) return text;

  return text.replace(PLACEHOLDER, (_match, expression) => {
    const [pathPart, ...filterParts] = String(expression).split('|');
    let value = getByPath(scope, pathPart.trim());

    for (const raw of filterParts) {
      const [name, ...argParts] = raw.trim().split(':');
      const filter = FILTERS[name.trim()];
      if (!filter) continue;
      value = filter(value, argParts.join(':').trim());
    }

    return render(value);
  });
}

/**
 * Substitute through a whole value — strings, arrays, and object values.
 *
 * Object *keys* are left alone. A template in a key would let a placeholder
 * decide which HTTP header gets set, which is a header-injection primitive
 * handed to whoever wrote the prompt.
 */
export function interpolateDeep(value, scope) {
  if (typeof value === 'string') return interpolate(value, scope);
  if (Array.isArray(value)) return value.map(v => interpolateDeep(v, scope));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, interpolateDeep(val, scope)])
    );
  }
  return value;
}

/** Every `{{ … }}` reference in a field set, for the editor's dependency hints. */
export function referencedNodes(values = {}) {
  const found = new Set();
  for (const value of Object.values(values)) {
    if (typeof value !== 'string') continue;
    for (const match of value.matchAll(PLACEHOLDER)) {
      const root = match[1].split('|')[0].trim().split(/[.[]/)[0].trim();
      if (root) found.add(root);
    }
  }
  return [...found];
}

/**
 * Resolve every field on a node against the run scope.
 *
 * JSON-typed fields are parsed *after* substitution, so `{"id": {{ x.id }}}`
 * works — the alternative (parse then substitute) can't produce a number or a
 * nested object from a placeholder, only a string.
 */
export function resolveValues(values = {}, fields = [], scope = {}) {
  const resolved = {};
  for (const field of fields) {
    const raw = values[field.key];
    if (raw === undefined) continue;

    const substituted = interpolateDeep(raw, scope);

    if (field.type === 'json' && typeof substituted === 'string') {
      const text = substituted.trim();
      if (!text) continue;
      try {
        resolved[field.key] = JSON.parse(text);
      } catch (err) {
        const error = new Error(`${field.label} is not valid JSON after substitution: ${err.message}`);
        error.code = 'BAD_FIELD_JSON';
        throw error;
      }
      continue;
    }

    if (field.type === 'number') {
      const n = Number(substituted);
      resolved[field.key] = Number.isFinite(n) ? n : field.default;
      continue;
    }

    if (field.type === 'boolean') {
      resolved[field.key] =
        typeof substituted === 'boolean'
          ? substituted
          : ['true', '1', 'yes', 'on'].includes(String(substituted).toLowerCase());
      continue;
    }

    resolved[field.key] = substituted;
  }

  // Defaults fill in only where the author left the field untouched, so an
  // intentionally blank optional field stays blank.
  for (const field of fields) {
    if (resolved[field.key] === undefined && field.default !== undefined) {
      resolved[field.key] = field.default;
    }
  }

  return resolved;
}

export default { interpolate, interpolateDeep, resolveValues, getByPath, referencedNodes };
