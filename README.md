> **Archived standalone snapshot.** Active development has moved to [the official upstream fork](https://github.com/dharmeshprataps/firecrawl-local-fork). Use its [self-hosting guide](https://github.com/dharmeshprataps/firecrawl-local-fork/blob/main/SELFHOST_KIT.md) and [testing details](https://github.com/dharmeshprataps/firecrawl-local-fork/blob/main/docs/TESTING.md). This repository preserves the historical v0.1.0 source, history and release.

# Firecrawl Self-host Kit

A community-maintained, local-first distribution of [Firecrawl](https://github.com/firecrawl/firecrawl). Run your own scraping API, browser renderer, search service and MCP tools on an Apple Silicon Mac.

This is an **unofficial project**, based on Firecrawl **v2.11.162**, commit `7666c1f9ae8720a6bba271e0f60b6a217f8a5210`. It is not the Firecrawl hosted service and does not promise hosted feature parity. Firecrawl itself is already open source; this repository publishes additional self-hosting configuration, correctness fixes, operations tools and MCP integration.

## What is included

- Full Firecrawl API and Playwright source, with PostgreSQL queues and persistent PostgreSQL, Redis and RabbitMQ storage. FoundationDB is excluded from the default stack.
- Markdown, HTML, raw HTML, links, images, native-text PDFs, screenshots, bounded crawls, mapping and browser actions.
- A separate read-only MCP reader, `local_web_read`, with interactive actions retained in `firecrawl_scrape`.
- Bounded parallel execution: two active remote calls, four waiting slots and a 60-second queue wait. Execution retains a separate 90-second deadline; clients may impose shorter timeouts.
- PDF page-limit enforcement, code preservation, per-page batch errors and explicit checks for missing expected content.
- Deterministic quarterly-table grounding and exact crore-to-rupee conversion for supported financial requests. Unsupported transformations fail explicitly; this is not a general financial accuracy guarantee.
- SearXNG search and optional local Ollama inference. No Firecrawl Cloud fallback, paid proxy or LLM API key is configured by this kit.
- Operations commands, backups, optional Mac login/heartbeat jobs, reproducible fixtures and regression tests.

## Supported environment

The tested deployment target is **macOS on Apple Silicon**, with a dedicated Colima profile named `firecrawl`: 4 CPUs, 10 GB RAM and a 30 GB disk on a 16 GB Mac. Containers build natively for `linux/arm64`.

Host tools: Git, curl, Python **3.11+**, Node **22+** (CI uses Node 24), npm, Docker CLI, a recent Docker Compose v2 with `!reset`/`!override` support, and Colima. Install these from their official sources before continuing. Ollama is optional.

Linux and Intel Mac deployments are **not validated by this release**. The operations scripts deliberately retain the reviewed Apple Silicon and Docker-context checks. Do not assume changing a platform flag is enough to support another architecture.

## Quick start

Clone this repository, then start the dedicated runtime if it does not already exist:

```sh
git clone https://github.com/dharmeshprataps/firecrawl-selfhost-kit.git
cd firecrawl-selfhost-kit
colima start --profile firecrawl --cpu 4 --memory 10 --disk 30 --arch aarch64
./local-ops/preflight-macos
python3 local-ops/configure.py
```

`configure.py` generates secrets locally, prepares private search settings and records installation paths for this checkout. It does not start containers, install background jobs or open a public route. Do not copy another person's `.env.local` or `.local-state` directory.

Review the merged deployment, pull the prebuilt support images, build the native services and start them:

```sh
./local-ops/firecrawl-local review
./local-ops/firecrawl-local pull
./local-ops/firecrawl-local build
./local-ops/firecrawl-local start
./local-ops/firecrawl-local status
./local-ops/firecrawl-local scrape https://example.com
```

The API is **`http://127.0.0.1:3012`**. Its authentication is disabled and **loopback is the access boundary**. Keep that binding; do not expose the raw API to a network. Port 3002 on the host is left available for other applications.

Example request:

```sh
curl --fail http://127.0.0.1:3012/v2/scrape \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://example.com","formats":["markdown"]}'
```

First builds compile native dependencies and can take substantial time. `start` uses existing images and waits for readiness; a successful health check alone does not establish extraction quality.

## Use an MCP client

Install the locked official MCP runtime into the generated private directory:

```sh
npm ci --ignore-scripts --prefix .local-state/mcp
```

Configure your MCP client to launch the absolute path to `local-plugin/bin/firecrawl-mcp`. For clients using the common `mcpServers` configuration shape:

```json
{
  "mcpServers": {
    "local-firecrawl": {
      "command": "/absolute/path/to/firecrawl-selfhost-kit/local-plugin/bin/firecrawl-mcp"
    }
  }
}
```

Use `local_web_status` and `local_web_capabilities` first. Use `local_web_read` for an ordinary page, `local_web_batch_scrape` for two to five known Markdown URLs, and `firecrawl_scrape` for browser interactions. The official MCP package is pinned to **3.36.1**; the wrapper forces this checkout's loopback API and disables Cloud mode.

This release includes a desktop plugin source package in `local-plugin`. It does not include anyone's private ChatGPT App, OAuth connection or account binding. See [remote access](docs/REMOTE_ACCESS.md) if you want to operate your own authenticated remote MCP endpoint.

## Optional local inference

Ordinary retrieval does not need an LLM key. General model-based extraction needs the optional local inference provider. The reviewed provider lock is in `local-ops/provider-lock.json`; `setup-providers` requires the pinned native Ollama installation and explicitly downloads the locked model and search image. Review the script and generated launchd paths before running it:

```sh
python3 local-ops/setup-providers
```

This is an optional, separate setup step. Missing providers should produce an explicit unsupported/unavailable result rather than trigger a hosted fallback.

## Operations and validation

See [deployment and maintenance](LOCAL_DEPLOYMENT.md), [capabilities and limits](docs/CAPABILITIES.md), [testing and evidence](docs/TESTING.md), and [security](SECURITY.md).

```sh
./local-ops/firecrawl-local stop
./local-ops/firecrawl-local start
./local-ops/firecrawl-local backup
```

The default API/browser memory ceilings are 5 GB/3 GB, with two queue workers, two crawl requests and log rotation at 10 MB × 3. These are bounded defaults, not a throughput promise. PostgreSQL backups do not automatically include Redis/RabbitMQ state or model files.

For source checks, first install the optional gateway's locked test dependency:

```sh
npm ci --ignore-scripts --prefix .local-state/remote-gateway
python3 local-ops/check-source.py
```

The regression suite covers extraction contracts, read-only boundaries, independent request IDs, bounded concurrency, OAuth, private-address rejection and queue expiry. Deterministic fixture access is disabled in the production configuration. Live acceptance must separately check content, terminal crawl state and persistence on your machine; this public snapshot has not been used to replace the maintainer's running installation.

## Test results and reproducibility

The public source snapshot passed **130 automated framework tests**, plus separate grounding-contract checks and fresh-checkout configuration/Compose review. The [testing guide](docs/TESTING.md) lists each suite, fixture, command, acceptance criterion and untested area. [Release evidence](docs/testing/release-validation.json) and a [sanitized full source-check log](docs/testing/source-check.log) are included.

A [historical live summary](docs/testing/historical-live-summary.json) records the earlier 217 benchmark attempts, observed failures and later four-call reader verification. Those attempts include failures and quota blocks; they are separate from the 130 source tests and were not rerun as a hosted comparison for this release. Public-source publication does not establish a new live deployment.

## License and upstream

The Firecrawl core and this distribution retain the **GNU Affero General Public License v3.0** in [LICENSE](LICENSE). Existing component-specific licenses and notices remain with their components, including SDK exceptions. See [NOTICE.md](NOTICE.md) and [MODIFICATIONS.md](MODIFICATIONS.md).

Upstream's original [README](docs/upstream/README.md), [self-hosting guide](docs/upstream/SELF_HOST.md) and [contribution guide](docs/upstream/CONTRIBUTING.md) are preserved for reference. Follow this repository's instructions for this kit's deployment profile.
