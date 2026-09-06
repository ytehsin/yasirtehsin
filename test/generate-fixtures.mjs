/**
 * FIXTURE CORPUS GENERATOR
 *
 * Produces twenty .docx files that fail in the twenty ways real author
 * manuscripts fail, each paired with a ground-truth manifest.
 *
 * Why generate rather than collect: you need ground truth. A donated
 * manuscript has to be read and labelled by hand, and you cannot commit
 * someone's unpublished novel to a repo. Generated fixtures give you exact
 * expected output, legal certainty, and the ability to add a new failure mode
 * in five minutes. Collect real manuscripts too, as a second private corpus —
 * but the CI gate runs on these.
 *
 *   node generate-fixtures.mjs [outDir]
 */

import {
  Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel,
  Table, TableRow, TableCell, WidthType, ShadingType, Footer, PageNumber,
} from "docx";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/* --- prose filler -------------------------------------------------------- */

const EN = [
  "The rain had not stopped for three days, and the road out of the valley was gone.",
  "She counted the coins twice before putting them back in the tin, as though the second count might disagree with the first.",
  "Nobody in the village used the old name any more, but everybody knew it.",
  "He learned to read from the labels on seed packets, which is why he always spelled marigold with two Rs.",
  "There was a particular quality to the silence in that house, a sort of attention.",
  "The bus came at six, or it came at seven, and there was no arguing with either.",
  "Her mother had a saying for this and had never once been asked to explain it.",
  "By the time the letter arrived the question it answered had stopped mattering.",
];

const HI = [
  "बारिश तीन दिन से नहीं रुकी थी और घाटी से बाहर जाने वाली सड़क बह चुकी थी।",
  "उसने सिक्कों को दो बार गिना, मानो दूसरी गिनती पहली से अलग निकल आएगी।",
  "गाँव में अब कोई पुराना नाम नहीं लेता था, पर सबको वह याद था।",
  "उस घर की चुप्पी में एक अलग ही तरह का ध्यान था।",
  "उसकी माँ के पास इस बात के लिए एक कहावत थी, जिसका मतलब कभी किसी ने नहीं पूछा।",
];

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];

/** n body paragraphs. */
const body = (n, pool = EN) =>
  Array.from({ length: n }, () => ({ t: [pick(pool), pick(pool), pick(pool)].join(" ") }));

const blank = () => ({ t: "" });

/* --- spec -> docx -------------------------------------------------------- */

function toParagraph(s) {
  const align = { center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED }[s.align];

  const opts = {
    children: [
      new TextRun({
        text: s.t ?? "",
        bold: s.b || undefined,
        italics: s.i || undefined,
        allCaps: s.caps || undefined,
        smallCaps: s.sc || undefined,
        size: s.size ? s.size * 2 : undefined, // pt -> half-points
        font: s.font || undefined,
      }),
    ],
    alignment: align,
    pageBreakBefore: s.brk || undefined,
    keepNext: s.keepNext || undefined,
    spacing: s.before ? { before: s.before * 20 } : undefined, // pt -> twips
  };

  if (s.heading === 1) opts.heading = HeadingLevel.HEADING_1;
  if (s.heading === 2) opts.heading = HeadingLevel.HEADING_2;
  if (s.heading === 3) opts.heading = HeadingLevel.HEADING_3;
  if (s.style) opts.style = s.style;
  if (s.bullet) opts.bullet = { level: 0 };

  return new Paragraph(opts);
}

/* --- the twenty ---------------------------------------------------------- */

const fixtures = [];
const F = (id, description, breaks, build, expected) =>
  fixtures.push({ id, description, breaks, build, expected });

/* 1 */
F("01-pagebreaks-only", "No styles anywhere. Chapters marked by a manual page break and a bare number.",
  "The commonest real-world case. Nothing semantic to grab; detection rests entirely on page breaks plus short numeric lines.",
  () => {
    const p = [...body(2)];
    for (let i = 1; i <= 18; i++) {
      p.push({ t: String(i), brk: true, align: "center" }, blank(), ...body(9));
    }
    return p;
  },
  { chapters: 18, parts: 0, firstTitle: "Chapter 1" });

