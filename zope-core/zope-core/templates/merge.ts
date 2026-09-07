/**
 * Template inheritance.
 *
 * A template declares only what it changes; everything else comes from
 * _base.tokens.json. That way adding a new engine variable does not mean
 * editing fifteen template files, and a template diff shows the design
 * decisions rather than a wall of inherited defaults.
 *
 * Shallow merge per section, deep merge for `vars`. Deliberately not a general
 * deep merge: page/runningHead/folio are small fixed records, and a recursive
 * merge over them would silently accept a typo'd key instead of failing.
 */

import type { TemplateTokens } from "../css/emit";

export function mergeTokens(
  base: TemplateTokens,
  template: Partial<TemplateTokens> & { id: string; name: string }
): TemplateTokens {
  return {
    id: template.id,
    name: template.name,
    page: { ...base.page, ...(template.page ?? {}) },
    runningHead: { ...base.runningHead, ...(template.runningHead ?? {}) },
    folio: { ...base.folio, ...(template.folio ?? {}) },
    vars: { ...base.vars, ...stripNotes(template.vars ?? {}) },
  };
}

/**
 * Token files carry `_note` keys documenting why a value is what it is. They
 * are for the next person reading the file, not for CSS — emitting them would
 * produce custom properties whose values are English sentences.
 */
function stripNotes(vars: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).filter(([k]) => !k.startsWith("_")));
}

/**
 * Every variable engine.css reads. A template that leaves one undefined
 * produces `var(--thing)` with no fallback, which resolves to nothing and
 * silently drops the property — a missing --indent means no paragraph indents
 * anywhere and no error.
 */
export function validateTokens(t: TemplateTokens, required: string[]): string[] {
  return required.filter((k) => !(k in t.vars));
}

/** Extracted from engine.css by scripts/extract-vars.mjs; keep in sync. */
export const REQUIRED_VARS = [
  "body-family", "display-family", "heading-family", "mono-family",
  "body-size", "leading", "body-weight", "body-align", "body-figures",
  "hyphenation", "orphans", "widows", "indent",
  "ink", "ink-muted", "accent", "rule-color", "rule-hairline", "rule-medium",
  "block-break", "opener-sinkage", "opener-sinkage-plain", "opener-space-after",
  "opener-align", "opener-number-size", "opener-number-weight",
  "opener-number-tracking", "opener-number-transform", "opener-number-figures",
  "opener-number-gap", "opener-title-size", "opener-title-weight",
  "opener-title-leading", "opener-title-tracking", "opener-title-transform",
  "initial-lines", "initial-family", "initial-weight", "initial-color", "initial-gap",
  "heading-weight", "heading-leading", "heading-align",
  "h1-size", "h1-space-before", "h1-space-after",
  "h2-size", "h2-space-before", "h2-space-after",
  "h3-size", "h3-space-before", "h3-space-after", "h3-style",
  "quote-space-before", "quote-space-after", "quote-inset-left", "quote-inset-right",
  "quote-size", "quote-leading", "quote-style",
  "epigraph-space-before", "epigraph-space-after", "epigraph-inset-left",
  "epigraph-inset-right", "epigraph-size", "epigraph-style", "epigraph-align",
  "attribution-gap", "attribution-size", "attribution-style", "attribution-align",
  "verse-space-before", "verse-space-after", "verse-inset", "verse-runover", "verse-step",
  "list-space-before", "list-space-after", "list-inset", "list-item-gap",
  "scene-space", "scene-glyph", "scene-size", "scene-tracking",
  "figure-space-before", "figure-space-after", "figure-full-bleed",
  "caption-gap", "caption-family", "caption-size", "caption-leading",
  "caption-style", "caption-align",
  "table-space-before", "table-space-after", "table-size", "table-leading",
  "table-caption-side", "table-head-weight", "cell-padding",
  "code-size", "code-leading", "code-space-before", "code-space-after",
  "code-padding", "code-bg",
  "footnote-size", "footnote-leading", "footnote-call-size",
  "footnote-marker-gap", "footnote-rule-gap",
  "sc-variant", "sc-fallback-size", "sc-fallback-transform", "sc-tracking",
  "link-decoration",
  "leading-devanagari", "leading-bengali", "leading-tamil", "leading-telugu",
  "leading-malayalam", "leading-gujarati", "leading-gurmukhi", "leading-nastaliq",
  "toc-entry-gap", "toc-family", "toc-leader-gap", "toc-indent",
  "toc-l2-size", "toc-l3-size",
  "preview-bg", "preview-gap",
];
