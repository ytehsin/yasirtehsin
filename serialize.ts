/**
 * ProseMirror JSON -> XHTML.
 *
 * One serializer, two targets. This function is the whole reason the "same
 * Book Project powers EPUB and print" principle actually holds: print and
 * EPUB receive *identical* markup and differ only in stylesheet and in how
 * footnotes are placed.
 *
 * Written by hand rather than using DOMSerializer because:
 *   - we need XHTML (self-closing tags, escaped entities) for EPUB, and
 *   - we need to collect footnotes as a side effect, and
 *   - it avoids a jsdom dependency in the export worker.
 */

import type { Block } from "./schema";

export type Target = "print" | "epub";

export interface Asset {
  id: string;
  path: string;        // relative path in the export bundle
  pixelWidth: number;
  pixelHeight: number;
}

export interface RenderContext {
  target: Target;
  assets: Map<string, Asset>;
  /** Collected in document order; rendered as endnotes for EPUB. */
  footnotes: { id: string; body: string }[];
}

const VOID = new Set(["br", "hr", "img"]);

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");

function tag(name: string, attrs: Record<string, string | null>, inner = ""): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => ` ${k}="${escAttr(String(v))}"`)
    .join("");
  return VOID.has(name) ? `<${name}${a} />` : `<${name}${a}>${inner}</${name}>`;
}

/** Marks are applied innermost-first so nesting order stays stable. */
const MARK_ORDER = ["lang", "link", "strong", "em", "smallCaps", "superscript", "subscript"];

function applyMarks(text: string, marks: any[] = []): string {
  const sorted = [...marks].sort(
    (a, b) => MARK_ORDER.indexOf(b.type) - MARK_ORDER.indexOf(a.type)
  );
  return sorted.reduce((acc, m) => {
    switch (m.type) {
      case "em": return tag("em", {}, acc);
      case "strong": return tag("strong", {}, acc);
      case "smallCaps": return tag("span", { class: "sc" }, acc);
      case "subscript": return tag("sub", {}, acc);
      case "superscript": return tag("sup", {}, acc);
      case "link": return tag("a", { href: m.attrs.href, title: m.attrs.title }, acc);
      case "lang": return tag("span", { lang: m.attrs.code }, acc);
      default: return acc;
    }
  }, text);
}

function children(node: any, ctx: RenderContext): string {
  return (node.content || []).map((c: any) => renderNode(c, ctx)).join("");
}

function renderNode(node: any, ctx: RenderContext): string {
  switch (node.type) {
    case "text":
      return applyMarks(esc(node.text), node.marks);

    case "hardBreak":
      return tag("br", {});

    case "paragraph":
      return tag(
        "p",
        { class: node.attrs?.variant && node.attrs.variant !== "auto"
            ? `p--${node.attrs.variant}` : null },
        children(node, ctx)
      );

    case "heading":
      // level 1 inside a chapter is an <h2>: <h1> is reserved for the block
      // title emitted by the wrapper, so the heading outline stays valid.
      return tag(`h${(node.attrs?.level || 1) + 1}`, {}, children(node, ctx));

    case "blockquote":
      return tag("blockquote", {}, children(node, ctx));

    case "verse":
      return tag("div", { class: "verse" }, children(node, ctx));

    case "verseLine": {
      const i = node.attrs?.indent || 0;
      return tag(
        "p",
        { class: i ? `verse-line verse-line--i${i}` : "verse-line" },
        children(node, ctx)
      );
    }

    case "epigraph":
      return tag("div", { class: "epigraph" }, children(node, ctx));

    case "attribution":
      return tag("p", { class: "attribution" }, children(node, ctx));

    case "bulletList":
      return tag("ul", {}, children(node, ctx));

    case "orderedList":
      return tag(
        "ol",
        { start: node.attrs?.start !== 1 ? String(node.attrs.start) : null },
        children(node, ctx)
      );

    case "listItem":
      return tag("li", {}, children(node, ctx));

    case "figure": {
      const asset = ctx.assets.get(node.attrs.assetId);
      if (!asset) return "";
      const img = tag("img", {
        src: asset.path,
        alt: node.attrs.decorative ? "" : node.attrs.alt,
        role: node.attrs.decorative ? "presentation" : null,
      });
      return tag(
        "figure",
        { class: `figure figure--${node.attrs.width}` },
        img + children(node, ctx)
      );
    }

    case "caption":
      return tag("figcaption", {}, children(node, ctx));

    case "table": {
      const body = tag("tbody", {}, children(node, ctx));
      const cap = node.attrs?.caption
        ? tag("caption", {}, esc(node.attrs.caption))
        : "";
      return tag("table", {}, cap + body);
    }

    case "tableRow":
      return tag("tr", {}, children(node, ctx));

    case "tableCell":
    case "tableHeader": {
      const name = node.type === "tableHeader" ? "th" : "td";
      const a = node.attrs || {};
      return tag(
        name,
        {
          colspan: a.colspan > 1 ? String(a.colspan) : null,
          rowspan: a.rowspan > 1 ? String(a.rowspan) : null,
        },
        children(node, ctx)
      );
    }

    case "codeBlock":
      return tag(
        "pre",
        { "data-language": node.attrs?.language || null },
        tag("code", {}, esc((node.content || []).map((c: any) => c.text).join("")))
      );

    case "sceneBreak":
      return tag("hr", { class: "scene-break" });

    case "pageBreak":
      return tag("hr", { class: "page-break" });

    case "footnote": {
      const n = ctx.footnotes.length + 1;
      const id = `fn${n}`;
      ctx.footnotes.push({ id, body: node.attrs.body });

      if (ctx.target === "print") {
        // Inline the body; the print stylesheet floats it to the page foot.
        return tag(
          "span",
          { class: "footnote", id: `${id}-ref` },
          tag("span", { class: "footnote__body" }, node.attrs.body)
        );
      }
      // EPUB: a linked endnote reference. epub:type is what makes reading
      // systems offer the popup-footnote behaviour.
      return tag(
        "a",
        {
          class: "noteref",
          href: `notes.xhtml#${id}`,
          id: `${id}-ref`,
          "epub:type": "noteref",
          role: "doc-noteref",
        },
        String(n)
      );
    }

    default:
      return children(node, ctx);
  }
}

