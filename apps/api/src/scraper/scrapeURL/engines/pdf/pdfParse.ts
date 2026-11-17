import type { Meta } from "../..";
import escapeHtml from "escape-html";
import PdfParse from "pdf-parse";
import { readFile } from "node:fs/promises";
import type { PDFProcessorResult } from "./types";

export async function scrapePDFWithParsePDF(
  meta: Meta,
  tempFilePath: string,
  maxPages?: number,
): Promise<PDFProcessorResult> {
  meta.logger.debug("Processing PDF document with parse-pdf", { tempFilePath });

  try {
    const startedAt = Date.now();
    // pdf-parse applies max before requesting/rendering each page. Capping only
    // metadata afterwards leaks the rest of the document into the response.
    const result = await PdfParse(await readFile(tempFilePath), {
      max: maxPages ?? 0,
    });
    const durationMs = Date.now() - startedAt;
    const escaped = escapeHtml(result.text);

    meta.logger.info("pdfParse succeeded", {
      durationMs,
      markdownLength: escaped.length,
      numPages: result.numrender,
      totalPages: result.numpages,
    });

    return {
      markdown: escaped,
      html: escaped,
      pagesProcessed: result.numrender,
      totalPages: result.numpages,
    };
  } catch (error) {
    meta.logger.error("pdfParse failed", { error });
    throw error;
  }
}
