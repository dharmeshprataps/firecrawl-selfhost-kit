import axios from "axios";
import IPAddr from "ipaddr.js";
import type { SearchResult } from "../lib/entities";

export class SearchProviderError extends Error {
  readonly code = "SEARCH_PROVIDER_UNAVAILABLE";
  readonly status = 503;
  constructor(message = "The configured local search provider is unavailable.") {
    super(message); this.name = "SearchProviderError";
  }
}

export class SearchCapabilityError extends Error {
  readonly code = "SEARCH_CAPABILITY_UNAVAILABLE";
  readonly status = 501;
  constructor(message: string) { super(message); this.name = "SearchCapabilityError"; }
}

/** Results are links, not fetch targets; the scraper independently checks DNS/redirects. */
export function publicSearchUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
    if (IPAddr.isValid(host)) {
      let address = IPAddr.parse(host);
      if (address.kind() === "ipv6" && (address as IPAddr.IPv6).isIPv4MappedAddress()) {
        address = (address as IPAddr.IPv6).toIPv4Address();
      }
      if (address.range() !== "unicast") return null;
    } else if (!host.includes(".") || /(^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(host)) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

export function inMapScope(candidate: string, scope: URL): boolean {
  const url = new URL(candidate);
  const hostname = scope.hostname.toLowerCase().replace(/^www\./, "");
  const candidateHost = url.hostname.toLowerCase().replace(/^www\./, "");
  if (candidateHost !== hostname && !candidateHost.endsWith("." + hostname)) return false;
  const path = scope.pathname.replace(/\/$/, "");
  return !path || url.pathname === path || url.pathname.startsWith(path + "/");
}

export function mapSearchScope(query: string): URL | null {
  const target = query.match(/(?:^|\s)site:([^\s]+)/i)?.[1];
  if (!target) return null;
  const normalized = publicSearchUrl(/^https?:\/\//i.test(target) ? target : "https://" + target);
  return normalized ? new URL(normalized) : null;
}

/** Conservative retrieval identity: never merge different versions or semantic query values. */
export function canonicalSearchUrl(value: unknown): string | null {
  const safe = publicSearchUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(gclid|fbclid|msclkid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
  }
  // Python's Sphinx highlight query changes highlighting, not the document.
  if (url.hostname === "docs.python.org") {
    url.protocol = "https:";
    url.searchParams.delete("highlight");
    url.pathname = url.pathname.replace(/\/index\.html$/, "/");
  }
  return url.toString();
}

function providerPublicationDate(item: any): string | undefined {
  const value = item?.publishedDate ?? item?.published_date;
  if (typeof value !== "string" || value.length > 64 || !/^\d{4}-\d{2}-\d{2}(?:T[0-9:.+-]+Z?)?$/.test(value)) return undefined;
  if (!Number.isFinite(Date.parse(value))) return undefined;
  const calendarDate = new Date(value.slice(0, 10) + "T00:00:00Z");
  return Number.isFinite(calendarDate.getTime()) && calendarDate.toISOString().slice(0, 10) === value.slice(0, 10) ? value : undefined;
}

export interface SearxngOptions {
  endpoint: string; engines?: string; categories?: string; language?: string;
  numResults: number; page?: number; signal?: AbortSignal; timeoutMs?: number;
  onPartialFailure?: (count: number) => void;
}

/** A configured provider is authoritative: an outage must never switch providers. */
export async function searchSearxng(query: string, options: SearxngOptions): Promise<SearchResult[]> {
  const limit = Math.max(0, Math.min(100, Math.floor(options.numResults)));
  if (!limit) return [];
  const deadlineMs = Math.min(15000, Math.max(1, options.timeoutMs ?? 15000));
  const started = Date.now();
  const seen = new Map<string, SearchResult>();
  const results: SearchResult[] = [];
  const endpoint = options.endpoint.replace(/\/+$/, "") + "/search";
  try {
    const maxPages = Math.min(5, Math.max(2, Math.ceil(limit / 20) + 1));
    for (let offset = 0; offset < maxPages; offset++) {
      const remaining = deadlineMs - (Date.now() - started);
      if (remaining <= 0) throw new SearchProviderError();
      const response = await axios.get(endpoint, {
        params: { q: query, format: "json", language: options.language,
          engines: options.engines ?? "", categories: options.categories ?? "",
          pageno: Math.max(1, options.page ?? 1) + offset },
        timeout: remaining, signal: options.signal,
        maxContentLength: 2 * 1024 * 1024, maxBodyLength: 2 * 1024 * 1024,
        maxRedirects: 0, proxy: false,
        headers: { Accept: "application/json" },
      });
      const data = response.data;
      if (!data || !Array.isArray(data.results)) throw new SearchProviderError("The configured local search provider returned an invalid response.");
      const failures = Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines.length : 0;
      if (!data.results.length && failures) throw new SearchProviderError("The configured local search provider could not reach its search engines.");
      if (failures) options.onPartialFailure?.(failures);
      for (const item of data.results) {
        const url = canonicalSearchUrl(item?.url);
        if (!url) continue;
        const publishedDate = providerPublicationDate(item);
        const previous = seen.get(url);
        if (previous) {
          if (!previous.publishedDate && publishedDate) Object.assign(previous, { date: publishedDate, publishedDate });
          continue;
        }
        const result: SearchResult = { url, title: typeof item.title === "string" ? item.title.slice(0, 2000) : url,
          description: typeof item.content === "string" ? item.content.slice(0, 10000) : "",
          ...(publishedDate ? { date: publishedDate, publishedDate } : {}) } as SearchResult;
        seen.set(url, result);
        results.push(result);
        if (results.length >= limit) break;
      }
      if (!data.results.length || results.length >= limit) break;
      if (offset + 1 < maxPages) {
        // Space page requests politely while retaining one overall deadline.
        const pause = Math.min(2000, deadlineMs - (Date.now() - started));
        if (pause <= 0) throw new SearchProviderError();
        await new Promise(resolve => setTimeout(resolve, pause));
      }
    }
    return results;
  } catch (error) {
    // A later page may time out or lose engines after earlier pages succeeded.
    // Preserve those verified links rather than report an entirely failed query.
    if (results.length > 0) {
      options.onPartialFailure?.(1);
      return results;
    }
    if (error instanceof SearchProviderError) throw error;
    // Do not include provider URL, query, response body, or credentials in errors.
    throw new SearchProviderError();
  }
}
