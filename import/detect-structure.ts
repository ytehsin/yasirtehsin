/**
 * STRUCTURE DETECTION
 *
 * Given paragraph signals, propose where the chapters are.
 *
 * THE CENTRAL IDEA: do not score paragraphs in isolation. A bold centred short
 * line might be a chapter heading, a section heading, a poem title, or an
 * emphasised sentence — and no amount of tuning a per-paragraph score tells
 * them apart. What tells them apart is CONSISTENCY. A book's chapter headings
 * all look the same as each other, there are between about five and a hundred
 * of them, and they are spread fairly evenly through the document.
 *
 * So: score candidates, group them by visual signature, then pick the
 * signature that behaves like a set of chapter headings. This handles the
 * common failure case where an author used the same bold-centred style for
 * chapters AND for section headings inside chapters — the two form separate
 * clusters with different spacing regularity, and the chapter cluster wins.
 *
 * OUTPUT IS A PROPOSAL, NEVER A DECISION. Every boundary carries a confidence
 * and its evidence, so the confirmation screen can say "24 chapters found,
 * detected from page breaks and 'Chapter N' headings" and let the author fix
 * what's wrong. Getting this to 100% is impossible; getting it to 85% with a
 * good correction UI is a solved product.
 */

import type { ParaSignals, DocumentSignals } from "./parse-ooxml";
import type { Block } from "../schema";

export interface Boundary {
  /** Paragraph index where this block starts (the heading paragraph itself). */
  startIndex: number;
  endIndex: number;
  kind: Block["kind"];
  title: string;
  number?: string;
  /** Paragraph indices consumed by the heading (1 or 2 — number on its own line). */
  headingIndices: number[];
  confidence: "high" | "medium" | "low";
  evidence: string[];
}

export interface StructureProposal {
  boundaries: Boundary[];
  sceneBreaks: number[];
  /** Shown above the confirmation screen so the author knows what happened. */
  summary: string;
  /** True when detection essentially failed and everything is one block. */
  needsManualSplit: boolean;
}

/* --- Chapter-word patterns, in the languages you are launching for -------- */

const CHAPTER_WORD =
  /^(chapter|chap\.?|ch\.?|part|book|section|अध्याय|परिच्छेद|প্রধান|অধ্যায়|પ્રકરણ|అధ్యాయం|ಅಧ್ಯಾಯ|അധ്യായം|அத்தியாயம்|ਅਧਿਆਇ|باب)\b/i;

