vi.mock("../config", () => ({ config: { SEARXNG_ENDPOINT: "http://searxng:8080", FIRE_ENGINE_BETA_URL: "https://cloud.invalid" } }));
vi.mock("../lib/logger", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../lib/retry-utils", () => ({ executeWithRetry: vi.fn(), attemptRequest: vi.fn() }));
vi.mock("@sentry/node", () => ({}));
vi.mock("./searxngClient", async () => ({
  ...await vi.importActual<typeof import("./searxngClient")>("./searxngClient"),
  searchSearxng: vi.fn(),
}));
import { fireEngineMap } from "./fireEngine";
import { searchSearxng } from "./searxngClient";
const localSearch = vi.mocked(searchSearxng);
beforeEach(() => { vi.clearAllMocks(); localSearch.mockResolvedValue([]); });
it("normalizes a legacy protocol site operator to one canonical scope", async () => {
  await fireEngineMap("site:https://docs.python.org/3/", { numResults: 5, mapScope: "https://docs.python.org/3/" });
  expect(localSearch.mock.calls[0][0]).toBe("site:docs.python.org/3/");
  expect(localSearch.mock.calls[0][0].match(/site:/gi)).toHaveLength(1);
});
it("preserves human search terms while replacing all supplied site operators", async () => {
  await fireEngineMap("asyncio tutorial site:evil.org -site:other.org site:https://docs.python.org/3/", { numResults: 5, mapScope: "https://docs.python.org/3/" });
  expect(localSearch.mock.calls[0][0]).toBe("asyncio tutorial site:docs.python.org/3/");
});
it("enforces the actual target host and path on returned provider links", async () => {
  localSearch.mockResolvedValue([
    { url: "https://docs.python.org/3/library/", title: "Python", description: "Allowed" },
    { url: "https://docs.python.org/3bad/", title: "Wrong path", description: "Wrong" },
    { url: "https://evil.org/3/", title: "Wrong host", description: "Wrong" },
  ] as any);
  const result = await fireEngineMap("site:evil.org", { numResults: 5, mapScope: "https://docs.python.org/3/" });
  expect(result.map(item => item.url)).toEqual(["https://docs.python.org/3/library/"]);
});