/* 2 */
F("02-number-then-title", "Chapter number and title on separate lines.",
  "Tests heading merging. A detector that treats these as two boundaries reports 48 chapters instead of 24.",
  () => {
    const titles = ["The Silent River", "Ash and Salt", "What the Ferryman Said", "A Borrowed Coat",
      "Nightjar", "The Long Field", "Debts", "The Second Letter", "Weather", "Coming Back",
      "The Photograph", "Small Hours"];
    const p = [];
    titles.forEach((t, i) => {
      p.push({ t: String(i + 1), brk: true, align: "center", size: 14, b: true }, blank(),
              { t, align: "center", size: 16, b: true }, blank(), ...body(10));
    });
    return p;
  },
  { chapters: 12, parts: 0, firstTitle: "The Silent River" });

/* 3 */
F("03-nonfiction-parts", "Parts, chapters and two levels of section headings, all properly styled.",
  "The well-behaved case. If this one fails, the bug is structural, not heuristic.",
  () => {
    const p = [];
    for (let part = 1; part <= 3; part++) {
      p.push({ t: `Part ${part}`, heading: 1, brk: true, align: "center", size: 22 });
      p.push(...body(1));
      for (let c = 1; c <= 4; c++) {
        p.push({ t: `Chapter ${(part - 1) * 4 + c}: Working Capital`, heading: 2, brk: true });
        p.push(...body(6));
        p.push({ t: "Where the money goes", heading: 3 }, ...body(5));
        p.push({ t: "A simple test", heading: 3 }, ...body(5));
      }
    }
    return p;
  },
  { chapters: 12, parts: 3, firstTitle: "Working Capital" });

/* 4 */
F("04-heading1-overused", "Heading 1 applied to chapters AND to sections inside them.",
  "The case that breaks per-paragraph scoring. Both sets carry identical style signals; only spacing regularity and count separate them.",
  () => {
    const p = [];
    for (let c = 1; c <= 10; c++) {
      p.push({ t: `Chapter ${c}`, heading: 1, brk: true, align: "center" }, ...body(6));
      for (let s = 1; s <= 3; s++) p.push({ t: `Section ${c}.${s}`, heading: 1 }, ...body(5));
    }
    return p;
  },
  { chapters: 10, parts: 0, firstTitle: "Chapter 10", note: "40 Heading-1 paragraphs; only 10 are chapters." });

/* 5 */
F("05-hindi-novel", "Hindi novel, chapters marked अध्याय N.",
  "Devanagari script, Devanagari numerals in some headings, danda terminal punctuation.",
  () => {
    const p = [];
    const dev = ["१", "२", "३", "४", "५", "६", "७", "८", "९", "१०", "११", "१२", "१३", "१४"];
    dev.forEach((n) => {
      p.push({ t: `अध्याय ${n}`, brk: true, align: "center", b: true, size: 16 }, blank(), ...body(9, HI));
    });
    return p;
  },
  { chapters: 14, parts: 0 });

/* 6 */
F("06-mixed-hindi-english", "Hindi body text with English chapter headings and quoted English passages.",
  "Language spans matter here: without them the English quotes inherit Devanagari leading.",
  () => {
    const p = [];
    for (let i = 1; i <= 9; i++) {
      p.push({ t: `Chapter ${i}`, brk: true, align: "center", b: true, size: 15 }, blank());
      p.push(...body(4, HI));
      p.push({ t: `"${pick(EN)}"`, i: true });
      p.push(...body(4, HI));
    }
    return p;
  },
  { chapters: 9, parts: 0 });

/* 7 */
F("07-poetry", "Poetry collection. Line breaks are semantic; poem titles are the chapter headings.",
  "Verse lines are short and unpunctuated, which is exactly what a chapter heading looks like. Heavy false-positive pressure.",
  () => {
    const titles = ["Aubade", "The Kitchen at Four", "Migration", "Postcard from Nashik",
      "Winter Count", "Reading the Meter", "Aunt Susheela", "Harbour", "The Lender", "Amen"];
    const p = [];
    titles.forEach((t) => {
      p.push({ t, brk: true, align: "center", b: true, size: 15 }, blank());
      for (let s = 0; s < 4; s++) {
        for (let l = 0; l < 4; l++) p.push({ t: pick(EN).split(",")[0], style: undefined });
        p.push(blank());
      }
    });
    return p;
  },
  { chapters: 10, parts: 0, note: "160 short unpunctuated verse lines must NOT become chapters." });

