/**
 * ZOPE proof-of-pipeline server.
 *
 * One page, three endpoints, no framework. This exists to prove that a person
 * with a Word file can get a print-ready PDF out of the engine without a
 * developer driving it. Everything a real product needs — accounts, saved
 * projects, payment, the rights declaration — is deliberately absent.
 *
 *   ZOPE_CHROMIUM=/path/to/chrome npm run dev
 *   open http://localhost:4000
 *
 * Two decisions worth knowing:
 *
 * No framework and no multipart parser. The browser sends the .docx as the
 * raw request body, so the server reads bytes and hands them to importDocx.
 * Adding Express and Multer would be three more dependencies to explain and
 * would not make this file shorter.
 *
 * Projects live in memory and vanish on restart. Real storage is a database
 * decision that belongs to the product, not to a proof. The Map below is the
 * one line that changes when that day comes.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { importDocx } from "../import/to-blocks";
import { buildEpub } from "../epub/package";
import { spineWidth, PAPER_STOCKS } from "../render/spine";
import { renderBook, type PrintProfile } from "../render/worker";
import { mergeTokens } from "../templates/merge";
import type { TemplateTokens } from "../css/emit";
import type { Block } from "../schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);
const MAX_UPLOAD = 50 * 1024 * 1024;

interface Project {
  id: string;
  filename: string;
  blocks: Block[];
  lang: string;
  summary: string;
  createdAt: number;
}

const projects = new Map<string, Project>();

// Projects are dropped after an hour so a long-running dev server doesn't
// accumulate manuscripts in memory.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, p] of projects) if (p.createdAt < cutoff) projects.delete(id);
}, 5 * 60 * 1000).unref();

const templates = {
  "classic-novel": JSON.parse(await readFile(join(HERE, "../templates/classic-novel.tokens.json"), "utf8")),
  "hindi-modern": JSON.parse(await readFile(join(HERE, "../templates/hindi-modern.tokens.json"), "utf8")),
};
const base: TemplateTokens = JSON.parse(
  await readFile(join(HERE, "../templates/_base.tokens.json"), "utf8")
);

const profile: PrintProfile = {
  id: "generic-print",
  colorSpace: "rgb",
  pdfStandard: "none",
  minPages: 1,
  maxPages: 100_000,
  requiresEmbeddedFonts: false,
};

/* ------------------------------------------------------------------------ */

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    if (req.method === "GET" && url.pathname === "/") {
      const html = await readFile(join(HERE, "index.html"));
      return send(res, 200, "text/html; charset=utf-8", html);
    }

    if (req.method === "POST" && url.pathname === "/api/import") {
      return await handleImport(req, res, url);
    }

    if (req.method === "POST" && url.pathname === "/api/render") {
      return await handleRender(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/epub") {
      return await handleEpub(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/papers") {
      return json(res, 200, PAPER_STOCKS);
    }

    return json(res, 404, { error: "Not found" });
  } catch (err: any) {
    console.error(err);
    return json(res, 500, { error: err.message || "Something went wrong" });
  }
});

server.listen(PORT, () => {
  console.log(`ZOPE running at http://localhost:${PORT}`);
  if (!process.env.ZOPE_CHROMIUM) {
    console.log("Using Playwright's bundled Chromium. If PDF export fails, run: npx playwright install chromium");
  }
});

/* --- import -------------------------------------------------------------- */

async function handleImport(req: any, res: any, url: URL) {
  const buf = await readBody(req);
  if (!buf.length) return json(res, 400, { error: "No file received." });

  // A .docx is a zip; every zip starts with PK. Checking here gives the person
  // a sentence they can act on instead of a stack trace from the XML parser.
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    return json(res, 400, {
      error: "That doesn't look like a Word file. ZOPE reads .docx — if you have a .doc, open it in Word and Save As .docx.",
    });
  }

  const filename = url.searchParams.get("name") || "manuscript.docx";
  const id = randomUUID();

  const result = await importDocx(buf, id);

  projects.set(id, {
    id,
    filename,
    blocks: result.blocks,
    lang: result.detectedLang || "en",
    summary: result.proposal.summary,
    createdAt: Date.now(),
  });

  const byIndex = new Map(result.proposal.boundaries.map((b, i) => [i, b]));

  return json(res, 200, {
    id,
    filename,
    summary: result.proposal.summary,
    needsManualSplit: result.proposal.needsManualSplit,
    notices: result.notices,
    images: result.assets.length,
    detectedLang: result.detectedLang,
    chapters: result.blocks.map((b, i) => ({
      index: i,
      kind: b.kind,
      number: b.number || "",
      title: b.title,
      words: countWords(textOf(b.doc)),
      confidence: byIndex.get(i)?.confidence || "medium",
      evidence: byIndex.get(i)?.evidence || [],
    })),
  });
}

/* --- render -------------------------------------------------------------- */