/** Render one block to a body fragment. */
export function renderBlock(block: Block, ctx: RenderContext): string {
  const inner = children(block.doc as any, ctx);

  const opener =
    block.kind === "chapter" || block.kind === "part"
      ? tag(
          "header",
          { class: "opener" },
          (block.number ? tag("p", { class: "opener__number" }, esc(block.number)) : "") +
            tag("h1", { class: "opener__title" }, esc(block.title))
        )
      : block.title
      ? tag("header", { class: "opener opener--plain" },
          tag("h1", { class: "opener__title" }, esc(block.title)))
      : "";

  return tag(
    "section",
    {
      class: `block block--${block.kind}`,
      id: `b-${block.id}`,
      lang: block.lang,
      "data-starts-on": block.startsOn || null,
      // Paged.js decides page breaks from this data attribute, not from the
      // CSS property. It converts break-before declarations into these
      // attributes during its own parse pass, which cannot resolve a var() or
      // an attribute selector — so `.block[data-starts-on="recto"] {
      // break-before: recto }` is silently ignored and every chapter opens
      // wherever it lands. Emitting the attribute directly is the fix; the CSS
      // stays for other renderers and for the editor preview.
      "data-break-before": breakBefore(block.startsOn),
      // Feeds CSS string-set for the running head.
      "data-running-title": block.runningTitle || block.title,
      "epub:type": epubType(block.kind),
    },
    opener + inner
  );
}

function breakBefore(startsOn: Block["startsOn"]): string {
  if (startsOn === "recto") return "recto";
  if (startsOn === "verso") return "verso";
  return "page";
}

function epubType(kind: Block["kind"]): string | null {
  const map: Partial<Record<Block["kind"], string>> = {
    "half-title": "halftitlepage",
    "title-page": "titlepage",
    copyright: "copyright-page",
    dedication: "dedication",
    foreword: "foreword",
    preface: "preface",
    contents: "toc",
    part: "part",
    chapter: "chapter",
    acknowledgements: "acknowledgments",
    bibliography: "bibliography",
    glossary: "glossary",
    index: "index",
  };
  return map[kind] || null;
}

/**
 * Print: every block concatenated into ONE document, because Paged.js needs
 * the whole book in a single flow to number pages and resolve the TOC.
 */
export function renderBookForPrint(
  blocks: Block[],
  assets: Map<string, Asset>,
  cssHrefs: string[],
  lang: string,
  // Becomes the PDF's Title metadata. Without it Chromium uses the source
  // filename, so every book ZOPE produces is called "book.html" in the
  // reader's title bar, in Finder's preview, and in the printer's job queue.
  title = "Untitled"
): { html: string; footnotes: RenderContext["footnotes"] } {
  const ctx: RenderContext = { target: "print", assets, footnotes: [] };
  const body = blocks.map((b) => renderBlock(b, ctx)).join("\n");
  const links = cssHrefs
    .map((h) => tag("link", { rel: "stylesheet", href: h }))
    .join("\n");
  return {
    html: `<!DOCTYPE html>
<html lang="${escAttr(lang)}">
<head><meta charset="utf-8" />
<title>${esc(title)}</title>
${links}
</head>
<body>
${body}
</body>
</html>`,
    footnotes: ctx.footnotes,
  };
}

/**
 * EPUB: one XHTML file per block, so reading systems can page efficiently and
 * the spine matches the book's structure.
 */
export function renderBlockForEpub(
  block: Block,
  assets: Map<string, Asset>
): { xhtml: string; footnotes: RenderContext["footnotes"] } {
  const ctx: RenderContext = { target: "epub", assets, footnotes: [] };
  const body = renderBlock(block, ctx);
  return {
    xhtml: `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escAttr(
      block.lang
    )}" xml:lang="${escAttr(block.lang)}">
<head><meta charset="utf-8" /><title>${esc(block.title)}</title>
<link rel="stylesheet" href="../css/book.css" />
</head>
<body>
${body}
</body>
</html>`,
    footnotes: ctx.footnotes,
  };
}
