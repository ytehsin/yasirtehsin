/**
 * EPUB 3 PACKAGER
 *
 * The other half of the core promise: one Book Project, both outputs. This
 * shares the serializer with the print path, so a chapter's markup is
 * identical in the PDF and the e-book and only the stylesheet differs.
 *
 * Reflowable only. Fixed-layout is a genuinely different product for
 * illustrated and children's books, and forcing every book through it — the
 * mistake the spec warns against — produces novels that cannot be read
 * comfortably on a phone.
 *
 * The two things most home-made EPUBs get wrong, both handled here:
 *
 *   1. The mimetype file must be the FIRST entry in the zip and must be
 *      STORED, not deflated. Reading systems identify the file by reading
 *      bytes 30-60 of the archive directly. Compress it and the book opens
 *      nowhere, with no useful error.
 *
 *   2. Footnotes need a backlink. Reading systems that support popup notes
 *      use epub:type; the rest send the reader to the notes page, and without
 *      a link back they are stranded there.
 */

import JSZip from "jszip";
import { renderBlockForEpub, type Asset } from "../serialize";
import type { Block } from "../schema";

export interface EpubMetadata {
  title: string;
  author: string;
  language: string;
  identifier?: string;   // ISBN if there is one, else a generated UUID
  publisher?: string;
  description?: string;
  /** ISO date. Defaults to today. */
  published?: string;
}

export interface EpubInput {
  blocks: Block[];
  meta: EpubMetadata;
  assets: { asset: Asset; data: Buffer }[];
  /** Reflowable stylesheet — engine.css plus epub-overrides.css, concatenated. */
  css: string;
  /** Cover image, if the book has one. */
  cover?: { data: Buffer; contentType: string };
}

const esc = (s: string) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function buildEpub(input: EpubInput): Promise<Buffer> {
  const zip = new JSZip();
  const id = input.meta.identifier || `urn:uuid:${crypto.randomUUID()}`;
  const modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const published = input.meta.published || new Date().toISOString().slice(0, 10);

  // 1. mimetype — first, stored, no compression. See the note above.
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  );

  zip.file("OEBPS/css/book.css", input.css);

  // 2. Content. One XHTML file per block: reading systems page more
  //    efficiently, and the spine mirrors the book's real structure.
  const assetMap = new Map(input.assets.map((a) => [a.asset.id, a.asset]));
  const allNotes: { id: string; body: string; file: string }[] = [];
  const files: { id: string; href: string; block: Block }[] = [];

  input.blocks.forEach((block, i) => {
    const name = `text/${String(i + 1).padStart(3, "0")}-${slug(block.title)}.xhtml`;
    const { xhtml, footnotes } = renderBlockForEpub(block, assetMap);
    zip.file(`OEBPS/${name}`, xhtml);
    files.push({ id: `c${i + 1}`, href: name, block });
    for (const f of footnotes) allNotes.push({ ...f, file: name });
  });

  for (const { asset, data } of input.assets) {
    zip.file(`OEBPS/${asset.path.replace(/^\.\.\//, "")}`, data);
  }

  if (input.cover) {
    zip.file(`OEBPS/images/cover${extFor(input.cover.contentType)}`, input.cover.data);
  }

  // 3. Endnotes page, if there are any.
  if (allNotes.length) {
    zip.file("OEBPS/text/notes.xhtml", notesPage(allNotes, input.meta.language));
  }

  // 4. Navigation. nav.xhtml is the EPUB 3 table of contents and is required.
  zip.file("OEBPS/text/nav.xhtml", navPage(files, input.meta, allNotes.length > 0));

  // 5. Package document.
  zip.file(
    "OEBPS/package.opf",
    packageDoc({ id, modified, published, files, input, hasNotes: allNotes.length > 0 })
  );

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    mimeType: "application/epub+zip",
  });
}

/* ------------------------------------------------------------------------ */

