#!/usr/bin/env python3
"""Create private local configuration without installing software or starting services."""
import argparse
import json
import os
import secrets
from pathlib import Path
from launchd_config import validate_public_base

ROOT = Path(__file__).resolve().parents[1]

def private_file(path, data, *, replace=False):
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents if parent != ROOT.parent):
        raise RuntimeError('Configuration path must not be a symlink')
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists() and not replace:
        if path.stat().st_mode & 0o777 != 0o600:
            raise RuntimeError('Existing private configuration must have mode 0600')
        return False
    if replace and path.exists():
        path.write_bytes(data)
        path.chmod(0o600)
    else:
        with path.open('xb') as stream:
            stream.write(data)
        path.chmod(0o600)
    return True

def configure(root=ROOT, public_base=None):
    root = root.resolve()
    if public_base is not None:
        validate_public_base(public_base)
    if (root / '.local-state').is_symlink():
        raise RuntimeError('Private state directory must not be a symlink')
    env = (root / '.env.local.example').read_text()
    for key in ['POSTGRES_PASSWORD', 'BULL_AUTH_KEY', 'RABBITMQ_PASSWORD']:
        marker = key + '=GENERATE_LOCALLY'
        if env.count(marker) != 1:
            raise RuntimeError('Unexpected environment template')
        env = env.replace(marker, key + '=' + secrets.token_hex(32))
    private_file(root / '.env.local', env.encode())
    search = (root / 'local-ops/searxng/settings.yml.example').read_text()
    if search.count('REPLACE_WITH_GENERATED_SECRET') != 1:
        raise RuntimeError('Unexpected search template')
    private_file(root / '.local-state/searxng/settings.yml', search.replace('REPLACE_WITH_GENERATED_SECRET', secrets.token_hex(32)).encode())
    settings = {'checkout': str(root), 'node': '/opt/homebrew/bin/node',
                'api_url': 'http://127.0.0.1:3012', 'official_mcp_version': '3.36.1'}
    private_file(root / 'local-plugin/runtime/installation.json', (json.dumps(settings, indent=2) + '\n').encode(), replace=True)
    for source, destination in [('local-plugin/runtime', '.local-state/mcp'), ('local-remote', '.local-state/remote-gateway')]:
        for name in ['package.json', 'package-lock.json']:
            private_file(root / destination / name, (root / source / name).read_bytes(), replace=True)
    if public_base is not None:
        config = {'public_base': validate_public_base(public_base)}
        private_file(root / '.local-state/remote-gateway/config.json', (json.dumps(config, indent=2) + '\n').encode(), replace=True)
    return {'configuration': 'ready', 'api': 'http://127.0.0.1:3012',
            'secrets': 'generated locally and retained on rerun', 'services_started': False,
            'software_installed': False, 'public_gateway_configured': public_base is not None}

def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public-base', help='Optional HTTPS /firecrawl base for an independently configured authenticated gateway')
    args = parser.parse_args()
    print(json.dumps(configure(public_base=args.public_base), indent=2))

if __name__ == '__main__':
    main()
