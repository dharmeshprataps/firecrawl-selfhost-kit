import { fetch } from "undici";
import { getSecureDispatcher } from "../scraper/scrapeURL/engines/utils/safeFetch";
import { canonicalSearchUrl, inMapScope, publicSearchUrl } from "./searxngClient";

/** One bounded, SSRF-protected seed-page read. This discovers links; it is not a crawl. */
export async function discoverMapLinks({ url, limit, includeSubdomains, filterByPath, signal, headers, extractLinks }: {
  url: string; limit: number; includeSubdomains: boolean; filterByPath: boolean;
  signal: AbortSignal; headers?: Record<string, string>;
  extractLinks: (html: string, baseUrl: string) => Promise<string[]>;
}): Promise<{ url: string }[]> {
  if (!publicSearchUrl(url)) return [];
  const scope = new URL(url);
  if (!filterByPath) scope.pathname = "/";
  const permitted = (value: string) => {
    if (!inMapScope(value, scope)) return false;
    return includeSubdomains || new URL(value).hostname.replace(/^www\./, "") === scope.hostname.replace(/^www\./, "");
  };
  const response = await fetch(url, {
    dispatcher: getSecureDispatcher(false), redirect: "follow",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    headers: { Accept: "text/html, application/xhtml+xml", ...headers },
  });
  const finalUrl = publicSearchUrl(response.url);
  const type = response.headers.get("content-type") ?? "";
  const length = Number(response.headers.get("content-length"));
  if (!response.ok || !finalUrl || !permitted(finalUrl) || !/text\/html|application\/xhtml\+xml/i.test(type) || length > 1048576) {
    await response.body?.cancel(); return [];
  }
  const reader = response.body?.getReader();
  if (!reader) return [];
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 1048576) { await reader.cancel(); return []; }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const found = await extractLinks(Buffer.concat(chunks).toString("utf8"), finalUrl);
  const result: { url: string }[] = [], seen = new Set<string>();
  for (const value of found.slice(0, 1000)) {
    let absolute: string; try { absolute = new URL(value, finalUrl).href; } catch { continue; }
    const safe = canonicalSearchUrl(absolute);
    if (!safe || !permitted(safe) || seen.has(safe)) continue;
    seen.add(safe); result.push({ url: safe });
    if (result.length >= Math.min(limit, 100)) break;
  }
  return result;
}
