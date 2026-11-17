import { config } from "../../../config";
import { scrapeTimeout } from "./lib";

const enabled = !!config.TEST_SUITE_SELF_HOSTED && !!process.env.LOCAL_FIXTURE_ORIGIN;
const origin = process.env.LOCAL_FIXTURE_ORIGIN ?? "http://fixtures.firecrawl.test:8765";
const api = config.TEST_API_URL;

describe.skipIf(!enabled)("Exact local fixture origin", () => {
  it("scrapes the allowlisted fixture with default private-address protection", async () => {
    const response = await fetch(`${api}/v2/scrape`, {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({url: `${origin}/static.html`, formats: ["markdown"], maxAge: 0}),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.markdown).toContain("alpha-marker-7319");
  }, scrapeTimeout);

  it("rejects another hostname reaching the same private fixture", async () => {
    const denied = new URL("/static.html", origin);
    denied.hostname = "fixtures-denied.firecrawl.test";
    const response = await fetch(`${api}/v2/scrape`, {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({url: denied.href, formats: ["markdown"], maxAge: 0, timeout: 15000}),
    });
    const body = await response.json();
    expect(response.status !== 200 || body.success === false).toBe(true);
  }, scrapeTimeout);
});
