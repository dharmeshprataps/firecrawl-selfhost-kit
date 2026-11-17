"""Exercise fixture maintenance safety without Docker or launchd mutations."""
import contextlib
import fcntl
import importlib.machinery
import importlib.util
import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'run-fixture-tests'
LOADER = importlib.machinery.SourceFileLoader('fixture_runner_under_test', str(SOURCE))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
RUNNER = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(RUNNER)


class FixtureRunnerTests(unittest.TestCase):
    def exercise(self, *, suite_status=0, restore_failure=False, start_failure=False,
                 runtime_failure=False, loaded=True, lock_held=False, review_only=False, suite=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / '.local-state/remote-gateway'
            state.mkdir(parents=True)
            events = []
            held = (state / 'fixture-tests.lock').open('a+') if lock_held else None
            if held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)

            def operation(command, *, check=True, timeout=240):
                if command[0] == '/bin/launchctl':
                    return SimpleNamespace(returncode=0 if loaded else 1, stdout='')
                if command[-1] in ('start', 'stop'):
                    events.append(command[-1])
                    if command[-1] == 'start':
                        # The maintenance lock must be released before control.py
                        # performs its own nonblocking startup safety check.
                        with (state / 'fixture-tests.lock').open('a+') as probe:
                            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        if start_failure:
                            raise RuntimeError('Synthetic startup failure')
                    return SimpleNamespace(returncode=0, stdout='')
                if str(command[1]).endswith('production-heartbeat.py'):
                    events.append('production-heartbeat')
                    return SimpleNamespace(returncode=0, stdout='')
                if str(command[1]).endswith('correctness.py'):
                    self.assertEqual(command[2:], ['--guarded-run'])
                    events.append('correctness-test')
                    return SimpleNamespace(returncode=suite_status, stdout='')
                if str(command[1]).endswith('heartbeat.py'):
                    events.append('test')
                    return SimpleNamespace(returncode=suite_status, stdout='')
                events.append('review')
                return SimpleNamespace(returncode=0, stdout='')

            def recreate(command):
                fixture = command is RUNNER.FIXTURE_COMPOSE
                events.append('fixture-up' if fixture else 'production-up')
                if not fixture and restore_failure:
                    raise RuntimeError('Synthetic restoration failure')

            def runtime(value):
                events.append('runtime-fixture' if value else 'runtime-production')
                if runtime_failure and not value and 'production-up' in events:
                    raise RuntimeError('Synthetic runtime isolation failure')

            argv = ['run-fixture-tests'] + (['--review'] if review_only else []) + (['--suite', suite] if suite else [])
            try:
                with patch.object(RUNNER, 'ROOT', root), patch.object(RUNNER, 'run', side_effect=operation), \
                     patch.object(RUNNER, 'merged_fixture_review'), patch.object(RUNNER, 'runtime_fixture_value', side_effect=runtime), \
                     patch.object(RUNNER, 'recreate', side_effect=recreate), patch.object(RUNNER, 'gateway_closed'), \
                     patch('sys.argv', argv), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    result = RUNNER.main()
                return result, events
            finally:
                if held:
                    held.close()

    def test_success_restores_and_checks_before_gateway_restart(self):
        result, events = self.exercise()
        self.assertEqual(result, 0)
        self.assertEqual(events, ['review', 'runtime-production', 'stop', 'fixture-up', 'runtime-fixture',
                                  'test', 'production-up', 'runtime-production', 'review', 'production-heartbeat', 'start'])

    def test_failed_suite_still_restores_production(self):
        result, events = self.exercise(suite_status=1)
        self.assertEqual(result, 1)
        self.assertIn('production-up', events)
        self.assertEqual(events[-1], 'start')

    def test_failed_restore_keeps_gateway_stopped(self):
        result, events = self.exercise(restore_failure=True)
        self.assertEqual(result, 1)
        self.assertNotIn('start', events)
        self.assertEqual(events.count('stop'), 2)

    def test_failed_runtime_guard_never_starts_gateway(self):
        result, events = self.exercise(runtime_failure=True)
        self.assertEqual(result, 1)
        self.assertNotIn('start', events)

    def test_gateway_start_failure_is_not_reported_as_success(self):
        result, events = self.exercise(start_failure=True)
        self.assertEqual(result, 1)
        self.assertEqual(events[-1], 'stop')

    def test_initially_stopped_gateway_remains_stopped(self):
        result, events = self.exercise(loaded=False)
        self.assertEqual(result, 0)
        self.assertNotIn('start', events)

    def test_maintenance_lock_prevents_overlapping_operations(self):
        result, events = self.exercise(lock_held=True)
        self.assertEqual(result, 1)
        self.assertEqual(events, [])

    def test_correctness_routes_only_after_fixture_guard_and_restores(self):
        result, events = self.exercise(suite='correctness')
        self.assertEqual(result, 0)
        self.assertEqual(events, ['review', 'runtime-production', 'stop', 'fixture-up', 'runtime-fixture',
                                  'correctness-test', 'production-up', 'runtime-production', 'review', 'production-heartbeat', 'start'])

    def test_correctness_failure_still_restores_before_gateway_restart(self):
        result, events = self.exercise(suite='correctness', suite_status=1)
        self.assertEqual(result, 1)
        self.assertIn('correctness-test', events)
        self.assertLess(events.index('runtime-production', events.index('production-up')), events.index('start'))

    def test_review_never_changes_services(self):
        result, events = self.exercise(review_only=True)
        self.assertEqual(result, 0)
        self.assertEqual(events, ['review', 'runtime-production'])


if __name__ == '__main__':
    unittest.main()
