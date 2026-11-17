import { config } from "../config";
import { logger } from "../lib/logger";
import { searchSearxng } from "./searxngClient";

interface SearchOptions {
  tbs?: string; filter?: string; lang?: string; country?: string; location?: string;
  num_results: number; page?: number;
}
export async function searxng_search(q: string, options: SearchOptions) {
  const results = await searchSearxng(q, {
    endpoint: config.SEARXNG_ENDPOINT!, engines: config.SEARXNG_ENGINES,
    categories: config.SEARXNG_CATEGORIES, language: options.lang,
    numResults: options.num_results, page: options.page,
    onPartialFailure: count => logger.warn("Local search returned partial engine results", { failedEngines: count }),
  });
  return results;
}
