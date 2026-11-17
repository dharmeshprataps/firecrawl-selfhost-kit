# Testing and release validation

This project separates source regressions, deterministic service acceptance and live-site acceptance. A healthy container or a schema-valid JSON response is not sufficient evidence that a page was retrieved correctly.

The public-release source check completed with **130 framework tests passing**: 6 configuration tests, 51 adapter tests, 22 correctness/maintenance tests and 51 Node tests. The standalone financial contract assertions also passed. These counts describe the public source snapshot; they are not a count of live pages scraped.

The full public Docker build, live service acceptance and hosted Firecrawl comparison were **not rerun for this publication**. Earlier installation work validated the underlying deployment on Apple Silicon macOS. This publication makes paths and configuration reusable, but does not establish a clean-install result on every Mac. Linux and Intel Mac deployment remain unvalidated. Running the portable source tests on Linux CI does not change that deployment-support boundary.

## Reproduce the source checks

Use Python 3.11+, Git, Node 24 and npm from a clean clone. This command does not require Docker, a running Firecrawl API, a public domain, provider credentials or a local model:

```sh
mkdir -p .local-state/remote-gateway
cp local-remote/package.json local-remote/package-lock.json .local-state/remote-gateway/
npm ci --ignore-scripts --prefix .local-state/remote-gateway
python3 local-ops/check-source.py
```

The same sequence is configured in [the source workflow](../.github/workflows/source.yml). Its dependencies are locked; the workflow has read-only repository permissions. Tests use temporary files, simulated subprocesses and temporary loopback HTTP listeners. The test environment must permit those listeners. A denied socket permission is an environment failure, not evidence that an assertion failed; repeat the complete check in a permitted environment instead of silently skipping the affected tests.

`check-source.py` also parses Python/JSON/plist/TOML files, checks Bash and JavaScript syntax, runs `git diff --check`, exercises the financial contract helper and inspects a tracked-source backup. The backup check rejects private state, installed dependencies, generated credentials and benchmark output. It does not require the maintainer's private history or an archived handoff bundle.

To run one layer while developing:

```sh
python3 -m unittest discover -s local-ops/tests -v
python3 -m unittest discover -s local-plugin/tests -v
python3 -m unittest discover -s local-ops/remote/tests -v
node --test local-remote/auth.test.mjs local-remote/tests/*.test.mjs
node local-ops/check-grounding.mjs
```

Run the complete source check before a release. A small test selection is useful while making a change, but does not replace the complete check.

## Source coverage register

Counts below are framework test cases, not assertions, HTTP requests or benchmark attempts.

| File | Cases | Behavior checked |
| --- | ---: | --- |
| `local-ops/tests/test_public_configuration.py` | 6 | Fresh private configuration, independent generated secrets, secret preservation on rerun, explicit/canonical public-domain configuration, restrictive permissions, symlink rejection, checkout/home path rendering and source backup without private history |
| `local-plugin/tests/test_companion_tools.py` | 22 | Batch validation, public URL rules, bounded parallel batches, exact cache/timeout controls, per-page HTTP failures, incomplete-content detection, typed provider failures, attribute retrieval and bounded output |
| `local-plugin/tests/test_dispatch.py` | 2 | Independent work overlaps within its limit; queue bounds and failed-operation capacity release |
| `local-plugin/tests/test_local_tools.py` | 7 | Manual monitor definitions, bounded history/excerpts, persistence and deletion, pause/lock behavior, last-success preservation and fixed local routes |
| `local-plugin/tests/test_proxy_protocol.py` | 9 | Real wrapper protocol routing, independent IDs, concurrent local operations, PDF option normalization, readiness-option removal before the official SDK and typed map errors/partial results |
| `local-plugin/tests/test_read_only_scrape.py` | 11 | Truthful read-only catalogue, strict option/nested-value boundaries, schema keys treated as data, no hidden writes, official-scrape alias routing, full-format forwarding, image-block retention and out-of-order IDs |
| `local-ops/remote/tests/test_correctness.py` | 12 | Source row/column evidence, exact rupee transformations, mixed field units, unsupported/ambiguous arithmetic, code fidelity, incomplete rendered content and detection of PDF page leakage |
| `local-ops/remote/tests/test_fixture_runner.py` | 10 | Maintenance lock, gateway shutdown before fixtures, production restoration on success/failure/interruption, runtime checks before restart, and leaving the gateway stopped when restoration is uncertain |
| `local-remote/auth.test.mjs` | 14 | OAuth discovery/resource binding, registered callback restrictions, owner consent/CSRF, login lockout, PKCE/code expiry, rotating refresh tokens, replay revocation, hashed private state and malformed-request rejection |
| `local-remote/tests/bridge.test.mjs` | 5 | Single initialization, independent RPC correlation, bounded pending work, deadline/child-exit recovery, response-size limits and stderr privacy |
| `local-remote/tests/config.test.mjs` | 2 | Explicit canonical HTTPS configuration and a validated Docker executable/context without shell interpolation |
| `local-remote/tests/gateway.test.mjs` | 26 | Auth before parsing, exact Host/Origin/resource boundaries, explicit public configuration, the 18-tool catalogue, private-target rejection, read-only options, independent IDs, request/output bounds, rate limits, two active/four queued calls, slow queues, expiry without dispatch and safe timing metadata |
| `local-remote/tests/metrics.test.mjs` | 4 | Timing-field allowlist, credential/body exclusion, bounded rotation and enumerated queue outcomes |
| **Total** | **130** | **Source regressions; no production scraping implied** |