const NUMBER_ONLY =
  /^(\d{1,3}|[ivxlcdm]{1,7}|[०-९]{1,3}|[௦-௯]{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(-(one|two|three|four|five|six|seven|eight|nine))?|thirty|forty|fifty)$/i;

const PART_WORD = /^(part|book|volume|खण्ड|भाग)\b/i;

const WORD_NUMBER =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty";

/**
 * "Chapter 17: The River", "17", "XVII — The River", "अध्याय ५".
 *
 * The lookahead after the number is what stops "Dedication" from parsing as
 * Roman numeral D followed by the title "edication". A number token must be
 * followed by the end of the line or a separator, never by another letter.
 */
const HEAD_NUMBER = new RegExp(
  `^(?:(chapter|chap\\.?|ch\\.?|part|book|अध्याय|परिच्छेद|অধ্যায়|પ્રકરણ|ਅਧਿਆਇ)\\s*)?` +
    `([0-9]{1,3}|[०-९]{1,3}|[௦-௯]{1,3}|[IVXLCDM]{1,7}|[ivxlcdm]{1,7}|${WORD_NUMBER})` +
    `(?=$|[\\s.:\\-–—])\\s*[.:\\-–—]?\\s*(.*)$`,
  "i"
);

/** Front and back matter, by the words authors actually type. */
const MATTER: [RegExp, Block["kind"]][] = [
  [/^(dedication|समर्पण|अर्पण)$/i, "dedication"],
  [/^(preface|प्राक्कथन|प्रस्तावना)$/i, "preface"],
  [/^(fore\s?word|भूमिका)$/i, "foreword"],
  [/^(contents|table of contents|अनुक्रम|विषय\s?सूची)$/i, "contents"],
  [/^(acknowledge?ments?|आभार|धन्यवाद)$/i, "acknowledgements"],
  [/^(about the author|लेखक परिचय)$/i, "about-author"],
  [/^(bibliography|works cited|सन्दर्भ\s?ग्रंथ)$/i, "bibliography"],
  [/^(references|सन्दर्भ)$/i, "bibliography"],
  [/^(glossary|शब्दावली)$/i, "glossary"],
  [/^(index|अनुक्रमणिका)$/i, "index"],
  [/^(copyright|copyright page)$/i, "copyright"],
];

/** Scene break: a short line of ornament characters and nothing else. */
const SCENE_BREAK = /^[\s*#§~•·—–\-\u2042\u2E2E.]{1,12}$/;

/* ------------------------------------------------------------------------ */

interface Candidate {
  index: number;
  score: number;
  evidence: string[];
  signature: string;
}

export function detectStructure(doc: DocumentSignals): StructureProposal {
  const paras = doc.paragraphs;
  const bodySize = doc.bodySizeHalfPt;

  const candidates = paras
    .map((p) => scoreParagraph(p, paras, bodySize, doc))
    .filter((c): c is Candidate => c !== null);

  if (candidates.length === 0) {
    return oneBlock(paras, "No chapter breaks were found. The manuscript has been imported as a single chapter.");
  }

  const clusters = groupBySignature(candidates);
  const chapterCluster = pickChapterCluster(clusters, paras.length);

  if (!chapterCluster) {
    return oneBlock(
      paras,
      `Found ${candidates.length} possible headings, but they were too inconsistent to identify chapters reliably. Please mark the chapter starts.`
    );
  }

  // Authors who wrote a book over three years often formatted chapters three
  // different ways. Each way clusters separately and only one wins, leaving
  // two thirds of the book undetected. So after picking the best cluster, look
  // at the regions it does not cover and see whether another cluster fills
  // them. Merged members carry lower confidence, because we inferred them from
  // position rather than from their own formatting.
  const partCluster = pickPartCluster(clusters, chapterCluster);
  const filled = fillCoverageGaps(chapterCluster, clusters, partCluster, paras.length);

  const marks = [
    ...chapterCluster.members.map((c) => ({ c, kind: "chapter" as const })),
    ...filled.map((c) => ({ c, kind: "chapter" as const })),
    ...(partCluster?.members.map((c) => ({ c, kind: "part" as const })) ?? []),
  ].sort((a, b) => a.c.index - b.c.index);

  const boundaries = buildBoundaries(marks, paras);
  const sceneBreaks = paras
    .filter((p) => !p.isEmpty && SCENE_BREAK.test(p.text) && p.charCount <= 12)
    .map((p) => p.index);

  // Honesty check. If the manuscript has far more page breaks than we found
  // chapters, we probably missed some — say so and stop claiming high
  // confidence. Silently confident and wrong is the failure mode that loses
  // the author's trust; visibly unsure and wrong is one they will forgive.
  const pageBreaks = paras.filter((p) => p.pageBreakBefore).length;
  const undercounted = pageBreaks > boundaries.length * 1.6 && pageBreaks > 4;
  if (undercounted) {
    for (const b of boundaries) if (b.confidence === "high") b.confidence = "medium";
  }

  return {
    boundaries,
    sceneBreaks,
    summary:
      describe(boundaries, chapterCluster, filled.length) +
      (undercounted
        ? ` The manuscript has ${pageBreaks} page breaks, so some chapter starts may have been missed.`
        : ""),
    needsManualSplit: false,
  };
}

/**
 * Regions of the document the chosen cluster leaves untouched, filled from
 * other viable clusters that sit almost entirely inside them.
 */
function fillCoverageGaps(
  chosen: Cluster,
  clusters: Cluster[],
  parts: Cluster | null,
  totalParas: number
): Candidate[] {
  const idx = chosen.members.map((m) => m.index);
  const gaps = idx.slice(1).map((v, i) => v - idx[i]);
  if (gaps.length === 0) return [];

  const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  const wide = median * 2.2;

  const regions: [number, number][] = [];
  if (idx[0] > wide) regions.push([0, idx[0] - 1]);
  for (let i = 1; i < idx.length; i++) {
    if (idx[i] - idx[i - 1] > wide) regions.push([idx[i - 1] + 1, idx[i] - 1]);
  }
  const last = idx[idx.length - 1];
  if (totalParas - last > wide) regions.push([last + 1, totalParas - 1]);
  if (regions.length === 0) return [];

  const inRegion = (i: number) => regions.some(([a, b]) => i >= a && i <= b);
  const extra: Candidate[] = [];

  for (const c of clusters) {
    if (c === chosen || c === parts) continue;
    if (c.members.length < 2) continue;
    const inside = c.members.filter((m) => inRegion(m.index));
    // Require the cluster to live almost entirely in the uncovered region.
    // A cluster scattered through the whole book is section headings, not a
    // second chapter style.
    if (inside.length >= 2 && inside.length / c.members.length >= 0.8) {
      extra.push(...inside.map((m) => ({ ...m, score: Math.min(m.score, 70) })));
    }
  }

  return extra;
}

/* --- per-paragraph scoring ----------------------------------------------- */

const W = {
  outlineLevel: 45,
  headingStyleName: 35,
  pageBreak: 30,
  chapterWord: 40,
  numberOnly: 25,
  largeType: 25,
  bold: 10,
  centered: 12,
  allCaps: 10,
  keepNext: 6,
  bigSpaceBefore: 6,
  followedByBlank: 4,
  precededByBlank: 4,
  // Negative
  endsWithSentencePunctuation: -35,
  tooLong: -60,
  isListItem: -40,
  hasImage: -25,
};

const THRESHOLD = 45;
const MAX_HEADING_CHARS = 90;

function scoreParagraph(
  p: ParaSignals,
  all: ParaSignals[],
  bodySize: number,
  doc: DocumentSignals
): Candidate | null {
  if (p.isEmpty) return null;
  if (p.isListItem) return null;

  let score = 0;
  const ev: string[] = [];

  // Explicit structure, when the author gave us any, beats every heuristic.
  if (p.outlineLevel !== null && p.outlineLevel <= 1) {
    score += W.outlineLevel;
    ev.push(`Word heading level ${p.outlineLevel + 1}`);
  }
  if (p.styleName && /^(heading\s*1|heading\s*2|title|chapter)/i.test(p.styleName)) {
    score += W.headingStyleName;
    ev.push(`the Word style "${p.styleName}"`);
  }
  if (p.pageBreakBefore) {
    score += W.pageBreak;
    ev.push("a page break before them");
  }

  if (CHAPTER_WORD.test(p.text)) {
    score += W.chapterWord;
    ev.push("the word \"Chapter\"");
  }
  if (NUMBER_ONLY.test(p.text)) {
    score += W.numberOnly;
    ev.push("a number on its own");
  }

  if (p.sizeHalfPt && p.sizeHalfPt >= bodySize * 1.25) {
    score += W.largeType;
    ev.push(`larger type, ${(p.sizeHalfPt / 2).toFixed(0)}pt against ${(bodySize / 2).toFixed(0)}pt`);
  }
  if (p.boldFraction > 0.8) { score += W.bold; ev.push("bold type"); }
  if (p.alignment === "center") { score += W.centered; ev.push("centred lines"); }
  if (p.capsFraction > 0.8) { score += W.allCaps; ev.push("capitals"); }
  if (p.keepNext) score += W.keepNext;
  if (p.spaceBeforeTwips >= 480) score += W.bigSpaceBefore; // >= 24pt

  const prev = all[p.index - 1];
  const next = all[p.index + 1];
  if (prev?.isEmpty) score += W.precededByBlank;
  if (next?.isEmpty) score += W.followedByBlank;

  // Negatives. A chapter heading is short and does not end like a sentence.
  if (p.charCount > MAX_HEADING_CHARS) {
    score += W.tooLong;
  } else if (p.charCount > 60) {
    score -= 15;
  }
  if (/[.!?,;:।]$/.test(p.text)) {
    // Devanagari danda included. A trailing full stop is the single most
    // reliable sign that a short bold line is a sentence, not a heading.
    score += W.endsWithSentencePunctuation;
  }
  if (p.hasImage) score += W.hasImage;

  if (score < THRESHOLD) return null;

  return { index: p.index, score, evidence: ev, signature: signatureOf(p, bodySize) };
}

/**
 * The visual fingerprint. Two headings with the same signature were formatted
 * the same way, which is what "these are the same kind of thing" means in a
 * document that has no semantic markup.
 */
function signatureOf(p: ParaSignals, bodySize: number): string {
  const sizeBucket = p.sizeHalfPt ? Math.round((p.sizeHalfPt / bodySize) * 4) / 4 : 1;
  return [
    p.styleId ?? "none",
    `x${sizeBucket}`,
    p.boldFraction > 0.8 ? "b" : "-",
    p.capsFraction > 0.8 ? "C" : "-",
    p.alignment ?? "-",
    p.pageBreakBefore ? "P" : "-",
  ].join("|");
}

/* --- clustering ---------------------------------------------------------- */

interface Cluster {
  signature: string;
  members: Candidate[];
  meanScore: number;
  /** Coefficient of variation of the gaps. Lower = more evenly spaced. */
  spacingCV: number;
  clusterScore: number;
}

function groupBySignature(cands: Candidate[]): Cluster[] {
  const groups = new Map<string, Candidate[]>();
  for (const c of cands) {
    const g = groups.get(c.signature) ?? [];
    g.push(c);
    groups.set(c.signature, g);
  }

  return [...groups.entries()].map(([signature, members]) => {
    members.sort((a, b) => a.index - b.index);
    const gaps = members.slice(1).map((m, i) => m.index - members[i].index);
    const meanGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    const variance = gaps.length
      ? gaps.reduce((a, g) => a + (g - meanGap) ** 2, 0) / gaps.length
      : 0;
    const cv = meanGap > 0 ? Math.sqrt(variance) / meanGap : 99;
    const meanScore = members.reduce((a, m) => a + m.score, 0) / members.length;

    return { signature, members, meanScore, spacingCV: cv, clusterScore: 0 };
  });
}

/**
 * Which cluster is the chapters?
 *
 * Books have 5 to 120 chapters. Chapters are long — at least a few paragraphs.
 * Chapters are roughly evenly spaced. Section headings inside chapters fail the
 * spacing test (they bunch) and usually fail the count test (there are far more
 * of them).
 */
function pickChapterCluster(clusters: Cluster[], totalParas: number): Cluster | null {
  const viable = clusters.filter((c) => {
    if (c.members.length < 2) return false;
    if (c.members.length > 200) return false;
    const meanGap = totalParas / c.members.length;
    return meanGap >= 4; // chapters shorter than 4 paragraphs are section heads
  });

  if (viable.length === 0) return null;

  for (const c of viable) {
    const n = c.members.length;
    const countFit = n >= 5 && n <= 120 ? 1 : n >= 2 && n <= 200 ? 0.5 : 0.2;
    // CV of 0 is suspiciously perfect; 0.3-0.8 is what real books look like.
    const regularity = 1 / (1 + c.spacingCV);
    c.clusterScore = c.meanScore * countFit * (0.5 + 0.5 * regularity);
  }

  viable.sort((a, b) => b.clusterScore - a.clusterScore);
  return viable[0];
}

/**
 * Parts are rarer, more prominent, and always fewer than the chapters they
 * contain. Require a real gap in count so a mis-clustered chapter set doesn't
 * get promoted.
 */
function pickPartCluster(clusters: Cluster[], chapters: Cluster): Cluster | null {
  const candidates = clusters.filter(
    (c) =>
      c !== chapters &&
      c.members.length >= 2 &&
      c.members.length <= Math.max(2, chapters.members.length / 2) &&
      c.meanScore >= chapters.meanScore
  );
  if (candidates.length === 0) return null;

  const best = candidates.sort((a, b) => b.meanScore - a.meanScore)[0];
  const looksLikeParts = best.members.some((m) => PART_WORD.test(""));
  return best.members.length <= 12 || looksLikeParts ? best : null;
}

/* --- assembling boundaries ----------------------------------------------- */

function buildBoundaries(
  marks: { c: Candidate; kind: "chapter" | "part" }[],
  paras: ParaSignals[]
): Boundary[] {
  const out: Boundary[] = [];

  // Anything before the first mark is front matter.
  if (marks.length > 0 && marks[0].c.index > 0) {
    const firstContent = paras.findIndex((p) => !p.isEmpty);
    if (firstContent >= 0 && firstContent < marks[0].c.index) {
      out.push({
        startIndex: 0,
        endIndex: marks[0].c.index - 1,
        kind: "preface",
        title: paras[firstContent].text.slice(0, 80) || "Front matter",
        headingIndices: [],
        confidence: "low",
        evidence: ["appears before the first chapter"],
      });
    }
  }

  marks.forEach((m, i) => {
    const start = m.c.index;
    const end = i + 1 < marks.length ? marks[i + 1].c.index - 1 : paras.length - 1;

    const { title: rawTitle, number, consumed } = readHeading(paras, start);
    const kind = classifyKind(rawTitle || paras[start].text, m.kind);

    const title =
      rawTitle ||
      (number
        ? `${kind === "part" ? "Part" : "Chapter"} ${number}`
        : kind === "part"
        ? "Part"
        : "Untitled chapter");

    out.push({
      startIndex: start,
      endIndex: end,
      kind,
      title,
      number,
      headingIndices: consumed,
      confidence: m.c.score >= 90 ? "high" : m.c.score >= 65 ? "medium" : "low",
      evidence: m.c.evidence,
    });
  });

  return out;
}

/**
 * Chapter headings frequently span two paragraphs: "17" then "The Silent
 * River". Merge them, but only when the second line looks like a title rather
 * than the first line of prose.
 */
function readHeading(paras: ParaSignals[], start: number) {
  const head = paras[start];
  const consumed = [start];
  let number: string | undefined;
  let title = head.text;

  // Named front and back matter is matched on the RAW text and never goes
  // through number parsing. Otherwise "Dedication" has its D read as the Roman
  // numeral 500 and arrives as a chapter called "edication".
  if (MATTER.some(([re]) => re.test(head.text.trim()))) {
    return { title: head.text.trim(), number: undefined, consumed };
  }

  const numMatch = head.text.match(HEAD_NUMBER);
  if (numMatch) {
    number = numMatch[2];
    title = (numMatch[3] || "").trim();
  } else if (CHAPTER_WORD.test(head.text)) {
    title = head.text.replace(CHAPTER_WORD, "").replace(/^[\s.:\-–—]+/, "").trim();
  }

  if (!title) {
    // Look ahead past blanks for the real title line.
    for (let j = start + 1; j < Math.min(start + 4, paras.length); j++) {
      const p = paras[j];
      if (p.isEmpty) continue;
      const looksLikeTitle =
        p.charCount <= MAX_HEADING_CHARS && !/[.!?।]$/.test(p.text);
      if (looksLikeTitle) {
        title = p.text;
        consumed.push(j);
      }
      break;
    }
  }

  // Deliberately not synthesised here: only the caller knows whether this is a
  // chapter or a part, and "Part 3" arriving as "Chapter 3" is the kind of
  // small wrongness an author notices immediately and never forgets.
  return { title, number, consumed };
}

function classifyKind(title: string, fallback: "chapter" | "part"): Block["kind"] {
  for (const [re, kind] of MATTER) {
    if (re.test(title.trim())) return kind;
  }
  return fallback;
}

/* --- fallbacks and reporting --------------------------------------------- */

function oneBlock(paras: ParaSignals[], summary: string): StructureProposal {
  return {
    boundaries: [
      {
        startIndex: 0,
        endIndex: paras.length - 1,
        kind: "chapter",
        title: "Chapter 1",
        headingIndices: [],
        confidence: "low",
        evidence: [],
      },
    ],
    sceneBreaks: paras
      .filter((p) => !p.isEmpty && SCENE_BREAK.test(p.text))
      .map((p) => p.index),
    summary,
    needsManualSplit: true,
  };
}

function describe(boundaries: Boundary[], cluster: Cluster, merged = 0): string {
  const chapters = boundaries.filter((b) => b.kind === "chapter").length;
  const parts = boundaries.filter((b) => b.kind === "part").length;
  const low = boundaries.filter((b) => b.confidence === "low").length;

  const reasons = [...new Set(cluster.members.flatMap((m) => m.evidence))].slice(0, 3);

  let s = `Found ${chapters} chapter${chapters === 1 ? "" : "s"}`;
  if (parts) s += ` across ${parts} parts`;
  if (merged) s += ` (${merged} formatted differently from the rest)`;
  if (reasons.length) s += `, identified by ${reasons.join(", ")}`;
  s += ".";
  if (low) s += ` ${low} need${low === 1 ? "s" : ""} checking.`;
  return s;
}
