# Contributing

This is an unofficial Firecrawl self-hosting distribution. Use an issue to describe a reproducible bug or proposal, then submit a focused pull request. Keep upstream attribution and component licenses intact.

Read [the testing guide](docs/TESTING.md) for suite coverage, fixture maintenance, live acceptance and evidence requirements.

For this kit's Python/MCP/operations/gateway changes:

```sh
python3 local-ops/configure.py
npm ci --ignore-scripts --prefix .local-state/remote-gateway
python3 local-ops/check-source.py
```

Do not start containers, create public routes, download models or install background jobs as part of source-only tests. Mock remote services and use the deterministic fixtures for controlled behavior. Changes to parsing, queues, OAuth or request boundaries need meaningful success and failure regressions. For API changes, follow the original [upstream development guidance](docs/upstream/CONTRIBUTING.md) and the targeted harness tests; broad integration suites may need additional dependencies.

Keep the raw API on loopback, private fixture exceptions disabled in production, read-only tool annotations truthful, concurrency bounded and Cloud fallback disabled. Document whether a result is a source regression test, a live content test or a performance measurement. Preserve caller and server timing boundaries.

Never commit `.env.local`, OAuth data, owner passwords, downloaded models, page bodies, screenshots, private reports, package stores, `node_modules` or machine-specific installation metadata. Inspect the staged diff before pushing. Use example domains and paths in documentation.

By contributing, you are offering the contribution under the applicable existing license of the changed component. Do not change third-party license notices or claim affiliation with upstream.
