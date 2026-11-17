import { config } from "../config";
import { SearchResult } from "../../src/lib/entities";
import * as Sentry from "@sentry/node";
import { logger } from "../lib/logger";
import { executeWithRetry, attemptRequest } from "../lib/retry-utils";

import { searchSearxng, mapSearchScope, inMapScope } from "./searxngClient";

const useFireEngine =
  config.FIRE_ENGINE_BETA_URL !== "" &&
  config.FIRE_ENGINE_BETA_URL !== undefined;

function hasResults(results: unknown): results is SearchResult[] {
  return Array.isArray(results) && results.length > 0;
}

export async function fire_engine_search(
  q: string,
  options: {
    tbs?: string;
    filter?: string;
    lang?: string;
    country?: string;
    location?: string;
    numResults: number;
    page?: number;
  },
  abort?: AbortSignal,
): Promise<SearchResult[]> {
  if (!useFireEngine) {
    return [];
  }

  const payload = {
    query: q,
    lang: options.lang,
    country: options.country,
    location: options.location,
    tbs: options.tbs,
    numResults: options.numResults,
    page: options.page ?? 1,
  };

  const url = `${config.FIRE_ENGINE_BETA_URL}/search`;
  const data = JSON.stringify(payload);

  const result = await executeWithRetry<SearchResult[]>(
    () => attemptRequest<SearchResult[]>(url, data, abort),
    hasResults,
    abort,
  );

  return result ?? [];
}

export async function fireEngineMap(
  q: string,
  options: {
    tbs?: string;
    filter?: string;
    lang?: string;
    country?: string;
    location?: string;
    numResults: number;
    page?: number;
    mapScope?: string;
  },
  abort?: AbortSignal,
): Promise<SearchResult[]> {
  if (config.SEARXNG_ENDPOINT) {
    const scope = mapSearchScope(options.mapScope ? `site:${options.mapScope}` : q);
    // Map requests without a site operator are not a license for unbounded discovery.
    if (!scope) return [];
    const queryText = q.replace(/(?:^|\s)-?site:\S+/gi, " ").replace(/\s+/g, " ").trim();
    const scopedQuery = `${queryText ? queryText + " " : ""}site:${scope.hostname}${scope.pathname}`;
    const results = await searchSearxng(scopedQuery, {
      endpoint: config.SEARXNG_ENDPOINT, engines: config.SEARXNG_ENGINES,
      categories: config.SEARXNG_CATEGORIES, language: options.lang,
      numResults: options.numResults, page: options.page, signal: abort,
      onPartialFailure: count => logger.warn("Local map returned partial engine results", { failedEngines: count }),
    });
    return results.filter(result => inMapScope(result.url, scope));
  }
  if (!useFireEngine) {
    logger.warn(
      "(v1/map Beta) Results might differ from cloud offering currently.",
    );
    return [];
  }

  const payload = {
    query: q,
    lang: options.lang,
    country: options.country,
    location: options.location,
    tbs: options.tbs,
    numResults: options.numResults,
    page: options.page ?? 1,
  };

  const url = `${config.FIRE_ENGINE_BETA_URL}/map`;
  const data = JSON.stringify(payload);

  const result = await executeWithRetry<SearchResult[]>(
    () => attemptRequest<SearchResult[]>(url, data, abort),
    hasResults,
    abort,
  );

  return result ?? [];
}
