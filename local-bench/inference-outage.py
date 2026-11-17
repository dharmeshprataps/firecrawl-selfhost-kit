#!/usr/bin/env python3
"""Controlled local inference outage acceptance; restores only its reviewed agent."""
import datetime
import json
import os
from pathlib import Path
import plistlib
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LABEL = "com.localcrawler.inference"
DOMAIN = f"gui/{os.getuid()}"
PLIST = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"
API = "http://127.0.0.1:3012"
ORIGIN = "http://fixtures.firecrawl.test:8765"
SCHEMA = {"type": "object", "properties": {"project": {"type": "string"}}, "required": ["project"], "additionalProperties": False}


def request(url, payload=None, timeout=100):
    req = urllib.request.Request(url, data=None if payload is None else json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, json.loads(response.read(100000))
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read(100000))
        except (ValueError, UnicodeError):
            body = {}
        return exc.code, body


def available(port):
    try:
        status, _ = request(f"http://127.0.0.1:{port}/api/version", timeout=2)
        return status == 200
    except (OSError, ValueError):
        return False


def launchctl(*args):
    return subprocess.run(["/bin/launchctl", *args], check=True, capture_output=True, text=True)


def review_agent():
    expected = plistlib.loads((ROOT / "local-ops/schedulers" / f"{LABEL}.plist").read_bytes())
    installed = plistlib.loads(PLIST.read_bytes())
    assert installed == expected, "Installed inference agent differs from the reviewed source template"
    assert installed["Label"] == LABEL
    assert installed["ProgramArguments"] == ["/usr/local/bin/ollama", "serve"]
    assert installed["WorkingDirectory"] == str(ROOT)
    env = installed["EnvironmentVariables"]
    assert env["OLLAMA_HOST"] == "127.0.0.1:11435" and env["OLLAMA_NO_CLOUD"] == "1"


def wait_provider(wanted):
    until = time.monotonic() + 20
    while time.monotonic() < until:
        if available(11435) is wanted:
            return
        time.sleep(0.5)
    raise AssertionError("Reviewed inference endpoint did not reach the expected state")


def scrape(formats):
    return request(API + "/v2/scrape", {"url": ORIGIN + "/structured.html", "formats": formats, "maxAge": 0, "timeout": 85000})


def main():
    os.umask(0o077)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = ROOT / "local-bench/var/enhancement" / f"inference-outage-{stamp}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    report = {"test": "controlled-local-inference-outage", "target_label": LABEL, "target_port": 11435, "started_at": stamp, "checks": []}
    stopped = False
    original_available = available(11434)
    report["preexisting_11434_available_before"] = original_available
    try:
        review_agent()
        assert available(11435), "Reviewed local inference provider must be running before the controlled outage"
        launchctl("print", f"{DOMAIN}/{LABEL}")
        launchctl("bootout", f"{DOMAIN}/{LABEL}")
        stopped = True
        wait_provider(False)
        report["checks"].append({"name": "only-reviewed-inference-agent-stopped", "passed": True})
        status, body = scrape(["markdown"])
        assert status == 200 and body.get("success") and "Orchid Local" in body.get("data", {}).get("markdown", ""), "Core scraping failed during local inference outage"
        report["checks"].append({"name": "markdown-still-works", "passed": True, "http_status": status})
        started = time.monotonic()
        status, body = scrape([{"type": "json", "schema": SCHEMA, "prompt": "Extract the project name from the page"}])
        assert status != 200 or body.get("success") is False, "JSON unexpectedly succeeded while the only configured inference provider was unavailable"
        assert body.get("data", {}).get("json") is None, "A fabricated JSON success was returned during provider outage"
        report["checks"].append({"name": "json-fails-without-cloud-fallback", "passed": True, "http_status": status, "seconds": round(time.monotonic() - started, 3), "error_code": body.get("code")})
    except Exception as exc:
        report["failure"] = type(exc).__name__
        # Fixed assertion messages contain no provider credentials or page body.
        if isinstance(exc, AssertionError):
            report["failure_reason"] = str(exc)[:220]
    finally:
        if stopped:
            try:
                launchctl("bootstrap", DOMAIN, str(PLIST))
                launchctl("kickstart", f"{DOMAIN}/{LABEL}")
                wait_provider(True)
                report["inference_agent_restored"] = True
            except Exception as exc:
                report["inference_agent_restored"] = False
                report["restore_failure"] = type(exc).__name__
        else:
            report["inference_agent_restored"] = available(11435)
        report["preexisting_11434_available_after"] = available(11434)
        report["preexisting_11434_untouched"] = report["preexisting_11434_available_after"] == original_available
        report["status"] = "passed" if not report.get("failure") and report["inference_agent_restored"] and report["preexisting_11434_untouched"] else "failed"
        target.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"status": report["status"], "report": str(target), "inference_agent_restored": report["inference_agent_restored"], "preexisting_11434_untouched": report["preexisting_11434_untouched"]}))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
