import { config } from "../../../config";
import { scrapeTimeout } from "./lib";
const enabled = !!config.TEST_SUITE_SELF_HOSTED && process.env.LOCAL_SEARCH_FIXTURE_TESTS === "true";
async function search(query: string, extra = {}, version = "v2") {
  const response = await fetch(`${config.TEST_API_URL}/${version}/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, limit: 2, ...extra }) });
  return { status: response.status, body: await response.json() };
}
describe.skipIf(!enabled)("Local SearXNG search (deterministic fixture provider)", () => {
  it("returns two valid unique URLs through the real API", async () => {
    const { status, body } = await search("LOCAL_SEARCH_FIXTURE_OK");
    expect(status).toBe(200); expect(body.success).toBe(true);
    expect(body.data.web.map(item => item.url)).toEqual(["https://docs.python.org/3/", "https://docs.python.org/3/library/"]);
  }, scrapeTimeout);
  it.each(["v1", "v2"])("surfaces a provider outage explicitly in %s", async version => {
    const { status, body } = await search("LOCAL_SEARCH_FIXTURE_FAILURE", {}, version);
    expect(status).toBe(503); expect(body.success).toBe(false); expect(body.code).toBe("SEARCH_PROVIDER_UNAVAILABLE");
  }, scrapeTimeout);
  it.each(["MALFORMED", "ALLFAILED", "TIMEOUT"])("surfaces %s without fallback", async mode => {
    const { status, body } = await search("LOCAL_SEARCH_FIXTURE_" + mode);
    expect(status).toBe(503); expect(body.code).toBe("SEARCH_PROVIDER_UNAVAILABLE");
  }, scrapeTimeout);
  it("returns useful partial engine results", async () => {
    const { status, body } = await search("LOCAL_SEARCH_FIXTURE_PARTIAL");
    expect(status).toBe(200); expect(body.data.web.map(item => item.url)).toEqual(["https://docs.python.org/3/"]);
  }, scrapeTimeout);
  it("keeps a successful empty query empty", async () => {
    const { status, body } = await search("LOCAL_SEARCH_FIXTURE_EMPTY");
    expect(status).toBe(200); expect(body.success).toBe(true); expect(body.data.web ?? []).toEqual([]);
  }, scrapeTimeout);
  it.each(["images", "news"])("clearly rejects unsupported %s", async source => {
    const { status, body } = await search("LOCAL_SEARCH_FIXTURE_OK", { sources: [source] });
    expect(status).toBe(501); expect(body.code).toBe("SEARCH_CAPABILITY_UNAVAILABLE");
  }, scrapeTimeout);
  it("clearly rejects the hosted developer category", async () => {
    const { status, body } = await search("LOCAL_SEARCH_FIXTURE_OK", { categories: ["developer"] });
    expect(status).toBe(501); expect(body.code).toBe("SEARCH_CAPABILITY_UNAVAILABLE");
  }, scrapeTimeout);
});
