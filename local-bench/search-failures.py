#!/usr/bin/env python3
"""Exercise local search failures; restore the production stack in a finally block.

--mode fixture briefly recreates only the API with a reviewed deterministic search
provider override. --mode outage stops only SearXNG. Never prints Compose secrets.
"""
import argparse,datetime,json,os,subprocess,tempfile,time,urllib.error,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
API='http://127.0.0.1:3012'
ENV={'HOME':str(Path.home()),'PATH':'/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'}
BASE=['/opt/homebrew/bin/docker','--context','colima-firecrawl','compose','--project-name','firecrawl','--project-directory',str(ROOT),'--env-file',str(ROOT/'.env.local'),'-f',str(ROOT/'docker-compose.yaml'),'-f',str(ROOT/'compose.override.yaml')]

def compose(*args,override=None):
 command=BASE+(['-f',str(override)] if override else [])+list(args)
 result=subprocess.run(command,env=ENV,text=True,capture_output=True)
 if result.returncode:raise RuntimeError('Compose operation failed: '+args[0])
 return result.stdout

def request(path,body=None):
 req=urllib.request.Request(API+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=25) as response:return response.status,json.load(response)
 except urllib.error.HTTPError as error:
  return error.code,json.loads(error.read(100000))

def ready():
 deadline=time.monotonic()+120
 while time.monotonic()<deadline:
  try:
   if request('/v0/health/readiness')[0]==200:return
  except (OSError,ValueError):pass
  time.sleep(1)
 raise RuntimeError('API did not become ready')

def wait_provider():
 deadline=time.monotonic()+90
 while time.monotonic()<deadline:
  status=compose('ps','--format','json','searxng').strip()
  if status:
   data=json.loads(status);service=data[0] if isinstance(data,list) else data
   if service.get('Health')=='healthy':return
  time.sleep(1)
 raise RuntimeError('Search provider did not become healthy after restoration')

def search(query,**extra):return request('/v2/search',{'query':query,'limit':2,'sources':['web'],**extra})

def failure(mode,version='v2'):
 status,body=request('/'+version+'/search',{'query':'LOCAL_SEARCH_FIXTURE_'+mode,'limit':2})
 assert status==503 and body.get('code')=='SEARCH_PROVIDER_UNAVAILABLE',f'{mode}: expected explicit provider503, got{status}'
 return {'case':mode+'-'+version,'http_status':status,'code':body['code']}

def partial_map_outage(status,body):
 assert status==200 and body.get('success') is True and body.get('partial') is True,f'Map outage: expected useful partial200, got{status}'
 failure=body.get('discoveryError',{})
 assert failure.get('code')=='SEARCH_PROVIDER_UNAVAILABLE' and failure.get('status')==503,'Map outage lost the typed provider failure'
 links=body.get('links',[])
 urls=[entry.get('url') if isinstance(entry,dict) else entry for entry in links]
 assert urls and all(isinstance(url,str) and url.startswith('https://docs.python.org/3/') for url in urls),'Map outage returned no in-scope fallback URLs'
 assert any(url.rstrip('/')!='https://docs.python.org/3' for url in urls),'Map outage returned only the seed URL'
 return {'case':'map-provider-stopped','http_status':status,'partial':True,'code':failure['code'],'provider_http_status':failure['status'],'urls':urls}

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--mode',choices=['fixture','outage'],required=True);args=parser.parse_args()
 os.umask(0o077);records=[];override=None;restore=False;restored=False
 before=json.loads(compose('config','--format','json'))
 assert before['services']['api']['environment']['SEARXNG_ENDPOINT']=='http://searxng:8080','Production search endpoint differs; refusing test mutation'
 assert [(name,port['host_ip'],str(port['published'])) for name,service in before['services'].items() for port in service.get('ports',[])]==[('api','127.0.0.1','3012')]
 try:
  if args.mode=='outage':
   restore=True;compose('stop','searxng')
   records.append(failure('PROVIDER_STOPPED'))
   records.append(failure('PROVIDER_STOPPED','v1'))
   status,body=request('/v2/map',{'url':'https://docs.python.org/3/','sitemap':'skip','useIndex':False,'ignoreCache':True,'limit':2})
   records.append(partial_map_outage(status,body))
  else:
   handle,path=tempfile.mkstemp(prefix='search-fixture-',suffix='.override.json',dir=ROOT/'.local-state');override=Path(path)
   with os.fdopen(handle,'w') as file:json.dump({'services':{'api':{'environment':{'SEARXNG_ENDPOINT':'http://fixtures.firecrawl.test:8765'}}}},file)
   merged=json.loads(compose('config','--format','json',override=override));expected=json.loads(json.dumps(before));expected['services']['api']['environment']['SEARXNG_ENDPOINT']='http://fixtures.firecrawl.test:8765'
   assert merged==expected,'Fixture override changed more than the intended endpoint'
   restore=True;compose('up','-d','--no-build','--pull','never','--no-deps','--force-recreate','api',override=override);ready()
   status,body=search('LOCAL_SEARCH_FIXTURE_OK');urls=[item['url'] for item in body.get('data',{}).get('web',[])]
   assert status==200 and urls==['https://docs.python.org/3/','https://docs.python.org/3/library/'],'Fixture valid/deduplicated URL check failed'
   records.append({'case':'fixture-valid','http_status':status,'urls':urls})
   for mode in ('FAILURE','MALFORMED','ALLFAILED','TIMEOUT'):records.append(failure(mode))
   records.append(failure('FAILURE','v1'))
   status,body=search('LOCAL_SEARCH_FIXTURE_EMPTY');assert status==200 and not body.get('data',{}).get('web');records.append({'case':'fixture-empty','http_status':status})
   status,body=search('LOCAL_SEARCH_FIXTURE_PARTIAL');assert status==200 and len(body['data']['web'])==1;records.append({'case':'fixture-partial','http_status':status,'results':1})
   for source in ('images','news'):
    status,body=search('LOCAL_SEARCH_FIXTURE_OK',sources=[source]);assert status==501 and body.get('code')=='SEARCH_CAPABILITY_UNAVAILABLE';records.append({'case':source+'-unsupported','http_status':status})
   status,body=search('LOCAL_SEARCH_FIXTURE_OK',categories=['developer']);assert status==501;records.append({'case':'hosted-developer-unsupported','http_status':status})
 finally:
  if restore:
   if args.mode=='fixture':compose('up','-d','--no-build','--pull','never','--no-deps','--force-recreate','api')
   else:compose('up','-d','--no-build','--pull','never','--no-deps','searxng')
   ready();wait_provider();restored=True
  if override:override.unlink(missing_ok=True)
 stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
 dest=ROOT/'local-bench/var/enhancement';dest.mkdir(parents=True,exist_ok=True)
 report={'mode':args.mode,'production_restored':restored,'passed':len(records),'checks':records}
 (dest/('search-'+args.mode+'-'+stamp+'.json')).write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps(report,indent=2))
if __name__=='__main__':main()