### Financial contract assertions

`local-ops/check-grounding.mjs` imports the actual production helper in `apps/api/src/lib/grounded-quarterly.ts`. It runs against a captured public quarterly table, rather than a model's recollection of numbers. It checks:

- Exact latest/previous period selection and six source facts.
- Matching row and column evidence, reporting basis and source units.
- Four exact crore-to-rupee multiplications by 10,000,000, with safe numeric ranges and conversion metadata.
- Rejection of unsupported arithmetic, missing tables and unsupported numbers/currencies.
- Explicit evidence for a nullable field whose requested row is absent.

The request fixture contains **10 request contracts: nine successful answers and one expected unavailable-energy-cost rejection**. Q083 and Q084 preserve the explicit rupee-conversion prompts. This helper also makes other direct assertions. These are a separate assertion program and are **not added to the 130 framework-test count**.

The captured values establish the transformation contract for that fixture. They are not current investment information or independent verification of company filings. General JSON extraction is not factually validated merely because it matches a schema.

## Deterministic service acceptance

These checks require built, running native services and intentionally change the API/browser configuration during a maintenance window. Do not run them on a busy service or directly enable fixture access while a remote gateway is serving callers.

First configure and start your own deployment using the repository README. Inspect the controlled maintenance procedure:

```sh
python3 local-ops/remote/run-fixture-tests --review
```

Review checks the merged production/test configurations and current runtime isolation; it does not recreate services. When ready for a maintenance window, select a suite explicitly:

```sh
python3 local-ops/remote/run-fixture-tests --suite smoke
python3 local-ops/remote/run-fixture-tests --suite acceptance
python3 local-ops/remote/run-fixture-tests --suite core
python3 local-ops/remote/run-fixture-tests --suite correctness
```

Each invocation obtains the maintenance lock, stops the remote gateway, confirms its listener is closed, enables only the exact private fixture origin for API and browser, runs the chosen suite, and restores production in `finally`. Restoration checks both runtime fixture settings, the production configuration and the production heartbeat before restarting a gateway that was previously loaded. If restoration cannot be verified, the gateway remains stopped for inspection. A gateway that was already stopped is not enabled by the test.

The `extract` suite is optional and requires the reviewed local inference provider:

```sh
python3 local-ops/remote/run-fixture-tests --suite extract
```

Do not call the fixture-facing scripts directly to bypass that maintenance sequence. The private fixture hostname is intentionally denied during normal production operation.

