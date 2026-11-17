import importlib.util
from pathlib import Path
import tempfile
import unittest
import threading
import time
import json

SOURCE = Path(__file__).resolve().parents[1] / 'lib/local_tools.py'
spec = importlib.util.spec_from_file_location('local_companions_test', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CompanionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.calls = []
        self.answer = {'success': True, 'data': {'attributes': [{'selector': '#facts', 'attribute': 'data-count', 'values': ['42']}], 'metadata': {'sourceURL': 'https://example.com/page'}, 'markdown': 'This must be omitted from attribute output.'}}

        def request(method, path, payload=None, timeout=20):
            self.calls.append((method, path, payload, timeout))
            if isinstance(self.answer, Exception):
                raise self.answer
            return self.answer

        self.tools = module.LocalTools(Path(self.temp.name), {}, request)

    def tearDown(self):
        self.temp.cleanup()

    def attributes(self, **changes):
        args = {'url': 'https://example.com/page#section', 'selectors': [{'selector': '#facts', 'attribute': 'data-count'}]}
        args.update(changes)
        return self.tools.call('local_web_attributes', args)

    def test_attributes_fixed_endpoint_and_output(self):
        result = self.attributes()
        self.assertEqual(set(result), {'attributes', 'metadata'})
        self.assertEqual(result['attributes'][0]['values'], ['42'])
        method, path, payload, timeout = self.calls[0]
        self.assertEqual((method, path, timeout), ('POST', '/v2/scrape', 20))
        self.assertEqual(payload, {'url': 'https://example.com/page', 'formats': [{'type': 'attributes', 'selectors': [{'selector': '#facts', 'attribute': 'data-count'}]}], 'maxAge': 0, 'timeout': 15000})
        self.assertFalse((Path(self.temp.name) / 'monitors.sqlite3').exists())

    def test_attributes_empty_result_is_valid(self):
        self.answer['data']['attributes'] = []
        self.assertEqual(self.attributes()['attributes'], [])

    def test_invalid_selectors_fail_before_any_request(self):
        for selectors in [None, [], [{}], [{'selector': '#x'}], [{'selector': '#x', 'attribute': 'id', 'script': 'bad'}], [{'selector': ' ', 'attribute': 'id'}], [{'selector': 'x' * 501, 'attribute': 'id'}], [{'selector': '#x', 'attribute': 'a' * 81}], [{'selector': '#x', 'attribute': 3}], [{'selector': '#x\n', 'attribute': 'id'}], [{'selector': '#x', 'attribute': 'id'}] * 11]:
            with self.subTest(selectors=selectors):
                with self.assertRaises(module.LocalToolError):
                    self.attributes(selectors=selectors)
        self.assertEqual(self.calls, [])

    def test_public_url_and_top_level_argument_checks(self):
        for url in ['http://127.0.0.1/', 'http://[::1]/', 'http://service.internal/', 'file:///etc/passwd', 'https://user:pass@example.com/']:
            with self.assertRaises(module.LocalToolError):
                self.attributes(url=url)
            with self.assertRaises(module.LocalToolError):
                self.tools.call('local_web_batch_scrape', {'urls': [url]})
        with self.assertRaises(module.LocalToolError):
            self.attributes(proxy='cloud')
        self.assertEqual(self.calls, [])

    def test_malformed_attribute_provider_response_fails(self):
        for answer in [{'success': False}, {'success': True, 'data': {'attributes': None}}, {'success': True, 'data': {'attributes': {}}}, {'success': True, 'data': {'attributes': [], 'metadata': []}}]:
            self.answer = answer
            with self.assertRaises(module.LocalToolError):
                self.attributes()

    def test_attribute_outage_has_one_local_attempt(self):
        self.answer = module.LocalToolError('Cannot reach local Firecrawl API')
        with self.assertRaises(module.LocalToolError):
            self.attributes()
        self.assertEqual(len(self.calls), 1)

    def test_batch_is_parallel_bounded_and_partial(self):
        active = []
        calls = []

        def request(method, path, payload=None, timeout=20):
            active.append(payload['url'])
            calls.append((method, path, payload, timeout))
            active.pop()
            if payload['url'].endswith('/blocked'):
                raise module.LocalToolError('Target denied access')
            return {'success': True, 'data': {'markdown': 'A' * 100001}}

        self.tools.request = request
        result = self.tools.call('local_web_batch_scrape', {'urls': ['https://example.com/ok', 'https://example.com/blocked']})
        self.assertEqual(result['status'], 'partial')
        self.assertEqual((result['completed'], result['failed']), (1, 1))
        self.assertEqual(result['execution'], 'bounded parallel local scrapes')
        self.assertEqual(result['concurrency'], 2)
        self.assertFalse(result['cloud_fallback'])
        self.assertEqual(len(result['documents'][0]['markdown']), 100000)
        self.assertTrue(result['documents'][0]['truncated'])
        self.assertEqual(result['documents'][0]['characters'], 100001)
        self.assertEqual(result['documents'][1]['status'], 'error')
        self.assertEqual({c[2]['url'] for c in calls}, {'https://example.com/ok', 'https://example.com/blocked'})
        self.assertTrue(all((c[0], c[1], c[2]['timeout'], c[3]) == ('POST', '/v2/scrape', 15000, 20) for c in calls))
        self.assertFalse((Path(self.temp.name) / 'monitors.sqlite3').exists())

    def test_batch_validates_all_urls_before_request(self):
        for urls in [[], ['https://example.com/'] * 6, ['https://example.com/', 'http://localhost/']]:
            with self.assertRaises(module.LocalToolError):
                self.tools.call('local_web_batch_scrape', {'urls': urls})
        self.assertEqual(self.calls, [])

    def test_batch_empty_markdown_fails_and_duplicates_are_deduplicated(self):
        self.answer = {'success': True, 'data': {'markdown': '   '}}
        result = self.tools.call('local_web_batch_scrape', {'urls': ['https://example.com', 'https://example.com/']})
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(result['documents']), 1)

    def test_batch_defaults_preserve_the_existing_fresh_api_contract(self):
        result = self.tools.call('local_web_batch_scrape', {'urls': ['https://example.com/page']})
        self.assertEqual(self.calls, [('POST', '/v2/scrape', {
            'url': 'https://example.com/page', 'formats': ['markdown'],
            'onlyMainContent': True, 'maxAge': 0, 'timeout': 15000}, 20)])
        self.assertEqual(result['scrape_options'], {'onlyMainContent': True, 'maxAge': 0, 'timeout': 15000})
        self.assertNotIn('storeInCache', self.calls[0][2])

    def test_fresh_batch_preserves_explicit_zero_false_and_expected_content(self):
        self.answer = {'success': True, 'data': {'markdown': 'Fresh topic', 'metadata': {'statusCode': 200}}}
        options = {'maxAge': 0, 'storeInCache': False, 'timeout': 16001, 'onlyMainContent': False}
        urls = ['https://example.com/one', 'https://example.com/two']
        result = self.tools.call('local_web_batch_scrape', {'urls': urls, 'expectedContent': ['Fresh'], **options})
        self.assertEqual((result['completed'], result['failed'], result['incomplete']), (2, 0, 0))
        self.assertEqual(result['scrape_options'], options)
        self.assertEqual([page['url'] for page in result['documents']], urls)
        for method, path, payload, timeout in self.calls:
            self.assertEqual((method, path, timeout), ('POST', '/v2/scrape', 21.001))
            self.assertEqual(payload, {'url': payload['url'], 'formats': ['markdown'], **options})
            self.assertNotIn('expectedContent', payload)
        self.assertTrue(all(page['content_check']['status'] == 'checked' for page in result['documents']))

    def test_bounded_batch_cache_and_timeout_options_forward_exactly(self):
        for max_age, timeout, store in [(0, 1000, False), (604800000, 20000, True)]:
            with self.subTest(max_age=max_age, timeout=timeout, store=store):
                self.calls.clear()
                self.tools.call('local_web_batch_scrape', {'urls': ['https://example.com/'],
                    'maxAge': max_age, 'timeout': timeout, 'storeInCache': store})
                self.assertEqual(self.calls[0][2]['maxAge'], max_age)
                self.assertEqual(self.calls[0][2]['timeout'], timeout)
                self.assertIs(self.calls[0][2]['storeInCache'], store)
                self.assertEqual(self.calls[0][3], timeout / 1000 + 5)

    def test_bad_batch_options_fail_before_any_network_request(self):
        cases = {
            'maxAge': [-1, 604800001, True, False, 0.0, '0', None, float('nan'), float('inf')],
            'timeout': [0, 999, 20001, True, 15000.0, '15000', None],
            'storeInCache': [0, 1, 'false', None],
            'onlyMainContent': [0, 1, 'true', None],
        }
        for field, values in cases.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    with self.assertRaises(module.LocalToolError) as caught:
                        self.tools.call('local_web_batch_scrape', {'urls': ['https://example.com/'], field: value})
                    self.assertEqual(caught.exception.code, 'INVALID_ARGUMENT')
        for extra in [{'apiUrl': 'https://example.com'}, {'headers': {'Authorization': 'unreviewed'}},
                      {'formats': ['rawHtml']}, {'proxy': 'stealth'}, {'maxAgeMs': 0}]:
            with self.assertRaises(module.LocalToolError):
                self.tools.call('local_web_batch_scrape', {'urls': ['https://example.com/'], **extra})
        self.assertEqual(self.calls, [])

    def test_batch_schema_exposes_bounded_controls_without_a_new_tool(self):
        self.assertEqual(len(module.LOCAL_TOOLS), 12)
        schema = next(tool['inputSchema'] for tool in module.LOCAL_TOOLS if tool['name'] == 'local_web_batch_scrape')
        self.assertFalse(schema['additionalProperties'])
        self.assertEqual(schema['required'], ['urls'])
        self.assertEqual(schema['properties']['maxAge'], module.BATCH_OPTIONS['maxAge'])
        self.assertEqual(schema['properties']['maxAge']['default'], 0)
        self.assertEqual(schema['properties']['timeout']['maximum'], 20000)
        self.assertEqual(schema['properties']['storeInCache']['type'], 'boolean')
        self.assertEqual(schema['properties']['onlyMainContent']['default'], True)

    def test_expected_content_beyond_batch_output_cap_is_explicitly_incomplete(self):
        marker = 'required financial row'
        markdown = 'A' * 100001 + marker
        self.answer = {'success': True, 'data': {'markdown': markdown, 'metadata': {'statusCode': 200}}}
        result = self.tools.call('local_web_batch_scrape', {'urls': ['https://example.com/'], 'expectedContent': [marker]})
        page = result['documents'][0]
        self.assertEqual((result['completed'], result['failed'], result['incomplete']), (0, 0, 1))
        self.assertEqual(page['status'], 'incomplete')
        self.assertTrue(page['truncated'])
        self.assertEqual(page['characters'], len(markdown))
        self.assertEqual(page['returned_characters'], 100000)
        self.assertEqual(len(page['markdown']), 100000)
        self.assertNotIn(marker, page['markdown'])
        self.assertIn('expected_content_not_returned_due_to_truncation', page['content_check']['reasons'])
        self.assertEqual(page['content_check']['missingReturnedExpectedContent'], [marker])

    def test_expected_content_within_batch_output_cap_can_pass_without_hiding_full_checks(self):
        marker = 'required financial row'
        within = 'A' * (100000 - len(marker)) + marker + 'B' * 100
        self.answer = {'success': True, 'data': {'markdown': within, 'metadata': {'statusCode': 200}}}
        result = self.tools.call('local_web_batch_scrape', {'urls': ['https://example.com/'], 'expectedContent': [marker]})
        page = result['documents'][0]
        self.assertEqual((result['completed'], result['failed'], result['incomplete']), (1, 0, 0))
        self.assertIn(marker, page['markdown'])
        self.assertEqual(page['content_check']['status'], 'checked')
        self.assertTrue(page['truncated'])
        self.assertEqual(page['characters'], len(within))
        self.assertEqual(page['returned_characters'], 100000)
        # A loading-only table outside the returned cap must still fail the full-source check.
        self.answer['data']['markdown'] = within + '\n\n| A | B |\n| --- | --- |\n| Loading… | |\n'
        incomplete = self.tools.call('local_web_batch_scrape', {'urls': ['https://example.com/'], 'expectedContent': [marker]})
        self.assertEqual(incomplete['incomplete'], 1)
        self.assertIn('loading_table_without_rows', incomplete['documents'][0]['content_check']['reasons'])


