/**
 * RENDER WORKER
 *
 * BookProject -> print-ready PDF, and the authoritative page count.
 *
 * Build this before any UI. It is roughly 300 lines and it is the piece that
 * tells you whether the whole architecture holds. Run it against hardcoded
 * JSON; if the output is a correctly paginated book with embedded fonts, the
 * rest is application code. If it isn't, you want to know in week one.
 *
 * Design notes that matter:
 *
 * - Rendering must be DETERMINISTIC. The same book must produce a
 *   byte-comparable PDF on every run, or you can't tell "the author changed
 *   something" from "Chromium rounded differently today". Pin the Chromium
 *   version, disable subpixel hinting, and never let a system font resolve.
 *
 * - Page count is READ BACK, never estimated. Blank versos inserted by
 *   `break-before: recto` are real pages that the spine width depends on.
 *
 * - Fonts are loaded from disk via @font-face with file:// URLs, and the page
 *   waits on document.fonts.ready. Without that wait you will occasionally
 *   paginate against a fallback face and ship a book with wrong line breaks —
 *   intermittently, which is the worst way to find a bug.
 */

import { chromium, type Browser, type Page } from "playwright";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, sep } from "node:path";

import { emitPageSetup, emitTokens, textBlock, type TemplateTokens } from "../css/emit";
import { renderBookForPrint, type Asset } from "../serialize";
import type { Block } from "../schema";

const run = promisify(execFile);

// ESM has no __dirname and no require. Resolving these once at module load
// keeps the rest of the file readable and makes the package importable from
// both a bundler and plain node.
const HERE = dirname(fileURLToPath(import.meta.url));

export interface FontFace {
  family: string;
  weight: string;   // "400", "600"
  style: string;    // "normal", "italic"
  path: string;     // absolute path to .woff2 or .otf
}

export interface PrintProfile {
  id: string;                       // "kdp-paperback-v2026.1"
  colorSpace: "rgb" | "cmyk";
  pdfStandard: "none" | "pdf-x-1a" | "pdf-x-4";
  iccProfilePath?: string;
  minPages: number;
  maxPages: number;
  requiresEmbeddedFonts: boolean;
}

export interface RenderRequest {
  blocks: Block[];
  tokens: TemplateTokens;           // already merged over _base
  meta: { title: string; author: string; lang: string };
  assets: Asset[];
  fonts: FontFace[];
  profile: PrintProfile;
  outputPath: string;
}

export interface RenderResult {
  pdfPath: string;
  pageCount: number;
  /** Pages that ended up empty. Real pages — they count toward the spine. */
  blankPages: number[];
  /** Feeds preflight. Never thrown as errors; the author decides. */
  warnings: RenderWarning[];
  /** Milliseconds, for the job queue's own sanity. */
  durationMs: number;
}

export interface RenderWarning {
  kind:
    | "text-overflow"
    | "image-low-dpi"
    | "missing-asset"
    | "font-fallback"
    | "widow"
    | "orphan"
    | "short-page"
    | "page-count-out-of-range";
  page?: number;
  blockId?: string;
  message: string;
  detail?: Record<string, unknown>;
}

/* ------------------------------------------------------------------------ */

