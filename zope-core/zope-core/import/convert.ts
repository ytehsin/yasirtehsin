/**
 * FORMAT CONVERSION
 *
 * Authors do not all arrive with .docx. They arrive with .doc from an old
 * Word, .rtf from a typing service, .odt from LibreOffice, and .txt from
 * anything. Telling them "convert it yourself first" is the moment most of
 * them leave, and it is avoidable: LibreOffice converts all of these to .docx
 * reliably, and the importer then behaves exactly as it does for a real .docx.
 *
 * WHY CONVERT RATHER THAN PARSE EACH FORMAT
 *
 * Every parser is a separate set of bugs, a separate corpus, and a separate
 * thing to keep working. Converting to one canonical format means the twenty
 * fixtures keep covering everything: a .doc that converts to .docx is tested
 * by the same suite that tests .docx.
 *
 * The cost is a LibreOffice install in the deployment image (about 400 MB) and
 * a few seconds per conversion. Worth it — the alternative is losing the
 * author at the upload screen.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * PDF. Extracting a structured manuscript from a PDF is a research problem,
 * not an engineering one: a PDF records where glyphs sit on a page, not what
 * is a paragraph, a heading, or a chapter. Converting one produces text in
 * roughly the right order with the structure destroyed, which is worse than
 * refusing, because the damage is not obvious until much later.
 *
 * Slide decks (.pptx, .key). A deck is not a manuscript. It has no continuous
 * prose, no chapters, and no paragraph flow — the things the whole pipeline
 * is built around. A book made from a slide deck is a different product
 * (turning a deck into a book means writing the book), and pretending
 * otherwise would produce a PDF of disconnected bullet points.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { tmpdir } from "node:os";

const run = promisify(execFile);

/** Formats we can turn into a Book Project, and what to say about each. */
export const ACCEPTED = {
  ".docx": { convert: false, label: "Word document" },
  ".doc": { convert: true, label: "Word 97–2003 document" },
  ".rtf": { convert: true, label: "Rich Text Format" },
  ".odt": { convert: true, label: "OpenDocument text" },
  ".txt": { convert: true, label: "Plain text" },
} as const;

/**
 * Formats people will try, with a sentence explaining what to do instead.
 * A named refusal is worth writing: "unsupported file" tells someone nothing,
 * and they will simply try the same file again.
 */
export const REJECTED: Record<string, string> = {
  ".pdf":
    "ZOPE can't rebuild a manuscript from a PDF. A PDF records where the letters sit on the page, not which parts are chapters or paragraphs, so the structure your book needs isn't in the file. Upload the Word file the PDF was made from.",
  ".pptx":
    "A slide deck isn't a manuscript — it has no continuous prose for ZOPE to lay out. If you want a book from this material, write it as a document first.",
  ".ppt":
    "A slide deck isn't a manuscript — it has no continuous prose for ZOPE to lay out. If you want a book from this material, write it as a document first.",
  ".key":
    "A slide deck isn't a manuscript — it has no continuous prose for ZOPE to lay out. If you want a book from this material, write it as a document first.",
  ".pages":
    "Pages files can't be read directly. In Pages, choose File → Export To → Word, then upload that.",
  ".epub":
    "EPUB import isn't built yet. If you have the Word file the EPUB was made from, upload that instead.",
  ".jpg": "That's an image, not a manuscript.",
  ".png": "That's an image, not a manuscript.",
  ".zip": "Unzip the folder first and upload the document inside it.",
};

export interface ConversionResult {
  buffer: Buffer;
  /** True when LibreOffice was involved, so the caller can warn about fidelity. */
  converted: boolean;
  from: string;
}

export function extensionOf(filename: string): string {
  return extname(filename || "").toLowerCase();
}

/**
 * Returns a .docx buffer whatever went in, or throws a message written for the
 * person rather than for a log.
 */
export async function toDocx(buffer: Buffer, filename: string): Promise<ConversionResult> {
  const ext = extensionOf(filename);

  if (ext in REJECTED) throw new Error(REJECTED[ext]);

  if (!(ext in ACCEPTED)) {
    throw new Error(
      `ZOPE reads Word (.docx, .doc), OpenDocument (.odt), Rich Text (.rtf) and plain text (.txt). ${
        ext ? `It can't read ${ext} files.` : "That file has no extension, so it can't be identified."
      }`
    );
  }

  if (ext === ".docx") {
    // A .docx is a zip, and every zip starts with PK. Checking the bytes
    // rather than trusting the extension catches the common case of a file
    // renamed from .doc to .docx in the hope it would work.
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      throw new Error(
        "This file is named .docx but isn't one — it looks like an older Word file that was renamed. Open it in Word and use Save As to make a real .docx."
      );
    }
    return { buffer, converted: false, from: ext };
  }

  const work = await mkdtemp(join(tmpdir(), "zope-convert-"));
  try {
    const inPath = join(work, `input${ext}`);
    await writeFile(inPath, buffer);

    // -env:UserInstallation gives this conversion its own profile directory.
    // Without it, concurrent conversions collide on a shared profile lock and
    // the second one hangs until it times out — which looks to the person like
    // the upload silently failing.
    await run(
      "soffice",
      [
        `-env:UserInstallation=file://${work}/profile`,
        "--headless",
        "--norestore",
        "--convert-to",
        "docx:MS Word 2007 XML",
        "--outdir",
        work,
        inPath,
      ],
      { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }
    );

    const outPath = join(work, `${basename(inPath, ext)}.docx`);
    const out = await readFile(outPath).catch(() => null);

    if (!out) {
      throw new Error(
        `That ${ACCEPTED[ext as keyof typeof ACCEPTED].label.toLowerCase()} couldn't be read. If you can open it, use Save As to make a .docx and upload that.`
      );
    }

    return { buffer: out, converted: true, from: ext };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * What to tell the person after a conversion. Plain text is the one worth
 * flagging: it has no styles, no page breaks and no bold, so chapter detection
 * has almost nothing to work with and will usually need correcting by hand.
 */
export function conversionNotice(from: string): string | null {
  if (from === ".txt") {
    return "Plain text carries no formatting, so ZOPE has little to go on when finding chapters. Check the list below carefully — you may need to mark the chapter starts yourself.";
  }
  if (from === ".doc" || from === ".rtf" || from === ".odt") {
    return `Converted from ${ACCEPTED[from as keyof typeof ACCEPTED].label} before importing. Complex layouts and text boxes may not survive the conversion.`;
  }
  return null;
}
