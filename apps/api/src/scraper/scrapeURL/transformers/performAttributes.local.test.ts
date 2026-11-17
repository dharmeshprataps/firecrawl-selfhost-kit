import { beforeEach, describe, expect, it, vi } from "vitest";
import { load } from "cheerio";
import { transformHtml } from "@mendable/firecrawl-rs";
import { attributeLookupHtml } from "../lib/attributeLookupHtml";
import { extractAttributes } from "../lib/extractAttributes";
import { performAttributes } from "./performAttributes";

const state = vi.hoisted(() => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../lib/logger", () => ({ logger: state.logger }));

const url = "https://docs.python.org/3/tutorial/appetite.html";
const next = "https://docs.python.org/3/tutorial/interpreter.html";
const raw = '<!doctype html><html lang="fr" data-page="source"><head>' +
  '<title>Source title</title><meta property="og:title" content="1. Whetting Your Appetite">' +
  '<link rel="canonical" href="' + url + '"></head><body>' +
  '<main id="article"><h1>Visible article</h1><a accesskey="N" href="interpreter.html">Next</a>' +
  '<p id="kept" data-value="42">Useful content.</p><p id="excluded" data-value="99">Excluded.</p></main>' +
  '<nav><a id="outside" href="outside.html">Navigation</a></nav></body></html>';
const cleaned = '<!doctype html><html lang="en" data-page="cleaned"><head><title>Stale cleaned title</title></head>' +
  '<body><main id="article"><h1>Visible article</h1><a accesskey="N" href="' + next + '">Next</a>' +
  '<p id="kept" data-value="42">Useful content.</p></main></body></html>';
const selectors = [
  { selector: "html", attribute: "lang" },
  { selector: 'meta[property="og:title"]', attribute: "content" },
  { selector: 'link[rel="canonical"]', attribute: "href" },
  { selector: 'a[accesskey="N"]', attribute: "href" },
  { selector: "#kept", attribute: "data-value" },
  { selector: "#excluded", attribute: "data-value" },
  { selector: "#outside", attribute: "href" },
];
const meta = () => ({ url, logger: state.logger, options: { formats: [{ type: "attributes", selectors }] } } as any);

beforeEach(() => vi.clearAllMocks());

describe("source head attributes over the cleaned body", () => {
  it("restores exact og:title/canonical while preserving HTML language, absolute next href, and exclusions", async () => {
    const document: any = { html: cleaned, rawHtml: raw, metadata: { url }, markdown: "Unchanged Markdown" };
    const result = await performAttributes(meta(), document);
    expect(result).toBe(document);
    expect(result.attributes).toEqual(selectors.map((selector, index) => ({ ...selector,
      values: [["en"], ["1. Whetting Your Appetite"], [url], [next], ["42"], [], []][index] })));
    expect(result.html).toBe(cleaned);
    expect(result.rawHtml).toBe(raw);
    expect(result.markdown).toBe("Unchanged Markdown");
    expect(state.logger.warn).not.toHaveBeenCalled();
    expect(state.logger.error).not.toHaveBeenCalled();
  });

  it("replaces head contents instead of duplicating old metadata, and is idempotent", () => {
    const initial = cleaned.replace("<title>Stale cleaned title</title>",
      '<title>Old</title><meta property="og:title" content="Old"><link rel="canonical" href="/old">');
    const lookup = attributeLookupHtml(initial, raw);
    const repeated = attributeLookupHtml(lookup, raw);
    for (const html of [lookup, repeated]) {
      const $ = load(html);
      expect($("head")).toHaveLength(1);
      expect($("head title").text()).toBe("Source title");
      expect($('head meta[property="og:title"]')).toHaveLength(1);
      expect($('head link[rel="canonical"]')).toHaveLength(1);
      expect($("html").attr("data-page")).toBe("cleaned");
      expect($("#excluded, #outside")).toHaveLength(0);
      expect($('a[accesskey="N"]').attr("href")).toBe(next);
    }
    expect(initial).toContain('content="Old"');
    expect(raw).toContain('lang="fr"');
  });

  it("keeps literal head attribute values, including relative URLs and entities decoded once", async () => {
    const source = '<html><head><meta property="og:title" content="A &amp; B &amp;lt;tag&amp;gt;">' +
      '<link rel="canonical" href="../canonical.html?x=1&amp;y=2"></head><body></body></html>';
    const values = await extractAttributes(attributeLookupHtml(cleaned, source), selectors.slice(1, 3));
    expect(values.map(item => item.values)).toEqual([["A & B &lt;tag&gt;"], ["../canonical.html?x=1&y=2"]]);
  });

  it("retains existing behavior and the exact lookup string when raw HTML is absent", async () => {
    expect(attributeLookupHtml(cleaned)).toBe(cleaned);
    const document: any = { html: cleaned, metadata: { url } };
    await performAttributes(meta(), document);
    expect(document.attributes.map((item: any) => item.values)).toEqual([["en"], [], [], [next], ["42"], [], []]);
    expect(document.html).toBe(cleaned);
    expect(document.rawHtml).toBeUndefined();
  });

  it("treats empty or whitespace-only raw HTML as unavailable without clearing an existing head", async () => {
    const retained = cleaned.replace("<title>Stale cleaned title</title>",
      '<meta property="og:title" content="Retained metadata"><link rel="canonical" href="/retained">');
    for (const source of ["", "  \n\t"]) {
      expect(attributeLookupHtml(retained, source)).toBe(retained);
      const document: any = { html: retained, rawHtml: source, metadata: { url } };
      await performAttributes(meta(), document);
      const bySelector = new Map(document.attributes.map((item: any) => [item.selector, item.values]));
      expect(bySelector.get('meta[property="og:title"]')).toEqual(["Retained metadata"]);
      expect(bySelector.get('link[rel="canonical"]')).toEqual(["/retained"]);
      expect(bySelector.get('a[accesskey="N"]')).toEqual([next]);
      expect(bySelector.get("#excluded")).toEqual([]);
      expect(document.html).toBe(retained);
      expect(document.rawHtml).toBe(source);
    }
  });

  it("restores metadata removed by the real native content cleaner without restoring filtered body nodes", async () => {
    const transformed = await transformHtml({ html: raw, url, onlyMainContent: true,
      includeTags: ["main#article"], excludeTags: ["#excluded"] });
    const $ = load(transformed);
    expect($('meta[property="og:title"], link[rel="canonical"], #excluded, #outside')).toHaveLength(0);
    const document: any = { html: transformed, rawHtml: raw, metadata: { url } };
    await performAttributes(meta(), document);
    const bySelector = new Map(document.attributes.map((item: any) => [item.selector, item.values]));
    expect(bySelector.get('meta[property="og:title"]')).toEqual(["1. Whetting Your Appetite"]);
    expect(bySelector.get('link[rel="canonical"]')).toEqual([url]);
    expect(bySelector.get("#kept")).toEqual(["42"]);
    expect(bySelector.get("#excluded")).toEqual([]);
    expect(bySelector.get("#outside")).toEqual([]);
    expect(document.html).toBe(transformed);
    expect(document.rawHtml).toBe(raw);
    expect(state.logger.error).not.toHaveBeenCalled();
  });

  it("does not run attribute lookup when the format is absent and preserves the existing ordering guard", async () => {
    const document: any = { rawHtml: raw };
    expect(await performAttributes({ ...meta(), options: { formats: [{ type: "markdown" }] } }, document)).toBe(document);
    await expect(performAttributes(meta(), document)).rejects.toThrow("html is undefined");
  });
});
