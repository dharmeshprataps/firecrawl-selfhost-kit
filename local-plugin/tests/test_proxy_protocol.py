"""Exercise real proxy routing, thread dispatch and error envelopes without network."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SOURCE=Path(__file__).resolve().parents[1]/'bin/local-mcp.py'
spec=importlib.util.spec_from_file_location('proxy_under_test',SOURCE)
proxy=importlib.util.module_from_spec(spec);spec.loader.exec_module(proxy)

class ProxyProtocolTests(unittest.TestCase):
    def exercise(self,requests,fetch=None,call=None):
        with tempfile.TemporaryDirectory()as folder:
            root=Path(folder);plugin=root/'plugin';(plugin/'runtime').mkdir(parents=True)
            runtime=root/'.local-state/mcp/node_modules/firecrawl-mcp';runtime.mkdir(parents=True)
            (runtime/'package.json').write_text(json.dumps({'version':'3.36.1'}))
            (plugin/'runtime/installation.json').write_text(json.dumps({'checkout':str(root),'api_url':'http://127.0.0.1:3012','node':'/opt/homebrew/bin/node','official_mcp_version':'3.36.1'}))
            caps=json.loads((SOURCE.parents[1]/'capabilities.json').read_text())
            (plugin/'capabilities.json').write_text(json.dumps(caps))
            child=SimpleNamespace(stdin=io.BytesIO(),stdout=io.BytesIO(),terminate=lambda:None,wait=lambda timeout:0,kill=lambda:None)
            class FakeTools:
                def __init__(self,*_):pass
                def call(self,name,args):return call(name,args)if call else {'ready':True}
                def fetch(self,*args,**kwargs):return fetch(*args,**kwargs)
            stream=SimpleNamespace(buffer=io.BytesIO(b''.join(json.dumps(r).encode()+b'\n'for r in requests)))
            output=io.StringIO()
            with patch.object(proxy,'PLUGIN',plugin),patch.object(proxy,'LocalTools',FakeTools),patch.object(proxy.subprocess,'Popen',return_value=child),patch.object(proxy.sys,'stdin',stream),contextlib.redirect_stdout(output):
                self.assertEqual(proxy.main(),0)
            return [json.loads(line)for line in output.getvalue().splitlines()], [json.loads(line)for line in child.stdin.getvalue().splitlines()]

    def request(self,identifier,name,args=None):return {'jsonrpc':'2.0','id':identifier,'method':'tools/call','params':{'name':name,'arguments':args or {}}}

    def test_typed_map_provider_failure_is_a_tool_error_not_invalid_argument(self):
        def fetch(*args,**kwargs):raise proxy.LocalToolError('Provider unavailable',code='SEARCH_PROVIDER_UNAVAILABLE',http_status=503)
        answers,_=self.exercise([self.request(1,'firecrawl_map',{'url':'https://example.org/'})],fetch=fetch)
        self.assertNotIn('error',answers[0])
        self.assertTrue(answers[0]['result']['isError'])
        body=json.loads(answers[0]['result']['content'][0]['text'])
        self.assertEqual((body['code'],body['httpStatus']),('SEARCH_PROVIDER_UNAVAILABLE',503))

    def test_partial_map_retains_useful_links_and_provider_diagnostics(self):
        response={'success':True,'links':[{'url':'https://example.org/docs'}],'partial':True,'warning':'Verified links only','discoveryError':{'code':'SEARCH_PROVIDER_UNAVAILABLE','status':503}}
        answers,_=self.exercise([self.request(1,'firecrawl_map',{'url':'https://example.org/'})],fetch=lambda *a,**k:response)
        self.assertFalse(answers[0]['result'].get('isError',False))
        self.assertEqual(json.loads(answers[0]['result']['content'][0]['text']),response)

    def test_local_operations_overlap_without_corrupting_rpc_ids(self):
        barrier=threading.Barrier(2);lock=threading.Lock();active=0;peak=0
        def call(name,args):
            nonlocal active,peak
            with lock:active+=1;peak=max(peak,active)
            barrier.wait(timeout=2);time.sleep(0.01)
            with lock:active-=1
            return {'ready':True,'marker':args.get('marker')}
        answers,_=self.exercise([self.request(10,'local_web_status'),self.request(11,'local_web_status')],call=call)
        self.assertEqual(peak,2);self.assertEqual({a['id']for a in answers},{10,11})
        self.assertTrue(all('localExecution'in a['result']['_meta']for a in answers))

    def test_readiness_extension_is_removed_before_the_pinned_sdk(self):
        _,forwarded=self.exercise([self.request(1,'firecrawl_scrape',{'url':'https://example.org/','formats':['markdown'],'expectedContent':['intended row']})])
        self.assertEqual(len(forwarded),1)
        self.assertNotIn('expectedContent',forwarded[0]['params']['arguments'])
        self.assertEqual(forwarded[0]['params']['arguments']['formats'],['markdown'])

    def test_batch_cache_controls_reach_the_companion_without_truthy_defaults(self):
        seen=[]
        args={'urls':['https://example.org/'],'maxAge':0,'storeInCache':False,
              'timeout':15000,'onlyMainContent':False,'expectedContent':['intended content']}
        def call(name,received):
            seen.append((name,received))
            return {'completed':1,'failed':0,'incomplete':0}
        answers,forwarded=self.exercise([self.request(19,'local_web_batch_scrape',args)],call=call)
        self.assertEqual(forwarded,[])
        self.assertEqual(seen,[('local_web_batch_scrape',args)])
        self.assertFalse(answers[0]['result'].get('isError',False))


    def test_pdf_limit_enables_parser_before_official_sidecar_conversion(self):
        args={'url':'https://example.org/document.pdf','formats':['markdown'],'pdfOptions':{'maxPages':2}}
        answers,forwarded=self.exercise([self.request(21,'firecrawl_scrape',args)])
        self.assertEqual(answers,[])
        sent=forwarded[0]['params']['arguments']
        self.assertEqual(sent['parsers'],['pdf'])
        self.assertEqual(sent['pdfOptions'],{'maxPages':2})
        self.assertEqual(sent['formats'],['markdown'])

    def test_nested_crawl_pdf_limit_preserves_official_path(self):
        _,forwarded=self.exercise([self.request(22,'firecrawl_crawl',{'url':'https://example.org/',
                                  'scrapeOptions':{'pdfOptions':{'maxPages':2},'parsers':['pdf']}})])
        self.assertEqual(len(forwarded),1)
        self.assertEqual(forwarded[0]['params']['arguments']['scrapeOptions'],{'pdfOptions':{'maxPages':2},'parsers':['pdf']})

    def test_conflicting_and_malformed_pdf_options_are_typed_local_errors(self):
        cases=[{'pdfOptions':{'maxPages':2},'parsers':[]},
               {'pdfOptions':{'maxPages':2},'parsers':None},
               {'pdfOptions':{'maxPages':0}}, {'pdfOptions':{'maxPages':True}},
               {'pdfOptions':{'maxPages':2.5}}, {'pdfOptions':{'maxPages':10001}},
               {'pdfOptions':{'maxPages':'2'}}, {'pdfOptions':None},
               {'pdfOptions':{'maxPages':2,'unreviewed':True}}]
        for options in cases:
            with self.subTest(options=options):
                answers,forwarded=self.exercise([self.request(23,'firecrawl_scrape',{'url':'https://example.org/document.pdf',**options})])
                self.assertEqual(forwarded,[])
                self.assertTrue(answers[0]['result']['isError'])
                payload=json.loads(answers[0]['result']['content'][0]['text'])
                self.assertEqual(payload['code'],'INVALID_ARGUMENT')

    def test_scrapes_without_pdf_options_do_not_change_parser_policy(self):
        _,forwarded=self.exercise([self.request(24,'firecrawl_scrape',{'url':'https://example.org/','parsers':[]})])
        self.assertEqual(forwarded[0]['params']['arguments']['parsers'],[])
