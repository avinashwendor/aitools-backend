/**
 * Page snapshots — how the model sees a web page.
 *
 * The choice here decides the cost and the reliability of every browser node,
 * so it's worth being explicit about it. Three options were on the table:
 *
 *   • Raw HTML. Accurate and hopeless: a modern page is 300KB of markup, which
 *     is ~80k tokens, most of it Tailwind classes. One `act` would cost more
 *     than the whole run is priced at.
 *   • Screenshots into a vision model. Works, and is what a lot of browser
 *     agents do, but it costs image tokens on every step, can't produce a
 *     selector (only coordinates, which break on the next re-render), and gives
 *     the model nothing to reason about for elements below the fold.
 *   • A structured index of *interactable* elements, each stamped with a
 *     stable reference. A few hundred tokens, and the model's answer is a
 *     handle we can act on directly.
 *
 * The third is what this does. The page is walked once in the browser, every
 * element a user could plausibly interact with is tagged `data-agent-ref="N"`,
 * and the model gets a numbered list. When it replies "click 12", `[data-agent-ref="12"]`
 * is a Playwright selector — no coordinate maths, no re-querying by fuzzy text,
 * and no chance of clicking a different element than the one described.
 *
 * The tagging is deliberately re-applied on every snapshot. A single-page app
 * re-renders between steps, and a ref from two actions ago pointing at a
 * detached node is precisely the bug that makes browser agents feel haunted.
 */

/**
 * Runs inside the page. Written as a single self-contained function because it
 * is serialized across the CDP boundary — it cannot close over anything here.
 */
/* eslint-disable no-undef */
function collectInteractive(maxElements) {
  const INTERACTIVE = 'a,button,input,textarea,select,summary,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="option"],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';

  // Clear refs from the previous snapshot so a stale number can never resolve.
  for (const stale of document.querySelectorAll('[data-agent-ref]')) {
    stale.removeAttribute('data-agent-ref');
  }

  const seen = new Set();
  const items = [];
  let ref = 0;

  const visible = el => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number(style.opacity) < 0.05) return false;
    // Well off-screen in either direction — usually a closed drawer.
    if (rect.bottom < -2000 || rect.top > window.innerHeight + 4000) return false;
    return true;
  };

  const describe = el => {
    const text = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim();
    return (
      text ||
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      el.getAttribute('name') ||
      el.getAttribute('alt') ||
      ''
    ).slice(0, 120);
  };

  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (items.length >= maxElements) break;
    if (seen.has(el) || !visible(el)) continue;
    seen.add(el);

    ref += 1;
    el.setAttribute('data-agent-ref', String(ref));

    const tag = el.tagName.toLowerCase();
    const entry = {
      ref,
      tag,
      role: el.getAttribute('role') || tag,
      label: describe(el),
    };

    if (tag === 'input' || tag === 'textarea') {
      entry.inputType = el.getAttribute('type') || 'text';
      entry.value = String(el.value || '').slice(0, 60);
      entry.required = el.required || undefined;
    }
    if (tag === 'select') {
      entry.options = [...el.options].slice(0, 12).map(o => o.text.trim().slice(0, 40));
    }
    if (tag === 'a') {
      entry.href = (el.getAttribute('href') || '').slice(0, 200);
    }
    if (el.getAttribute('aria-checked') || el.checked !== undefined) {
      entry.checked = el.checked ?? el.getAttribute('aria-checked') === 'true';
    }
    if (el.disabled) entry.disabled = true;

    items.push(entry);
  }

  return {
    url: location.href,
    title: document.title,
    elements: items,
    // Rough scroll position, so the model can tell "nothing matched" from
    // "what you want is further down the page".
    scroll: {
      y: Math.round(window.scrollY),
      height: Math.round(document.body?.scrollHeight || 0),
      viewport: Math.round(window.innerHeight),
    },
  };
}

/** Readable page text, for extraction. Skips chrome that carries no content. */
function collectText(maxChars) {
  const clone = document.body.cloneNode(true);
  for (const junk of clone.querySelectorAll('script,style,noscript,svg,iframe,nav,footer')) {
    junk.remove();
  }
  const text = (clone.innerText || '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  return {
    url: location.href,
    title: document.title,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  };
}
/* eslint-enable no-undef */

/** Snapshot the page's interactive surface and stamp refs onto the DOM. */
export async function snapshotInteractive(page, { maxElements = 120 } = {}) {
  return page.evaluate(collectInteractive, maxElements);
}

/** Snapshot the page's readable text. Does not touch the DOM. */
export async function snapshotText(page, { maxChars = 12_000 } = {}) {
  return page.evaluate(collectText, maxChars);
}

/**
 * Render a snapshot as the compact lines the prompt actually carries.
 *
 * One line per element, no JSON. JSON of the same data is roughly 40% more
 * tokens for information the model doesn't need — it never has to parse this,
 * only read it.
 */
export function renderSnapshot(snapshot) {
  const lines = snapshot.elements.map(el => {
    const bits = [`[${el.ref}]`, el.role];
    if (el.label) bits.push(`"${el.label}"`);
    if (el.inputType) bits.push(`type=${el.inputType}`);
    if (el.value) bits.push(`value="${el.value}"`);
    if (el.options?.length) bits.push(`options=[${el.options.join(', ')}]`);
    if (el.checked !== undefined) bits.push(`checked=${el.checked}`);
    if (el.disabled) bits.push('disabled');
    if (el.href && !el.href.startsWith('javascript')) bits.push(`href=${el.href}`);
    return bits.join(' ');
  });

  const { scroll } = snapshot;
  const position =
    scroll.height > scroll.viewport
      ? `Scrolled to ${scroll.y}px of ${scroll.height}px (viewport ${scroll.viewport}px).`
      : 'Whole page fits in the viewport.';

  return [
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
    position,
    '',
    lines.length ? 'Interactive elements:' : 'No interactive elements found.',
    ...lines,
  ].join('\n');
}

/** The Playwright selector for a ref returned by a snapshot. */
export function refSelector(ref) {
  return `[data-agent-ref="${Number(ref)}"]`;
}

export default { snapshotInteractive, snapshotText, renderSnapshot, refSelector };