function packageDoc(a: {
  id: string;
  modified: string;
  published: string;
  files: { id: string; href: string; block: Block }[];
  input: EpubInput;
  hasNotes: boolean;
}): string {
  const { input } = a;

  const manifest = [
    `<item id="nav" href="text/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="css" href="css/book.css" media-type="text/css"/>`,
    ...a.files.map(
      (f) => `<item id="${f.id}" href="${f.href}" media-type="application/xhtml+xml"/>`
    ),
    ...(a.hasNotes
      ? [`<item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/>`]
      : []),
    ...input.assets.map(
      (x, i) =>
        `<item id="img${i}" href="${x.asset.path.replace(/^\.\.\//, "")}" media-type="${imageType(
          x.asset.path
        )}"/>`
    ),
    ...(input.cover
      ? [
          `<item id="cover-image" href="images/cover${extFor(
            input.cover.contentType
          )}" media-type="${input.cover.contentType}" properties="cover-image"/>`,
        ]
      : []),
  ].join("\n    ");

  const spine = [
    ...a.files.map((f) => `<itemref idref="${f.id}"/>`),
    ...(a.hasNotes ? [`<itemref idref="notes"/>`] : []),
  ].join("\n    ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${esc(
    input.meta.language
  )}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${esc(a.id)}</dc:identifier>
    <dc:title>${esc(input.meta.title)}</dc:title>
    <dc:language>${esc(input.meta.language)}</dc:language>
    ${input.meta.author ? `<dc:creator id="author">${esc(input.meta.author)}</dc:creator>` : ""}
    ${input.meta.author ? `<meta refines="#author" property="role" scheme="marc:relators">aut</meta>` : ""}
    ${input.meta.publisher ? `<dc:publisher>${esc(input.meta.publisher)}</dc:publisher>` : ""}
    ${input.meta.description ? `<dc:description>${esc(input.meta.description)}</dc:description>` : ""}
    <dc:date>${esc(a.published)}</dc:date>
    <meta property="dcterms:modified">${a.modified}</meta>

    <!-- Accessibility metadata. Not decoration: EPUB distributors increasingly
         require it, and institutional and government buyers in India check for
         it. These claims are true of what this packager produces. -->
    <meta property="schema:accessMode">textual</meta>
    <meta property="schema:accessibilityFeature">structuralNavigation</meta>
    <meta property="schema:accessibilityFeature">readingOrder</meta>
    <meta property="schema:accessibilityHazard">none</meta>
    <meta property="schema:accessibilitySummary">Structured text with semantic headings and a navigable table of contents.</meta>
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`;
}

function navPage(
  files: { id: string; href: string; block: Block }[],
  meta: EpubMetadata,
  hasNotes: boolean
): string {
  const items = files
    .filter((f) => f.block.includeInToc)
    .map(
      (f) =>
        `        <li><a href="../${f.href}">${esc(
          f.block.number ? `${f.block.number}. ${f.block.title}` : f.block.title
        )}</a></li>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${esc(
    meta.language
  )}" xml:lang="${esc(meta.language)}">
<head><meta charset="utf-8"/><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc" role="doc-toc">
    <h1>Contents</h1>
    <ol>
${items}
${hasNotes ? `        <li><a href="notes.xhtml">Notes</a></li>` : ""}
    </ol>
  </nav>
</body>
</html>`;
}

function notesPage(
  notes: { id: string; body: string; file: string }[],
  lang: string
): string {
  const items = notes
    .map(
      (n, i) =>
        `    <aside epub:type="footnote" role="doc-footnote" id="${n.id}">
      <p><a href="../${n.file}#${n.id}-ref" epub:type="backlink" role="doc-backlink">${i + 1}</a> ${n.body}</p>
    </aside>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${esc(
    lang
  )}" xml:lang="${esc(lang)}">
<head><meta charset="utf-8"/><title>Notes</title><link rel="stylesheet" href="../css/book.css"/></head>
<body>
  <section epub:type="endnotes" role="doc-endnotes">
    <h1>Notes</h1>
${items}
  </section>
</body>
</html>`;
}

function slug(s: string): string {
  return (s || "section")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "section";
}

function imageType(path: string): string {
  if (/\.png$/i.test(path)) return "image/png";
  if (/\.gif$/i.test(path)) return "image/gif";
  if (/\.svg$/i.test(path)) return "image/svg+xml";
  if (/\.webp$/i.test(path)) return "image/webp";
  return "image/jpeg";
}

function extFor(contentType: string): string {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("gif")) return ".gif";
  if (contentType.includes("webp")) return ".webp";
  return ".jpg";
}
