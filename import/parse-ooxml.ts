/**
 * OOXML PARAGRAPH SIGNALS
 *
 * Mammoth deliberately throws away direct formatting — that is exactly why it
 * produces clean semantic HTML, and exactly why it cannot find chapters. Real
 * author manuscripts almost never use Word's Heading styles. Chapters are
 * marked by 16pt bold centred text, or a manual page break, or the literal
 * word "Chapter", or nothing but a few blank lines.
 *
 * So the importer runs two passes over the same file:
 *
 *   Pass A (this file)  read word/document.xml directly, keep every signal
 *                       that might indicate a chapter boundary
 *   Pass B (to-blocks)  mammoth, with a style map informed by what pass A found
 *
 * One Word quirk to know: a single visible sentence is usually split across
 * many <w:r> runs, because Word inserts revision ids and spell-check markers
 * mid-word. Any text you extract must concatenate every <w:t> in the
 * paragraph, or your regexes will silently miss half their matches.
 */

import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

export interface ParaSignals {
  index: number;
  text: string;
  charCount: number;
  isEmpty: boolean;

  styleId: string | null;
  styleName: string | null;
  /** 0 = top level. Word sets this on built-in headings and on custom styles
   *  whose author bothered to configure them, which is rare but decisive. */
  outlineLevel: number | null;

  pageBreakBefore: boolean;
  sectionBreakBefore: boolean;

  alignment: "left" | "center" | "right" | "justify" | null;
  /** Half-points, as OOXML stores it. 24 = 12pt. */
  sizeHalfPt: number | null;
  boldFraction: number;
  italicFraction: number;
  capsFraction: number;
  smallCapsFraction: number;

  spaceBeforeTwips: number;
  keepNext: boolean;
  numId: string | null;

  hasImage: boolean;
  isListItem: boolean;
}

export interface DocumentSignals {
  paragraphs: ParaSignals[];
  /** Modal body size in half-points — the baseline everything is judged against. */
  bodySizeHalfPt: number;
  bodyStyleId: string | null;
  /** True if the author used real Word heading styles anywhere. */
  hasOutlineStructure: boolean;
  defaultLang: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  preserveOrder: false,
  isArray: (name) => ["w:p", "w:r", "w:t", "w:tab", "w:br", "w:style"].includes(name),
});

export async function extractSignals(buffer: Buffer): Promise<DocumentSignals> {
  const zip = await JSZip.loadAsync(buffer);

  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) throw new Error("Not a Word document: word/document.xml is missing.");

  const stylesXml = await zip.file("word/styles.xml")?.async("string");
  const styles = stylesXml ? parseStyles(stylesXml) : new Map();
  const docDefaultSize = stylesXml ? parseDocDefaultSize(stylesXml) : 22;

  const doc = parser.parse(docXml);
  const body = doc?.["w:document"]?.["w:body"];
  const rawParas: any[] = body?.["w:p"] ?? [];

  const paragraphs: ParaSignals[] = rawParas.map((p, i) => readParagraph(p, i, styles, docDefaultSize));

  const bodySizeHalfPt = modalSize(paragraphs, docDefaultSize);
  const bodyStyleId = modalStyle(paragraphs);

  return {
    paragraphs,
    bodySizeHalfPt,
    bodyStyleId,
    hasOutlineStructure: paragraphs.some((p) => p.outlineLevel !== null && p.outlineLevel <= 1),
    defaultLang: readDefaultLang(stylesXml),
  };
}

/* ------------------------------------------------------------------------ */

interface StyleInfo {
  id: string;
  name: string;
  outlineLevel: number | null;
  sizeHalfPt: number | null;
  bold: boolean;
  alignment: string | null;
  basedOn: string | null;
}

function parseStyles(xml: string): Map<string, StyleInfo> {
  const parsed = parser.parse(xml);
  const list: any[] = parsed?.["w:styles"]?.["w:style"] ?? [];
  const map = new Map<string, StyleInfo>();

  for (const s of list) {
    const id = s?.["@w:styleId"];
    if (!id) continue;
    const pPr = s?.["w:pPr"];
    const rPr = s?.["w:rPr"];
    map.set(id, {
      id,
      name: s?.["w:name"]?.["@w:val"] ?? id,
      outlineLevel: num(pPr?.["w:outlineLvl"]?.["@w:val"]),
      sizeHalfPt: num(rPr?.["w:sz"]?.["@w:val"]),
      bold: present(rPr?.["w:b"]),
      alignment: pPr?.["w:jc"]?.["@w:val"] ?? null,
      basedOn: s?.["w:basedOn"]?.["@w:val"] ?? null,
    });
  }

  // Resolve inheritance one level up; deeper chains are vanishingly rare in
  // author manuscripts and not worth the cycle-detection code.
  for (const s of map.values()) {
    if (!s.basedOn) continue;
    const parent = map.get(s.basedOn);
    if (!parent) continue;
    if (s.outlineLevel === null) s.outlineLevel = parent.outlineLevel;
    if (s.sizeHalfPt === null) s.sizeHalfPt = parent.sizeHalfPt;
    if (!s.alignment) s.alignment = parent.alignment;
  }

  return map;
}

