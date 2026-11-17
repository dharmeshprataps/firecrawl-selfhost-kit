import { config } from "../../../config";
import { scrapeTimeout } from "./lib";

// Run only with the reviewed private fixture profile and deterministic local
// search provider selected, with explicit opt-in for public documentation reads.
// The public gateway must be stopped by the operator.
const enabled = !!config.TEST_SUITE_SELF_HOSTED && process.env.LOCAL_SEARCH_FIXTURE_TESTS === "true" && process.env.LOCAL_MAP_LIVE_TESTS === "true";
const privateFixtureEnabled = !!config.TEST_SUITE_SELF_HOSTED && !!process.env.LOCAL_FIXTURE_ORIGIN;
const origin = process.env.LOCAL_FIXTURE_ORIGIN ?? "http://fixtures.firecrawl.test:8765";
const publicTarget = "https://docs.python.org/3/tutorial/";
async function map(version: "v1" | "v2", payload: Record<string, unknown>) {
  const response = await fetch(`${config.TEST_API_URL}/${version}/map`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ useIndex: false, ignoreCache: true, limit: 5, ...payload }),
  });
  return { status: response.status, body: await response.json() };
}
describe.skipIf(!enabled)("Local provider failure with independent public-page discovery", () => {
  it.each(["v1", "v2"] as const)("keeps sitemap links when local search fails in %s", async version => {
    const result = await map(version, { url: publicTarget, search: "LOCAL_SEARCH_FIXTURE_FAILURE" });
    expect(result.status).toBe(200); expect(result.body.success).toBe(true);
    expect(result.body.partial).toBe(true);
    expect(result.body.discoveryError).toEqual({ code: "SEARCH_PROVIDER_UNAVAILABLE", status: 503 });
    const urls = result.body.links.map((item: string | { url: string }) => typeof item === "string" ? item : item.url);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url: string) => url.startsWith(publicTarget))).toBe(true);
    expect(urls).toHaveLength(5);
  }, scrapeTimeout);
  it.each(["v1", "v2"] as const)("returns a provider error, not invalid arguments, when no discovery survives in %s", async version => {
    const result = await map(version, { url: "https://docs.python.org/local-map-fixture-does-not-exist-7319.html", search: "LOCAL_SEARCH_FIXTURE_FAILURE", ...(version === "v1" ? { ignoreSitemap: true } : { sitemap: "skip" }) });
    expect(result.status).toBe(503); expect(result.body.success).toBe(false);
    expect(result.body.code).toBe("SEARCH_PROVIDER_UNAVAILABLE");
  }, scrapeTimeout);
});


describe.skipIf(!privateFixtureEnabled)("Exact private sitemap fixture", () => {
  it("retains the first real sitemap URL and enforces the requested count", async () => {
    const result = await map("v2", { url: origin + "/", sitemap: "only", limit: 2 });
    expect(result.status).toBe(200); expect(result.body.links).toHaveLength(2);
    expect(new URL(result.body.links[0].url).pathname).toBe("/");
    expect(result.body.links[1].url).toBe(origin + "/static.html");
  }, scrapeTimeout);
});
