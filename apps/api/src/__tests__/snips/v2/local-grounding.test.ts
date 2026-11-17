import { config } from "../../../config";
import { scrapeTimeout } from "./lib";

const enabled = !!config.TEST_SUITE_SELF_HOSTED && !!process.env.LOCAL_FIXTURE_ORIGIN && !!process.env.OLLAMA_BASE_URL;
const origin = process.env.LOCAL_FIXTURE_ORIGIN ?? "http://fixtures.firecrawl.test:8765";
const schema = { type: "object", properties: { latestQuarter: { type: "string" }, latestSales: { type: "number" }, latestNetProfit: { type: "number" }, previousQuarter: { type: "string" }, previousSales: { type: "number" }, previousNetProfit: { type: "number" } }, required: ["latestQuarter", "latestSales", "latestNetProfit", "previousQuarter", "previousSales", "previousNetProfit"], additionalProperties: false };
const expected = { latestQuarter: "Sep 2026", latestSales: 21794, latestNetProfit: 411, previousQuarter: "Jun 2026", previousSales: 15548, previousNetProfit: 718 };
const moneyFields = ["latestSales", "latestNetProfit", "previousSales", "previousNetProfit"] as const;
const sourcePrompt = "Extract the latest two consolidated quarters' sales and net profit, preserving source units and period labels.";
const convertPrompt = "Extract sales and net profit from the latest two consolidated quarters. Convert crore into rupees. Preserve period labels.";
const mixedPrompt = "Extract sales and net profit from the latest two consolidated quarters in the units specified by each field. Preserve period labels.";

async function read(path: string, requested: unknown = schema, prompt = sourcePrompt) {
  const r = await fetch(`${config.TEST_API_URL}/v2/scrape`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: origin + path, formats: ["markdown", { type: "json", schema: requested, prompt }], maxAge: 0, timeout: 45000 }) });
  return { status: r.status, body: await r.json() };
}

function assertMoneyEvidence(document: any, converted: ReadonlySet<string>) {
  const grounding = document.metadata.extractionGrounding;
  expect(grounding).toMatchObject({ method: "deterministic-quarterly-table", status: "row-column-and-unit-verified", periods: ["Sep 2026", "Jun 2026"], inputTruncated: false });
  expect(grounding.fields).toHaveLength(6);
  for (const key of moneyFields) {
    const field = grounding.fields.find((item: any) => item.path === key);
    const isConverted = converted.has(key);
    const latest = key.startsWith("latest");
    expect(field).toMatchObject({ period: latest ? "Sep 2026" : "Jun 2026", column: latest ? 13 : 12,
      sourceValue: expected[key], sourceUnit: "INR_crore", outputUnit: isConverted ? "INR_rupee" : "INR_crore",
      value: expected[key] * (isConverted ? 10000000 : 1) });
    expect(field.raw.replace(/[,\s]/g, "")).toBe(String(expected[key]));
    expect(field.row).toMatch(key.includes("NetProfit") ? /net\s*profit/i : /\bsales\b/i);
    if (isConverted) {
      expect(field.conversion).toEqual({ operation: "multiply", factor: 10000000, exact: true });
      expect(field.value).toBe(field.sourceValue * field.conversion.factor);
      expect(field.value).not.toBe(field.sourceValue);
    } else expect(field.conversion).toBeUndefined();
  }
  for (const key of ["latestQuarter", "previousQuarter"] as const) {
    const field = grounding.fields.find((item: any) => item.path === key);
    expect(field).toMatchObject({ row: "header", raw: expected[key], value: expected[key] });
    expect(field.conversion).toBeUndefined();
  }
}

describe.skipIf(!enabled)("Local financial JSON source grounding", () => {
  it("returns all six captured facts with explicit row/column evidence", async () => {
    const { status, body } = await read("/quarterly-results.html");
    expect(status).toBe(200); expect(body.success).toBe(true); expect(body.data.json).toEqual(expected);
    expect(body.data.metadata.extractionGrounding).toMatchObject({ method: "deterministic-quarterly-table", status: "row-column-verified", inputTruncated: false });
    expect(body.data.metadata.extractionGrounding.fields).toHaveLength(6);
  }, scrapeTimeout);
  it("does not fabricate financial JSON when the requested source table is absent", async () => {
    const { status, body } = await read("/structured.html");
    expect(status !== 200 || body.success === false).toBe(true); expect(body.data?.json).toBeUndefined();
  }, scrapeTimeout);
  it("converts all four crore money fields to exact rupees with arithmetic provenance", async () => {
    const { status, body } = await read("/quarterly-results.html", schema, convertPrompt);
    expect(status).toBe(200); expect(body.success).toBe(true);
    expect(body.data.json).toEqual({ latestQuarter: "Sep 2026", latestSales: 217940000000, latestNetProfit: 4110000000,
      previousQuarter: "Jun 2026", previousSales: 155480000000, previousNetProfit: 7180000000 });
    assertMoneyEvidence(body.data, new Set(moneyFields));
  }, scrapeTimeout);
  it("honors explicit mixed field scales while leaving period labels intact", async () => {
    const mixed = { ...schema, properties: { ...schema.properties,
      latestSales: { type: "number", description: "Latest quarter sales in rupees" },
      latestNetProfit: { type: "number", description: "Latest quarter net profit in crores" },
      previousSales: { type: "number", description: "Previous quarter sales in rupees" },
      previousNetProfit: { type: "number", description: "Previous quarter net profit in crores" } } };
    const { status, body } = await read("/quarterly-results.html", mixed, mixedPrompt);
    expect(status).toBe(200); expect(body.success).toBe(true);
    expect(body.data.json).toEqual({ ...expected, latestSales: 217940000000, previousSales: 155480000000 });
    assertMoneyEvidence(body.data, new Set(["latestSales", "previousSales"]));
  }, scrapeTimeout);
  it("rejects an ambiguous unit transformation with its typed error and no numerical JSON", async () => {
    const { status, body } = await read("/quarterly-results.html", schema,
      "Extract sales and net profit from the latest two consolidated quarters. Convert each amount into crore or rupees.");
    expect(status).toBeGreaterThanOrEqual(400); expect(body.success).toBe(false);
    expect(body.code).toBe("LOCAL_EXTRACTION_GROUNDING_FAILED");
    expect(body.data?.json).toBeUndefined();
  }, scrapeTimeout);
});
