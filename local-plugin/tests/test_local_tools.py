import importlib.util,json,tempfile,unittest
from pathlib import Path
SOURCE=Path(__file__).resolve().parents[1]/'lib/local_tools.py'
spec=importlib.util.spec_from_file_location('local_tools_test',SOURCE);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class LocalToolTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.body='Initial fixture body';self.calls=[]
  self.caps={'official_tools':{'firecrawl_scrape':{'enabled':True}},'features':{}}
  def request(method,path,payload=None,timeout=20):
   self.calls.append((method,path,payload))
   if path.endswith('readiness'):return {'status':'ready'}
   if self.body is None:raise module.LocalToolError('Deterministic local scrape error')
   return {'success':True,'data':{'markdown':self.body}}
  self.request=request;self.tools=module.LocalTools(self.root,self.caps,request)
 def tearDown(self):self.tmp.cleanup()
 def create(self):return self.tools.call('local_web_monitor_create',{'name':'Test','urls':['https://example.com/page']})['id']
 def test_manual_creation_no_fetch(self):
  identifier=self.create();m=self.tools.call('local_web_monitor_get',{'id':identifier})
  self.assertEqual(self.calls,[]);self.assertIsNone(m['schedule']);self.assertEqual(m['notifications'],'none')
  with self.assertRaises(module.LocalToolError):self.tools.call('local_web_monitor_create',{'name':'No','urls':['https://example.com'],'schedule':'daily'})
 def test_persistence_changes_delete(self):
  identifier=self.create();first=self.tools.call('local_web_monitor_run',{'id':identifier});self.assertEqual(first['summary']['new'],1)
  self.tools=module.LocalTools(self.root,self.caps,self.request)
  self.assertEqual(self.tools.call('local_web_monitor_run',{'id':identifier})['summary']['same'],1)
  self.body='Updated fixture body';changed=self.tools.call('local_web_monitor_run',{'id':identifier});self.assertEqual(changed['summary']['changed'],1);self.assertIn('excerpt_diff',changed['pages'][0])
  detail=self.tools.call('local_web_monitor_check',{'id':identifier,'checkId':changed['checkId']});self.assertEqual(detail['status'],'completed')
  self.tools.call('local_web_monitor_delete',{'id':identifier})
  with self.assertRaises(module.LocalToolError):self.tools.call('local_web_monitor_get',{'id':identifier})
 def test_error_preserves_last_success(self):
  identifier=self.create();self.tools.call('local_web_monitor_run',{'id':identifier});self.body=None
  self.assertEqual(self.tools.call('local_web_monitor_run',{'id':identifier})['status'],'failed')
  self.body='Initial fixture body';self.assertEqual(self.tools.call('local_web_monitor_run',{'id':identifier})['summary']['same'],1)
 def test_paused_and_lock(self):
  identifier=self.create();self.tools.call('local_web_monitor_update',{'id':identifier,'active':False})
  with self.assertRaises(module.LocalToolError):self.tools.call('local_web_monitor_run',{'id':identifier})
  with self.tools.locked():
   with self.assertRaises(module.LocalToolError):self.tools.call('local_web_monitor_update',{'id':identifier,'active':True})
 def test_limits_private_urls(self):
  for value in [['file:///etc/passwd'],['http://user:password@example.com'],['https://example.com']*6,['http://127.0.0.1'],['http://10.1.1.1'],['http://[::1]'],['http://localhost'],['http://service.internal']]:
   with self.assertRaises(module.LocalToolError,msg=str(value)):module.urls_value(value)
  with self.assertRaises(module.LocalToolError):module.pagination({'limit':True})
  identifier=self.create();self.body='x'*500001
  self.assertEqual(self.tools.call('local_web_monitor_run',{'id':identifier})['status'],'failed')
 def test_bounded_history_and_excerpt(self):
  identifier=self.create();self.body='A'*450+'FULL_BODY_TAIL_MUST_NOT_PERSIST'
  for _ in range(52):self.tools.call('local_web_monitor_run',{'id':identifier})
  self.assertEqual(len(self.tools.call('local_web_monitor_checks',{'id':identifier,'limit':50})['checks']),50)
  self.assertNotIn(b'FULL_BODY_TAIL_MUST_NOT_PERSIST',(self.root/'monitors.sqlite3').read_bytes())
  self.assertEqual((self.root/'monitors.sqlite3').stat().st_mode&0o777,0o600)
 def test_fixed_api_routes(self):
  identifier=self.create();self.tools.call('local_web_monitor_run',{'id':identifier});self.tools.call('local_web_status',{})
  self.assertTrue(all(path in {'/v2/scrape','/v0/health/readiness'} for _,path,_ in self.calls))
if __name__=='__main__':unittest.main()