/* 8 */
F("08-academic", "Academic monograph: numbered chapters, tables, block quotes, long headings.",
  "Long descriptive headings push against the length cutoff.",
  () => {
    const p = [];
    const heads = [
      "1. Situating the Informal Sector Within Post-Liberalisation Economic Policy",
      "2. Method and Sampling Across Four Districts",
      "3. Household Credit and the Limits of Microfinance",
      "4. Gendered Labour in Small Manufacturing",
      "5. Conclusions and Directions for Further Research",
    ];
    heads.forEach((h) => {
      p.push({ t: h, heading: 1, brk: true }, ...body(5));
      p.push({ t: "3.1 Sampling frame", heading: 2 }, ...body(4));
      p.push({ t: pick(EN), style: "IntenseQuote" }, ...body(4));
    });
    return p;
  },
  { chapters: 5, parts: 0 });

/* 9 */
F("09-google-docs-export", "Exported from Google Docs. Heading styles present, no page breaks, extra empty paragraphs.",
  "Google Docs never inserts pageBreakBefore, so that signal is absent entirely.",
  () => {
    const p = [];
    for (let i = 1; i <= 15; i++) {
      p.push(blank(), blank(), { t: `Chapter ${i}`, heading: 1 }, blank(), ...body(8), blank());
    }
    return p;
  },
  { chapters: 15, parts: 0 });

/* 10 */
F("10-libreoffice-export", "LibreOffice export. Custom style names, direct formatting on top.",
  "Style names differ from Word's built-ins, so name matching alone misses them.",
  () => {
    const p = [];
    for (let i = 1; i <= 11; i++) {
      p.push({ t: `CHAPTER ${i}`, brk: true, b: true, size: 18, align: "center", caps: true, before: 36 },
             blank(), ...body(9));
    }
    return p;
  },
  { chapters: 11, parts: 0 });

/* 11 */
F("11-scrivener-spelled-numbers", "Chapter numbers spelled out, centred, no page breaks.",
  "'Chapter Seventeen' has no digits. Word-number matching required.",
  () => {
    const words = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
      "Ten", "Eleven", "Twelve", "Thirteen"];
    const p = [];
    words.forEach((w) => {
      p.push({ t: `Chapter ${w}`, align: "center", b: true, size: 14, before: 48 }, blank(), ...body(10));
    });
    return p;
  },
  { chapters: 13, parts: 0 });

/* 12 */
F("12-long-900pp", "A very long manuscript. Render timing and detection at scale.",
  "Roughly 900 printed pages. Time both the import and the render against this one.",
  () => {
    const p = [];
    for (let i = 1; i <= 60; i++) {
      p.push({ t: `Chapter ${i}`, brk: true, align: "center", b: true, size: 16 }, blank(), ...body(45));
    }
    return p;
  },
  { chapters: 60, parts: 0 });

/* 13 */
F("13-typed-in-2003", "Tabs for indentation, double spaces, all-caps headings, no styles.",
  "Tab-indented paragraphs and manual spacing. Cleanup pass territory.",
  () => {
    const p = [];
    for (let i = 1; i <= 12; i++) {
      p.push({ t: `CHAPTER ${["ONE","TWO","THREE","FOUR","FIVE","SIX","SEVEN","EIGHT","NINE","TEN","ELEVEN","TWELVE"][i-1]}`,
               brk: true, align: "center", b: true },
             blank(), blank(),
             ...body(9).map((x) => ({ t: "\t" + x.t.replace(/\. /g, ".  ") })));
    }
    return p;
  },
  { chapters: 12, parts: 0 });

/* 14 */
F("14-roman-numerals", "Chapters numbered with Roman numerals only.",
  "'I', 'V', 'X' are also ordinary words or initials in English. Ambiguity by design.",
  () => {
    const r = ["I","II","III","IV","V","VI","VII","VIII","IX","X","XI","XII","XIII","XIV","XV","XVI"];
    const p = [];
    r.forEach((n) => p.push({ t: n, brk: true, align: "center", size: 16, sc: true }, blank(), ...body(10)));
    return p;
  },
  { chapters: 16, parts: 0 });

/* 15 */
F("15-frontmatter-heavy", "Extensive front and back matter around a short main text.",
  "Named sections must map to block kinds, not become chapters.",
  () => {
    const p = [];
    const fm = ["Dedication", "Foreword", "Preface", "Acknowledgements"];
    fm.forEach((t) => p.push({ t, brk: true, align: "center", b: true, size: 15 }, blank(), ...body(3)));
    for (let i = 1; i <= 6; i++) p.push({ t: `Chapter ${i}`, brk: true, align: "center", b: true, size: 15 }, blank(), ...body(9));
    ["About the Author", "Bibliography", "Index"].forEach((t) =>
      p.push({ t, brk: true, align: "center", b: true, size: 15 }, blank(), ...body(3)));
    return p;
  },
  { chapters: 6, parts: 0, note: "7 named matter sections must be classified, not counted as chapters." });

