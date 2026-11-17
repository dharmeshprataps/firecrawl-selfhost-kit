# Capabilities and limits

| Area | Included behavior | Boundary |
| --- | --- | --- |
| Page retrieval | Markdown, HTML, raw HTML, links, images | Sites may block requests or return partial content |
| Browser rendering | Native headless Chromium; interactive actions | No promise of hosted anti-bot/proxy behavior |
| PDFs | Native-text extraction and page limits | OCR/scanned PDFs are not validated |
| MCP page reads | `local_web_read`, honestly marked read-only | Actions, profiles, sessions, headers and provider options rejected |
| Browser actions | Existing `firecrawl_scrape` | Client may serialize interactive calls |
| Batches | Two-to-five known Markdown URLs; per-page failures | Bounded concurrency and output |
| Remote crawls | One-to-five pages per job | Hosted-scale crawls not promised |
| Mapping | Sitemaps/links, explicit partial/provider errors | Search engines and sites can be unavailable |
| Search | Optional keyless SearXNG | Search quality/availability depends on upstream engines |
| JSON extraction | Supported deterministic financial requests; optional local model | Not every schema/transformation is supported |
| Website monitors | Manual checks, hashes and bounded excerpts | No scheduler, email or push delivery in monitor tools |
| Remote connection | Optional OAuth + PKCE gateway for your own domain | No shared account, private App binding or public raw API |

The read-only tool uses the pinned official MCP scrape implementation while enforcing explicit input boundaries. It preserves PDF options, cache controls, expected-content checks and screenshot image blocks. The interactive tool remains available with its original action contract.

Numerical extraction must identify the source row, column, period and unit. Supported crore-to-rupee conversions multiply source cells by 10,000,000 and include exact transformation evidence. Unsupported arithmetic is rejected rather than reported as verified. A valid JSON schema does not by itself prove factual correctness.

The maintainer's pre-release setup exercised ordinary/static and JavaScript pages, native-text PDFs, screenshots, browser actions and bounded crawls. It also demonstrated two simultaneous ordinary reader calls through an authenticated connected client. Those observations are not a benchmark for every machine, a guarantee that clients dispatch calls in parallel, or a claim of parity with Firecrawl Cloud. This release includes reproducible source tests; historical private reports and account-specific evidence are intentionally not distributed.

Known gaps include difficult anti-bot/live-market pages, OCR, persistent hosted-style browser sessions, premium proxies, commercial enrichment, hosted research indexes and long-duration reliability across arbitrary sites. Some pages retain navigation or omit dynamic prices. Use expected-content checks and inspect important source data.
