vi.mock("../config", () => ({ config: { SEARXNG_ENDPOINT: "http://searxng:8080" } }));
vi.mock("../controllers/v2/types", () => ({ MAX_MAP_LIMIT: 5000, scrapeOptions: { parse: (x: any) => x } }));
vi.mock("./crawl-redis", () => ({ crawlToCrawler: vi.fn() }));
vi.mock("./zdr-helpers", () => ({ getScrapeZDR: () => null }));
vi.mock("./validateUrl", () => ({
  resolveRedirects: async (url: string) => url,
  checkAndUpdateURLForMap: (value: string, ignoreQuery = false) => { const u = new URL(value); if (ignoreQuery) u.search = ""; u.hash = ""; return { url: u.href.replace(/\/$/, "") }; },
  isSameDomain: (a: string, b: string) => new URL(a).hostname === new URL(b).hostname,
  isSameSubdomain: (a: string, b: string) => new URL(a).hostname === new URL(b).hostname,
}));
vi.mock("../services/redis", () => ({ redisEvictConnection: { get: vi.fn(), set: vi.fn() } }));
vi.mock("../services/index", () => ({ generateURLSplits: () => [], queryIndexAtDomainSplitLevelWithMeta: vi.fn(), queryIndexAtSplitLevelWithMeta: vi.fn() }));
vi.mock("./map-cosine", () => ({ performCosineSimilarityV2: (x: any) => x }));
vi.mock("../search/fireEngine", () => ({ fireEngineMap: vi.fn() }));
vi.mock("../search/localMapLinks", () => ({ discoverMapLinks: vi.fn() }));
import { getMapResults } from "./map-utils";
import { crawlToCrawler } from "./crawl-redis";
import { redisEvictConnection } from "../services/redis";
import { fireEngineMap } from "../search/fireEngine";
import { discoverMapLinks } from "../search/localMapLinks";
import { SearchProviderError } from "../search/searxngClient";
const root = "https://docs.python.org/3/tutorial/";
const searchResult = (url: string, title = "Search fixture page") => ({ url, title, description: "Deterministic search fixture result" });
let sitemap: string[], blocked: boolean;
const run = (options = {}) => getMapResults({ url: root, limit: 5, teamId: "local", flags: null, useIndex: false, crawlerOptions: { sitemap: "include" }, ...options });
beforeEach(() => {
  vi.clearAllMocks(); sitemap = []; blocked = false;
  vi.mocked(redisEvictConnection.get).mockResolvedValue(null);
  vi.mocked(fireEngineMap).mockResolvedValue([]);
  vi.mocked(discoverMapLinks).mockResolvedValue([]);
  vi.mocked(crawlToCrawler).mockReturnValue({
    getRobotsTxt: async () => "", importRobotsTxt: () => {},
    tryGetSitemap: async (callback: (urls: string[]) => void) => { callback(sitemap); return sitemap.length; },
    filterURL: async () => ({ allowed: !blocked }), extractLinksFromHTML: async () => [],
  } as any);
});
it("retains sitemap URLs when the configured search provider is unavailable", async () => {
  sitemap = [root + "intro.html"];
  vi.mocked(fireEngineMap).mockRejectedValue(new SearchProviderError());
  const result = await run();
  expect(result.mapResults.map(x => x.url)).toEqual([root + "intro.html"]);
  expect(result).toMatchObject({ success: true, partial: true, discoveryError: { code: "SEARCH_PROVIDER_UNAVAILABLE", status: 503 } });
  expect(redisEvictConnection.set).not.toHaveBeenCalled();
});
it("uses bounded seed-page links when sitemap and search are empty", async () => {
  vi.mocked(discoverMapLinks).mockResolvedValue([{ url: root + "controlflow.html" }]);
  const result = await run();
  expect(result.mapResults).toEqual([{ url: root + "controlflow.html" }]);
  expect(result.partial).toBe(true); expect(result.discoveryError).toBeUndefined();
  expect(discoverMapLinks).toHaveBeenCalledWith(expect.objectContaining({ url: root, limit: 5, filterByPath: true }));
});
it("keeps the typed provider failure when no usable discovery remains", async () => {
  vi.mocked(fireEngineMap).mockRejectedValue(new SearchProviderError());
  await expect(run()).rejects.toMatchObject({ code: "SEARCH_PROVIDER_UNAVAILABLE", status: 503 });
});
it("does not treat filtered-out sitemap links as usable fallback results", async () => {
  sitemap = ["https://docs.python.org/3/library/asyncio.html"];
  vi.mocked(fireEngineMap).mockRejectedValue(new SearchProviderError());
  vi.mocked(discoverMapLinks).mockResolvedValue([{ url: root + "intro.html" }]);
  expect((await run()).mapResults.map(x => x.url)).toEqual([root + "intro.html"]);
});
it("does not discard the first actual sitemap URL or fetch HTML in sitemap-only mode", async () => {
  sitemap = [root + "intro.html", root + "controlflow.html"];
  const result = await run({ crawlerOptions: { sitemap: "only" } });
  expect(result.mapResults.map(x => x.url)).toEqual(sitemap);
  expect(fireEngineMap).not.toHaveBeenCalled(); expect(discoverMapLinks).not.toHaveBeenCalled();
});
it("respects robots refusal before fetching seed-page HTML", async () => {
  blocked = true;
  expect((await run()).mapResults).toEqual([]);
  expect(discoverMapLinks).not.toHaveBeenCalled();
});
it("does not leak similarly-prefixed paths and deduplicates before limiting", async () => {
  sitemap = [root + "intro.html", root + "intro.html", "https://docs.python.org/3/tutorial-bad/", root + "controlflow.html"];
  const result = await run({ limit: 2, url: root.replace(/\/$/, "") });
  expect(result.mapResults.map(x => x.url)).toEqual([root + "intro.html", root + "controlflow.html"]);
});
it("propagates cancellation instead of converting it to an empty success", async () => {
  const abort = new AbortController(); abort.abort();
  vi.mocked(discoverMapLinks).mockRejectedValue(new Error("Aborted"));
  await expect(run({ abort: abort.signal })).rejects.toThrow("Aborted");
});

