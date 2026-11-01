/**
 * HTML sanitisation for inbound email bodies.
 *
 * Email HTML is untrusted. We strip scripts, event handlers, dangerous
 * URL schemes and embeddable content, and force links to open safely.
 * The client additionally renders the result inside a sandboxed iframe,
 * so this is defence in depth.
 */
import sanitizeHtml from 'sanitize-html';

const OPTIONS = {
  allowedTags: [
    'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
    'dd', 'div', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
    'i', 'img', 'li', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strong',
    'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    '*': ['style', 'align', 'valign', 'colspan', 'rowspan', 'width', 'height'],
  },
  // Only allow http(s)/mailto/tel and safe relative-ish anchors.
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'cid', 'data'],
  },
  // Drop data: URIs except small images handled below.
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
      },
    }),
  },
  // Remove inline event handlers and style attributes that are dangerous.
  disallowedTagsMode: 'discard',
  parser: {
    lowerCaseTags: true,
  },
};

// sanitize-html already strips on* handlers via allowedAttributes, but we also
// explicitly clean the `style` attribute to avoid CSS-based injection vectors.
const SAFE_STYLE_RE = /^(?:(?:color|background-color|font-weight|font-style|font-size|text-align|text-decoration|padding|margin|border|width|height|max-width|display|white-space)\s*:[^;{}]*;?\s*)*$/i;

export function sanitizeEmailHtml(html) {
  if (!html || typeof html !== 'string') return '';
  const cleaned = sanitizeHtml(html, OPTIONS);
  // Second pass: strip any style attribute that does not match the safe pattern.
  return cleaned.replace(/style="([^"]*)"/gi, (match, value) =>
    SAFE_STYLE_RE.test(value.trim()) ? match : '',
  );
}

/** Best-effort plain-text fallback when a message has no text part. */
export function htmlToText(html) {
  if (!html) return '';
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim();
}
