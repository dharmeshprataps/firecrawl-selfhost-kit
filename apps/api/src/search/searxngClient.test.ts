import axios from "axios";
import { searchSearxng, SearchProviderError, publicSearchUrl, canonicalSearchUrl, mapSearchScope, inMapScope } from "./searxngClient";
vi.mock("axios", () => ({ default: { get: vi.fn() } }));
const get = vi.mocked(axios.get);
const options = { endpoint: "http://searxng:8080/", numResults: 2 };
afterEach(() => { vi.restoreAllMocks(); });
beforeEach(() => { get.mockReset(); });
const result = (url = "https://docs.python.org/3/") => ({ url, title: "Python", content: "Documentation" });

describe("configured local search provider", () => {
  it("bounds requests, discards invalid/private links, and deduplicates", async () => {
    get.mockResolvedValue({ data: { results: [result(), result(), result("javascript:alert(1)"), result("http://127.0.0.1/"), result("https://docs.python.org/3/library/")] } });
    const results = await searchSearxng("Python", options);
    expect(results.map(item => item.url)).toEqual(["https://docs.python.org/3/", "https://docs.python.org/3/library/"]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe("http://searxng:8080/search");
    expect(get.mock.calls[0][1]).toMatchObject({ maxRedirects: 0, proxy: false, maxContentLength: 2097152, maxBodyLength: 2097152 });
    expect(get.mock.calls[0][1]?.timeout).toBeLessThanOrEqual(15000);
  });
  it("returns a legitimate empty response without inventing results", async () => {
    get.mockResolvedValue({ data: { results: [], unresponsive_engines: [] } });
    await expect(searchSearxng("nothing", options)).resolves.toEqual([]);
  });
  it("accepts useful partial engine results and reports only a count", async () => {
    const onPartialFailure = vi.fn();
    get.mockResolvedValue({ data: { results: [result()], unresponsive_engines: [["duckduckgo", "CAPTCHA"]] } });
    await expect(searchSearxng("Python", { ...options, numResults: 1, onPartialFailure })).resolves.toHaveLength(1);
    expect(onPartialFailure).toHaveBeenCalledWith(1);
  });
  it("distinguishes all-engine failure from a successful empty query", async () => {
    get.mockResolvedValue({ data: { results: [], unresponsive_engines: [["brave", "timeout"]] } });
    await expect(searchSearxng("Python", options)).rejects.toMatchObject({ status: 503, code: "SEARCH_PROVIDER_UNAVAILABLE" });
  });
  it.each([{}, { results: null }, "<html>upstream failure</html>"])("rejects a malformed provider response: %j", async data => {
    get.mockResolvedValue({ data });
    await expect(searchSearxng("private query", options)).rejects.toBeInstanceOf(SearchProviderError);
  });
  it("turns transport timeouts into an explicit safe provider error", async () => {
    get.mockRejectedValue(new Error("secret provider body and query"));
    await expect(searchSearxng("private query", options)).rejects.toMatchObject({ message: "The configured local search provider is unavailable.", status: 503 });
  });
  it("enforces one overall deadline across result pages", async () => {
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValueOnce(15001);
    get.mockResolvedValue({ data: { results: [result()] } });
    await expect(searchSearxng("Python", { ...options, numResults: 21 })).resolves.toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("keeps verified links when a later result page loses its engines", async () => {
    const onPartialFailure = vi.fn();
    get.mockResolvedValueOnce({ data: { results: [result()] } });
    get.mockResolvedValueOnce({ data: { results: [], unresponsive_engines: [["fixture", "timeout"]] } });
    await expect(searchSearxng("Python", { ...options, numResults: 21, onPartialFailure })).resolves.toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(2); expect(onPartialFailure).toHaveBeenCalledWith(1);
  });
  it.each(["http://localhost/", "http://192.168.1.2/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://host.lima.internal/", "https://user:pass@python.org/", "file:///etc/passwd"])("does not expose unsafe result URL %s", url => expect(publicSearchUrl(url)).toBeNull());
});

describe("map result scope", () => {
  const scope = mapSearchScope("asyncio site:https://docs.python.org/3/")!;
  it("extracts a site scope and refuses an unscoped query", () => {
    expect(scope.hostname).toBe("docs.python.org");
    expect(mapSearchScope("Python documentation")).toBeNull();
  });
  it.each([
    ["https://docs.python.org/3/library/", true],
    ["https://sub.docs.python.org/3/", true],
    ["https://docs.python.org/3", true],
    ["https://docs.python.org/3bad/", false],
    ["https://docs.python.org/2/", false],
    ["https://docs.python.org.evil.org/3/", false],
    ["https://other.org/3/", false],
  ])("filters %s to requested host and path", (url, allowed) => expect(inMapScope(url as string, scope)).toBe(allowed));
});


describe("canonical search diversity and factual dates", () => {
  it("deduplicates tracker and Python highlighting/index aliases", () => {
    expect(canonicalSearchUrl("http://docs.python.org/3/tutorial/index.html?highlight=await&utm_source=test#x"))
      .toBe("https://docs.python.org/3/tutorial/");
    expect(canonicalSearchUrl("https://react.dev/learn?utm_medium=email&gclid=123"))
      .toBe("https://react.dev/learn");
  });
  it("preserves different versions, hosts and semantic query values", () => {
    const values = ["https://docs.python.org/3.14/library/asyncio.html", "https://docs.python.org/3.15/library/asyncio.html", "https://react.dev/learn?id=1", "https://react.dev/learn?id=2", "https://www.react.dev/learn?id=1"];
    expect(new Set(values.map(canonicalSearchUrl)).size).toBe(values.length);
  });
  it("refills a duplicate-heavy first page within the provider deadline", async () => {
    get.mockResolvedValueOnce({ data: { results: [result("https://docs.python.org/3/tutorial/index.html?highlight=x"), result("https://docs.python.org/3/tutorial/?utm_source=x")] } });
    get.mockResolvedValueOnce({ data: { results: [result("https://docs.python.org/3/library/asyncio.html")] } });
    const results = await searchSearxng("Python", options);
    expect(results.map(x => x.url)).toEqual(["https://docs.python.org/3/tutorial/", "https://docs.python.org/3/library/asyncio.html"]);
    expect(get).toHaveBeenCalledTimes(2);
  });
  it("preserves an explicit provider date without inferring one for undated hits", async () => {
    get.mockResolvedValue({ data: { results: [{ ...result(), publishedDate: "2026-11-15T11:00:00Z" }, result("https://docs.python.org/3/library/")] } });
    const results = await searchSearxng("Python", options);
    expect(results[0]).toMatchObject({ date: "2026-11-15T11:00:00Z", publishedDate: "2026-11-15T11:00:00Z" });
    expect(results[1]).not.toHaveProperty("date"); expect(results[1]).not.toHaveProperty("publishedDate");
  });
  it("can retain a date from a duplicate without spending a result slot", async () => {
    get.mockResolvedValue({ data: { results: [result(), { ...result(), published_date: "2026-11-15" }, result("https://docs.python.org/3/library/")] } });
    const results = await searchSearxng("Python", options);
    expect(results).toHaveLength(2); expect(results[0].publishedDate).toBe("2026-11-15");
  });
  it.each(["yesterday", "2026-99-11", "2026-02-30"])("does not invent or normalize a provider's invalid date %s", async date => {
    get.mockResolvedValue({ data: { results: [{ ...result(), publishedDate: date }] } });
    const results = await searchSearxng("Python", { ...options, numResults: 1 });
    expect(results[0]).not.toHaveProperty("date");
  });
});