function readParagraph(
  p: any,
  index: number,
  styles: Map<string, StyleInfo>,
  docDefaultSize: number
): ParaSignals {
  const pPr = p?.["w:pPr"] ?? {};
  const styleId: string | null = pPr?.["w:pStyle"]?.["@w:val"] ?? null;
  const style = styleId ? styles.get(styleId) : undefined;

  const runs: any[] = p?.["w:r"] ?? [];

  // Concatenate every text node. See the run-fragmentation note above.
  let text = "";
  let hasImage = false;
  let boldChars = 0;
  let italicChars = 0;
  let capsChars = 0;
  let smallCapsChars = 0;
  let totalChars = 0;
  const sizes: number[] = [];
  let inlinePageBreak = false;

  for (const r of runs) {
    const rPr = r?.["w:rPr"] ?? {};
    const texts: any[] = r?.["w:t"] ?? [];
    let runText = texts.map((t) => (typeof t === "string" ? t : t?.["#text"] ?? "")).join("");
    if (r?.["w:tab"]) runText = "\t" + runText;

    const brs: any[] = r?.["w:br"] ?? [];
    for (const b of brs) {
      if (b?.["@w:type"] === "page") inlinePageBreak = true;
    }

    if (r?.["w:drawing"] || r?.["w:pict"]) hasImage = true;

    const len = runText.length;
    totalChars += len;
    text += runText;

    if (present(rPr["w:b"]) || style?.bold) boldChars += len;
    if (present(rPr["w:i"])) italicChars += len;
    if (present(rPr["w:caps"])) capsChars += len;
    if (present(rPr["w:smallCaps"])) smallCapsChars += len;

    const sz = num(rPr["w:sz"]?.["@w:val"]);
    if (sz && len > 0) sizes.push(sz);
  }

  const trimmed = text.trim();
  const effectiveSize =
    sizes.length > 0 ? mode(sizes) : style?.sizeHalfPt ?? docDefaultSize;

  // Text that is visually uppercase counts as caps whether it was typed that
  // way or applied as a run property. Authors do both, roughly half and half.
  //
  // No minimum length. Requiring more than one character looks harmless and is
  // not: in a manuscript numbered I, II, III ... the single-letter headings
  // fail the test while the rest pass, the signature splits in two, and
  // clustering silently drops I, V and X. Any rule that treats short headings
  // differently from long ones will fragment a cluster somewhere.
  const typedCaps =
    trimmed === trimmed.toUpperCase() && /[A-Z\u0400-\u04FF]/.test(trimmed);

  return {
    index,
    text: trimmed,
    charCount: trimmed.length,
    isEmpty: trimmed.length === 0 && !hasImage,

    styleId,
    styleName: style?.name ?? null,
    outlineLevel:
      num(pPr?.["w:outlineLvl"]?.["@w:val"]) ?? style?.outlineLevel ?? null,

    pageBreakBefore: present(pPr["w:pageBreakBefore"]) || inlinePageBreak,
    sectionBreakBefore: Boolean(pPr["w:sectPr"]),

    alignment: (pPr?.["w:jc"]?.["@w:val"] ?? style?.alignment ?? null) as any,
    sizeHalfPt: effectiveSize,
    boldFraction: totalChars ? boldChars / totalChars : 0,
    italicFraction: totalChars ? italicChars / totalChars : 0,
    capsFraction: typedCaps ? 1 : totalChars ? capsChars / totalChars : 0,
    smallCapsFraction: totalChars ? smallCapsChars / totalChars : 0,

    spaceBeforeTwips: num(pPr?.["w:spacing"]?.["@w:before"]) ?? 0,
    keepNext: present(pPr["w:keepNext"]),
    numId: pPr?.["w:numPr"]?.["w:numId"]?.["@w:val"] ?? null,

    hasImage,
    isListItem: Boolean(pPr?.["w:numPr"]),
  };
}

/* --- small helpers ------------------------------------------------------- */

function num(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** OOXML toggles: present with no val, or val="1"/"true", means on. */
function present(v: any): boolean {
  if (v === undefined || v === null) return false;
  const val = v?.["@w:val"];
  if (val === undefined) return true;
  return val !== "0" && val !== "false";
}

function mode(xs: number[]): number {
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** Weighted by character count, so a few big headings don't skew it. */
function modalSize(paras: ParaSignals[], fallback: number): number {
  const weights = new Map<number, number>();
  for (const p of paras) {
    if (p.isEmpty || !p.sizeHalfPt) continue;
    weights.set(p.sizeHalfPt, (weights.get(p.sizeHalfPt) ?? 0) + p.charCount);
  }
  if (weights.size === 0) return fallback;
  return [...weights.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function modalStyle(paras: ParaSignals[]): string | null {
  const weights = new Map<string, number>();
  for (const p of paras) {
    if (p.isEmpty) continue;
    const k = p.styleId ?? "__default";
    weights.set(k, (weights.get(k) ?? 0) + p.charCount);
  }
  if (weights.size === 0) return null;
  const top = [...weights.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return top === "__default" ? null : top;
}

/**
 * The default body size, when no paragraph sets one explicitly.
 *
 * Scope the search to the docDefaults block. An unscoped lazy match runs
 * straight past </w:docDefaults> into the style list and returns the first
 * w:sz it finds there — typically the Title style at 28pt. That makes every
 * real heading look SMALLER than "body text", the large-type signal never
 * fires, and manuscripts with no explicit body sizing detect zero chapters.
 */
function parseDocDefaultSize(xml: string): number {
  const block = xml.match(/<w:docDefaults>[\s\S]*?<\/w:docDefaults>/);
  const inDefaults = block?.[0].match(/<w:sz\s+w:val="(\d+)"/);
  if (inDefaults) return Number(inDefaults[1]);

  const normal = xml.match(/<w:style\b[^>]*w:styleId="Normal"[\s\S]*?<\/w:style>/);
  const inNormal = normal?.[0].match(/<w:sz\s+w:val="(\d+)"/);
  return inNormal ? Number(inNormal[1]) : 22; // Word's 11pt default
}

function readDefaultLang(xml: string | undefined): string | null {
  if (!xml) return null;
  const m = xml.match(/<w:lang[^>]*w:val="([a-zA-Z-]+)"/);
  return m ? m[1] : null;
}
