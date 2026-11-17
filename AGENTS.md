# Repository guidance

Read README.md, LOCAL_DEPLOYMENT.md and SECURITY.md before changing deployment or access behavior. This is a community self-hosting distribution of pinned Firecrawl source; keep attribution and component licenses intact.

For local-ops, local-plugin, local-bench or local-remote changes, run `python3 local-ops/check-source.py` with the locked gateway test dependency installed as described in CONTRIBUTING.md. Use meaningful regressions for request boundaries, extraction correctness, queues and OAuth. Source tests must not start Docker, install jobs or create public routes.

For API changes use targeted upstream harness tests. Preserve native builds, PostgreSQL queues, loopback API binding, production fixture restrictions, truthful tool annotations and bounded execution. Never enable a paid provider or Cloud fallback implicitly.

Do not commit runtime state, secrets, scraped bodies, personal reports or absolute machine paths. A source check or healthy container does not establish successful live extraction. Clearly label tested, optional, blocked and untested features.
