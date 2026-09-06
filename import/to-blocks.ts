/**
 * DOCX -> BLOCKS
 *
 * Pass B. Mammoth converts to semantic HTML; the HTML is split at the
 * boundaries detection proposed, and each piece is parsed into ProseMirror
 * JSON against the manuscript schema.
 *
 * THE ALIGNMENT PROBLEM AND ITS SOLUTION
 *
 * Detection works on paragraph indices from the raw XML. Mammoth produces a
 * flat HTML string with no index information, and merges some paragraphs
 * (list items, adjacent runs), so the two are not positionally comparable.
 *
 * The fix: before conversion, use mammoth's transformDocument to rename the
 * style of each boundary paragraph to a sentinel. A style map turns that
 * sentinel into a marker element, and the HTML is split on those markers. The
 * markers are the only thing crossing between the two passes, and there are
 * only a few dozen of them.
 */

import mammoth from "mammoth";
import { JSDOM } from "jsdom";
import { DOMParser as PMDOMParser } from "prosemirror-model";
import { createHash } from "node:crypto";

import { manuscriptSchema, type Block } from "../schema";
import { extractSignals } from "./parse-ooxml";
import { detectStructure, type StructureProposal, type Boundary } from "./detect-structure";

const SENTINEL_CHAPTER = "ZopeBoundaryChapter";
const SENTINEL_PART = "ZopeBoundaryPart";
const SENTINEL_SCENE = "ZopeSceneBreak";

export interface ImportedAsset {
  id: string;
  contentType: string;
  data: Buffer;
  pixelWidth?: number;
  pixelHeight?: number;
}

export interface ImportResult {
  blocks: Block[];
  assets: ImportedAsset[];
  proposal: StructureProposal;
  /** Surfaced on the confirmation screen — things the author should know. */
  notices: ImportNotice[];
  detectedLang: string | null;
}

export interface ImportNotice {
  severity: "info" | "warning";
  message: string;
  count?: number;
}

/* ------------------------------------------------------------------------ */

export async function importDocx(buffer: Buffer, bookId: string): Promise<ImportResult> {
  // Pass A: signals and structure proposal.
  const signals = await extractSignals(buffer);
  const proposal = detectStructure(signals);

  const chapterStarts = new Set(
    proposal.boundaries.filter((b) => b.kind !== "part" && b.headingIndices.length).map((b) => b.startIndex)
  );
  const partStarts = new Set(
    proposal.boundaries.filter((b) => b.kind === "part").map((b) => b.startIndex)
  );
  // Heading paragraphs that were folded into a title must not survive as body
  // text, or every chapter opens with its own title repeated.
  const swallowed = new Set(proposal.boundaries.flatMap((b) => b.headingIndices));
  const sceneBreaks = new Set(proposal.sceneBreaks);

  const assets: ImportedAsset[] = [];
  const notices: ImportNotice[] = [];

  // Pass B: mammoth.
  let paraIndex = -1;
  const result = await mammoth.convertToHtml(
    { buffer },
    {
      styleMap: [
        `p[style-name='${SENTINEL_CHAPTER}'] => h1.zope-boundary.zope-chapter:fresh`,
        `p[style-name='${SENTINEL_PART}'] => h1.zope-boundary.zope-part:fresh`,
        `p[style-name='${SENTINEL_SCENE}'] => hr.scene-break:fresh`,

        // Real Word styles, mapped to the schema's semantics. Level 1 headings
        // inside a chapter become h2, matching the serializer's convention
        // that h1 is reserved for the block title.
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
        "p[style-name='Heading 4'] => h4:fresh",
        "p[style-name='Quote'] => blockquote > p:fresh",
        "p[style-name='Intense Quote'] => blockquote > p:fresh",
        "p[style-name='Block Text'] => blockquote > p:fresh",
        "p[style-name='Caption'] => figcaption:fresh",
        "p[style-name='Verse'] => div.verse > p.verse-line:fresh",
        "p[style-name='Poem'] => div.verse > p.verse-line:fresh",

        // Word's "No Spacing" and "Body Text" are just body paragraphs.
        "p[style-name='No Spacing'] => p:fresh",
        "p[style-name='Body Text'] => p:fresh",

        "r[style-name='Small Caps'] => span.sc",
        "r[style-name='Book Title'] => em",
      ],

      transformDocument: mammoth.transforms.paragraph((p: any) => {
        paraIndex += 1;
        if (partStarts.has(paraIndex)) return { ...p, styleName: SENTINEL_PART };
        if (chapterStarts.has(paraIndex)) return { ...p, styleName: SENTINEL_CHAPTER };
        if (sceneBreaks.has(paraIndex)) return { ...p, styleName: SENTINEL_SCENE };
        // A heading line that was folded into the block title: drop its content.
        if (swallowed.has(paraIndex) && !chapterStarts.has(paraIndex) && !partStarts.has(paraIndex)) {
          return { ...p, children: [] };
        }
        return p;
      }),

      convertImage: mammoth.images.imgElement(async (image: any) => {
        const data: Buffer = await image.read();
        const id = createHash("sha1").update(data).digest("hex").slice(0, 16);
        if (!assets.some((a) => a.id === id)) {
          assets.push({ id, contentType: image.contentType, data });
        }
        // The schema stores an asset reference, never the image itself.
        return { "data-asset-id": id, alt: image.altText || "" };
      }),
    }
  );

  // Mammoth reports every style it could not map. This is genuinely useful to
  // show the author: "we did not recognise 3 of your styles" is honest and
  // tells them where to look.
  const unmapped = result.messages.filter((m: any) => m.type === "warning");
  if (unmapped.length) {
    notices.push({
      severity: "warning",
      message: "Some Word styles had no direct equivalent and were imported as ordinary paragraphs.",
      count: unmapped.length,
    });
  }

  const blocks = splitIntoBlocks(result.value, proposal, bookId, signals.defaultLang ?? "en");

  if (assets.length) {
    notices.push({ severity: "info", message: "Images imported.", count: assets.length });
  }
  if (proposal.needsManualSplit) {
    notices.push({
      severity: "warning",
      message: proposal.summary,
    });
  }

  return { blocks, assets, proposal, notices, detectedLang: signals.defaultLang };
}

