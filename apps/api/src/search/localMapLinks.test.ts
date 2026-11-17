vi.mock("undici", () => ({ fetch: vi.fn() }));
vi.mock("../scraper/scrapeURL/engines/utils/safeFetch", () => ({ getSecureDispatcher: () => "reviewed-secure-dispatcher" }));
import { fetch } from "undici";
import { discoverMapLinks } from "./localMapLinks";
const mockedFetch = vi.mocked(fetch);
const url = "https://docs.python.org/3/tutorial/";
const extractLinks = vi.fn();
const run = (extra = {}) => discoverMapLinks({ url, limit: 5, includeSubdomains: false, filterByPath: true, signal: new AbortController().signal, extractLinks, ...extra });
function response(text = "<a href='intro.html'>Intro</a>", options = {}) {
  const r = new Response(text, { headers: { "content-type": "text/html" }, ...options });
  Object.defineProperty(r, "url", { value: url, configurable: true }); return r as any;
}
beforeEach(() => { vi.clearAllMocks(); mockedFetch.mockResolvedValue(response()); extractLinks.mockResolvedValue(["intro.html"]); });
it("uses the reviewed secure dispatcher, strict deadline, and returns scoped public HTML links", async () => {
  extractLinks.mockResolvedValue(["intro.html", "intro.html#same", "http://127.0.0.1/", "https://evil.org/", "../library/"]);
  expect(await run()).toEqual([{ url: url + "intro.html" }]);
  expect(mockedFetch).toHaveBeenCalledWith(url, expect.objectContaining({ dispatcher: "reviewed-secure-dispatcher", redirect: "follow", signal: expect.any(AbortSignal) }));
});
it("limits returned URLs and refuses private input without any request", async () => {
  extractLinks.mockResolvedValue(["intro.html", "controlflow.html"]);
  expect(await run({ limit: 1 })).toHaveLength(1);
  vi.clearAllMocks(); expect(await run({ url: "http://127.0.0.1/" })).toEqual([]); expect(mockedFetch).not.toHaveBeenCalled();
});
it.each([404, 503])("does not call a failed HTTP %s response useful content", async status => {
  mockedFetch.mockResolvedValue(response("Page not found", { status }));
  expect(await run()).toEqual([]); expect(extractLinks).not.toHaveBeenCalled();
});
it("refuses non-HTML responses and bodies larger than the actual byte limit", async () => {
  mockedFetch.mockResolvedValue(response("pdf", { headers: { "content-type": "application/pdf" } }));
  expect(await run()).toEqual([]);
  mockedFetch.mockResolvedValue(response("x".repeat(1048577)));
  expect(await run()).toEqual([]); expect(extractLinks).not.toHaveBeenCalled();
});
it("does not use a redirect that leaves the requested public scope", async () => {
  const r = response(); Object.defineProperty(r, "url", { value: "https://evil.org/", configurable: true });
  mockedFetch.mockResolvedValue(r); expect(await run()).toEqual([]); expect(extractLinks).not.toHaveBeenCalled();
});
