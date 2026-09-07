/**
 * ROUND-TRIP TEST
 *
 * Detection accuracy is the interesting number. This is the important one.
 *
 * A wrong chapter split is visible on the confirmation screen and the author
 * fixes it in ten seconds. Content that vanished during import is invisible —
 * it surfaces when someone reads the printed book and finds a paragraph
 * missing from chapter nine. By then you have shipped it.
 *
 * So: count the words going in, count them coming out, and require the numbers
 * to match. Also check nothing was duplicated, which is the other half of the
 * same failure — heading text that stays in the body as well as moving to the
 * block title gives you every chapter opening with its own name twice.
 *
 *   npx tsx test/roundtrip.ts test/fixtures
 *   npx tsx test/roundtrip.ts test/fixtures --only 15 --verbose
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractSignals } from "../import/parse-ooxml";
import { importDocx } from "../import/to-blocks";

const dir = process.argv[2] || "test/fixtures";
const only = argValue("--only");
const verbose = process.argv.includes("--verbose");

const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));

const rows: any[] = [];
let failures = 0;

for (const entry of manifest) {
  if (only && !entry.id.startsWith(only)) continue;

  const buf = await readFile(join(dir, entry.file));

  // Compare BODY text against BODY text.
  //
  // The first version of this test compared every source word against block
  // text plus titles, and reported loss on five fixtures that had lost
  // nothing. Heading paragraphs legitimately leave the body: "Chapter 12:
  // Working Capital" becomes number "12" and title "Working Capital", and the
  // word "Chapter" is structure, not content. Scene-break ornaments become
  // semantic nodes and their asterisks are meant to disappear.
  //
  // So exclude what is supposed to move, and then require the remainder to
  // match EXACTLY. A tolerance here would hide the bug this test exists for.
  const signals = await extractSignals(buf);
  const t0 = performance.now();
  const result = await importDocx(buf, entry.id);
  const ms = performance.now() - t0;
  const moved = new Set<number>([
    ...result.proposal.boundaries.flatMap((b) => b.headingIndices),
    ...result.proposal.sceneBreaks,
  ]);

  const wordsIn = signals.paragraphs.reduce(
    (n, p) => (moved.has(p.index) ? n : n + countWords(p.text)),
    0
  );

  const wordsOut = result.blocks.reduce((n, b) => n + countWords(textOf(b.doc)), 0);
  const delta = wordsOut - wordsIn;
  const lossPct = wordsIn ? (delta / wordsIn) * 100 : 0;

  // Every heading that left the body must be findable on a block, or it was
  // not moved — it was dropped. This is what catches a front-matter section
  // arriving as "Untitled".
  const titleWords = new Set(
    result.blocks.flatMap((b) => countWordSet(`${b.number ?? ""} ${b.title}`))
  );
  const orphanedHeadings = signals.paragraphs.filter(
    (p) =>
      moved.has(p.index) &&
      !result.proposal.sceneBreaks.includes(p.index) &&
      countWords(p.text) > 0 &&
      !countWordSet(p.text).some((w) => titleWords.has(w))
  ).length;

  const empties = result.blocks.filter((b) => countWords(textOf(b.doc)) === 0).length;
  const dupes = result.blocks.filter((b) => startsWithOwnTitle(b)).length;
  const untitled = result.blocks.filter((b) => /^Untitled/.test(b.title)).length;

  const ok = delta === 0 && dupes === 0 && orphanedHeadings === 0 && untitled === 0;
  if (!ok) failures++;

  rows.push({
    id: entry.id,
    verdict: ok ? "PASS" : "FAIL",
    blocks: result.blocks.length,
    wordsIn,
    wordsOut,
    delta: delta > 0 ? `+${delta}` : String(delta),
    "loss%": lossPct.toFixed(2),
    empty: empties,
    dupes,
    orphan: orphanedHeadings,
    untitled,
    imgs: result.assets.length,
    ms: Math.round(ms),
  });

  if (!ok || verbose) {
    console.log(`\n${ok ? "PASS" : "FAIL"}  ${entry.id}`);
    console.log(`   ${wordsIn} body words in, ${wordsOut} out (${delta > 0 ? "+" : ""}${delta})`);
    if (orphanedHeadings) console.log(`   ${orphanedHeadings} heading(s) left the body but reached no block title`);
    if (untitled) console.log(`   ${untitled} block(s) came through untitled`);
    if (empties) console.log(`   ${empties} block(s) have no body text`);
    if (dupes) console.log(`   ${dupes} block(s) repeat their own title as the first paragraph`);
    for (const n of result.notices) console.log(`   notice: ${n.message}${n.count ? ` (${n.count})` : ""}`);
    console.log(`   blocks: ${result.blocks.slice(0, 5).map((b) => `${b.kind}:${b.title}`).join(" | ")}`);
  }
}

console.log("\n" + table(rows));
console.log(`\n${rows.length - failures}/${rows.length} round-tripped without loss.`);
process.exit(failures > 0 ? 1 : 0);

/* --- helpers ------------------------------------------------------------- */

/** Distinct words, for the heading-coverage check. */
function countWordSet(s: string): string[] {
  // Keep single-character tokens. Dropping them looks like sensible noise
  // filtering and silently breaks every manuscript numbered 1, 2, 3 or I, II,
  // III — the heading "7" then has no token to match against its title.
  return (s || "").toLowerCase().split(/[\s.:,\-–—]+/).filter(Boolean);
}

function countWords(s: string): number {
  const t = (s || "").trim();
  if (!t) return 0;
  // Split on whitespace only. Devanagari and other Indic scripts have no
  // word-boundary metacharacter support worth relying on in JS, and \b is
  // ASCII-only — using it silently counts every Hindi paragraph as one word.
  return t.split(/\s+/).filter(Boolean).length;
}

/** Every text node in a ProseMirror document, in order. */
function textOf(doc: any): string {
  const out: string[] = [];
  const walk = (n: any) => {
    if (!n) return;
    if (n.type === "text" && n.text) out.push(n.text);
    if (n.attrs?.body) out.push(stripTags(n.attrs.body)); // footnote bodies
    (n.content || []).forEach(walk);
  };
  walk(doc);
  return out.join(" ");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

/**
 * The duplication check. If the first paragraph of a block repeats its title,
 * the heading was both promoted to the block record and left in the body.
 */
function startsWithOwnTitle(b: any): boolean {
  const first = firstParagraphText(b.doc).trim().toLowerCase();
  const title = (b.title || "").trim().toLowerCase();
  if (!first || !title || title.length < 3) return false;
  return first === title || first === `${b.number} ${title}`.trim().toLowerCase();
}

function firstParagraphText(doc: any): string {
  const p = (doc?.content || []).find((n: any) => n.type === "paragraph" || n.type === "heading");
  return p ? textOf(p) : "";
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
