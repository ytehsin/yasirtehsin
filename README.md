# ZOPE core: manuscript schema and template architecture

Two things live here: how a book's content is represented, and how appearance
is applied to it. They are deliberately kept apart, because that separation is
what makes "one Book Project generates both EPUB and print" true rather than
aspirational.

```
schema.ts                        content model (ProseMirror)
serialize.ts                     content  ->  XHTML  (one serializer, two targets)

css/emit.ts                      tokens   ->  @page rules + :root variables
css/engine.css                   fixed layout mechanics, reads only variables
css/epub-overrides.css           undoes page-dependent rules for reflowable EPUB

templates/_base.tokens.json      full set of defaults
templates/classic-novel.tokens.json    English serif, 5.25 x 8in
templates/hindi-modern.tokens.json     Devanagari, A5
```

## The rule everything follows

Content carries meaning; templates carry appearance. There is no `fontSize`,
`color`, or `textAlign` anywhere in the schema. An author can mark text as
emphasised, quoted, a chapter subsection, or in another language — never as
14pt Garamond.

The payoff is concrete: switching template reflows the entire book, EPUB is a
different stylesheet rather than a different export path, and a manuscript
imported today still renders correctly against a template you design in 2028.

The cost is that your DOCX importer has to work harder, because Word files are
almost entirely direct formatting. That is where the effort goes, and it is
the right place for it to go.

## Three decisions worth understanding before you build

**One ProseMirror document per block, not per book.** A 400-page novel in a
single document makes the editor unusable — every keystroke revalidates the
whole manuscript. Chapters are separate documents; the book is an ordered list
of them. Reordering chapters is a cheap array operation, and two editors can
work on different chapters without collaborative-editing machinery.

**The chapter title is not in the document.** It lives on the block record.
This is what makes the table of contents reliable, the running head correct,
and the EPUB navigation valid — none of which work if an author can turn a
title into a styled paragraph the system can't see.

**Templates are data, not stylesheets.** A template is a JSON token record. It
emits CSS; it isn't CSS. Three reasons this matters more than it looks:

1. CSS custom properties do not work inside `@page`. The page box lives outside
   the document tree, so `size: var(--page-width) var(--page-height)` silently
   resolves to nothing and you get letter-sized output. Generating literal
   values sidesteps a problem that has no clean workaround. This one is worth
   knowing before you write a line of CSS.
2. The spine calculator, cover generator, and preflight all need the trim size
   and text-block dimensions. With tokens as data, they read the same record
   the interior renders from. With tokens as CSS, they each keep their own copy
   and drift.
3. Non-designers can build templates through a form, which is how you get from
   two templates to the twelve to fifteen polished ones you want at launch
   without twelve to fifteen rounds of CSS review.

## Do the Hindi template in week one

Not as a nice-to-have. Devanagari breaks four assumptions that Latin-first
typography bakes in silently:

- Leading. Matras stack above the shirorekha and below the baseline. At Latin
  leading they collide, and this is the defect that marks out almost every
  Indian-language book laid out in Western software.
- Letterspacing. The script is joined along a horizontal headline. Tracking
  severs it.
- Case. There isn't any, so small caps and uppercase produce nothing or garbage.
- Hyphenation. No dictionaries exist, so justification opens rivers unless you
  widen the measure or go ragged-right.

Every one of these is cheap to handle in the engine now and expensive to
retrofit later. It is also your clearest differentiator: LaTeX-based
competitors handle Indic scripts badly, and Chromium's HarfBuzz shaping handles
them properly for free.

## Font licensing will constrain your template list

Embedding a font in a customer's print PDF is redistribution. Most commercial
book faces prohibit it or price it per title, which does not work when you are
generating thousands of PDFs. Confirm the embedding grant for every face before
it gets a template, and prefer SIL Open Font License releases — EB Garamond,
Source Serif 4, Noto Serif Devanagari, and Mukta above are all OFL and all
embeddable without a per-book licence.

## Things this code does not yet do

- **Footnotes in print.** Paged.js implements `float: footnote` only partially
  and mishandles notes longer than the space left on the page. Test with a real
  academic manuscript before promising footnote support, and be ready to ship
  MVP 1 with endnotes.
- **Table of contents page numbers.** `target-counter()` resolves after
  pagination; the TOC block needs generating from the block list at export time
  with anchors the counter can target.
- **CMYK.** Chromium outputs RGB. KDP accepts it, IngramSpark wants PDF/X-1a
  with a CMYK output intent. Ghostscript post-processing, as its own pipeline
  step.
- **Blank page accounting.** `break-before: recto` inserts blank versos, and
  those pages count toward the total that feeds spine width. Read the final
  page count back from the rendered PDF, never from an estimate.

## Suggested next piece

The renderer is where this becomes real, and it is small: load tokens, emit the
two generated stylesheets, serialize blocks, run Paged.js in headless Chromium,
capture the page count. Building it against hardcoded JSON before any UI exists
tells you within a week whether the whole approach holds.
