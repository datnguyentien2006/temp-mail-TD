/**
 * Link extraction for inbound email.
 *
 * Verification emails carry a call-to-action URL. The client renders the
 * sanitised HTML inside a sandboxed iframe, where links are inert unless the
 * sandbox is relaxed, and automation agents need a machine-readable list
 * rather than scraping markup. This module is the single source of truth for
 * both, so a UI change can never silently break the automation contract.
 *
 * Security rules (the input is untrusted mail):
 *   - only `http:` / `https:` URLs are returned; `javascript:`, `data:`,
 *     `mailto:`, `tel:` and protocol-relative URLs are dropped;
 *   - URLs are deduplicated case-insensitively, first occurrence wins;
 *   - surrounding whitespace and sentence punctuation are trimmed, while a
 *     balanced `)` inside a URL is preserved;
 *   - text is decoded and stripped of markup, never trusted as HTML.
 */

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/** Decode the handful of entities sanitize-html may leave behind. */
function decodeEntities(value) {
  return String(value ?? '').replace(
    /&(?:amp|lt|gt|quot|#39|apos|nbsp);/g,
    (match) => ENTITIES[match] ?? match,
  );
}

/** Collapse markup and whitespace into a single-line label. */
function stripTags(value) {
  return decodeEntities(String(value ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Trim punctuation that usually belongs to the surrounding sentence rather
 * than the URL. Closing parentheses are only dropped when unbalanced, so
 * `https://x.test/a_(b)` survives intact.
 */
function trimTrailingPunctuation(value) {
  let out = value.replace(/[.,;:!?"'`\]}]+$/g, '');
  while (out.endsWith(')')) {
    const opens = (out.match(/\(/g) ?? []).length;
    const closes = (out.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    out = out.slice(0, -1);
  }
  return out;
}

/** Normalise to an absolute http(s) URL, or null if it is not one. */
function normalizeUrl(raw) {
  const candidate = trimTrailingPunctuation(String(raw ?? '').trim());
  if (!candidate) return null;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.href;
}

const ANCHOR_RE =
  /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

function matches(regex, value) {
  return String(value ?? '').match(regex) ?? [];
}

/**
 * Extract the deduplicated http(s) links from an email body.
 *
 * @param {string} [html] sanitised HTML part (falls back to text if absent)
 * @param {string} [text] plain-text part
 * @returns {{ url: string, text: string }[]} in first-seen order
 */
export function extractLinks(html, text) {
  const ordered = [];
  const byUrl = new Map();

  const push = (rawUrl, label) => {
    const url = normalizeUrl(decodeEntities(rawUrl));
    if (!url) return;
    const key = url.toLowerCase();
    const existing = byUrl.get(key);
    if (existing) {
      // Prefer anchor text over an empty label if we saw the URL bare first.
      if (!existing.text && label) existing.text = label;
      return;
    }
    const entry = { key, url, text: label ?? '' };
    byUrl.set(key, entry);
    ordered.push(entry);
  };

  // 1. Anchors, in document order, so their visible text is preserved.
  for (const match of String(html ?? '').matchAll(ANCHOR_RE)) {
    const href = match[1] ?? match[2] ?? match[3] ?? '';
    push(href, stripTags(match[4]));
  }

  // 2. Bare URLs in the plain-text part and in the HTML (catches links that
  //    were never wrapped in an <a>).
  for (const url of matches(BARE_URL_RE, text)) push(url, '');
  for (const url of matches(BARE_URL_RE, html)) push(url, '');

  return ordered.map(({ url, text: label }) => ({ url, text: label }));
}
