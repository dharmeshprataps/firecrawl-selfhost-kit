import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Meta } from "../..";
import { scrapePDFWithParsePDF } from "./pdfParse";
import { processPdf } from "@mendable/firecrawl-rs";

const fixture = join(process.cwd(), "src/scraper/scrapeURL/engines/pdf/__fixtures__/pdf-page-limits.pdf");
const meta = () =>
  ({
    logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  }) as unknown as Meta;
const marker = (page: number) =>
  `pdf-limit-page-${String(page).padStart(2, "0")}-marker`;

describe("local PDF fallback page limits", () => {
  it("also bounds native extraction while retaining the original document length", () => {
    const result = processPdf(fixture, 2);
    expect(result.pageCount).toBe(9);
    expect(result.markdown).toContain(marker(1));
    expect(result.markdown).toContain(marker(2));
    for (let page = 3; page <= 9; page++)
      expect(result.markdown).not.toContain(marker(page));
  });

  it("extracts all nine fixture pages without a cap", async () => {
    const result = await scrapePDFWithParsePDF(meta(), fixture);
    for (let page = 1; page <= 9; page++)
      expect(result.markdown).toContain(marker(page));
    expect(result.pagesProcessed).toBe(9);
    expect(result.totalPages).toBe(9);
  });

  it("extracts only the first two pages, excluding every later marker from both outputs", async () => {
    const result = await scrapePDFWithParsePDF(meta(), fixture, 2);
    for (const output of [result.markdown, result.html]) {
      expect(output).toContain(marker(1));
      expect(output).toContain(marker(2));
      for (let page = 3; page <= 9; page++)
        expect(output).not.toContain(marker(page));
    }
    expect(result.pagesProcessed).toBe(2);
    expect(result.totalPages).toBe(9);
  });

  it("does not reuse full-document text after a full parse", async () => {
    const full = await scrapePDFWithParsePDF(meta(), fixture);
    const limited = await scrapePDFWithParsePDF(meta(), fixture, 1);
    expect(full.markdown).toContain(marker(9));
    expect(limited.markdown).toContain(marker(1));
    expect(limited.markdown).not.toContain(marker(2));
    expect(limited.markdown).not.toContain(marker(9));
    expect(limited.markdown!.length).toBeLessThan(full.markdown!.length / 2);
    expect(limited.pagesProcessed).toBe(1);
  });

  it("reports actual document pages when the requested cap is larger", async () => {
    const result = await scrapePDFWithParsePDF(meta(), fixture, 20);
    expect(result.markdown).toContain(marker(9));
    expect(result.pagesProcessed).toBe(9);
    expect(result.totalPages).toBe(9);
  });
});
