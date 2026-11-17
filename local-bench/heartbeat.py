#!/usr/bin/env python3
"""Bounded deterministic checks against the fixed local Firecrawl API."""
import argparse,datetime,fcntl,hashlib,json,os,re,sqlite3,sys,tempfile,time,urllib.request,urllib.error,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parent
API="http://127.0.0.1:3012";ORIGIN="http://fixtures.firecrawl.test:8765"
PATHS=["/","/static.html","/javascript.html","/guide.html","/about.html"]
MARKERS=["index-marker-1182","alpha-marker-7319","js-marker-4826","guide-marker-2251","about-marker-6314"]
DEADLINE=0

def request(method,path,payload=None):
 remaining=DEADLINE-time.monotonic()
 if remaining<=0:raise RuntimeError("Suite deadline exceeded")
 req=urllib.request.Request(API+path,data=None if payload is None else json.dumps(payload).encode(),method=method,headers={"Content-Type":"application/json","Accept":"application/json"})
 try:
  with urllib.request.urlopen(req,timeout=min(90,remaining)) as response:return response.status,json.load(response)
 except urllib.error.HTTPError as exc:
  try:body=json.loads(exc.read(100000))
  except Exception:body={"success":False}
  return exc.code,body

def scrape(url,wait=0):
 return request("POST","/v2/scrape",{"url":url,"formats":["markdown"],"maxAge":0,"waitFor":wait,"timeout":20000})

def document(response):
 assert response[0]==200 and response[1].get("success") is True,"Scrape did not succeed"
 d=response[1].get("data",{});assert isinstance(d,dict) and d.get("markdown"),"Useful Markdown missing"
 return d

def audit(token):
 md=document(scrape(ORIGIN+"/security/audit/"+token)).get("markdown","")
 assert re.search(r"canary-count-0(?![0-9])",md),"Denied-target canary received a request"

def run_case(case):
 kind=case["kind"]
 if kind=="scrape":
  d=document(scrape(ORIGIN+case["path"],case.get("wait_for_ms",0)));md=d["markdown"]
  assert all(v in md for v in case.get("expected_markers",[])),"Expected content marker missing"
  assert all(v not in md for v in case.get("forbidden_markers",[])),"Forbidden content marker present"
  for k,v in case.get("metadata",{}).items():assert d.get("metadata",{}).get(k)==v,"Metadata assertion failed: "+k
  assert d.get("metadata",{}).get("sourceURL","").startswith(ORIGIN),"Source URL missing"
  return {"content_length":len(md),"content_sha256":hashlib.sha256(md.encode()).hexdigest(),"metadata_checks":list(case.get("metadata",{}))}
 if kind=="map":
  version=case.get("version",2);payload={"url":ORIGIN,"limit":10,"useIndex":False,"ignoreCache":True}
  payload.update({"sitemapOnly":True} if version==1 else {"sitemap":"only"})
  status,body=request("POST",f"/v{version}/map",payload)
  assert status==200 and body.get("success") is True,"Map did not succeed"
  urls=[v if isinstance(v,str) else v["url"] for v in body.get("links",[])]
  assert {ORIGIN+p for p in PATHS}<={u.rstrip('/')+'/' if u.rstrip('/')==ORIGIN else u for u in urls},"Map omitted expected fixture URLs"
  return {"url_count":len(urls),"api_version":version}
 if kind=="crawl":
  status,body=request("POST","/v1/crawl",{"url":ORIGIN,"limit":5,"scrapeOptions":{"formats":["markdown"],"waitFor":1200,"maxAge":0}})
  assert status==200 and body.get("id"),"Crawl did not start";job=body["id"]
  until=min(DEADLINE,time.monotonic()+240)
  while time.monotonic()<until:
   status,body=request("GET","/v1/crawl/"+job)
   assert status==200,"Crawl polling failed"
   if body.get("status") in ("failed","cancelled"):raise RuntimeError("Crawl reached unsuccessful terminal state")
   if body.get("status")=="completed":break
   time.sleep(2)
  assert body.get("status")=="completed","Crawl deadline expired"
  docs=body.get("data",[]);assert len(docs)==5,"Crawl must return exactly five pages"
  found={str(d.get("metadata",{}).get("sourceURL",d.get("metadata",{}).get("url",""))).rstrip('/'):d.get("markdown","") for d in docs}
  for path,marker in zip(PATHS,MARKERS):assert marker in found.get((ORIGIN+path).rstrip('/'),""),"Crawl content or URL missing"
  return {"crawl_id":job,"documents":len(docs),"terminal_state":"completed"}
 token=uuid.uuid4().hex
 if kind=="browser_security":
  d=document(scrape(ORIGIN+"/security/browser?token="+token,1800));md=d["markdown"]
  assert "browser-safety-marker" in md and "browser-rendered-marker" in md and "waiting-for-browser" not in md and "private-subresource-leaked" not in md,"Browser security content failed"
  audit(token);return {"canary_requests":0}
 if kind=="redirect":url=ORIGIN+"/security/redirect?token="+token+"&target="+case["target"]
 elif kind=="reject":
  target={"denied-host":"http://fixtures-denied.firecrawl.test:8765","alternate-port":"http://fixtures.firecrawl.test:8766","userinfo":"http://user:pass@fixtures.firecrawl.test:8765"}[case["target"]]
  url=target+"/security/probe?token="+token
 else:raise RuntimeError("Unsupported case kind")
 status,body=scrape(url)
 assert status>=400 or body.get("success") is False,"Forbidden target was accepted"
 audit(token);return {"rejected":True,"http_status":status,"canary_requests":0}

