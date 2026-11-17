# Optional authenticated remote MCP access

Source publication does not make an installation a public hosted service. The default API stays on `127.0.0.1:3012`. Each operator supplies their own domain, TLS reverse proxy, OAuth owner credentials and client connection.

The optional gateway binds to `127.0.0.1:3013`. Configure its external resource explicitly:

```sh
python3 local-ops/configure.py --public-base https://your-domain.example/firecrawl
npm ci --ignore-scripts --prefix .local-state/remote-gateway
```

Review the private configuration and launchd template paths, then use `python3 local-ops/remote/control.py install` to install and start the optional gateway. Later starts use `control.py start`. This requires the main API/browser stack to be running with fixture exceptions disabled. The owner password and OAuth state are created locally on first gateway startup. The external base must be an HTTPS URL ending in `/firecrawl`; the MCP endpoint is its `/mcp` path. The gateway refuses to start with an unset/invalid base or an unsafe production stack.

Provision TLS and routing yourself. Route only this gateway's required `/firecrawl` paths and path-aware OAuth discovery to the loopback gateway. Do not forward raw API paths, replace another application's routes, or expose port 3012. This repository does not create tunnels or modify a shared proxy configuration automatically.

Use the gateway's own discovery metadata to review issuer, resource, authorization, token, registration and revocation endpoints. Clients use OAuth authorization code + PKCE and the `firecrawl:use` scope. The owner-consent flow is separate from scraping. Keep the generated owner password and OAuth state private; never put them in issues, client-facing metadata, packages or Git.

The owner is responsible for access policy and capacity. The gateway is for one operator's bounded workload, not an anonymous multi-tenant scraping service. It validates the external Host and browser Origin against the configured resource and reviewed client origins, rejects private destinations and fixtures, and retains rate, input/output, concurrency and queue bounds.

The packaged private ChatGPT App and account receipts used by the maintainer are not part of this release. Create and review your own connection. The remote callback allowlist currently supports the reviewed ChatGPT connector callback; supporting another remote client requires an explicit code change and tests. Local stdio MCP is independent of that callback restriction. No platform approval, public App listing or review status is implied by publishing this source.

Gateway verification is an explicit operator test, not part of automatic setup. It may exercise registration, consent, refresh and revocation using disposable test credentials. Review its configured base before running it and never use another operator's endpoint.
