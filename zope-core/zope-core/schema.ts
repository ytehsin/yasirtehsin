/**
 * ZOPE manuscript schema.
 *
 * SCOPE: one ProseMirror document = one BLOCK (a chapter, or a front/back
 * matter section). A book is an ordered array of blocks. Do NOT put a whole
 * book in one ProseMirror doc — a 400pp novel becomes unusable in the editor
 * and every keystroke re-validates the entire manuscript.
 *
 * THE RULE THIS SCHEMA ENFORCES: content carries meaning, never appearance.
 * There is deliberately no fontSize, fontFamily, color, textAlign or lineHeight
 * anywhere below. If an author could set those, "switch template and the whole
 * book reflows" stops working, and so does EPUB. Appearance lives entirely in
 * the template tokens.
 *
 * ALSO DELIBERATELY ABSENT: the chapter title. It lives on the block record
 * (block.title), not inside the doc. That keeps the TOC generatable, keeps the
 * running head reliable, and stops authors from turning a chapter title into a
 * styled paragraph that the TOC can't see.
 */

import { Schema, NodeSpec, MarkSpec } from "prosemirror-model";

const nodes: Record<string, NodeSpec> = {
  doc: {
    content: "blockContent+",
  },

  paragraph: {
    group: "blockContent",
    content: "inline*",
    attrs: {
      // Authors get one appearance-adjacent lever, because typography
      // genuinely requires it: suppressing the first-line indent. Everything
      // else (indent width, spacing) is the template's business.
      // "auto" lets CSS decide from context (first para after a heading or
      // scene break is not indented in most book styles).
      variant: { default: "auto" }, // "auto" | "indent" | "noindent"
    },
    parseDOM: [{ tag: "p" }],
    toDOM: (n) => ["p", { "data-variant": n.attrs.variant }, 0],
  },

  /**
   * Headings WITHIN a chapter. Level 1 is a major section break inside the
   * chapter, level 2 a subsection, level 3 the deepest a book should go.
   * The chapter's own title is not a heading node — see the note above.
   */
  heading: {
    group: "blockContent",
    content: "inline*",
    attrs: { level: { default: 1 } },
    defining: true,
    parseDOM: [
      { tag: "h2", attrs: { level: 1 } },
      { tag: "h3", attrs: { level: 2 } },
      { tag: "h4", attrs: { level: 3 } },
    ],
    toDOM: (n) => [`h${n.attrs.level + 1}`, 0],
  },

  blockquote: {
    group: "blockContent",
    content: "(paragraph | verse)+",
    defining: true,
    parseDOM: [{ tag: "blockquote" }],
    toDOM: () => ["blockquote", 0],
  },

  /**
   * Verse: line breaks are semantic, not cosmetic. Poetry books are a real
   * category for you (§58) and forcing poems into paragraphs destroys them —
   * a reflowable EPUB will re-wrap the lines and the poem is gone.
   */
  verse: {
    group: "blockContent",
    content: "verseLine+",
    defining: true,
    parseDOM: [{ tag: "div.verse" }],
    toDOM: () => ["div", { class: "verse" }, 0],
  },

  verseLine: {
    content: "inline*",
    attrs: { indent: { default: 0 } }, // steps, not px — template sets the step size
    parseDOM: [
      {
        tag: "p.verse-line",
        getAttrs: (el) => ({
          indent: parseInt((el as HTMLElement).dataset.indent || "0", 10),
        }),
      },
    ],
    toDOM: (n) => [
      "p",
      { class: "verse-line", "data-indent": String(n.attrs.indent) },
      0,
    ],
  },

  /**
   * Epigraph: the quotation under a chapter opener. Distinct from blockquote
   * because it is positioned by the template (often flush right, smaller,
   * with the attribution set differently) and must never be confused with a
   * body quotation.
   */
  epigraph: {
    group: "blockContent",
    content: "(paragraph | verse)+ attribution?",
    defining: true,
    parseDOM: [{ tag: "div.epigraph" }],
    toDOM: () => ["div", { class: "epigraph" }, 0],
  },

  attribution: {
    content: "inline*",
    parseDOM: [{ tag: "p.attribution" }],
    toDOM: () => ["p", { class: "attribution" }, 0],
  },

  bulletList: {
    group: "blockContent",
    content: "listItem+",
    parseDOM: [{ tag: "ul" }],
    toDOM: () => ["ul", 0],
  },

  orderedList: {
    group: "blockContent",
    content: "listItem+",
    attrs: { start: { default: 1 } },
    parseDOM: [
      {
        tag: "ol",
        getAttrs: (el) => ({
          start: parseInt((el as HTMLElement).getAttribute("start") || "1", 10),
        }),
      },
    ],
    toDOM: (n) =>
      n.attrs.start === 1 ? ["ol", 0] : ["ol", { start: n.attrs.start }, 0],
  },

  listItem: {
    content: "paragraph blockContent*",
    defining: true,
    parseDOM: [{ tag: "li" }],
    toDOM: () => ["li", 0],
  },

  /**
   * Figure references an asset by id. The image itself is never embedded in
   * the doc — assets live in the BookProject asset table with their measured
   * pixel dimensions, so preflight can compute effective DPI from the placed
   * width without re-decoding the file at export time.
   */
  figure: {
    group: "blockContent",
    content: "caption?",
    attrs: {
      assetId: { default: null },
      alt: { default: "" },
      decorative: { default: false }, // drives EPUB a11y: alt="" + role
      width: { default: "column" }, // "column" | "full" | "bleed"
    },
    draggable: true,
    parseDOM: [
      {
        tag: "figure[data-asset-id]",
        getAttrs: (el) => {
          const e = el as HTMLElement;
          return {
            assetId: e.dataset.assetId,
            alt: e.dataset.alt || "",
            decorative: e.dataset.decorative === "true",
            width: e.dataset.width || "column",
          };
        },
      },
    ],
    toDOM: (n) => [
      "figure",
      {
        "data-asset-id": n.attrs.assetId,
        "data-alt": n.attrs.alt,
        "data-decorative": String(n.attrs.decorative),
        "data-width": n.attrs.width,
        class: `figure figure--${n.attrs.width}`,
      },
      0,
    ],
  },

  caption: {
    content: "inline*",
    parseDOM: [{ tag: "figcaption" }],
    toDOM: () => ["figcaption", 0],
  },

  table: {
    group: "blockContent",
    content: "tableRow+",
    tableRole: "table",
    isolating: true,
    attrs: { caption: { default: "" } },
    parseDOM: [{ tag: "table" }],
    toDOM: () => ["table", ["tbody", 0]],
  },

  tableRow: {
    content: "(tableCell | tableHeader)+",
    tableRole: "row",
    parseDOM: [{ tag: "tr" }],
    toDOM: () => ["tr", 0],
  },

  tableCell: {
    content: "blockContent+",
    tableRole: "cell",
    isolating: true,
    attrs: { colspan: { default: 1 }, rowspan: { default: 1 } },
    parseDOM: [{ tag: "td" }],
    toDOM: (n) => ["td", cellAttrs(n.attrs), 0],
  },

  tableHeader: {
    content: "blockContent+",
    tableRole: "header_cell",
    isolating: true,
    attrs: { colspan: { default: 1 }, rowspan: { default: 1 } },
    parseDOM: [{ tag: "th" }],
    toDOM: (n) => ["th", cellAttrs(n.attrs), 0],
  },

  codeBlock: {
    group: "blockContent",
    content: "text*",
    marks: "",
    code: true,
    defining: true,
    attrs: { language: { default: null } },
    parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
    toDOM: (n) => [
      "pre",
      n.attrs.language ? { "data-language": n.attrs.language } : {},
      ["code", 0],
    ],
  },

  /** The asterism / ornament / blank-line break between scenes. */
  sceneBreak: {
    group: "blockContent",
    atom: true,
    selectable: true,
    parseDOM: [{ tag: "hr.scene-break" }],
    toDOM: () => ["hr", { class: "scene-break" }],
  },

  /** An author-forced page break. Rare, but poetry and gift books need it. */
  pageBreak: {
    group: "blockContent",
    atom: true,
    selectable: true,
    parseDOM: [{ tag: "hr.page-break" }],
    toDOM: () => ["hr", { class: "page-break" }],
  },

  /**
   * Footnote as an inline atom whose content is stored in attrs rather than as
   * child nodes. This is the pragmatic choice: nested editable content inside
   * an inline node is a well-known ProseMirror pain point, and footnote bodies
   * are short. Store the body as a serialized inline fragment.
   *
   * The SAME node becomes a bottom-of-page footnote in print and an endnote
   * with a backlink in EPUB — the renderer decides, not the author.
   */
  footnote: {
    group: "inline",
    inline: true,
    atom: true,
    draggable: true,
    attrs: { body: { default: "" } }, // HTML-safe inline fragment
    parseDOM: [
      {
        tag: "span.footnote",
        getAttrs: (el) => ({ body: (el as HTMLElement).dataset.body || "" }),
      },
    ],
    toDOM: (n) => ["span", { class: "footnote", "data-body": n.attrs.body }],
  },

  text: { group: "inline" },

  hardBreak: {
    group: "inline",
    inline: true,
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM: () => ["br"],
  },
};

