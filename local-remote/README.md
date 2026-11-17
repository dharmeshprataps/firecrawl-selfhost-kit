# Optional authenticated remote MCP gateway

The local API and desktop MCP launcher work without a public gateway. This directory contains the optional single-owner OAuth gateway. Publishing this source does not publish any running instance, create a tunnel, register a domain, or install a shared ChatGPT App.

The gateway always listens on `127.0.0.1:3013`. The raw Firecrawl API remains on `127.0.0.1:3012`. A server owner who chooses remote access must arrange their own HTTPS reverse proxy and domain, keeping OAuth discovery, consent and MCP paths routed to the gateway. Do not route the raw API publicly.

## Configuration

Gateway startup requires an explicit `FIRECRAWL_PUBLIC_BASE`, such as `https://crawl.example/firecrawl`. The URL must use HTTPS, a public hostname and exactly `/firecrawl`, with no credentials, trailing slash, query or fragment. There is no default public domain. The OAuth issuer is `<public-base>/oauth`; its protected resource is `<public-base>/mcp`. Host and browser-origin checks are derived from that same configured base.

On supported Apple Silicon Macs, use `python3 local-ops/configure.py --public-base https://crawl.example/firecrawl` to generate the private configuration and launchd paths for your checkout. This prepares configuration only; it does not arrange DNS or expose the service. Remote launch-agent installation remains a separate explicit step.

Install the pinned gateway dependencies from `package.json` and `package-lock.json` into `.local-state/remote-gateway` as described in the main setup guide. They are loaded from that private runtime directory. Node.js 22 or newer is required. No dependency directory or OAuth state is distributed in this repository.

The runtime guard defaults to `/opt/homebrew/bin/docker --context colima-firecrawl`. For a direct Node launch only, operators using another reviewed runtime can set `FIRECRAWL_DOCKER` to `docker` or an absolute executable path, and `FIRECRAWL_DOCKER_CONTEXT` to an explicit Docker context. Execution never uses a shell. The generated launchd job retains the reviewed default runtime/context; shell overrides are not automatically copied into it. Both running Compose services must still belong to the `firecrawl` project and explicitly disable the private fixture exception before gateway startup.

## Access and limits

- OAuth uses an explicit owner-consent password, S256 PKCE, one-hour access tokens, rotating refresh tokens and token-family replay revocation.
- The owner password and hashed OAuth state are generated locally under `.local-state/remote-gateway/auth/`; keep this directory private and out of Git.
- The callback allowlist is the supported ChatGPT connector callback. Creating and connecting your own client/App is separate from deploying the gateway.
- Only the reviewed 18-tool catalogue is exposed. Public web retrieval is allowed; private fixture and private-address requests are rejected. No Firecrawl Cloud fallback is enabled.
- Admission remains two active requests and four waiting requests, with a 60-second queue wait and a 90-second execution deadline. A caller or reverse proxy can impose a tighter timeout.
- Timing logs retain bounded counts, durations and enumerated queue outcomes, never page bodies, arguments or credentials.

`verify.mjs` is an opt-in end-to-end acceptance tool for your own configured deployment. Supply `FIRECRAWL_PUBLIC_BASE` explicitly in its environment; the verifier does not read the generated configuration file. It reads the local owner password, creates disposable test grants and revokes them afterward. It never follows the ChatGPT authorization callback. It is not run by the offline unit test suite.

## Offline regression tests

After installing the pinned dependencies, run:

```sh
node --test local-remote/auth.test.mjs local-remote/tests/*.test.mjs
```

The tests bind only temporary loopback fixture servers and stub the scraping bridge. They do not contact a live Firecrawl service or a hosted scraping provider.