/* ------------------------------------------------------------------------ */

function splitIntoBlocks(
  html: string,
  proposal: StructureProposal,
  bookId: string,
  lang: string
): Block[] {
  const dom = new JSDOM(`<body>${html}</body>`);
  const body = dom.window.document.body;
  const pmParser = PMDOMParser.fromSchema(manuscriptSchema);

  // Walk top-level nodes, starting a new block at each marker.
  const groups: { boundary: Boundary | null; nodes: Element[] }[] = [];
  let current: { boundary: Boundary | null; nodes: Element[] } = { boundary: null, nodes: [] };
  let boundaryCursor = 0;

  // Detection may propose a leading front-matter boundary that consumed no
  // heading paragraph — text sitting before the first chapter. It has no
  // marker in the HTML, so without this the leading group falls through with a
  // null boundary and the author's dedication arrives as "Untitled".
  const leading =
    proposal.boundaries.length && proposal.boundaries[0].headingIndices.length === 0
      ? proposal.boundaries[0]
      : null;

  const ordered = proposal.boundaries.filter((b) => b.headingIndices.length > 0);

  for (const node of Array.from(body.children)) {
    if (node.classList?.contains("zope-boundary")) {
      if (current.nodes.length || current.boundary) groups.push(current);
      current = { boundary: ordered[boundaryCursor++] ?? null, nodes: [] };
      continue; // the marker itself is not content — the title lives on the block
    }
    current.nodes.push(node as Element);
  }
  if (current.nodes.length || current.boundary) groups.push(current);

  if (leading && groups.length && groups[0].boundary === null) {
    groups[0].boundary = leading;
  }

  return groups
    .filter((g) => g.boundary || g.nodes.some((n) => n.textContent?.trim() || n.querySelector("img")))
    .map((g, i) => {
      const container = dom.window.document.createElement("div");
      g.nodes.forEach((n) => container.appendChild(n.cloneNode(true)));

      const doc = pmParser.parse(container);
      const b = g.boundary;

      return {
        id: `${bookId}-b${String(i + 1).padStart(3, "0")}`,
        bookId,
        order: i,
        kind: b?.kind ?? "chapter",
        title: b?.title ?? "Untitled",
        number: b?.number,
        lang,
        includeInToc: b ? b.kind !== "copyright" && b.kind !== "half-title" : true,
        // Novels open chapters recto. The template can override, but this is
        // the convention the author expects to see in the preview.
        startsOn: b?.kind === "chapter" || b?.kind === "part" ? "recto" : "any",
        doc: doc.toJSON(),
      } as Block;
    });
}

/**
 * WHAT TO SHOW THE AUTHOR NEXT
 *
 * Do not import silently. The confirmation screen is where this feature is won
 * or lost, and it needs exactly four things:
 *
 *   1. The summary sentence, in plain words: "Found 24 chapters, identified
 *      because they start on a new page and begin with a chapter word."
 *   2. The chapter list, with the low-confidence ones visibly flagged. Not an
 *      error state — a "check this" state.
 *   3. Merge, split, rename, and change-type on every row. Splitting needs a
 *      paragraph picker; everything else is a text field or a dropdown.
 *   4. "This is wrong, let me mark them myself" as a first-class escape, not a
 *      hidden link. Roughly one manuscript in ten will need it, and an author
 *      who can fix it in two minutes stays. One who can't, leaves.
 *
 * Log every correction with the signals that produced the wrong answer. After
 * a few hundred imports you will have a labelled dataset, and the weights in
 * detect-structure.ts stop being guesses.
 */
