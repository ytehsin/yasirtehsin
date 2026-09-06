/**
 * CORPUS HARNESS
 *
 * Runs structure detection over every fixture and reports accuracy against the
 * manifest's ground truth.
 *
 *   npx tsx eval.ts ./fixtures
 *   npx tsx eval.ts ./fixtures --only 04
 *   npx tsx eval.ts ./fixtures --verbose
 *
 * This is the CI gate. Every change to detect-structure.ts runs it, and a drop
 * in the pass count fails the build. Without that, you fix one manuscript and
 * break four, repeatedly, with no way to know.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractSignals } from "../import/parse-ooxml";
import { detectStructure } from "../import/detect-structure";

interface Expected {
  chapters: number;
  parts: number;
  firstTitle?: string;
  expectManualSplit?: boolean;
  tolerant?: boolean;
  note?: string;
}

interface ManifestEntry {
  id: string;
  file: string;
  description: string;
  whyItIsHard: string;
  paragraphCount: number;
  expected: Expected;
}

const dir = process.argv[2] || "./fixtures";
const only = argValue("--only");
const verbose = process.argv.includes("--verbose");

const manifest: ManifestEntry[] = JSON.parse(
  await readFile(join(dir, "manifest.json"), "utf8")
);

const rows: any[] = [];
let passed = 0;
let partial = 0;

for (const entry of manifest) {
  if (only && !entry.id.startsWith(only)) continue;

  const buf = await readFile(join(dir, entry.file));
  const t0 = performance.now();
  const signals = await extractSignals(buf);
  const proposal = detectStructure(signals);
  const ms = performance.now() - t0;

  const chapters = proposal.boundaries.filter((b) => b.kind === "chapter").length;
  const parts = proposal.boundaries.filter((b) => b.kind === "part").length;
  const e = entry.expected;

  // Grading. "Tolerant" fixtures pass on partial detection as long as the
  // proposal does not claim high confidence in a wrong answer.
  const chapterDelta = chapters - e.chapters;
  const exact = chapterDelta === 0 && parts === e.parts;
  const close = Math.abs(chapterDelta) <= Math.max(1, Math.round(e.chapters * 0.1));

  const overconfident =
    !exact &&
    proposal.boundaries.filter((b) => b.confidence === "high").length ===
      proposal.boundaries.length;

  let verdict: "PASS" | "PARTIAL" | "FAIL";
  if (e.expectManualSplit) {
    verdict = proposal.needsManualSplit ? "PASS" : "FAIL";
  } else if (exact) {
    verdict = "PASS";
  } else if ((e.tolerant || close) && !overconfident) {
    verdict = "PARTIAL";
  } else {
    verdict = "FAIL";
  }

  if (verdict === "PASS") passed++;
  if (verdict === "PARTIAL") partial++;

  rows.push({
    id: entry.id,
    verdict,
    expected: e.chapters,
    got: chapters,
    parts: `${parts}/${e.parts}`,
    conf: confidenceMix(proposal.boundaries),
    ms: Math.round(ms),
  });

  if (verbose || verdict !== "PASS") {
    console.log(`\n${verdict}  ${entry.id}`);
    console.log(`   why hard: ${entry.whyItIsHard}`);
    console.log(`   summary:  ${proposal.summary}`);
    if (e.note) console.log(`   note:     ${e.note}`);
    console.log(`   first 6:  ${proposal.boundaries.slice(0, 6)
      .map((b) => `[${b.kind}] ${b.number ? b.number + " " : ""}${b.title} (${b.confidence})`)
      .join(" | ")}`);
  }
}

console.log("\n" + table(rows));
const total = rows.length;
console.log(
  `\n${passed}/${total} exact, ${partial} partial, ${total - passed - partial} failed.`
);
console.log(
  `Total detection time: ${rows.reduce((a, r) => a + r.ms, 0)}ms across ${manifest
    .reduce((a, m) => a + m.paragraphCount, 0)
    .toLocaleString()} paragraphs.`
);

process.exit(total - passed - partial > 0 ? 1 : 0);

/* --- helpers ------------------------------------------------------------- */

function confidenceMix(bs: { confidence: string }[]): string {
  const h = bs.filter((b) => b.confidence === "high").length;
  const m = bs.filter((b) => b.confidence === "medium").length;
  const l = bs.filter((b) => b.confidence === "low").length;
  return `${h}h ${m}m ${l}l`;
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

function table(rows: any[]): string {
  if (!rows.length) return "(no fixtures matched)";
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c]).length))
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(w[i])).join("  ");
  return [
    line(cols),
    line(w.map((n) => "-".repeat(n))),
    ...rows.map((r) => line(cols.map((c) => String(r[c])))),
  ].join("\n");
}
