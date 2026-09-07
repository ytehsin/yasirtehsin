/**
 * Template tokens -> CSS.
 *
 * WHY THIS EXISTS RATHER THAN A HAND-WRITTEN tokens.css:
 *
 * CSS custom properties do not work inside `@page`. The @page context is
 * outside the document tree, so `size: var(--page-width) var(--page-height)`
 * resolves to nothing — in Chromium and in Paged.js alike. Every project that
 * tries the "just use CSS variables everywhere" approach hits this and ends up
 * with letter-sized output.
 *
 * So the page box is GENERATED with literal values, from the same token record
 * that also produces the :root block. One source of truth, two emissions.
 *
 * This also gives you the numbers the rest of the platform needs: the spine
 * calculator, the cover template, and preflight all read the same tokens.
 */

export interface TemplateTokens {
  id: string;
  name: string;

  page: {
    widthMm: number;
    heightMm: number;
    marginTopMm: number;
    marginBottomMm: number;
    marginInnerMm: number;   // binding side — larger, this is the gutter
    marginOuterMm: number;
    bleedMm: number;         // 3mm typical; 0 for interiors with no bleed art
  };

  runningHead: {
    verso: "author" | "title" | "none";
    recto: "chapter" | "title" | "none";
    sizePt: number;
    tracking: string;
    transform: "none" | "uppercase" | "lowercase";
    family: "body" | "display";
  };

  folio: {
    // Page numbers. `outer` is the book-conventional position. "none" omits
    // them entirely — used by front-matter-only projects and by the render
    // round-trip test, which compares text and does not want page furniture.
    position: "outer" | "center" | "none";
    location: "foot" | "head";
    sizePt: number;
    figures: "lining" | "oldstyle";
  };

  /** Every remaining key becomes a CSS custom property verbatim. */
  vars: Record<string, string>;
}

const mm = (n: number) => `${n}mm`;

export function emitPageSetup(t: TemplateTokens): string {
  const p = t.page;
  const rh = t.runningHead;
  const f = t.folio;

  const headFamily = rh.family === "display" ? "var(--display-family)" : "var(--body-family)";

  const runningHeadStyle = `
    font-family: ${headFamily};
    font-size: ${rh.sizePt}pt;
    letter-spacing: ${rh.tracking};
    text-transform: ${rh.transform};
    color: var(--ink-muted);`;

  const folioStyle = `
    font-family: var(--body-family);
    font-size: ${f.sizePt}pt;
    font-variant-numeric: ${f.figures === "oldstyle" ? "oldstyle-nums" : "lining-nums"};
    content: counter(page);`;

  const showFolio = f.position !== "none";

  // Margin-box selection. Verso = left page, recto = right page.
  const folioVersoBox =
    f.position === "center" ? "@bottom-center" : "@bottom-left";
  const folioRectoBox =
    f.position === "center" ? "@bottom-center" : "@bottom-right";
  const folioVersoTop = f.location === "head" ? folioVersoBox.replace("bottom", "top") : folioVersoBox;
  const folioRectoTop = f.location === "head" ? folioRectoBox.replace("bottom", "top") : folioRectoBox;

  const versoHeadContent =
    rh.verso === "author" ? "var(--meta-author)" :
    rh.verso === "title"  ? "var(--meta-title)"  : "normal";
  const rectoHeadContent =
    rh.recto === "chapter" ? "string(chapter-title)" :
    rh.recto === "title"   ? "var(--meta-title)"     : "normal";

  return `/* GENERATED — do not edit. Source: template "${t.id}". */

@page {
  size: ${mm(p.widthMm)} ${mm(p.heightMm)};
  margin: ${mm(p.marginTopMm)} ${mm(p.marginOuterMm)} ${mm(p.marginBottomMm)} ${mm(p.marginInnerMm)};
  ${p.bleedMm > 0 ? `bleed: ${mm(p.bleedMm)};\n  marks: crop cross;` : ""}
}

@page :left {
  margin-left: ${mm(p.marginOuterMm)};
  margin-right: ${mm(p.marginInnerMm)};
  @top-center { content: ${versoHeadContent}; ${runningHeadStyle} }
  ${showFolio ? `${folioVersoTop} { ${folioStyle} }` : ""}
}

@page :right {
  margin-left: ${mm(p.marginInnerMm)};
  margin-right: ${mm(p.marginOuterMm)};
  @top-center { content: ${rectoHeadContent}; ${runningHeadStyle} }
  ${showFolio ? `${folioRectoTop} { ${folioStyle} }` : ""}
}

/* A chapter opening page carries no running head, and by convention no folio
   either (or a centred one). Blank versos carry nothing at all. */
@page chapter-opening {
  @top-center { content: normal; }
  @top-left { content: normal; }
  @top-right { content: normal; }
}

@page :blank {
  @top-center { content: normal; }
  @bottom-left { content: normal; }
  @bottom-right { content: normal; }
  @bottom-center { content: normal; }
}

.block--chapter, .block--part { page: chapter-opening; }
`;
}

export function emitTokens(t: TemplateTokens, meta: { title: string; author: string }): string {
  const lines = Object.entries(t.vars).map(([k, v]) => `  --${k}: ${v};`);

  // Book metadata that the running head needs, injected as strings.
  lines.push(`  --meta-title: "${meta.title.replace(/"/g, '\\"')}";`);
  lines.push(`  --meta-author: "${meta.author.replace(/"/g, '\\"')}";`);

  return `/* GENERATED — do not edit. Source: template "${t.id}". */\n:root {\n${lines.join("\n")}\n}\n`;
}

/**
 * Trim size in mm, which the cover template and spine calculator both need.
 * Kept here so there is exactly one place that knows a book's dimensions.
 */
export function trimSize(t: TemplateTokens) {
  return { widthMm: t.page.widthMm, heightMm: t.page.heightMm };
}

/**
 * Text block dimensions — used by preflight to compute effective image DPI:
 * an image placed at column width has effective DPI = pixelWidth / (columnWidthMm / 25.4).
 */
export function textBlock(t: TemplateTokens) {
  const p = t.page;
  return {
    widthMm: p.widthMm - p.marginInnerMm - p.marginOuterMm,
    heightMm: p.heightMm - p.marginTopMm - p.marginBottomMm,
  };
}