def atomic(path,data):
 with tempfile.NamedTemporaryFile('w',dir=path.parent,delete=False) as f:json.dump(data,f,indent=2);f.write('\n');tmp=f.name
 os.replace(tmp,path)

def main():
 global DEADLINE
 os.umask(0o077)
 ap=argparse.ArgumentParser();ap.add_argument('--config',default=str(ROOT/'cases/smoke-v1.json'));args=ap.parse_args()
 assert os.environ.get('FIRECRAWL_API_URL',API)==API,"Only the reviewed local API is permitted"
 assert os.environ.get('BENCH_FIXTURE_ORIGIN',ORIGIN)==ORIGIN,"Only the reviewed fixture origin is permitted"
 manifest=json.loads(Path(args.config).read_text());DEADLINE=time.monotonic()+manifest.get('deadline_seconds',300)
 var=ROOT/'var';var.mkdir(parents=True,exist_ok=True)
 with (var/'heartbeat.lock').open('a+') as lock:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:print('Another heartbeat is running; overlap skipped.');return 0
  runid=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ');dest=var/'runs'/runid;dest.mkdir(parents=True)
  db=sqlite3.connect(var/'state.sqlite3');db.execute('CREATE TABLE IF NOT EXISTS local_results(run_id TEXT,case_id TEXT,status TEXT,detail TEXT)')
  health=False;results=[]
  try:
   status,body=request('GET','/v0/health/readiness');health=status==200 and body.get('status')=='ok'
  except Exception:pass
  for case in manifest['cases']:
   started=time.monotonic();record={'case_id':case['id'],'kind':case['kind']}
   try:
    assert health,'Readiness failed';record.update(run_case(case));record['status']='passed'
   except Exception as exc:record.update(status='failed',error=(str(exc) or type(exc).__name__)[:250])
   record['duration_ms']=round((time.monotonic()-started)*1000);results.append(record)
   db.execute('INSERT INTO local_results VALUES(?,?,?,?)',(runid,case['id'],record['status'],json.dumps(record)));db.commit()
   print(json.dumps(record),flush=True)
  db.close();passed=sum(r['status']=='passed' for r in results)
  summary={'run_id':runid,'suite':manifest['suite'],'readiness':health,'status':'passed' if health and passed==len(results) else 'failed','passed':passed,'total':len(results),'results':results,'results_path':str(dest/'results.jsonl')}
  (dest/'results.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in results));atomic(dest/'summary.json',summary);atomic(var/'latest.json',summary)
  (dest/'report.md').write_text('# Firecrawl verification\n\nStatus: '+summary['status']+'\n\n'+''.join('- '+r['case_id']+': '+r['status']+'\n' for r in results))
  print(json.dumps({'status':summary['status'],'passed':passed,'total':len(results),'report':str(dest/'report.md')}));return 0 if summary['status']=='passed' else 1

if __name__=='__main__':raise SystemExit(main())
