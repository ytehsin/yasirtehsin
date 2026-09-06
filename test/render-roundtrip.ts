/**
 * RENDER ROUND-TRIP
 *
 * The import side is covered by roundtrip.ts. This covers the other half:
 * everything in the Book Project must appear in the printed PDF, and nothing
 * else may.
 *
 * Loss here is even harder to notice than loss on import. A paragraph that
 * overflows its page box, a chapter whose `break-before: recto` swallowed it,
 * a glyph that failed to render — none of these throw. The pagination
 * succeeds, the PDF opens, and the missing text is discovered by a reader.
 *
 * METHOD: render, extract the text layer with pdftotext, and compare word
 * multisets against the Book Project. Multisets rather than sequences, because
 * page furniture and reflow legitimately reorder things; a missing word is
 * still a missing word.
 *
 * The test renders with running heads and page numbers turned OFF. They are
 * repeated furniture that would appear hundreds of times in the extracted text
 * and swamp the comparison. This test is about content conservation; page
 * furniture is checked by looking at a rendered page, which is a different job.
 *
 *   ZOPE_CHROMIUM=/path/to/chrome npx tsx test/render-roundtrip.ts test/fixtures
 *   npx tsx test/render-roundtrip.ts test/fixtures --only 05 --keep
 *   npx tsx test/render-roundtrip.ts test/fixtures --all        # includes the 900pp one
 */

import { readFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { importDocx } from "../import/to-blocks";
import { renderBook, type PrintProfile } from "../render/worker";
import { mergeTokens, validateTokens, REQUIRED_VARS } from "../templates/merge";
import type { TemplateTokens } from "../css/emit";

const run = promisify(execFile);

const dir = process.argv[2] || "test/fixtures";
const only = argValue("--only");
const keep = process.argv.includes("--keep");
const all = process.argv.includes("--all");
const verbose = process.argv.includes("--verbose");

const outDir = resolve("test/output");
await mkdir(outDir, { recursive: true });

const base: TemplateTokens = JSON.parse(
  await readFile("templates/_base.tokens.json", "utf8")
);
const novel = JSON.parse(await readFile("templates/classic-novel.tokens.json", "utf8"));
const hindi = JSON.parse(await readFile("templates/hindi-modern.tokens.json", "utf8"));

// Fixture 12 is roughly 900 printed pages. Excluded by default: it is a timing
// benchmark, not a correctness case, and it makes the suite unusable as a
// pre-commit check.
const SLOW = new Set(["12-long-900pp"]);
const HINDI = new Set(["05-hindi-novel", "06-mixed-hindi-english"]);

const profile: PrintProfile = {
  id: "test-rgb",
  colorSpace: "rgb",
  pdfStandard: "none",
  minPages: 1,
  maxPages: 100_000,
  requiresEmbeddedFonts: false,
};

const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
const rows: any[] = [];
let failures = 0;

for (const entry of manifest) {
  if (only && !entry.id.startsWith(only)) continue;
  if (!all && SLOW.has(entry.id) && !only) continue;

  const buf = await readFile(join(dir, entry.file));
  const { blocks } = await importDocx(buf, entry.id);

  const tokens = testTokens(mergeTokens(base, HINDI.has(entry.id) ? hindi : novel));
  const missingVars = validateTokens(tokens, REQUIRED_VARS);

  const pdfPath = join(outDir, `${entry.id}.pdf`);
  const t0 = performance.now();

  let result;
  try {
    result = await renderBook({
      blocks,
      tokens,
      meta: { title: entry.id, author: "Test Author", lang: HINDI.has(entry.id) ? "hi" : "en" },
      assets: [],
      fonts: [], // system fallback; font embedding is checked separately
      profile,
      outputPath: pdfPath,
    });
  } catch (err: any) {
    failures++;
    console.log(`\nFAIL  ${entry.id}\n   render threw: ${err.message.slice(0, 200)}`);
    continue;
  }

  const renderMs = Math.round(performance.now() - t0);

  // pdftotext gives the text layer, which is what a reader's search, a screen
  // reader, and the printer's preflight all see. If a word is not here, it is
  // not in the book in any meaningful sense.
  const { stdout: pdfText } = await run("pdftotext", ["-nopgbrk", "-q", pdfPath, "-"]);

  // Per-page text, for the parity check below. Form feeds separate pages when
  // -nopgbrk is omitted.
  const { stdout: paged } = await run("pdftotext", ["-q", pdfPath, "-"]);
  const pages = paged.split("\f");

  // Chapters are set to open recto — on a right-hand, odd-numbered page. This
  // is not decoration: honouring it inserts blank versos, and those blanks are
  // real pages that the spine width depends on. A renderer that quietly
  // ignores break-before:recto produces a book that paginates plausibly and a
  // spine that is millimetres too narrow.
  const parityErrors: string[] = [];
  for (const b of blocks) {
    if (b.startsOn !== "recto") continue;
    const needle = tokenize(b.title).slice(0, 4).join(" ");
    if (!needle) continue;
    const at = pages.findIndex((pg) => tokenize(pg).join(" ").includes(needle));
    if (at >= 0 && (at + 1) % 2 === 0) parityErrors.push(`"${b.title}" opens on page ${at + 1}`);
  }

  const expected = blocks
    .map((b) => `${b.number ?? ""} ${b.title} ${textOf(b.doc)}`)
    .join(" ");

  const wantCounts = counts(tokenize(expected));
  const gotCounts = counts(tokenize(pdfText));

  const missing = diff(wantCounts, gotCounts);
  const extra = diff(gotCounts, wantCounts);

  const missingTotal = sum(missing);
  const extraTotal = sum(extra);

  const ok =
    missingTotal === 0 &&
    extraTotal === 0 &&
    missingVars.length === 0 &&
    parityErrors.length === 0;
  if (!ok) failures++;

  rows.push({
    id: entry.id,
    verdict: ok ? "PASS" : "FAIL",
    pages: result.pageCount,
    blank: result.blankPages.length,
    words: sum(wantCounts),
    missing: missingTotal,
    extra: extraTotal,
    parity: parityErrors.length,
    warn: result.warnings.length,
    ms: renderMs,
  });

  if (!ok || verbose) {
    console.log(`\n${ok ? "PASS" : "FAIL"}  ${entry.id}`);
    console.log(`   ${result.pageCount} pages (${result.blankPages.length} blank), ${renderMs}ms`);
    if (missingVars.length)
      console.log(`   template is missing ${missingVars.length} required variables: ${missingVars.slice(0, 6).join(", ")}`);
    if (missingTotal) console.log(`   MISSING from the PDF: ${sample(missing)}`);
    if (extraTotal) console.log(`   EXTRA in the PDF: ${sample(extra)}`);
    if (parityErrors.length)
      console.log(`   ${parityErrors.length} chapter(s) set to open recto opened on a verso: ${parityErrors.slice(0, 3).join("; ")}`);
    for (const w of groupWarnings(result.warnings)) console.log(`   ${w}`);
  }
}

if (!keep) await rm(outDir, { recursive: true, force: true });

console.log("\n" + table(rows));
console.log(`\n${rows.length - failures}/${rows.length} rendered without loss.`);
if (!all) console.log("Fixture 12 (900pp) skipped; pass --all to include it.");
process.exit(failures > 0 ? 1 : 0);

/* ------------------------------------------------------------------------ */

/**
 * Test-only token adjustments. Each one removes a source of text that is real
 * in a book but noise in a content comparison.
 */
function testTokens(t: TemplateTokens): TemplateTokens {
  return {
    ...t,
    runningHead: { ...t.runningHead, verso: "none", recto: "none" },
    folio: { ...t.folio, position: "none" },
    vars: {
      ...t.vars,
      // Hyphenation splits a word across two lines and pdftotext returns both
      // halves. Real books hyphenate; this test would report the halves as one
      // missing word and two extra ones.
      hyphenation: "none",
      // text-transform changes the extracted glyphs, so a chapter number set
      // in uppercase comes back uppercase. Comparison is case-insensitive
      // anyway, but leaving it on adds nothing.
      "opener-number-transform": "none",
      // Letter-spacing degrades the PDF text layer: pdftotext returns a
      // tracked "TWELVE" as "t w e lv e". That is not a rendering bug — the
      // page looks right — but it breaks search inside the PDF and confuses
      // screen readers, so it is worth knowing about. Real templates should
      // keep tracking modest on anything a reader might search for.
      "opener-number-tracking": "0",
    },
  };
}

/** Letters and digits only: drops asterisms, rules, and punctuation. */
function tokenize(s: string): string[] {
  return (s.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function counts(words: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of words) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

/** Words present in `a` more often than in `b`, with the surplus count. */
function diff(a: Map<string, number>, b: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [w, n] of a) {
    const d = n - (b.get(w) ?? 0);
    if (d > 0) out.set(w, d);
  }
  return out;
}

// Declaration, not a const arrow: this module has top-level await, so the
// loop above runs before a const defined below it is initialised.
function sum(m: Map<string, number>): number {
  return [...m.values()].reduce((a, b) => a + b, 0);
}

function sample(m: Map<string, number>): string {
  const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return top.map(([w, n]) => (n > 1 ? `${w} x${n}` : w)).join(", ");
}

function groupWarnings(ws: { kind: string; message: string }[]): string[] {
  const by = new Map<string, number>();
  for (const w of ws) by.set(w.kind, (by.get(w.kind) ?? 0) + 1);
  return [...by.entries()].map(([k, n]) => `warning ${k} x${n}`);
}

function textOf(doc: any): string {
  const out: string[] = [];
  const walk = (n: any) => {
    if (!n) return;
    if (n.type === "text" && n.text) out.push(n.text);
    if (n.attrs?.body) out.push(String(n.attrs.body).replace(/<[^>]*>/g, " "));
    (n.content || []).forEach(walk);
  };
  walk(doc);
  return out.join(" ");
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

function table(rows: any[]): string {
  if (!rows.length) return "(no fixtures matched)";
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(w[i])).join("  ");
  return [line(cols), line(w.map((n) => "-".repeat(n))), ...rows.map((r) => line(cols.map((c) => String(r[c]))))].join("\n");
}
