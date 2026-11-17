#!/usr/bin/env python3
"""Bounded read-only Docker/readiness/queue samples; never dumps environment values."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DOCKER = ['/opt/homebrew/bin/docker', '--context', 'colima-firecrawl']
CONTAINERS = ['firecrawl-' + name + '-1' for name in
              ['api', 'playwright-service', 'nuq-postgres', 'redis', 'rabbitmq', 'searxng', 'fixtures']]
QUEUE_SQL = """SELECT json_build_object(
 'scrapeQueued',(SELECT count(*) FROM nuq.queue_scrape WHERE status='queued'),
 'scrapeActive',(SELECT count(*) FROM nuq.queue_scrape WHERE status='active'),
 'scrapeBacklog',(SELECT count(*) FROM nuq.queue_scrape_backlog));"""
PW_PROBE = """fetch('http://127.0.0.1:3000/health',{signal:AbortSignal.timeout(3000)})
.then(async r=>{const b=await r.json();console.log(JSON.stringify({httpStatus:r.status,
 status:b.status,activePages:b.activePages,maxConcurrentPages:b.maxConcurrentPages}));})
.catch(()=>process.exit(1));"""


def command(args, data=None):
    result = subprocess.run(DOCKER + args, input=data, text=True, capture_output=True, timeout=8)
    if result.returncode:
        raise RuntimeError('probe_exit_' + str(result.returncode))
    return result.stdout


def docker_stats():
    raw = command(['stats', '--no-stream', '--format', '{{json .}}', *CONTAINERS])
    keys = ['Name', 'CPUPerc', 'MemUsage', 'MemPerc', 'PIDs', 'NetIO', 'BlockIO']
    return [{key: value[key] for key in keys if key in value}
            for value in (json.loads(line) for line in raw.splitlines() if line)]


def queues():
    # These existing variables are consumed inside PostgreSQL's container, never printed.
    raw = command(['exec', '-i', 'firecrawl-nuq-postgres-1', 'sh', '-c',
                   'exec psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB"'], QUEUE_SQL)
    body = json.loads(raw)
    return {key: int(body[key]) for key in ['scrapeQueued', 'scrapeActive', 'scrapeBacklog']}


def playwright():
    return json.loads(command(['exec', 'firecrawl-playwright-service-1', 'node', '-e', PW_PROBE]))


def readiness():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://127.0.0.1:3012/v0/health/readiness', timeout=3) as response:
        body = json.load(response)
        return {'httpStatus': response.status, 'status': body.get('status')}


def collect(name, probe):
    started = time.monotonic()
    try:
        return name, {'value': probe(), 'probeMs': round((time.monotonic() - started) * 1000)}
    except Exception as exc:
        return name, {'error': type(exc).__name__, 'probeMs': round((time.monotonic() - started) * 1000)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=int, default=240)
    parser.add_argument('--interval', type=int, default=5)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--stop-file', type=Path)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 600 or not 3 <= args.interval <= 30:
        parser.error('seconds must be 1..600 and interval 3..30')
    os.umask(0o077)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    probes = {'docker': docker_stats, 'queues': queues, 'playwright': playwright, 'api': readiness}
    deadline = time.monotonic() + args.seconds
    with args.output.open('x') as stream, ThreadPoolExecutor(max_workers=4) as pool:
        stream.write(json.dumps({'kind': 'local-resource-samples', 'intervalSeconds': args.interval,
            'notes': ['Read-only stats, PostgreSQL SELECTs and fixed health probes; no environment output.',
                      'The Playwright health route briefly creates and closes a probe page.',
                      'Point samples can miss short peaks. Native host inference is outside Docker statistics.']}) + '\n')
        stream.flush()
        while time.monotonic() < deadline and not (args.stop_file and args.stop_file.exists()):
            start = time.monotonic()
            sample = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
            futures = [pool.submit(collect, name, probe) for name, probe in probes.items()]
            sample.update(dict(future.result() for future in futures))
            stream.write(json.dumps(sample) + '\n')
            stream.flush()
            remaining = min(args.interval - (time.monotonic() - start), deadline - time.monotonic())
            if remaining > 0:
                time.sleep(remaining)
    print(json.dumps({'output': str(args.output), 'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}))


if __name__ == '__main__':
    main()
