import { load } from "cheerio";

/**
 * Attribute selectors need source head metadata that content cleaning removes.
 * Restore only that head in a temporary DOM. The cleaned body retains selected
 * content and normalized URLs; neither returned HTML string is modified.
 */
export function attributeLookupHtml(html: string, rawHtml?: string): string {
  if (rawHtml === undefined || !rawHtml.trim() || rawHtml === html) return html;

  const source = load(rawHtml);
  const lookup = load(html);
  lookup("head").first().empty().append(source("head").first().contents().clone());
  return lookup.html();
}
