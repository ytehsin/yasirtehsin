# The fixture corpus

Twenty .docx manuscripts that fail in the twenty ways real ones fail, each with
a ground-truth manifest. This is the CI gate for chapter detection.

```
test/generate-fixtures.mjs     regenerates every fixture
test/eval.ts                   runs detection, grades against ground truth
test/fixtures/*.docx           the corpus (260 KB, commit it)
test/fixtures/manifest.json    expected chapters, parts, and why each is hard
```

```bash
npm i docx jszip fast-xml-parser tsx
node test/generate-fixtures.mjs test/fixtures
npx tsx test/eval.ts test/fixtures            # exits non-zero on failure
npx tsx test/eval.ts test/fixtures --only 14 --verbose
```

## Why generated rather than donated

You need ground truth, and a donated manuscript has to be read and labelled by
hand. You also cannot commit someone's unpublished novel to a repo. Generated
fixtures give exact expected output, legal certainty, and a new failure mode in
five minutes when a customer finds one.

Collect real manuscripts as a second, private corpus once you have customers.
The CI gate runs on these.

## Current state

- **Detection:** 20/20 exact, ~380ms across 6,246 paragraphs
- **Import round-trip:** 20/20, zero body words lost, ~3.2s total
- **Render round-trip:** 19/19, zero words lost, correct page parity, ~24s total

| Fixture | Chapters | What it tests |
|---|---|---|
| 01 pagebreaks-only | 18 | No styles at all; page break plus a bare number |
| 02 number-then-title | 12 | Number and title on separate lines — must merge, not double-count |
| 03 nonfiction-parts | 12 (3 parts) | Properly styled Parts and two heading levels |
| 04 heading1-overused | 10 | Heading 1 on chapters *and* sections — 40 candidates, 10 correct |
| 05 hindi-novel | 14 | Devanagari script and numerals, danda punctuation |
| 06 mixed-hindi-english | 9 | Mixed-script body with English headings |
| 07 poetry | 10 | 160 short unpunctuated verse lines as false positives |
| 08 academic | 5 | Long descriptive headings near the length cutoff |
| 09 google-docs-export | 15 | Heading styles but no page breaks at all |
| 10 libreoffice-export | 11 | Direct formatting, non-Word style names |
| 11 scrivener-spelled-numbers | 13 | "Chapter Seventeen" — no digits anywhere |
| 12 long-900pp | 60 | 2,820 paragraphs; timing for import and render |
| 13 typed-in-2003 | 12 | Tab indentation, double spaces, all-caps headings |
| 14 roman-numerals | 16 | I, V, X are also words and initials |
| 15 frontmatter-heavy | 6 | Seven named matter sections must classify, not count |
| 16 single-essay | 1 | Must fail gracefully instead of inventing structure |
| 17 memoir-titles-only | 9 | No numbers anywhere; signature consistency is the only signal |
| 18 cookbook-many-short | 80 | High count, short blocks, bulleted lines as decoys |
| 19 scene-breaks-epigraphs | 10 | Ornament lines and bold one-liners |
| 20 inconsistent-author | 15 | Three different chapter formats in one manuscript |

## Bugs the corpus caught on its first run

Five fixtures failed immediately. All five were real defects, and none would
have been obvious from reading the code.

**The body font size was read as 28pt.** `parseDocDefaultSize` searched for
`<w:sz>` with a lazy match anchored at `<w:docDefaults>` but never bounded by
its closing tag, so on any file where docDefaults omits a size the match ran
past it into the style list and returned the Title style's 28pt. Every real
heading then looked *smaller* than "body text", the large-type signal never
fired, and two fixtures detected zero chapters. Any manuscript without explicit
body sizing — which is most of them — was affected.

**"Dedication" parsed as Roman numeral D followed by "edication".** The heading
number pattern had no boundary after the number token. Fixed with a lookahead
requiring end-of-line or a separator, and by matching named front matter on the
raw text before number parsing runs at all.

**Single-character headings formed their own cluster.** The caps test required
more than one character, which looks harmless. In a manuscript numbered I, II,
III … the single-letter headings failed it while the rest passed, the visual
signature split in two, and clustering silently dropped I, V and X. The general
lesson: any rule that treats short headings differently from long ones will
fragment a cluster somewhere.

**An author who changed format mid-manuscript lost two thirds of the book.**
Fixture 20 has chapters formatted three ways. Each clusters separately, one
wins, the rest vanish — and the detector reported *high confidence* on its five
chapters. Fixed by looking at the regions the winning cluster doesn't cover and
merging in other clusters that sit almost entirely inside them, at reduced
confidence.

**Silent overconfidence.** The same fixture exposed the worse half of that bug.
Detection now compares its boundary count against the manuscript's page-break
count and, when it has clearly missed some, downgrades every boundary from high
confidence and says so in the summary. Visibly unsure and wrong is a state
authors forgive. Silently confident and wrong is not.

