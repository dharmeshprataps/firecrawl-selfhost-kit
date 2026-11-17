import { generateLocalInference, localInferenceConfig, LOCAL_INFERENCE_ENDPOINT, LOCAL_INFERENCE_MODEL, prepareLocalInput } from "./local-inference";
import { z } from "zod";
const schema = { type: "object", properties: { value: { type: "number" }, active: { type: "boolean" } }, required: ["value", "active"], additionalProperties: false };
const base = { baseURL: LOCAL_INFERENCE_ENDPOINT, modelName: LOCAL_INFERENCE_MODEL, markdown: "Value 42. Active false.", schema };
const answer = (content: string, extra = {}) => new Response(JSON.stringify({ message: { content }, prompt_eval_count: 40, eval_count: 8, done: true, done_reason: "stop", ...extra }));
describe("Bounded local inference", () => {
  it("validates exact endpoints and pinned model before sending any data", async () => {
    const fetchImpl = vi.fn();
    for (const baseURL of ["https://ollama.com/api", "http://host.lima.internal:11434/api", "http://evil.example:11435/api", "http://user@host.lima.internal:11435/api"]) {
      await expect(generateLocalInference({ ...base, baseURL, fetchImpl })).rejects.toThrow("reviewed");
    }
    expect(() => localInferenceConfig(LOCAL_INFERENCE_ENDPOINT, "qwen3:cloud")).toThrow("pinned");
    expect(() => localInferenceConfig(LOCAL_INFERENCE_ENDPOINT)).toThrow("pinned");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("sends one bounded local request and validates exact typed JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(answer('{"value":42,"active":false}'));
    const result = await generateLocalInference({ ...base, fetchImpl });
    expect(result.extract).toEqual({ value: 42, active: false });
    expect(result.totalUsage).toEqual({ promptTokens: 40, completionTokens: 8, totalTokens: 48 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(LOCAL_INFERENCE_ENDPOINT + "/chat");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toMatchObject({ model: LOCAL_INFERENCE_MODEL, stream: false, format: schema, options: { num_ctx: 8192, num_predict: 1024, temperature: 0 } });
  });
  it.each(["not-json", '{"value":"42","active":false}', '{"value":42}', '{"value":42,"active":false,"extra":true}'])("rejects invalid or schema-mismatched output without repair/fallback: %s", async content => {
    const fetchImpl = vi.fn().mockResolvedValue(answer(content));
    await expect(generateLocalInference({ ...base, fetchImpl })).rejects.toThrow(/invalid JSON|requested schema/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("validates Zod output without coercing false or zero", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(answer('{"value":0,"active":false}'));
    const result = await generateLocalInference({ ...base, markdown: "Value 0. Active false.", schema: z.object({ value: z.number(), active: z.boolean() }), fetchImpl });
    expect(result.extract).toEqual({ value: 0, active: false });
  });
  it("returns summaries through the same local provider", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(answer('{"summary":"The project value is 42."}'));
    const result = await generateLocalInference({ ...base, schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] }, prompt: "Summarize the page", fetchImpl });
    expect(result.extract.summary).toContain("42");
  });
  it("rejects a schema-valid number absent from the retained source without retry", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(answer('{"value":99999,"active":false}'));
    await expect(generateLocalInference({ ...base, fetchImpl })).rejects.toMatchObject({ code: "LOCAL_EXTRACTION_GROUNDING_FAILED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("uses deterministic source cells before context trimming, without contacting any model", async () => {
    const fetchImpl = vi.fn();
    const markdown = "Navigation ".repeat(3000) + "\n\n| | Sep 2026 | Jun 2026 |\n| --- | --- | --- |\n| Sales + | 21,794 | 15,548 |\n| Net Profit + | 411 | 718 |\n";
    const schema = { type: "object", properties: { latestQuarter: { type: "string" }, latestSales: { type: "number" }, previousQuarter: { type: "string" }, previousSales: { type: "number" } }, required: ["latestQuarter", "latestSales", "previousQuarter", "previousSales"] };
    const result = await generateLocalInference({ ...base, markdown, prompt: "Latest two quarters sales", schema, fetchImpl });
    expect(result.extract).toEqual({ latestQuarter: "Sep 2026", latestSales: 21794, previousQuarter: "Jun 2026", previousSales: 15548 });
    expect(result.grounding?.status).toBe("row-column-verified");
    expect(result.totalUsage.totalTokens).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("surfaces provider outage with exactly one call and no fallback", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(generateLocalInference({ ...base, fetchImpl })).rejects.toThrow("no cloud fallback");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects provider HTTP errors and truncated output", async () => {
    await expect(generateLocalInference({ ...base, fetchImpl: vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })) })).rejects.toThrow("HTTP 503");
    await expect(generateLocalInference({ ...base, fetchImpl: vi.fn().mockResolvedValue(answer('{"value":42,"active":false}', { done_reason: "length" })) })).rejects.toThrow("token limit");
  });
  it("bounds response bytes rather than parsing an unbounded response", async () => {
    await expect(generateLocalInference({ ...base, fetchImpl: vi.fn().mockResolvedValue(new Response("x".repeat(270000))) })).rejects.toThrow("size limit");
  });
  it("reserves prompt/schema headroom and reports page truncation", () => {
    const result = prepareLocalInput({ markdown: "你好🙂 ".repeat(20000), prompt: "Extract facts", schema, previousWarning: "Previous warning." });
    expect(Buffer.byteLength(result.prompt + result.system + JSON.stringify(schema), "utf8") / 2 + 256).toBeLessThanOrEqual(6001);
    expect(result.prompt).not.toContain("�");
    expect(result.warning).toContain("Previous warning.");
    expect(result.warning).toContain("trimmed");
    expect(() => prepareLocalInput({ markdown: "small", prompt: "x".repeat(13000) })).toThrow("budget");
  });
});