it("supplements a successful nine-link inventory from the seed page without crawling", async () => {
  const inventory = Array.from({ length: 25 }, (_, i) => root + `chapter-${i}.html`);
  vi.mocked(fireEngineMap).mockResolvedValue(inventory.slice(0, 9).map(url => searchResult(url)));
  vi.mocked(discoverMapLinks).mockResolvedValue(inventory.map(url => ({ url })));
  const result = await run({ limit: 25 });
  expect(result.mapResults.map(x => x.url)).toEqual(inventory);
  expect(discoverMapLinks).toHaveBeenCalledTimes(1);
  expect(discoverMapLinks).toHaveBeenCalledWith(expect.objectContaining({ url: root, limit: 25, filterByPath: true }));
  expect(fireEngineMap).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ success: true, partial: true });
  expect(result.warning).toContain("incomplete");
  expect(result.discoveryError).toBeUndefined();
});
it("counts canonical unique in-scope links before deciding that an inventory is full", async () => {
  vi.mocked(fireEngineMap).mockResolvedValue([
    searchResult(root + "intro.html?source=one"),
    searchResult(root + "intro.html?source=two#same"),
    searchResult(root + "intro.html#again"),
    searchResult("https://docs.python.org/3/tutorial-bad/outside.html"),
  ]);
  vi.mocked(discoverMapLinks).mockResolvedValue([
    { url: root + "intro.html" }, { url: root + "controlflow.html" }, { url: root + "datastructures.html" },
  ]);
  const result = await run({ limit: 3 });
  expect(result.mapResults.map(x => x.url)).toEqual([root + "intro.html", root + "controlflow.html", root + "datastructures.html"]);
  expect(discoverMapLinks).toHaveBeenCalledTimes(1);
});
it("does not read the seed when canonical search inventory already reaches the limit", async () => {
  const urls = [root + "intro.html", root + "controlflow.html", root + "datastructures.html"];
  vi.mocked(fireEngineMap).mockResolvedValue(urls.map(url => searchResult(url)));
  const result = await run({ limit: 3 });
  expect(result.mapResults.map(x => x.url)).toEqual(urls);
  expect(discoverMapLinks).not.toHaveBeenCalled();
  expect(result.partial).toBeUndefined();
});
it("does not broaden successful underfilled filtered searches with unfiltered seed links", async () => {
  vi.mocked(fireEngineMap).mockResolvedValue([searchResult(root + "controlflow.html", "Control flow")]);
  vi.mocked(discoverMapLinks).mockResolvedValue([{ url: root + "unrelated.html" }]);
  const result = await run({ limit: 25, search: "control flow" });
  expect(result.mapResults.map(x => x.url)).toEqual([root + "controlflow.html"]);
  expect(discoverMapLinks).not.toHaveBeenCalled();
  expect(result.partial).toBeUndefined();
});
it("keeps successful search results when robots refuses the supplement", async () => {
  blocked = true;
  vi.mocked(fireEngineMap).mockResolvedValue([searchResult(root + "intro.html")]);
  const result = await run({ limit: 25 });
  expect(result.mapResults.map(x => x.url)).toEqual([root + "intro.html"]);
  expect(discoverMapLinks).not.toHaveBeenCalled();
  expect(result.discoveryError).toBeUndefined();
});
