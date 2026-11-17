# Deployment and maintenance

Follow the [quick start](README.md) for the tested Apple Silicon setup. All paths are generated from the cloned checkout. Never copy runtime state from another installation.

## Defaults and boundaries

| Setting | Default |
| --- | --- |
| Raw API | `127.0.0.1:3012` only |
| Docker context / project | `colima-firecrawl` / `firecrawl` |
| Architecture | Native ARM64 |
| Queue | PostgreSQL; two workers |
| Crawl concurrency | Two requests |
| API / browser memory ceiling | 5 GB / 3 GB |
| Persistent volumes | PostgreSQL, Redis, RabbitMQ |
| Log rotation | 10 MB × 3 |
| Remote gateway | Optional; disabled until explicitly configured |
| Remote execution | Two active, four pending; 60-second queue wait, separate 90-second service deadline |
| Paid providers / Cloud fallback | Disabled |

The deployment owns the named context/project and host port 3012. Review conflicts before using it. Existing port 3002 services are not moved or replaced. Do not run these operations against an unrelated Docker project.

`configure.py` creates `.env.local`, private SearXNG settings, local installation metadata and locked package inputs. Re-running it must preserve existing generated secrets. Runtime files are ignored by Git. Keep filesystem permissions private and back up secrets separately from source.

## Start, stop and inspect

Use `local-ops/firecrawl-local review` before starting or building. It validates the merged Compose configuration without printing secrets. `build` compiles the API, browser, queue database image and fixture service sequentially. `pull` retrieves the reviewed support images. `start` starts prebuilt services and waits for readiness.

`status` includes a resource snapshot; `logs [SERVICE]` passes logs through redaction. Treat logs and scraped documents as potentially private even after redaction. `stop` preserves persistent data; `start` reuses it.

## Verify useful behavior

Readiness and container health are necessary but insufficient. Test a static page and a JavaScript-rendered page for expected content, a three-to-five-page crawl until completed/failed, mapping with useful URLs, and the formats you actually use. Check page limits against actual returned sections, not only metadata. Stop/start and verify the same persisted state. Measure resource usage during the work.

`local-bench` contains deterministic fixtures and acceptance tools. The special fixture-origin exception must remain disabled outside a controlled local test run. The remote gateway refuses startup unless both the API and browser show disabled fixture exceptions. Never weaken that check to make a test pass.

## Backups, updates and rollback

`local-ops/firecrawl-local backup [DIR]` writes a PostgreSQL dump and source/deployment metadata. Inspect the command's output and check that a backup can be read. This is not a complete snapshot of Redis, RabbitMQ, downloaded models or all queued work. Back those up separately if they matter to your workflow, with services quiesced and an appropriate restoration procedure.

To update, keep the old checkout and image identifiers, back up the database and private settings, prepare a separate checkout at a reviewed version, apply compatible configuration and inspect migrations. Build and run acceptance before switching. The `update` command deliberately does not fetch a floating upstream branch or replace a running deployment.

For rollback, review database migration compatibility first. Restore a compatible source/image set in a separate checkout. Do not assume that reversing Git commits reverses database migrations. The `rollback` command is guidance, not an unattended database restore.

## Optional background jobs

No background job is installed by configuration or first start. Use `python3 local-ops/install-launchd.py stack` or `heartbeat` to inspect the rendered job for this checkout. Review the paths, then add `--install` only if you want it enabled. The heartbeat runs every two hours and records local results; it does not send notifications.

Local inference and the authenticated remote gateway are separate optional jobs. Review their generated configuration and dependencies before installing them. Moving a checkout requires regenerating and reviewing the installed paths.

## Removal

`local-ops/firecrawl-local uninstall` stops this kit's jobs and removes its containers/project network while retaining volumes and backups. Review any reverse-proxy route separately. Persistent data and credentials are not silently destroyed. Inspect named volumes before intentionally deleting data.