/* 16 */
F("16-single-essay", "One continuous essay with no chapters at all.",
  "Detection must fail gracefully to one block rather than inventing structure.",
  () => body(60),
  { chapters: 1, parts: 0, expectManualSplit: true });

/* 17 */
F("17-memoir-titles-only", "Chapter titles with no numbers, no styles, page break only.",
  "Nothing numeric to anchor on. Signature consistency is the only signal.",
  () => {
    const titles = ["Bombay, 1974", "My Father's Shop", "The Year of the Strike", "Leaving",
      "Letters Home", "What I Kept", "The Wedding", "Return", "Now"];
    const p = [];
    titles.forEach((t) => p.push({ t, brk: true, b: true, size: 15 }, blank(), ...body(11)));
    return p;
  },
  { chapters: 9, parts: 0, firstTitle: "Bombay, 1974" });

/* 18 */
F("18-cookbook-many-short", "Eighty short recipes, each a chapter.",
  "High chapter count and short blocks. Pushes the count and mean-gap guards.",
  () => {
    const p = [];
    for (let i = 1; i <= 80; i++) {
      p.push({ t: `Recipe ${i}: Something With Rice`, brk: true, b: true, size: 14 },
             { t: "Serves 4", i: true }, ...body(3),
             { t: "1 cup rice", bullet: true }, { t: "2 onions", bullet: true });
    }
    return p;
  },
  { chapters: 80, parts: 0, note: "Bulleted ingredient lines must not score as headings." });

/* 19 */
F("19-scene-breaks-epigraphs", "Scene breaks, epigraphs and emphasised one-line paragraphs.",
  "Ornament lines and short italic lines are the classic false positives.",
  () => {
    const p = [];
    for (let i = 1; i <= 10; i++) {
      p.push({ t: `Chapter ${i}`, brk: true, align: "center", b: true, size: 16 }, blank());
      p.push({ t: pick(EN), i: true, align: "right" }, { t: "— Anon", align: "right", i: true }, blank());
      for (let s = 0; s < 3; s++) {
        p.push(...body(4));
        p.push({ t: "* * *", align: "center" });
      }
      p.push({ t: "And then it was over", b: true, align: "center" });
    }
    return p;
  },
  { chapters: 10, parts: 0, note: "30 scene breaks and 10 bold centred closing lines are decoys." });

/* 20 */
F("20-inconsistent-author", "The same author formatted chapters three different ways over three years.",
  "Signature clustering fragments. This one is expected to need manual correction — the value is that the summary says so honestly.",
  () => {
    const p = [];
    for (let i = 1; i <= 5; i++) p.push({ t: `Chapter ${i}`, brk: true, align: "center", b: true, size: 16 }, blank(), ...body(9));
    for (let i = 6; i <= 10; i++) p.push({ t: String(i), brk: true, size: 20 }, blank(), ...body(9));
    for (let i = 11; i <= 15; i++) p.push({ t: `CHAPTER ${i}`, heading: 1, caps: true }, blank(), ...body(9));
    return p;
  },
  { chapters: 15, parts: 0, tolerant: true, note: "Partial detection is an acceptable pass; silent wrong confidence is not." });

/* --- build --------------------------------------------------------------- */

const outDir = process.argv[2] || "./fixtures";
await mkdir(outDir, { recursive: true });

const manifest = [];

for (const f of fixtures) {
  const specs = f.build();
  const doc = new Document({
    creator: "ZOPE fixture generator",
    title: f.id,
    sections: [{ properties: {}, children: specs.map(toParagraph) }],
  });
  const buf = await Packer.toBuffer(doc);
  await writeFile(join(outDir, `${f.id}.docx`), buf);

  manifest.push({
    id: f.id,
    file: `${f.id}.docx`,
    description: f.description,
    whyItIsHard: f.breaks,
    paragraphCount: specs.length,
    expected: f.expected,
  });
  console.log(`${f.id.padEnd(28)} ${String(specs.length).padStart(5)} paras  ->  ${f.expected.chapters} chapters`);
}

await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\n${fixtures.length} fixtures + manifest.json written to ${outDir}`);
