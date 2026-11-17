import { config } from "../../../config";
import { scrapeTimeout } from "./lib";

const fixture = process.env.LOCAL_PDF_LIMIT_FIXTURE_URL;
const enabled = !!config.TEST_SUITE_SELF_HOSTED && !!fixture;
const marker = (page: number) =>
  `pdf-limit-page-${String(page).padStart(2, "0")}-marker`;

async function readPDF(maxPages?: number, mode: "auto" | "ocr" = "auto") {
  const response = await fetch(`${config.TEST_API_URL}/v2/scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: fixture,
      formats: ["markdown", "html"],
      maxAge: 0,
      parsers: [
        { type: "pdf", mode, ...(maxPages === undefined ? {} : { maxPages }) },
      ],
    }),
  });
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.success).toBe(true);
  return body.data;
}

describe.skipIf(!enabled)("local PDF page-limit contract", () => {
  it(
    "caps native-path content and reports original versus processed pages",
    async () => {
      const result = await readPDF(2);
      expect(result.markdown).toContain(marker(1));
      expect(result.markdown).toContain(marker(2));
      for (let page = 3; page <= 9; page++)
        expect(result.markdown).not.toContain(marker(page));
      expect(result.metadata.numPages).toBe(2);
      expect(result.metadata.totalPages).toBe(9);
    },
    scrapeTimeout,
  );

  it(
    "caps the local fallback before extraction after a full-document read",
    async () => {
      // On the local stack no external OCR provider is configured. OCR mode skips
      // native extraction and exercises its existing pdf-parse text fallback.
      const full = await readPDF(undefined, "ocr");
      const limited = await readPDF(2, "ocr");
      expect(full.markdown).toContain(marker(9));
      expect(full.metadata.numPages).toBe(9);
      for (const output of [limited.markdown, limited.html]) {
        expect(output).toContain(marker(1));
        expect(output).toContain(marker(2));
        for (let page = 3; page <= 9; page++)
          expect(output).not.toContain(marker(page));
      }
      expect(limited.metadata.numPages).toBe(2);
      expect(limited.metadata.totalPages).toBe(9);
    },
    scrapeTimeout,
  );

  it(
    "reports actual length rather than a larger requested page count",
    async () => {
      const result = await readPDF(20, "ocr");
      expect(result.markdown).toContain(marker(9));
      expect(result.metadata.numPages).toBe(9);
      expect(result.metadata.totalPages).toBe(9);
    },
    scrapeTimeout,
  );

  it(
    "rejects a zero page limit instead of treating it as unlimited",
    async () => {
      const response = await fetch(`${config.TEST_API_URL}/v2/scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: fixture,
          formats: ["markdown"],
          parsers: [{ type: "pdf", maxPages: 0 }],
        }),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).success).toBe(false);
    },
    scrapeTimeout,
  );
});
