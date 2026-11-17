"""Exercise the read-only boundary and actual alias RPC forwarding without network."""
import base64
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
from queue import Queue
from types import SimpleNamespace
import tempfile
import threading
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'bin/local-mcp.py'
SPEC = importlib.util.spec_from_file_location('readonly_proxy_under_test', SOURCE)
proxy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proxy)
from read_only_scrape import READ_KEYS, READ_NAME, read_tool_from_scrape, validate_read_args


def base_tool():
    properties = {name: {'type': 'object' if name in {'jsonOptions', 'queryOptions', 'screenshotOptions', 'pdfOptions', 'location'} else 'string'}
                  for name in READ_KEYS | {'actions', 'profile', 'proxy', 'headers', 'domainTools', 'toolDetail'}}
    for name, children in {'jsonOptions': ['prompt', 'schema'], 'queryOptions': ['prompt', 'mode'],
                           'screenshotOptions': ['fullPage', 'quality', 'viewport'], 'pdfOptions': ['maxPages'],
                           'location': ['country', 'languages']}.items():
        properties[name]['properties'] = {key: {} for key in children + ['headers', 'actions']}
    properties['screenshotOptions']['properties']['viewport'] = {'properties': {'width': {}, 'height': {}}}
    return {'name': 'firecrawl_scrape', 'inputSchema': {'type': 'object', 'properties': properties},
            'outputSchema': {'type': 'object'}, 'annotations': {'readOnlyHint': False}}


class ReaderBoundaryTests(unittest.TestCase):
    def test_catalog_clones_only_reviewed_reads_and_preserves_output_schema(self):
        original = base_tool(); before = copy.deepcopy(original)
        tool = read_tool_from_scrape(original)
        self.assertEqual(original, before)
        self.assertEqual(tool['name'], READ_NAME)
        self.assertEqual(tool['annotations'], {'title': 'Local web read', 'readOnlyHint': True,
                                               'destructiveHint': False, 'openWorldHint': True})
        self.assertEqual(set(tool['inputSchema']['properties']), READ_KEYS)
        self.assertEqual(tool['inputSchema']['required'], ['url'])
        self.assertIs(tool['inputSchema']['additionalProperties'], False)
        self.assertIs(tool['inputSchema']['properties']['jsonOptions']['additionalProperties'], False)
        self.assertEqual(tool['outputSchema'], original['outputSchema'])
        self.assertNotIn('headers', tool['inputSchema']['properties']['jsonOptions']['properties'])

    def test_absent_or_malformed_upstream_base_is_not_fabricated(self):
        for value in [None, {}, {'name': 'other'}, {'name': 'firecrawl_scrape', 'inputSchema': {}}, {'name': 'firecrawl_scrape', 'inputSchema': None}, {'name': 'firecrawl_scrape', 'inputSchema': {'type': 'object', 'properties': None}}]:
            with self.subTest(value=value), self.assertRaises(proxy.LocalToolError):
                read_tool_from_scrape(value)

    def test_no_stateful_or_unknown_argument_can_be_silently_stripped(self):
        for key in ['actions', 'profile', 'session', 'sessionId', 'headers', 'requestId', 'alexandria',
                    'proxy', 'zeroDataRetention', 'domainTools', 'toolDetail', 'webhook']:
            for value in [None, {}, [], False]:
                with self.subTest(key=key, value=value), self.assertRaises(proxy.LocalToolError):
                    validate_read_args({'url': 'https://example.org/', key: value})
        for name in ['jsonOptions', 'queryOptions', 'screenshotOptions', 'pdfOptions', 'location']:
            with self.subTest(name=name), self.assertRaises(proxy.LocalToolError):
                validate_read_args({'url': 'https://example.org/', name: {'headers': {'Authorization': 'sentinel'}}})
        with self.assertRaises(proxy.LocalToolError):
            validate_read_args({'url': 'https://example.org/', 'screenshotOptions': {'viewport': {'width': 400, 'height': 300, 'actions': []}}})

    def test_data_schema_keys_do_not_become_tool_options(self):
        args = {'url': 'https://example.org/', 'jsonOptions': {'prompt': 'Extract the schema fields',
                'schema': {'type': 'object', 'properties': {'actions': {'type': 'string'}, 'headers': {'type': 'string'}}}},
                'formats': ['json'], 'maxAge': 0, 'storeInCache': False, 'timeout': 45000,
                'location': {'country': 'IN', 'languages': ['en']}, 'screenshotOptions': {'fullPage': False, 'quality': 75.5, 'viewport': {'width': 500.5, 'height': 300}}}
        before = copy.deepcopy(args); validate_read_args(args)
        self.assertEqual(args, before)

    def test_malformed_nested_shapes_and_primitives_fail_before_sdk(self):
        cases = [{'jsonOptions': None}, {'jsonOptions': {'schema': []}}, {'queryOptions': {'mode': 'directQuote'}},
                 {'queryOptions': {'prompt': 'x', 'mode': 'other'}}, {'onlyMainContent': 1}, {'storeInCache': 'false'},
                 {'waitFor': True}, {'maxAge': -1}, {'timeout': 0}, {'timeout': 1.5}, {'includeTags': 'body'},
                 {'excludeTags': [1]}, {'parsers': ['pdf', 'pdf']}, {'parsers': ['other']},
                 {'screenshotOptions': {'fullPage': 1}}, {'screenshotOptions': {'quality': float('inf')}},
                 {'screenshotOptions': {'viewport': {'width': True, 'height': 2}}},
                 {'location': {'languages': 'en'}}, {'expectedContent': ['']}, {'expectedContent': None}]
        for values in cases:
            with self.subTest(values=values), self.assertRaises(proxy.LocalToolError):
                validate_read_args({'url': 'https://example.org/', **values})


