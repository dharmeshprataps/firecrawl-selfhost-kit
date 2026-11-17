import { config } from "../../../config";
import { scrapeTimeout } from "./lib";
const enabled = !!config.TEST_SUITE_SELF_HOSTED && !!process.env.LOCAL_FIXTURE_ORIGIN && !!process.env.OLLAMA_BASE_URL;
const origin = process.env.LOCAL_FIXTURE_ORIGIN ?? "http://fixtures.firecrawl.test:8765";
const factsSchema = { type: "object", properties: { project: { type: "string" }, value: { type: "number" }, active: { type: "boolean" } }, required: ["project", "value", "active"], additionalProperties: false };
async function scrape(formats: object[]) {
  const response = await fetch(`${config.TEST_API_URL}/v2/scrape`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: origin + "/structured.html", formats, maxAge: 0, timeout: 85000 }) });
  return { status: response.status, body: await response.json() };
}
describe.skipIf(!enabled)("Local inference extraction and summary", () => {
  it("extracts a typed schema from the page using the local model", async () => {
    const { status, body } = await scrape([{ type: "json", schema: factsSchema, prompt: "Extract the project name, numeric value and active boolean exactly from the page." }]);
    expect(status).toBe(200); expect(body.success).toBe(true);
    expect(body.data.json).toEqual({ project: "Orchid Local", value: 42, active: false });
  }, scrapeTimeout);
  it("summarizes factual page content", async () => {
    const { status, body } = await scrape([{ type: "summary" }]);
    expect(status).toBe(200); expect(body.success).toBe(true);
    expect(body.data.summary).toMatch(/Orchid/i); expect(body.data.summary).toContain("42");
  }, scrapeTimeout);
  it.skipIf(process.env.LOCAL_INFERENCE_EXPECT_UNAVAILABLE !== "1")("returns a provider failure when the reviewed local inference server is stopped", async () => {
    const { status, body } = await scrape([{ type: "json", schema: factsSchema }]);
    expect(status !== 200 || body.success === false).toBe(true);
    expect(body.data?.json).toBeUndefined();
  }, scrapeTimeout);
});
