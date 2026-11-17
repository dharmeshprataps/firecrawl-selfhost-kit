#!/usr/bin/env python3
"""Install an explicitly selected local launch agent after reviewing rendered paths."""
import argparse
import os
import plistlib
import subprocess
from pathlib import Path
from launchd_config import ROOT, render_agent

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('agent', choices=['stack', 'heartbeat'])
    parser.add_argument('--install', action='store_true', help='Install the displayed configuration; otherwise review only')
    args = parser.parse_args()
    label = 'com.localcrawler.' + args.agent
    folder = ROOT / ('local-bench/schedulers' if args.agent == 'heartbeat' else 'local-ops/schedulers')
    config = render_agent(folder / (label + '.plist'))
    print(plistlib.dumps(config).decode())
    if not args.install:
        return
    if not Path('/bin/launchctl').is_file():
        raise SystemExit('launchd installation requires macOS')
    os.umask(0o077)
    (ROOT / 'local-bench/var').mkdir(parents=True, exist_ok=True, mode=0o700)
    destination = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.read_bytes() != plistlib.dumps(config):
        raise SystemExit('Existing launch agent differs; review and remove it manually before replacement')
    destination.write_bytes(plistlib.dumps(config)); destination.chmod(0o600)
    target = f'gui/{os.getuid()}/{label}'
    subprocess.run(['/bin/launchctl', 'enable', target], check=True)
    loaded = subprocess.run(['/bin/launchctl', 'print', target], capture_output=True).returncode == 0
    if not loaded:
        subprocess.run(['/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', str(destination)], check=True)

if __name__ == '__main__':
    main()