| Register | Cases/inputs | Expected result |
| --- | --- | --- |
| `local-bench/cases/smoke-v1.json` | Static page, delayed JavaScript marker, v2 sitemap map | Useful static Markdown/metadata; delayed marker present and loading text absent; useful expected map URLs |
| `local-bench/cases/acceptance-v1.json` | 11 configured cases | Smoke behavior plus v1 mapping, a terminal five-page crawl, denied host/alternate port/userinfo/redirect targets and browser-subresource canaries |
| `local-bench/enhancement.py --suite core` | Formats/attributes, browser actions/screenshot, rejected action/private navigation, native-text PDF, batch job | Content/output checks and terminal job state, with blocked private navigation and untouched canaries |
| `local-bench/correctness.py` through the guarded runner | Financial tables/units/absence, code literals, multi-page PDF boundaries, mixed-success batch and content readiness | Correct facts and typed failures; page limits apply to returned content, not just metadata |
| `local-bench/enhancement.py --suite extract` through the guarded runner | Structured fixture and summary | Exact stated fixture facts and a bounded useful summary using the configured local provider |

These suites are present and their validation/maintenance logic is covered by source tests. Their Docker executions were not repeated for the public release snapshot. A successful source test for the runner is not a claim that a real scrape or container recreation occurred.

## Public-page MCP acceptance

After building your deployment and installing the pinned local MCP runtime, this acceptance command uses the checkout launcher and public pages; it does not enable private fixture access:

```sh
node local-bench/verify-read-only.mjs \
  --launcher "$PWD/local-plugin/bin/firecrawl-mcp"
```

Run it without unrelated MCP/API traffic so its negative-dispatch observation can be interpreted correctly. The nine checks are:

| Check | Pass condition |
| --- | --- |
| Catalogue and contracts | Exactly 18 reviewed tools; `local_web_read` is read-only and rejects unreviewed options; the interactive scraper remains action-capable |
| Readiness | Local service reports ready with Cloud fallback disabled |
| Four independent reads | Python, React, MDN and Firecrawl documentation all contain expected content; calls launch together with independent results and available local timing metadata |
| Formats and readiness | Useful Markdown, HTML, raw HTML, links and an images array; the required page text is checked explicitly |
| PDF page limit | Bitcoin PDF reports two processed pages out of nine; later section headings are absent from returned Markdown |
| Q084 financial conversion | Latest two returned table columns match JSON; all four amounts equal their source crore cells × 10,000,000, with row/column/unit proof |
| Screenshot | A real bounded JPEG image block is returned and saved privately; a human still needs to inspect it |
| Negative reads | Actions, profiles, headers and a private URL are rejected. Zero local API dispatch is required when the request trace is available |
| Interactive compatibility | The existing scraper follows Python's Next link, returns the expected final URL and retrieves its content |

The negative check explicitly records whether trace observation was available. If it was unavailable, report **dispatch count unverified**, not “zero requests observed.” The screenshot result starts with a pending visual-review field; a green automated result does not replace inspecting the actual image.

The four documentation requests use `formats:["markdown"]`, `onlyMainContent:true`, `maxAge:0` and `timeout:45000`, omitting `storeInCache`. They preserve canonical argument hashes for comparison. Requested fresh-fetch controls do not independently prove an origin/cache miss. Live source pages can change, block retrieval, move a selector or return different content, so inspect failures instead of automatically weakening expected-content checks.

This tests local stdio MCP. To establish behavior in a remote MCP client, run an equivalent independent-call wave through that client and correlate it with gateway records. Record caller wall time separately from gateway queue/service time. Client reasoning and dispatch can serialize work before it reaches this Mac. The gateway permits two active calls and four waiting slots; the 60-second queue wait and separate 90-second execution deadline do not guarantee a particular throughput or client timeout.

## Production heartbeat, persistence and resources

The production heartbeat can run without the fixture exception:

```sh
python3 local-bench/production-heartbeat.py
```

It checks readiness, useful content from a public Python documentation page and rejection of a private fixture target, including a canary audit. It is deliberately smaller than full acceptance. Installing the optional two-hour launchd heartbeat is a separate action after path review and a successful manual run; source checks do not install it or send notifications.

State and resource checks are also separate from readiness:

```sh
# Read-only snapshot of the deployment and its current resource use.
python3 local-bench/verify_state.py --snapshot

# Bounded sampler; use a new output filename for each run.
python3 local-bench/resource-sample.py --seconds 240 --interval 5 \
  --output local-bench/var/resources/run-001.jsonl
```

