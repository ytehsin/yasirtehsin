# Render and import pipelines

Two workers, both runnable from the command line with no UI attached. Build and
test them that way — the moment they need a running application to exercise,
iteration slows by an order of magnitude.

```
import/parse-ooxml.ts        pass A: paragraph signals Word actually stores
import/detect-structure.ts   chapter detection (proposal, never a decision)
import/to-blocks.ts          pass B: mammoth + assembly into Blocks

render/worker.ts             Blocks -> paginated PDF + authoritative page count
render/paged-config.js       injected into the page before Paged.js loads
```

## Render

`renderBook()` emits the two generated stylesheets from the token record,
serializes every block into one HTML document, paginates it with Paged.js in
headless Chromium, and prints to PDF.

Four things in there are less obvious than they look:

**The page count is read back from the DOM, never estimated.** `break-before:
recto` inserts blank versos, and those are real pages the spine width depends
on. Estimating gives you a spine that is millimetres too narrow, which the
printer will not catch and the author will.

**Fonts are awaited before pagination.** Without `document.fonts.ready` you
will occasionally paginate against a fallback face and ship wrong line breaks —
intermittently, which is the hardest kind of bug to believe in. The explicit
`fonts.check()` afterwards catches the case where a font silently failed and
Chromium carried on regardless.

**Preflight data is gathered from the laid-out DOM, not from the PDF.** The PDF
has lost the semantics. In the DOM you still know which block a page belongs
to, what an image's placed width is (which is what effective DPI actually
depends on), and whether a heading is stranded. Doing this in the same pass
costs nothing and is the difference between preflight that points at page 74
and preflight that points at "an image somewhere".

**Determinism is a launch flag setting.** Pin the Chromium version and disable
subpixel hinting, or the same book renders differently across machines and you
can never tell a real change from a rendering wobble.

The Ghostscript step at the end converts to PDF/X-1a with a CMYK output intent.
KDP takes Chromium's RGB output as-is; IngramSpark and most Indian offset
printers do not. Without an embedded ICC output intent the file is not PDF/X at
all, and you find out a week later.

## Import

Two passes over the same file, because neither alone is enough.

**Mammoth throws away direct formatting.** That is why it produces clean
semantic HTML, and exactly why it cannot find chapters. Most author manuscripts
have no Word heading styles at all — chapters are 16pt bold centred text, or a
manual page break, or the word "Chapter", or three blank lines and nothing
else. So pass A reads `word/document.xml` directly and keeps every signal that
might matter.

One Word quirk that bites everyone: a visible sentence is usually split across
many `<w:r>` runs, because Word inserts revision ids and spell-check markers
mid-word. Text extraction must concatenate every `<w:t>` in the paragraph, or
regexes silently miss half their matches.

### The detection idea worth keeping

Do not score paragraphs in isolation. A bold centred short line might be a
chapter heading, a section heading, a poem title, or an emphasised sentence,
and no per-paragraph score separates them.

What separates them is **consistency**. A book's chapter headings all look the
same as each other, there are between about five and a hundred of them, and
they are spread fairly evenly through the manuscript. So: score candidates,
group them by visual signature, then pick the signature that behaves like a set
of chapters — right count, plausible chapter length, regular spacing.

This handles the case that breaks naive detectors: the author used one
bold-centred style for both chapters and the section headings inside them. The
two form separate clusters, the section headings bunch together and fail the
spacing test, and the chapter cluster wins.

Parts fall out of the same machinery — a smaller, more prominent cluster.

### Accept that this will never be perfect

Roughly one manuscript in ten defeats any heuristic. Plan for that instead of
tuning toward a number you cannot reach.

The confirmation screen carries the feature, and it needs four things:

1. The summary in plain words: "Found 24 chapters, identified because they
   start on a new page and begin with a chapter word."
2. The chapter list with low-confidence rows flagged — a "check this" state,
   not an error state.
3. Merge, split, rename, and change-type on every row.
4. "This is wrong, let me mark them myself" as a visible escape, not a hidden
   link.

Log every correction alongside the signals that produced the wrong answer.
After a few hundred imports you have a labelled dataset and the weights in
`detect-structure.ts` stop being guesses. That is also the point at which a
small classifier becomes worth training, if you still want one.

## Test corpus, before you write another line

Collect twenty real manuscripts and keep them in the repo as fixtures. Not
clean samples — the messy ones:

- A novel with no styles at all, chapters marked only by page breaks
- A novel with chapter number and title on separate lines
- Non-fiction with Parts and three levels of headings
- A manuscript where the author used Heading 1 for section headings too
- A Hindi manuscript, and one with mixed Hindi and English
- Poetry, where line breaks are semantic
- An academic manuscript with footnotes and tables
- One exported from Google Docs, one from LibreOffice, one from Scrivener
- One 900 pages long, for the render timing
- One that was clearly typed in the early 2000s with tabs for indentation

Every detection change runs against all twenty and reports chapter-count
accuracy. Without this you will fix one manuscript and break four, repeatedly,
and have no way to know it.
