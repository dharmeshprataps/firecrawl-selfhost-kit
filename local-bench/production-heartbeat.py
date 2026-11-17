#!/usr/bin/env python3
"""Production readiness/content/private-target checks; no fixture exception.

This suite uses one public Python documentation page and no search or LLM.
The deterministic fixture suites require compose.fixture-tests.yaml and must
only run manually while the public remote gateway is stopped.
"""
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
API = 'http://127.0.0.1:3012'
PUBLIC_PAGE = 'https://docs.python.org/3/library/asyncio.html'
PRIVATE_PAGE = 'http://fixtures.firecrawl.test:8765/security/probe'
MAX_RESPONSE = 2 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('Unexpected redirect from local API')


def request(method, path, payload=None, timeout=10):
    if path not in {'/v0/health/readiness', '/v2/scrape'}:
        raise RuntimeError('Unreviewed local API path')
    req = urllib.request.Request(
        API + path, method=method,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={'Accept': 'application/json', 'Content-Type': 'application/json'},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(req, timeout=timeout) as response:
            status, raw = response.status, response.read(MAX_RESPONSE + 1)
    except urllib.error.HTTPError as exc:
        status, raw = exc.code, exc.read(MAX_RESPONSE + 1)
    if len(raw) > MAX_RESPONSE:
        raise RuntimeError('Local API response exceeded the size limit')
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeError) as exc:
        raise RuntimeError('Local API returned non-JSON content') from exc
    if not isinstance(body, dict):
        raise RuntimeError('Local API returned an invalid response')
    return status, body


def audit_private_probe(token):
    if not re.fullmatch('[a-f0-9]{32}', token):
        raise RuntimeError('Invalid private probe token')
    checkout = ROOT.parent
    script = ("import json,re,sys,urllib.request; "
              "o=urllib.request.build_opener(urllib.request.ProxyHandler({})); "
              "d=o.open('http://127.0.0.1:8765/security/audit/'+sys.argv[1],timeout=3).read(65536).decode(); "
              "m=re.search(r'<p>canary-count-([0-9]+)</p>',d); "
              "assert m, 'Invalid private canary response'; "
              "print(json.dumps({'requests':int(m.group(1))}))")
    command = ['/opt/homebrew/bin/docker', '--context', 'colima-firecrawl', 'compose',
               '--project-name', 'firecrawl', '--project-directory', str(checkout),
               '--env-file', str(checkout / '.env.local'),
               '-f', str(checkout / 'docker-compose.yaml'),
               '-f', str(checkout / 'compose.override.yaml'),
               'exec', '-T', 'fixtures', 'python', '-c', script, token]
    result = subprocess.run(command, capture_output=True, text=True, timeout=10,
                            env={'HOME': str(Path.home()), 'PATH': '/opt/homebrew/bin:/usr/bin:/bin'})
    if result.returncode or len(result.stdout) > 1024:
        raise RuntimeError('Private fixture audit could not be completed')
    try:
        counter = json.loads(result.stdout)['requests']
    except (ValueError, KeyError, TypeError) as exc:
        raise RuntimeError('Private fixture audit returned invalid data') from exc
    if type(counter) is not int or counter < 0:
        raise RuntimeError('Private fixture audit returned an invalid counter')
    return counter


def run_checks(call=request, audit=audit_private_probe):
    results = []
    ready = False
    for case in ['readiness', 'public-content', 'private-fixture-denied']:
        started = time.monotonic()
        record = {'case_id': case}
        try:
            if case == 'readiness':
                status, body = call('GET', '/v0/health/readiness', timeout=5)
                if status != 200 or body.get('status') != 'ok':
                    raise RuntimeError('Local API readiness failed')
                ready = True
                record['http_status'] = status
            else:
                if not ready:
                    raise RuntimeError('Readiness failed; scrape check skipped')
                public = case == 'public-content'
                token = uuid.uuid4().hex
                status, body = call('POST', '/v2/scrape', {
                    'url': PUBLIC_PAGE if public else PRIVATE_PAGE + '?token=' + token,
                    'formats': ['markdown'], 'onlyMainContent': True,
                    'maxAge': 0, 'timeout': 35000 if public else 15000,
                }, timeout=45 if public else 20)
                record['http_status'] = status
                if public:
                    doc = body.get('data', {})
                    markdown = doc.get('markdown') if isinstance(doc, dict) else None
                    metadata = doc.get('metadata', {}) if isinstance(doc, dict) else {}
                    if (status != 200 or body.get('success') is not True or
                            not isinstance(markdown, str) or len(markdown) < 1000 or
                            'asyncio' not in markdown.lower() or 'await' not in markdown or
                            not isinstance(metadata, dict) or metadata.get('statusCode') != 200):
                        raise RuntimeError('Public Python documentation content check failed')
                    record.update(characters=len(markdown), content_sha256=hashlib.sha256(markdown.encode()).hexdigest())
                elif status < 400 and body.get('success') is not False:
                    raise RuntimeError('Private fixture was accepted')
                else:
                    # This API can return a generic 500 when all engines reject
                    # a private URL. Prove no request reached the private target
                    # through its isolated internal counter, rather than treating
                    # the error status alone as proof of the SSRF protection.
                    counter = audit(token)
                    if counter != 0:
                        raise RuntimeError('Private target received a request')
                    record['canary_requests'] = counter
                    record['private_target_rejected'] = True
            record['status'] = 'passed'
        except Exception as exc:
            # Avoid logging exception URLs, request bodies or upstream responses.
            record.update(status='failed', error=type(exc).__name__)
        record['duration_ms'] = round((time.monotonic() - started) * 1000)
        results.append(record)
    return ready, results


def atomic(path, value):
    with tempfile.NamedTemporaryFile('w', dir=path.parent, delete=False) as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')
        temporary = handle.name
    os.replace(temporary, path)


def main():
    os.umask(0o077)
    if os.environ.get('FIRECRAWL_API_URL', API) != API:
        raise RuntimeError('Only the reviewed loopback API is permitted')
    var = ROOT / 'var'
    var.mkdir(parents=True, exist_ok=True)
    with (var / 'heartbeat.lock').open('a+') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Another heartbeat is running; overlap skipped.')
            return 0
        runid = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        dest = var / 'runs' / runid
        dest.mkdir(parents=True)
        ready, results = run_checks()
        passed = sum(record['status'] == 'passed' for record in results)
        summary = {'run_id': runid, 'suite': 'production-heartbeat-v1',
                   'readiness': ready, 'status': 'passed' if passed == 3 else 'failed',
                   'passed': passed, 'total': len(results), 'results': results,
                   'results_path': str(dest / 'results.jsonl')}
        (dest / 'results.jsonl').write_text(''.join(json.dumps(record) + '\n' for record in results))
        atomic(dest / 'summary.json', summary)
        atomic(var / 'latest.json', summary)
        (dest / 'report.md').write_text('# Production Firecrawl heartbeat\n\nStatus: ' + summary['status'] + '\n\n' +
                                      ''.join('- ' + record['case_id'] + ': ' + record['status'] + '\n' for record in results))
        print(json.dumps({'status': summary['status'], 'passed': passed, 'total': len(results),
                          'report': str(dest / 'report.md')}))
        return 0 if summary['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