`verify_state.py` **without** `--snapshot` is a disruptive acceptance operation: it creates temporary PostgreSQL/Redis/RabbitMQ probes, stops/starts the stack, force-recreates containers, checks persistent data and named mounts, then cleans up its probes. An optional `--crawl-id ID` additionally checks a completed crawl with at least three returned documents. Review that operation, take an appropriate backup and reserve a maintenance window before running it. These persistence/recreation checks were not rerun for the public snapshot.

For resource claims, record machine/runtime configuration, workload and cache options, concurrent request count, sampling interval, queue depth, browser activity, CPU/RAM, restarts and OOM state. A single idle snapshot cannot establish that RAM or CPU is sufficient under load. Matching memory ceilings do not establish matching hosted throughput.

## Live corpus, intended cases and remaining boundaries

`local-bench/corpus/live-v1.json` is **disabled and empty by default**. Its admission checklist requires a public, unauthenticated/non-paywalled target, reviewed robots/terms status, page/depth caps and per-domain pacing. It is scaffolding for a consciously selected live corpus, not an executed benchmark.

`local-bench/cases/prompt-matrix-v1.json` records ten intended natural-language routing cases, including unsupported login/CAPTCHA and destructive requests. It reflects the read-only reader routing, but has no automated client/model runner in this release. Treat it as a planning register, not evidence that prompt routing or a ChatGPT integration passed.

Use the following release register when collecting results on a new machine:

| Area | Required evidence | Release boundary |
| --- | --- | --- |
| Startup | Native image build, services running and readiness response | Not rebuilt from the public snapshot during publication |
| Retrieval | Static content/metadata, JavaScript marker, native-text PDF and screenshot | Source contracts covered; rerun service acceptance locally |
| Jobs | Three-to-five-page crawl reaches a terminal state; useful map URLs | Health alone is insufficient; provider-dependent mapping may be partial |
| Correctness | Source-grounded financial cells/units, PDF content boundaries, literal code and typed batch failures | Supported deterministic contracts only; arbitrary model extraction remains unverified |
| Parallelism | Independent calls, caller timings and overlapping gateway/service intervals | Two active requests are bounded capacity, not hosted-parity performance |
| Persistence | Same data and named mounts after stop/start and recreation | Requires disruptive maintenance test |
| Optional providers | Explicit local search/inference availability and provider-specific checks | Missing provider is a blocked/unsupported result; no Cloud fallback |
| Remote client | OAuth connection and real client calls against the operator's own gateway | No private maintainer App/account binding is included |
| Longer-term operation | Repeated heartbeat results, resource samples, restarts/OOM and failure recovery | Two-hour scheduling and long-duration reliability must be established by the operator |

Anti-bot retrieval success on sites such as live exchanges or government portals is not guaranteed. OCR/scanned PDFs, persistent hosted-style browser sessions, commercial enrichment and hosted research indexes are not established by this suite. A site returning a loading placeholder must be reported incomplete even if HTTP status is 200.

## Evidence privacy and reporting failures

Generated state and evidence belong under ignored `.local-state/` and `local-bench/var/`, not in a public commit. The read-only acceptance report is written beneath `local-bench/var/readonly-deployment/acceptance/`; its screenshot is a private local artifact. Other suites create private run summaries/reports under `local-bench/var/`.

Record the revision, versions, command/options, timestamp, pass/fail/blocked/untested status, typed error/check identifier, content hashes/counts and the relevant timing scope. Distinguish an expected negative rejection from an unexpected failure and an unavailable provider from an invalid request. Keep repeated attempts distinct; do not replace a failed first run with a successful retry.

Review evidence before sharing it. Do not publish credentials, OAuth tokens/cookies, owner-password files, complete environment or interpolated Compose output, personal paths, raw private documents or unrestricted page bodies. Some manual diagnostics contain machine paths or public source facts even when secrets are excluded. Share a small sanitized reproducer and the minimum source content needed to explain a defect. Never infer factual correctness from JSON validity or resource capacity from container health alone.

The [release validation record](testing/release-validation.json), [sanitized source-check log](testing/source-check.log), [fresh configuration review](testing/fresh-configuration.json), and [historical live summary](testing/historical-live-summary.json) are included with this release. Historical attempts include failures and quota blocks and are not added to the source-test total.
