"""Render reviewed launchd templates for one checkout; never install them implicitly."""
import plistlib
import ipaddress
import re
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]

def validate_public_base(value):
    if not isinstance(value, str):
        raise ValueError('An explicit HTTPS public base is required')
    parsed = urlsplit(value)
    host = parsed.hostname or ''
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError('Invalid public port') from exc
    if (parsed.scheme != 'https' or not host or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path != '/firecrawl'
            or port is not None and not 1 <= port <= 65535 or value.endswith('/')):
        raise ValueError('Public base must be https://your-domain.example/firecrawl')
    if ('.' not in host or host.endswith('.') or host == 'localhost'
            or host.endswith(('.localhost', '.local', '.internal', '.test'))
            or not re.fullmatch(r'[a-z0-9.-]+', host) or not re.search('[a-z]', host.rsplit('.', 1)[1])):
        raise ValueError('Use a public DNS hostname')
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise ValueError('Use a public DNS hostname rather than an IP address')
    expected = 'https://' + host + (':' + str(port) if port not in (None, 443) else '') + '/firecrawl'
    if value != expected:
        raise ValueError('Use the canonical HTTPS public base')
    return value

def remote_public_base(root=ROOT):
    import json
    source = root / '.local-state/remote-gateway/config.json'
    if source.is_symlink() or not source.is_file() or source.stat().st_mode & 0o777 != 0o600:
        raise ValueError('Run configure.py --public-base with your own domain; gateway config must be private 0600')
    config = json.loads(source.read_text())
    if set(config) != {'public_base'}:
        raise ValueError('Unexpected gateway configuration fields')
    return validate_public_base(config['public_base'])

def render_agent(source, *, root=ROOT, home=None, public_base=None):
    root = root.resolve()
    home = Path.home() if home is None else Path(home).resolve()
    import shutil
    ollama = shutil.which('ollama', path='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin') or '/usr/local/bin/ollama'
    values = {'__CHECKOUT__': str(root), '__HOME__': str(home), '__OLLAMA__': ollama}
    if public_base is not None:
        values['__PUBLIC_BASE__'] = validate_public_base(public_base)
    def render(value):
        if isinstance(value, str):
            for token, replacement in values.items():
                value = value.replace(token, replacement)
            if any(token in value for token in ['__CHECKOUT__', '__HOME__', '__PUBLIC_BASE__', '__OLLAMA__']):
                raise ValueError('Missing launchd template value')
            return value
        if isinstance(value, list):
            return [render(item) for item in value]
        if isinstance(value, dict):
            return {key: render(item) for key, item in value.items()}
        return value
    return render(plistlib.loads(Path(source).read_bytes()))
