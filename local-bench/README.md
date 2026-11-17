# Deterministic verification

Run `python3 local-bench/heartbeat.py --config local-bench/cases/smoke-v1.json` or `acceptance-v1.json` from the checkout. API3012 and the fixture origin are fixed. Fixtures run only on the private Compose network. The full suite validates useful content and security canaries; it is separate from health.

Private reports/SQLite are under `var/`. `verify_state.py --crawl-id ID` performs manual stop/start and recreation persistence checks. `var/acceptance/resource-workload.json` records sampled resource use. The two-hour launchd template is installed only after reviewed paths and a successful manual run. Linux scheduler templates are not used on this Mac. Live corpus/prompt matrix remain disabled scaffolding.