if __name__ == '__main__':
    unittest.main()

class AccuracyBoundaryTests(unittest.TestCase):
    def test_batch_retains_target_404_in_successful_api_envelope(self):
        def request(method,path,payload=None,timeout=20):
            bad=payload['url'].endswith('/missing')
            return {'success':True,'data':{'markdown':'Page not found' if bad else 'Useful intended content','metadata':{'statusCode':404 if bad else 200,'sourceURL':payload['url'],'title':'Missing' if bad else 'Present'}}}
        with tempfile.TemporaryDirectory() as root:
            tools=module.LocalTools(root,{},request)
            result=tools.call('local_web_batch_scrape',{'urls':['https://example.com/one','https://example.com/missing','https://example.com/two']})
        self.assertEqual((result['completed'],result['failed'],result['incomplete']),(2,1,0))
        self.assertEqual(result['documents'][1]['http_status'],404)
        self.assertEqual(result['documents'][1]['metadata']['title'],'Missing')
        self.assertEqual(result['documents'][1]['error_code'],'TARGET_HTTP_ERROR')
        self.assertEqual(result['status'],'partial')

    def test_two_batch_requests_overlap_and_five_urls_remain_ordered(self):
        lock=threading.Lock(); barrier=threading.Barrier(2); active=0; peak=0;calls=0
        def request(method,path,payload=None,timeout=20):
            nonlocal active,peak,calls
            with lock:
                active+=1;peak=max(peak,active);calls+=1;first_pair=calls<=2
            if first_pair: barrier.wait(timeout=2)
            time.sleep(0.01)
            with lock: active-=1
            return {'success':True,'data':{'markdown':'Ready '+payload['url'],'metadata':{'statusCode':200}}}
        urls=['https://example.com/'+str(n)for n in range(5)]
        with tempfile.TemporaryDirectory() as root:
            result=module.LocalTools(root,{},request).call('local_web_batch_scrape',{'urls':urls})
        self.assertEqual(peak,2);self.assertEqual(result['completed'],5)
        self.assertEqual([d['url']for d in result['documents']],urls)

    def test_loading_table_and_missing_expected_content_are_incomplete(self):
        markdown='# Market\n\n| Symbol | Price |\n| --- | --- |\n| Loading… | |\n\nCopyright market.'
        check=module.content_check({'markdown':markdown,'metadata':{'statusCode':200}})
        self.assertEqual(check['status'],'incomplete')
        self.assertIn('loading_table_without_rows',check['reasons'])
        message=module.annotate_scrape_message({'result':{'content':[{'type':'text','text':json.dumps({'markdown':markdown,'metadata':{'statusCode':200}})}]}})
        self.assertTrue(message['result']['isError'])
        self.assertEqual(message['result']['structuredContent']['metadata']['statusCode'],200)
        self.assertIn('incomplete',message['result']['structuredContent']['warning'])
        self.assertEqual(module.content_check({'markdown':'NIFTY table ready'},['actual row'])['status'],'incomplete')

    def test_populated_tables_and_loading_documentation_are_not_false_failures(self):
        for markdown in ['Documentation for loading a module.', '| Symbol | Price |\n| --- | --- |\n| NIFTY 50 | 12345.67 |', 'An example:\n```markdown\n| A | B |\n| --- | --- |\n| Loading… | |\n```\nEnd.']:
            check=module.content_check({'markdown':markdown,'metadata':{'statusCode':200}})
            self.assertEqual(check['status'],'checked',markdown)
            self.assertFalse(check['accuracyVerified'])

    def test_explicit_expected_content_and_bounded_metadata(self):
        with tempfile.TemporaryDirectory() as root:
            def request(*args,**kwargs):return {'success':True,'data':{'markdown':'Some useful page','metadata':{'statusCode':200,'description':'x'*20000}}}
            tools=module.LocalTools(root,{},request)
            result=tools.call('local_web_batch_scrape',{'urls':['https://example.com'],'expectedContent':['required table row']})
            page=result['documents'][0]
            self.assertEqual((result['completed'],result['incomplete']),(0,1))
            self.assertTrue(page['metadata_truncated'])
            self.assertLess(len(json.dumps(page['metadata'])),16384)
            for expected in [[],[''],['a']*11,42]:
                with self.assertRaises(module.LocalToolError): tools.call('local_web_batch_scrape',{'urls':['https://example.com'],'expectedContent':expected})

    def test_provider_error_keeps_machine_readable_code_and_http_status(self):
        error=module.api_http_error(503,b'{"success":false,"code":"SEARCH_PROVIDER_UNAVAILABLE","error":"Temporary provider outage"}')
        self.assertEqual(error.response()['code'],'SEARCH_PROVIDER_UNAVAILABLE')
        self.assertEqual(error.response()['httpStatus'],503)
        self.assertNotEqual(error.response()['code'],'INVALID_ARGUMENT')
