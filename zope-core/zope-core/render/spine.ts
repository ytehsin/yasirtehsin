/**
 * SPINE WIDTH
 *
 * Width = leaves x paper caliper, where leaves is pages / 2. The number that
 * goes in is the page count READ BACK from the rendered PDF, blank versos
 * included — an estimate here produces a cover that does not fit the book.
 *
 * Caliper varies by paper, and by mill for the same nominal stock. These are
 * the published figures for the two print-on-demand services most Indian
 * self-publishers use, plus a conservative default for offset work. Confirm
 * with your printer before a real print run: a spine 1mm out is visible, and
 * on a wrap cover it drags the artwork onto the front.
 */

export interface PaperStock {
  id: string;
  label: string;
  /** Millimetres per single page (two pages = one leaf). */
  mmPerPage: number;
  source: string;
}

export const PAPER_STOCKS: PaperStock[] = [
  { id: "kdp-white", label: "KDP white", mmPerPage: 0.0572, source: "KDP published figure" },
  { id: "kdp-cream", label: "KDP cream", mmPerPage: 0.0635, source: "KDP published figure" },
  { id: "ingram-50-white", label: "IngramSpark 50# white", mmPerPage: 0.0512, source: "IngramSpark published figure" },
  { id: "offset-70gsm", label: "70gsm offset (typical India)", mmPerPage: 0.0700, source: "conservative default — confirm with your printer" },
  { id: "offset-80gsm", label: "80gsm offset", mmPerPage: 0.0800, source: "conservative default — confirm with your printer" },
];

export interface SpineResult {
  widthMm: number;
  /** Hardcover and some perfect binding need a minimum before a spine can be printed on. */
  printableSpine: boolean;
  note: string;
}

export function spineWidth(pageCount: number, stockId: string): SpineResult {
  const stock = PAPER_STOCKS.find((s) => s.id === stockId) ?? PAPER_STOCKS[0];
  const widthMm = Math.round(pageCount * stock.mmPerPage * 100) / 100;

  // Below roughly 130 pages most POD services will not print text on the
  // spine, because the fold tolerance is wider than the spine itself.
  const printableSpine = pageCount >= 130;

  return {
    widthMm,
    printableSpine,
    note: printableSpine
      ? `${stock.label}, ${stock.source}.`
      : `At ${pageCount} pages the spine is too narrow for text on most printers. ${stock.label}.`,
  };
}