## Adding a fixture

Add one entry to the `F(...)` list in `generate-fixtures.mjs` — an id, a
description, why it's hard, a builder returning paragraph specs, and the
expected counts. Regenerate and rerun. The paragraph spec DSL is small:
`{ t, b, i, caps, sc, size, align, brk, before, heading, bullet }`.

Do this every time a customer import goes wrong. Reproduce their failure as a
fixture first, then fix the detector. That order keeps the fix from breaking
four other manuscripts.

## Grading

`PASS` is an exact chapter and part count. `PARTIAL` is within 10% *and* not
claiming high confidence on every boundary — the harness treats overconfidence
as its own failure, separate from being wrong. Fixture 16 inverts the test: it
passes only when detection gives up and sets `needsManualSplit`.

## Round-trip: the more important test

`test/roundtrip.ts` counts body words in and body words out, and requires them
to match **exactly**. No tolerance — a single missing word is a bug.

A wrong chapter split is visible on the confirmation screen and the author
fixes it in ten seconds. Content that vanished during import is invisible until
someone reads the printed book. That asymmetry is why this test has the
stricter bar.

What counts as body: everything except heading paragraphs that legitimately
moved to a block's title and number, and scene-break ornaments that became
semantic nodes. A separate coverage check then confirms every heading that left
the body actually arrived somewhere — which is what catches a section arriving
as "Untitled" rather than as "Dedication".

### Bugs this test caught

**Parts were titled "Chapter".** `readHeading` synthesised a fallback title
without knowing the block kind, so "Part 3" came through as "Chapter 3". Small,
but the kind of wrongness an author notices immediately.

**Front matter before the first chapter arrived as "Untitled".** Detection
proposed a leading boundary that consumed no heading paragraph; the block
splitter only matched boundaries that had one, so the leading HTML group fell
through with no title at all.

**The test itself was wrong first.** Its initial version compared every source
word against block text *plus* titles, and reported loss on five fixtures that
had lost nothing — heading words legitimately leave the body. Worth recording:
a test that fails for the wrong reason costs more than no test, because the
next person assumes the code is broken and starts changing it.

**Single-character tokens were being filtered as noise** in the coverage check,
which broke every manuscript numbered 1, 2, 3 or I, II, III — the heading "7"
had no token left to match against its title. The same shape of bug as the caps
one above, in different code. Any rule that treats short strings differently
from long ones will bite somewhere.

## Render round-trip: does the PDF contain the book?

`test/render-roundtrip.ts` renders each fixture through Paged.js in headless
Chromium, extracts the text layer with `pdftotext`, and compares word multisets
against the Book Project. Multisets rather than sequences, because reflow
legitimately reorders things across pages; a missing word is still missing.

It also checks **page parity**: every block set to open recto must land on an
odd page. That is not a typographic nicety. Honouring it inserts blank versos,
and those blanks are real pages the spine width is calculated from.

Running heads and folios are switched off for this test. They are repeated
furniture that would appear hundreds of times in the extracted text and swamp
the comparison.

### Bugs this test caught

**`break-before: recto` was being silently ignored.** Every chapter opened
wherever it happened to land. Paged.js decides page breaks from a
`data-break-before` attribute, which it derives from CSS during its own parse
pass — a pass that cannot resolve a `var()` or an attribute selector, so
`.block[data-starts-on="recto"] { break-before: recto }` did nothing at all.
No error, no warning, a perfectly plausible PDF. Fixed by emitting the
attribute directly in the serializer.

The knock-on effect is the part worth remembering: with recto breaks working,
fixture 03 went from 40 pages to 54, and fixture 18 from 80 to 159. Those extra
pages are blank versos. A spine calculated from the earlier number would have
been roughly half the width it needed to be.

**Blank-page detection missed the pages that matter.** The worker tested for
empty text content, which misses the versos Paged.js inserts — they carry a
class instead. The pages invisible in the PDF were exactly the ones excluded
from the count that feeds the spine.

**Letter-spacing degrades the PDF text layer.** A chapter number tracked at
0.32em came back from `pdftotext` as "t w e lv e". The page looks correct, so
this is not a rendering bug — but it breaks search inside the PDF, confuses
screen readers, and would break Amazon's "Look Inside" indexing. Worth knowing
before a template ships with heavily tracked display type.

## What to add next

Detection accuracy is the interesting number, but not the only one:

- **Visual regression.** Text conservation is covered; appearance is not.
  Rasterise page 1 of each fixture and diff against a committed reference, so a
  template change that wrecks the chapter opener fails CI instead of shipping.
- **Render timing on fixture 12.** It is roughly 900 printed pages. If it takes
  more than a few minutes, the job queue needs to stream progress rather than
  make the author watch a spinner.
- **Correction logging.** When a real author fixes a boundary, record the
  signals that produced the wrong answer. After a few hundred imports the
  weights in `detect-structure.ts` stop being guesses.