class AliasProtocolTests(unittest.TestCase):
    def exercise(self, requests, answer=None, reverse_pair=False, disable=False):
        replies = []; sent = []; done = threading.Event(); wire = Queue()
        expected_count = len(requests)
        class Output(io.StringIO):
            def write(self, text):
                count = super().write(text)
                for line in text.splitlines():
                    try: item = json.loads(line)
                    except ValueError: continue
                    replies.append(item)
                if len(replies) >= expected_count: done.set()
                return count
        class Input:
            def __init__(self): self.items = iter(requests); self.buffer = self
            def readline(self, _):
                try: return (json.dumps(next(self.items)) + '\n').encode()
                except StopIteration:
                    if not done.wait(timeout=3): raise AssertionError('Proxy did not return every fake tool response')
                    return b''
        class Stdout:
            def readline(self, _): return wire.get(timeout=3)
        class Stdin:
            def __init__(self): self.batch = []
            def write(self, raw):
                item = json.loads(raw); sent.append(item)
                if reverse_pair:
                    self.batch.append(item)
                    if len(self.batch) < 2: return
                    outgoing = list(reversed(self.batch)); self.batch.clear()
                else: outgoing = [item]
                for request in outgoing:
                    body = answer(request) if answer else {'content': [{'type': 'text', 'text': json.dumps({'markdown': 'intended marker', 'metadata': {'statusCode': 200}})}]}
                    wire.put((json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': body}) + '\n').encode())
            def flush(self): pass
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); plugin = root / 'plugin'; (plugin / 'runtime').mkdir(parents=True)
            runtime = root / '.local-state/mcp/node_modules/firecrawl-mcp'; runtime.mkdir(parents=True)
            (runtime / 'package.json').write_text(json.dumps({'version': '3.36.1'}))
            (plugin / 'runtime/installation.json').write_text(json.dumps({'checkout': str(root), 'api_url': 'http://127.0.0.1:3012', 'node': '/opt/homebrew/bin/node', 'official_mcp_version': '3.36.1'}))
            caps = json.loads((SOURCE.parents[1] / 'capabilities.json').read_text())
            if disable: caps['official_tools']['firecrawl_scrape']['enabled'] = False
            (plugin / 'capabilities.json').write_text(json.dumps(caps))
            child = SimpleNamespace(stdin=Stdin(), stdout=Stdout(), terminate=lambda: wire.put(b''), wait=lambda timeout: 0, kill=lambda: None)
            class Tools:
                def __init__(self, *_): pass
            with patch.object(proxy, 'PLUGIN', plugin), patch.object(proxy, 'LocalTools', Tools), \
                    patch.object(proxy.subprocess, 'Popen', return_value=child), \
                    patch.object(proxy.sys, 'stdin', Input()), contextlib.redirect_stdout(Output()):
                self.assertEqual(proxy.main(), 0)
        return replies, sent

    def call(self, ident, args):
        return {'jsonrpc': '2.0', 'id': ident, 'method': 'tools/call', 'params': {'name': READ_NAME, 'arguments': args}}

    def test_forwards_read_options_through_official_scrape_and_retains_metadata(self):
        args = {'url': 'https://example.org/document.pdf', 'formats': ['markdown', 'html', 'json'],
                'jsonOptions': {'prompt': 'Read', 'schema': {'type': 'object'}}, 'pdfOptions': {'maxPages': 2},
                'expectedContent': ['intended marker'], 'storeInCache': False, 'maxAge': 0, 'timeout': 45000}
        replies, sent = self.exercise([self.call('read-client', args)])
        forwarded = sent[0]['params']
        self.assertEqual(forwarded['name'], 'firecrawl_scrape')
        self.assertEqual(sent[0]['id'], 'read-client')
        self.assertEqual(forwarded['arguments'], {key: value for key, value in args.items() if key != 'expectedContent'} | {'parsers': ['pdf']})
        result = replies[0]['result']
        self.assertEqual(result['_meta']['localExecution']['tool'], READ_NAME)
        self.assertEqual(result['structuredContent']['metadata']['localContentCheck']['status'], 'checked')
        self.assertEqual(result['structuredContent']['markdown'], 'intended marker')

    def test_rejects_actions_and_unknown_nested_fields_without_upstream_dispatch(self):
        for extra in [{'actions': []}, {'actions': None}, {'profile': {'name': 'saved'}},
                      {'jsonOptions': {'schema': {}, 'profile': {}}}, {'pdfOptions': {'maxPages': False}}]:
            with self.subTest(extra=extra):
                replies, sent = self.exercise([self.call(10, {'url': 'https://example.org/', **extra})])
                self.assertEqual(sent, [])
                payload = json.loads(replies[0]['result']['content'][0]['text'])
                self.assertEqual(payload['code'], 'INVALID_ARGUMENT')

    def test_disabled_scrape_policy_disables_alias(self):
        replies, sent = self.exercise([self.call(1, {'url': 'https://example.org/'})], disable=True)
        self.assertEqual(sent, [])
        self.assertEqual(json.loads(replies[0]['result']['content'][0]['text'])['code'], 'LOCAL_TOOL_UNAVAILABLE')

    def test_cached_catalog_calls_forward_and_out_of_order_ids_remain_independent(self):
        replies, sent = self.exercise([self.call('A', {'url': 'https://example.org/a'}),
                                      self.call(42, {'url': 'https://example.org/b'})], reverse_pair=True)
        self.assertEqual([item['id'] for item in sent], ['A', 42])
        self.assertEqual([item['id'] for item in replies], [42, 'A'])
        self.assertTrue(all(item['params']['name'] == 'firecrawl_scrape' for item in sent))
        self.assertTrue(all(item['result']['_meta']['localExecution']['tool'] == READ_NAME for item in replies))

    def test_alias_screenshot_keeps_image_blocks_and_readiness(self):
        encoded = base64.b64encode(b'fake-test-jpeg').decode()
        def answer(_):
            return {'content': [{'type': 'text', 'text': json.dumps({'markdown': 'intended marker',
                    'screenshot': 'data:image/jpeg;base64,' + encoded, 'metadata': {'statusCode': 200}})}]}
        replies, _ = self.exercise([self.call(5, {'url': 'https://example.org/', 'formats': ['markdown', 'screenshot']})], answer=answer)
        result = replies[0]['result']; blocks = result['content']
        self.assertEqual([b['type'] for b in blocks], ['text', 'image'])
        self.assertEqual(blocks[1]['data'], encoded)
        self.assertEqual(result['structuredContent']['metadata']['localContentCheck']['status'], 'checked')

    def test_catalog_adds_alias_and_missing_base_fails_closed(self):
        request = {'jsonrpc': '2.0', 'id': 6, 'method': 'tools/list', 'params': {}}
        replies, _ = self.exercise([request], answer=lambda _: {'tools': [base_tool()]})
        tools = replies[0]['result']['tools']
        self.assertEqual(sum(t['name'] == READ_NAME for t in tools), 1)
        self.assertFalse(next(t for t in tools if t['name'] == 'firecrawl_scrape')['annotations']['readOnlyHint'])
        replies, _ = self.exercise([request], answer=lambda _: {'tools': []})
        self.assertTrue(replies[0]['result']['isError'])
        self.assertEqual(json.loads(replies[0]['result']['content'][0]['text'])['code'], 'LOCAL_TOOL_UNAVAILABLE')


if __name__ == '__main__':
    unittest.main()