async function handleRender(req: any, res: any) {
  const body = JSON.parse((await readBody(req)).toString("utf8"));
  const project = projects.get(body.id);
  if (!project) {
    return json(res, 404, { error: "That project has expired. Upload the manuscript again." });
  }

  // Apply the corrections the person made on the confirmation screen. Renaming
  // and merging are the two that matter: renaming fixes a bad title, merging
  // fixes a false chapter break, and between them they cover most of what
  // detection gets wrong.
  const blocks = applyCorrections(project.blocks, body.corrections || []);
  if (blocks.length === 0) {
    return json(res, 400, { error: "There are no chapters left to print." });
  }

  const templateId: keyof typeof templates =
    body.template in templates ? body.template : "classic-novel";
  const tokens = mergeTokens(base, templates[templateId]);

  const outPath = join(tmpdir(), `zope-${project.id}.pdf`);

  const result = await renderBook({
    blocks,
    tokens,
    meta: {
      title: body.title || project.filename.replace(/\.docx$/i, ""),
      author: body.author || "",
      lang: project.lang,
    },
    assets: [],
    fonts: [],
    profile,
    outputPath: outPath,
  });

  const pdf = await readFile(result.pdfPath);

  // Preflight findings ride along in headers so the page can show them without
  // a second request. Grouped, because "47 low-resolution images" is useful and
  // 47 separate warnings are not.
  const grouped: Record<string, number> = {};
  for (const w of result.warnings) grouped[w.kind] = (grouped[w.kind] || 0) + 1;

  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${safeName(body.title || project.filename)}.pdf"`,
    "X-Zope-Pages": String(result.pageCount),
    "X-Zope-Blank-Pages": String(result.blankPages.length),
    "X-Zope-Warnings": JSON.stringify(grouped),
    "X-Zope-Render-Ms": String(result.durationMs),
    // Spine width travels with the PDF because it is derived from the page
    // count, and the page count only exists once the book has been rendered.
    // Anyone designing a cover needs this number and cannot compute it earlier.
    "X-Zope-Spine": JSON.stringify(spineWidth(result.pageCount, body.paper || "kdp-cream")),
  });
  res.end(pdf);
}

/* --- epub ---------------------------------------------------------------- */

/**
 * The same corrected blocks the PDF path uses, through the same serializer,
 * with a different stylesheet. If these two ever diverge, the promise that one
 * Book Project produces both outputs has quietly stopped being true.
 */
async function handleEpub(req: any, res: any) {
  const body = JSON.parse((await readBody(req)).toString("utf8"));
  const project = projects.get(body.id);
  if (!project) {
    return json(res, 404, { error: "That project has expired. Upload the manuscript again." });
  }

  const blocks = applyCorrections(project.blocks, body.corrections || []);
  if (blocks.length === 0) {
    return json(res, 400, { error: "There are no chapters left to publish." });
  }

  const [engineCss, epubCss] = await Promise.all([
    readFile(join(HERE, "../css/engine.css"), "utf8"),
    readFile(join(HERE, "../css/epub-overrides.css"), "utf8"),
  ]);

  const title = body.title || project.filename.replace(/\.docx$/i, "");

  const epub = await buildEpub({
    blocks,
    meta: {
      title,
      author: body.author || "",
      language: project.lang,
      identifier: body.isbn || undefined,
    },
    assets: [],
    // Order matters: overrides must follow the engine, or the fixed-page rules
    // they exist to undo win instead.
    css: `${engineCss}\n\n/* --- EPUB overrides --- */\n${epubCss}`,
  });

  res.writeHead(200, {
    "Content-Type": "application/epub+zip",
    "Content-Disposition": `attachment; filename="${safeName(title)}.epub"`,
    "X-Zope-Blocks": String(blocks.length),
  });
  res.end(epub);
}

/**
 * Corrections are [{ index, action, title }]. Merging folds a block into the
 * one before it, keeping its heading as a paragraph so no words are lost —
 * the same rule the round-trip test enforces.
 */
function applyCorrections(
  blocks: Block[],
  corrections: { index: number; action?: string; title?: string }[]
): Block[] {
  const byIndex = new Map(corrections.map((c) => [c.index, c]));
  const out: Block[] = [];

  blocks.forEach((b, i) => {
    const c = byIndex.get(i);
    const block: Block = { ...b, doc: structuredClone(b.doc) };

    if (c?.title !== undefined && c.title.trim()) block.title = c.title.trim();

    if (c?.action === "merge" && out.length > 0) {
      const prev = out[out.length - 1];
      const heading = {
        type: "paragraph",
        attrs: { variant: "noindent" },
        content: [{ type: "text", text: `${block.number ? block.number + " " : ""}${block.title}` }],
      };
      (prev.doc as any).content = [
        ...((prev.doc as any).content || []),
        heading,
        ...(((block.doc as any).content) || []),
      ];
      return;
    }

    out.push(block);
  });

  return out.map((b, i) => ({ ...b, order: i }));
}

/* --- plumbing ------------------------------------------------------------ */

function readBody(req: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_UPLOAD) {
        reject(new Error("That file is larger than 50 MB."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: any, status: number, type: string, body: any) {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function json(res: any, status: number, body: unknown) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function safeName(s: string): string {
  return s.replace(/\.docx$/i, "").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "book";
}

function countWords(s: string): number {
  const t = (s || "").trim();
  return t ? t.split(/\s+/).filter(Boolean).length : 0;
}

function textOf(doc: any): string {
  const out: string[] = [];
  const walk = (n: any) => {
    if (!n) return;
    if (n.type === "text" && n.text) out.push(n.text);
    (n.content || []).forEach(walk);
  };
  walk(doc);
  return out.join(" ");
}
