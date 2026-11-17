#!/usr/bin/env python3
"""Check portable source syntax and backup export after committing the overlay."""
import ast,json,plistlib,subprocess,tarfile,tempfile,tomllib
from pathlib import Path
r=Path(__file__).resolve().parents[1]
for folder in ["local-ops","local-bench","local-plugin","local-remote"]:
 for p in (r/folder).rglob("*.py"):
  if not {"node_modules","var","__pycache__"}.intersection(p.parts):ast.parse(p.read_text(),filename=str(p))
 for p in (r/folder).rglob("*.json"):
  if not {"node_modules","var"}.intersection(p.parts):json.loads(p.read_text())
ast.parse((r/"local-ops/setup-providers").read_text())
ast.parse((r/"local-ops/remote/run-fixture-tests").read_text())
json.loads((r/".agents/plugins/marketplace.json").read_text())
for p in [r/"local-ops/schedulers/com.localcrawler.stack.plist",r/"local-ops/schedulers/com.localcrawler.inference.plist",r/"local-ops/schedulers/com.localcrawler.remote.plist",r/"local-bench/schedulers/com.localcrawler.heartbeat.plist"]:
 with p.open("rb") as f:plistlib.load(f)
tomllib.loads((r/"local-plugin/codex-mcp.example.toml").read_text())
for name in ["local-ops/firecrawl-local","local-ops/start-at-login","local-ops/run-heartbeat","local-ops/preflight-macos","local-plugin/bin/firecrawl-mcp"]:subprocess.run(["bash","-n",str(r/name)],check=True)
subprocess.run(["node","--check",str(r/"local-plugin/bin/local-api-guard.mjs")],check=True)
subprocess.run(["node","--check",str(r/"local-bench/verify-read-only.mjs")],check=True)
subprocess.run(["node",str(r/"local-ops/check-grounding.mjs")],check=True)
for p in (r/"local-remote").rglob("*.mjs"):
 if "node_modules" not in p.parts:subprocess.run(["node","--check",str(p)],check=True)
subprocess.run(["git","diff","--check"],cwd=r,check=True)
with tempfile.TemporaryDirectory() as folder:
 export=Path(folder)/"overlay.tar.gz"
 subprocess.run(["python3",str(r/"local-ops/backup-overlay.py"),str(export)],check=True)
 with tarfile.open(export) as f:
  names=set(f.getnames())
  assert {"compose.override.yaml","local-ops/firecrawl-local","local-ops/backup-overlay.py","local-plugin/bin/firecrawl-mcp","apps/api/src/scraper/scrapeURL/engines/utils/localFixture.ts","local-remote/gateway.mjs","local-remote/auth.mjs"}<=names
  assert all(not ({".git",".local-state","backups","node_modules"}.intersection(Path(p).parts)) and p!=".env.local" and Path(p).parts[:2]!=("local-bench","var") for p in names)
subprocess.run(["python3","-m","unittest","discover","-s",str(r/"local-ops/tests"),"-v"],check=True)
subprocess.run(["python3","-m","unittest","discover","-s",str(r/"local-plugin/tests"),"-v"],check=True)
subprocess.run(["python3","-m","unittest","discover","-s",str(r/"local-ops/remote/tests"),"-v"],check=True)
subprocess.run(["node","--test",str(r/"local-remote/auth.test.mjs"),*[str(p) for p in sorted((r/"local-remote/tests").glob("*.test.mjs"))]],check=True)
print("Source syntax, tracked-source backup and local regression checks passed")
