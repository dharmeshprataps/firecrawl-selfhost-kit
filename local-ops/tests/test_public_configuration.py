"""Fresh-checkout configuration and safe launchd rendering, without live services."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

OPS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS))
from launchd_config import render_agent, remote_public_base, validate_public_base
spec = importlib.util.spec_from_file_location('public_configuration', OPS / 'configure.py')
configuration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(configuration)

class PublicConfigurationTests(unittest.TestCase):
    def make_checkout(self, folder):
        root = Path(folder) / 'checkout with spaces'; root.mkdir()
        (root / '.env.local.example').write_text('PORT=3012\nPOSTGRES_PASSWORD=GENERATE_LOCALLY\nBULL_AUTH_KEY=GENERATE_LOCALLY\nRABBITMQ_PASSWORD=GENERATE_LOCALLY\n')
        (root / 'local-ops/searxng').mkdir(parents=True)
        (root / 'local-ops/searxng/settings.yml.example').write_text('secret_key: REPLACE_WITH_GENERATED_SECRET\n')
        for rel in ['local-plugin/runtime', 'local-remote']:
            (root / rel).mkdir(parents=True)
            for name in ['package.json', 'package-lock.json']:
                (root / rel / name).write_text('{}\n')
        return root

    def test_fresh_configuration_is_private_local_and_rerun_preserves_secrets(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.make_checkout(folder)
            result = configuration.configure(root)
            self.assertFalse(result['services_started']); self.assertFalse(result['software_installed'])
            env = (root / '.env.local').read_bytes()
            self.assertNotIn(b'GENERATE_LOCALLY', env)
            secrets = [line.split(b'=')[1] for line in env.splitlines() if b'PASSWORD=' in line or b'AUTH_KEY=' in line]
            self.assertEqual(len(set(secrets)), 3); self.assertTrue(all(len(value) == 64 for value in secrets))
            self.assertEqual((root / '.env.local').stat().st_mode & 0o777, 0o600)
            installation = json.loads((root / 'local-plugin/runtime/installation.json').read_text())
            self.assertEqual(installation['checkout'], str(root.resolve()))
            self.assertEqual(installation['api_url'], 'http://127.0.0.1:3012')
            self.assertFalse((root / '.local-state/remote-gateway/config.json').exists())
            configuration.configure(root)
            self.assertEqual((root / '.env.local').read_bytes(), env)

    def test_explicit_public_base_is_private_and_invalid_base_has_no_side_effects(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.make_checkout(folder)
            with self.assertRaises(ValueError): configuration.configure(root, 'http://crawl.example/firecrawl')
            self.assertFalse((root / '.env.local').exists())
            configuration.configure(root, 'https://crawl.example:8443/firecrawl')
            self.assertEqual(remote_public_base(root), 'https://crawl.example:8443/firecrawl')
            path = root / '.local-state/remote-gateway/config.json'; path.chmod(0o644)
            with self.assertRaises(ValueError): remote_public_base(root)

    def test_state_symlink_is_rejected_before_writing(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.make_checkout(folder)
            target = Path(folder) / 'elsewhere'; target.mkdir()
            (root / '.local-state').symlink_to(target, target_is_directory=True)
            with self.assertRaises(RuntimeError): configuration.configure(root)
            self.assertFalse((root / '.env.local').exists())

    def test_templates_render_current_paths_and_no_missing_remote_value(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'checkout with spaces'
            for rel in ['local-ops/schedulers/com.localcrawler.stack.plist',
                        'local-ops/schedulers/com.localcrawler.inference.plist',
                        'local-bench/schedulers/com.localcrawler.heartbeat.plist']:
                config = render_agent(OPS.parent / rel, root=root, home=Path(folder) / 'owner')
                self.assertEqual(config['WorkingDirectory'], str(root.resolve()))
                self.assertNotIn('__CHECKOUT__', json.dumps(config))
                self.assertNotIn('/Users/', json.dumps(config))
            remote = OPS / 'schedulers/com.localcrawler.remote.plist'
            with self.assertRaises(ValueError): render_agent(remote, root=root)
            config = render_agent(remote, root=root, public_base='https://crawl.example/firecrawl')
            self.assertEqual(config['EnvironmentVariables']['FIRECRAWL_PUBLIC_BASE'], 'https://crawl.example/firecrawl')

    def test_public_base_rejects_credentials_private_hosts_and_noncanonical_routes(self):
        for value in ['https://localhost/firecrawl', 'https://127.0.0.1/firecrawl', 'https://127.1/firecrawl',
                      'https://crawl.internal/firecrawl', 'https://crawl.example/firecrawl/',
                      'https://user:pass@crawl.example/firecrawl', 'https://crawl.example/firecrawl?token=secret',
                      'https://CRAWL.example/firecrawl', 'https://crawl.example:443/firecrawl']:
            with self.subTest(value=value), self.assertRaises(ValueError): validate_public_base(value)

    def test_source_backup_works_without_upstream_history_and_excludes_private_tracked_paths(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.make_checkout(folder)
            configuration.configure(root)
            (root / 'public.txt').write_text('public source')
            (root / '.local-state/token.txt').write_text('private-sentinel')
            shutil.copy2(OPS / 'backup-overlay.py', root / 'local-ops/backup-overlay.py')
            subprocess.run(['git', '-C', str(root), 'init', '--quiet'], check=True)
            subprocess.run(['git', '-C', str(root), 'add', '-f', 'public.txt', '.env.local',
                            '.local-state/token.txt', 'local-plugin/runtime/installation.json'], check=True)
            archive = Path(folder) / 'source.tar.gz'
            subprocess.run([sys.executable, str(root / 'local-ops/backup-overlay.py'), str(archive)],
                           check=True, capture_output=True)
            with tarfile.open(archive) as source:
                self.assertEqual(source.getnames(), ['public.txt'])
                self.assertEqual(source.extractfile('public.txt').read(), b'public source')

if __name__ == '__main__':
    unittest.main()
