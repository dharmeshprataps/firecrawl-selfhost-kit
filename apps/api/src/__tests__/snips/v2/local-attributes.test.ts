import { config } from "../../../config";
import { scrapeTimeout } from "./lib";

// Explicit opt-in: this uses the benchmark's existing public target, not a new
// fixture exception or provider. The selector sets are Q048/Q050 verbatim, but
// these API payloads are translated backend checks. Exact MCP tool replay and
// its original argument hashes remain separate post-deployment acceptance.
const target = "https://docs.python.org/3/tutorial/appetite.html";
const enabled = !!config.TEST_SUITE_SELF_HOSTED && process.env.LOCAL_ATTRIBUTE_ACCEPTANCE_URL === target;
const head = [
  { selector: "html", attribute: "lang" },
  { selector: 'meta[property="og:title"]', attribute: "content" },
  { selector: 'link[rel="canonical"]', attribute: "href" },
];
const body = [
  { selector: "html", attribute: "lang" },
  { selector: 'a[accesskey="N"]', attribute: "href" },
  { selector: 'meta[property="og:title"]', attribute: "content" },
];

async function attributes(selectors: typeof head, options: Record<string, unknown> = {}) {
  const response = await fetch(`${config.TEST_API_URL}/v2/scrape`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: target, formats: [{ type: "attributes", selectors }], maxAge: 0, timeout: 15000, ...options }),
  });
  const result = await response.json();
  expect(response.status).toBe(200);
  expect(result.success).toBe(true);
  expect(result.data.metadata.statusCode).toBe(200);
  return result.data;
}

describe.skipIf(!enabled)("local public head-attribute API translation acceptance", () => {
  it("returns Q048 selector values through the translated API payload", async () => {
    const document = await attributes(head);
    expect(document.attributes).toEqual([
      { ...head[0], values: ["en"] },
      { ...head[1], values: ["1. Whetting Your Appetite"] },
      { ...head[2], values: [target] },
    ]);
    expect(document.attributes[1].values).toEqual([document.metadata["og:title"]]);
  }, scrapeTimeout);

  it("returns Q050 body and head selector values through the translated API payload", async () => {
    const document = await attributes(body);
    expect(document.attributes).toEqual([
      { ...body[0], values: ["en"] },
      { ...body[1], values: ["https://docs.python.org/3/tutorial/interpreter.html"] },
      { ...body[2], values: ["1. Whetting Your Appetite"] },
    ]);
  }, scrapeTimeout);

  it("keeps body filtering effective while exposing source head metadata", async () => {
    const document = await attributes(body, {
      includeTags: ["section#whetting-your-appetite"], excludeTags: ["a.headerlink"], onlyMainContent: true,
    });
    expect(document.attributes[1].values).toEqual([]);
    expect(document.attributes[2].values).toEqual(["1. Whetting Your Appetite"]);
  }, scrapeTimeout);
});