export async function renderBook(req: RenderRequest): Promise<RenderResult> {
  const started = Date.now();
  const work = await mkdtemp(join(tmpdir(), "zope-render-"));

  try {
    // 1. Emit the two generated stylesheets from the token record.
    const pageSetup = emitPageSetup(req.tokens);
    const tokensCss = emitTokens(req.tokens, req.meta);
    const fontsCss = emitFontFaces(req.fonts);

    await writeFile(join(work, "page-setup.css"), pageSetup);
    await writeFile(join(work, "tokens.css"), tokensCss);
    await writeFile(join(work, "fonts.css"), fontsCss);
    await writeFile(join(work, "engine.css"), await readFile(engineCssPath(), "utf8"));

    // Order matters: page-setup and tokens must precede engine, because engine
    // reads the variables tokens defines.
    const cssHrefs = ["fonts.css", "page-setup.css", "tokens.css", "engine.css"];

    // 2. Serialize the book to one HTML document. Paged.js needs the whole
    //    book in a single flow to number pages and resolve target-counter().
    const assetMap = new Map(req.assets.map((a) => [a.id, a]));
    const { html } = renderBookForPrint(
      req.blocks, assetMap, cssHrefs, req.meta.lang, req.meta.title
    );
    const htmlPath = join(work, "book.html");
    await writeFile(htmlPath, html);

    // 3. Paginate.
    const browser = await launch();
    try {
      const page = await browser.newPage();
      const warnings: RenderWarning[] = [];

      page.on("console", (m) => {
        if (m.type() === "error") {
          warnings.push({ kind: "text-overflow", message: `Renderer: ${m.text()}` });
        }
      });
      page.on("requestfailed", (r) => {
        warnings.push({
          kind: "missing-asset",
          message: `Failed to load ${r.url()}`,
        });
      });

      await page.goto(`file://${htmlPath}`, { waitUntil: "load" });

      // Fonts before pagination. Non-negotiable.
      await page.evaluate(() => (document as any).fonts.ready);

      const missingFonts = await checkFontsLoaded(page, req.fonts);
      for (const f of missingFonts) {
        warnings.push({
          kind: "font-fallback",
          message: `Font did not load and a fallback was used: ${f}`,
          detail: { family: f },
        });
      }

      // Config first: Paged.js reads window.PagedConfig when the polyfill
      // loads, so injecting it afterwards has no effect.
      await page.addScriptTag({ path: join(HERE, "paged-config.js") });
      await page.addScriptTag({ path: pagedPolyfillPath() });
      await page.waitForFunction(
        () => (window as any).__pagedDone === true,
        undefined,
        { timeout: 10 * 60_000 } // a 900pp book takes minutes; this is normal
      );

      const inspection = await inspectPages(page, req.tokens);
      warnings.push(...inspection.warnings);

      // 4. PDF. preferCSSPageSize makes Chromium honour the generated @page
      //    size instead of defaulting to Letter.
      await page.pdf({
        path: req.outputPath,
        preferCSSPageSize: true,
        printBackground: true,
        displayHeaderFooter: false,
        // Margins are in @page; Chromium's own margins must be zero or they
        // are applied on top and every page shifts inward.
        margin: { top: "0", right: "0", bottom: "0", left: "0" },
        tagged: true, // PDF/UA structure tags — needed for accessibility claims
      });

      let outPath = req.outputPath;

      // 5. Colour space and PDF standard conversion.
      if (req.profile.pdfStandard !== "none" || req.profile.colorSpace === "cmyk") {
        outPath = await convertForPress(outPath, req.profile, work);
      }

      const pageCount = inspection.pageCount;

      if (pageCount < req.profile.minPages || pageCount > req.profile.maxPages) {
        warnings.push({
          kind: "page-count-out-of-range",
          message: `${pageCount} pages is outside the ${req.profile.id} range of ${req.profile.minPages}-${req.profile.maxPages}.`,
          detail: { pageCount },
        });
      }

      return {
        pdfPath: outPath,
        pageCount,
        blankPages: inspection.blankPages,
        warnings,
        durationMs: Date.now() - started,
      };
    } finally {
      await browser.close();
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------------ */

async function launch(): Promise<Browser> {
  return chromium.launch({
    // CI images and locked-down build hosts often have a browser already but
    // not the exact revision Playwright wants to download. Allow an override
    // rather than making the render worker unrunnable in those environments.
    executablePath: process.env.ZOPE_CHROMIUM || undefined,
    args: [
      // Determinism. Without these the same book renders with slightly
      // different metrics across machines and your diffs become useless.
      "--font-render-hinting=none",
      "--disable-lcd-text",
      "--disable-font-subpixel-positioning",
      "--force-color-profile=srgb",
      "--disable-remote-fonts=false",
      // Large books allocate heavily during layout.
      "--js-flags=--max-old-space-size=4096",
      "--allow-file-access-from-files",
    ],
  });
}

function emitFontFaces(fonts: FontFace[]): string {
  return fonts
    .map(
      (f) => `@font-face {
  font-family: '${f.family}';
  font-weight: ${f.weight};
  font-style: ${f.style};
  font-display: block;
  src: url('file://${f.path}') format('${f.path.endsWith(".woff2") ? "woff2" : "opentype"}');
}`
    )
    .join("\n\n");
}

/**
 * A font can silently fail and Chromium will happily paginate with a fallback.
 * document.fonts.check is the only reliable way to know it didn't.
 */
async function checkFontsLoaded(page: Page, fonts: FontFace[]): Promise<string[]> {
  return page.evaluate((families: string[]) => {
    return families.filter((f) => !(document as any).fonts.check(`12pt '${f}'`));
  }, [...new Set(fonts.map((f) => f.family))]);
}

interface Inspection {
  pageCount: number;
  blankPages: number[];
  warnings: RenderWarning[];
}

/**
 * Everything preflight needs, gathered from the laid-out DOM in one pass —
 * far cheaper and far more accurate than re-parsing the PDF afterwards. The
 * PDF has lost the semantics; here you still know which block a page belongs
 * to and whether a heading is stranded.
 */
async function inspectPages(page: Page, tokens: TemplateTokens): Promise<Inspection> {
  const tb = textBlock(tokens);

  return page.evaluate(
    ({ textWidthMm }) => {
      const warnings: any[] = [];
      const pages = Array.from(document.querySelectorAll(".pagedjs_page"));
      const blankPages: number[] = [];
      const MM_PER_PX = 25.4 / 96;

      pages.forEach((p, i) => {
        const n = i + 1;
        const area = p.querySelector(".pagedjs_page_content");
        if (!area) return;

        // Paged.js marks the versos it inserts for a recto break with their
        // own class. Testing for empty content alone misses them, and those
        // are precisely the pages that matter: they are invisible in the PDF
        // and they count toward the page total the spine width is built from.
        if (
          p.classList.contains("pagedjs_blank_page") ||
          (!area.textContent?.trim() && !area.querySelector("img"))
        ) {
          blankPages.push(n);
          return;
        }

        // Content wider than the text block: usually a table or a long code
        // line or an unbreakable URL. It will be clipped in the PDF.
        area.querySelectorAll("table, pre, figure").forEach((el) => {
          const w = (el as HTMLElement).scrollWidth * MM_PER_PX;
          if (w > textWidthMm + 0.5) {
            warnings.push({
              kind: "text-overflow",
              page: n,
              message: `Content is ${(w - textWidthMm).toFixed(1)}mm wider than the text area and will be cut off.`,
              detail: { element: el.tagName.toLowerCase(), overflowMm: w - textWidthMm },
            });
          }
        });

        // Effective image DPI at placed size. This is the check §39 describes,
        // and doing it here means you know the placed width — computing it
        // from the source file alone gives the wrong answer.
        area.querySelectorAll("img").forEach((img) => {
          const el = img as HTMLImageElement;
          const placedMm = el.getBoundingClientRect().width * MM_PER_PX;
          if (placedMm <= 0 || !el.naturalWidth) return;
          const dpi = el.naturalWidth / (placedMm / 25.4);
          if (dpi < 300) {
            warnings.push({
              kind: "image-low-dpi",
              page: n,
              message: `Image resolution is ${Math.round(dpi)} DPI at its printed size. 300 DPI is needed for print.`,
              detail: { dpi: Math.round(dpi), src: el.getAttribute("src") },
            });
          }
        });

        // A heading as the last thing on a page. `break-after: avoid` should
        // prevent it, but Paged.js does not always honour it near a float.
        const last = area.lastElementChild;
        if (last && /^H[1-4]$/.test(last.tagName)) {
          warnings.push({
            kind: "orphan",
            page: n,
            message: "A heading is stranded at the foot of the page with no text beneath it.",
          });
        }
      });

      // Short pages: a chapter ending with one or two lines on a fresh page
      // reads badly and is what a human typesetter would fix by tightening the
      // preceding spread. Automated preflight flags it; a human decides.
      pages.forEach((p, i) => {
        const area = p.querySelector(".pagedjs_page_content") as HTMLElement | null;
        if (!area || !area.textContent?.trim()) return;
        const fill = area.scrollHeight / area.clientHeight;
        const isLastOfBlock = p.querySelector("[data-starts-on]") === null;
        if (fill < 0.12 && isLastOfBlock) {
          warnings.push({
            kind: "short-page",
            page: i + 1,
            message: "This page carries only a line or two. Consider tightening the previous pages.",
          });
        }
      });

      return { pageCount: pages.length, blankPages, warnings };
    },
    { textWidthMm: tb.widthMm }
  );
}

/**
 * Chromium emits RGB PDF 1.4. KDP accepts that. IngramSpark and most Indian
 * offset printers want PDF/X-1a:2001 with a CMYK output intent.
 *
 * Ghostscript does the conversion. The ICC profile is not optional — without
 * an output intent the file is not PDF/X and preflight at the printer rejects
 * it, usually after a week of silence.
 */
async function convertForPress(
  inputPath: string,
  profile: PrintProfile,
  work: string
): Promise<string> {
  if (profile.pdfStandard === "none") return inputPath;

  const out = join(work, "press.pdf");
  const defPath = join(work, "pdfx.ps");

  await writeFile(
    defPath,
    `%!
[ /Title (ZOPE) /DOCINFO pdfmark
[ /_objdef {icc_PDFX} /type /stream /OBJ pdfmark
[ {icc_PDFX} << /N 4 >> /PUT pdfmark
[ {icc_PDFX} (${profile.iccProfilePath}) (r) file /PUT pdfmark
[ /_objdef {OutputIntent_PDFX} /type /dict /OBJ pdfmark
[ {OutputIntent_PDFX} <<
  /Type /OutputIntent /S /GTS_PDFX
  /OutputCondition (CMYK)
  /OutputConditionIdentifier (Custom)
  /DestOutputProfile {icc_PDFX}
>> /PUT pdfmark
[ {Catalog} << /OutputIntents [ {OutputIntent_PDFX} ] >> /PUT pdfmark
`
  );

  await run("gs", [
    "-dPDFX",
    "-dBATCH",
    "-dNOPAUSE",
    "-dNOOUTERSAVE",
    "-sDEVICE=pdfwrite",
    "-dPDFSETTINGS=/prepress",
    "-sColorConversionStrategy=CMYK",
    "-sProcessColorModel=DeviceCMYK",
    "-dEmbedAllFonts=true",
    "-dSubsetFonts=true",
    "-dCompatibilityLevel=1.3",
    `-sOutputFile=${out}`,
    defPath,
    inputPath,
  ]);

  return out;
}

function engineCssPath(): string {
  return join(HERE, "..", "css", "engine.css");
}

/**
 * Paged.js exposes dist/ only through a "polyfill" export condition, and seals
 * everything else — including package.json — behind its exports map. Neither a
 * subpath resolve nor the usual package.json trick works. Resolve the main
 * entry, which IS exported, and walk up from src/ to the package root.
 */
function pagedPolyfillPath(): string {
  const main = fileURLToPath(import.meta.resolve("pagedjs"));
  const root = main.includes(`${sep}src${sep}`)
    ? main.slice(0, main.indexOf(`${sep}src${sep}`))
    : dirname(dirname(main));
  return join(root, "dist", "paged.polyfill.js");
}