const marks: Record<string, MarkSpec> = {
  em: {
    parseDOM: [{ tag: "i" }, { tag: "em" }, { style: "font-style=italic" }],
    toDOM: () => ["em", 0],
  },

  strong: {
    parseDOM: [
      { tag: "strong" },
      { tag: "b" },
      { style: "font-weight", getAttrs: (v) => /^(bold(er)?|[5-9]\d{2})$/.test(v as string) && null },
    ],
    toDOM: () => ["strong", 0],
  },

  /** Real small caps, via font features — not a CSS text-transform fake. */
  smallCaps: {
    parseDOM: [{ tag: "span.sc" }],
    toDOM: () => ["span", { class: "sc" }, 0],
  },

  subscript: {
    excludes: "superscript",
    parseDOM: [{ tag: "sub" }],
    toDOM: () => ["sub", 0],
  },

  superscript: {
    excludes: "subscript",
    parseDOM: [{ tag: "sup" }],
    toDOM: () => ["sup", 0],
  },

  link: {
    attrs: { href: {}, title: { default: null } },
    inclusive: false,
    parseDOM: [
      {
        tag: "a[href]",
        getAttrs: (el) => ({
          href: (el as HTMLElement).getAttribute("href"),
          title: (el as HTMLElement).getAttribute("title"),
        }),
      },
    ],
    toDOM: (m) => ["a", m.attrs, 0],
  },

  /**
   * Language span. This is load-bearing, not a nicety: it drives correct font
   * fallback and hyphenation per script in print, and it is an EPUB
   * accessibility requirement for any passage not in the book's main language.
   * A Hindi novel quoting English, or an academic book quoting Sanskrit,
   * breaks without it.
   */
  lang: {
    attrs: { code: {} }, // BCP-47: "hi", "en", "sa-Deva", "ur"
    parseDOM: [
      {
        tag: "span[lang]",
        getAttrs: (el) => ({ code: (el as HTMLElement).getAttribute("lang") }),
      },
    ],
    toDOM: (m) => ["span", { lang: m.attrs.code }, 0],
  },
};

function cellAttrs(a: Record<string, number>) {
  const out: Record<string, string> = {};
  if (a.colspan !== 1) out.colspan = String(a.colspan);
  if (a.rowspan !== 1) out.rowspan = String(a.rowspan);
  return out;
}

export const manuscriptSchema = new Schema({ nodes, marks });

/**
 * The block record. This is the DB row; `doc` is the ProseMirror JSON above.
 */
export interface Block {
  id: string;
  bookId: string;
  order: number;

  kind:
    | "half-title" | "title-page" | "copyright" | "dedication" | "epigraph-page"
    | "foreword" | "preface" | "contents"
    | "part" | "chapter"
    | "acknowledgements" | "about-author" | "bibliography" | "glossary" | "index";

  /** Chapter title. Not in the doc — see the note at the top of this file. */
  title: string;
  /** Short form for the running head when the full title won't fit. */
  runningTitle?: string;
  /** "17", "Seventeen", "" for an unnumbered prologue. Not auto-derived. */
  number?: string;

  lang: string;
  includeInToc: boolean;
  /** Overrides the template default. Novels: chapters open recto. */
  startsOn?: "any" | "recto" | "verso";

  doc: unknown; // ProseMirror JSON
}
