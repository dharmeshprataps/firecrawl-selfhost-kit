#!/usr/bin/env python3
import argparse,json,os,re,selectors,subprocess,time,uuid,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
TOOLS=['firecrawl_scrape','firecrawl_crawl','firecrawl_check_crawl_status','firecrawl_map']
ORIGIN='http://fixtures.firecrawl.test:8765'
class ToolError(RuntimeError):pass

def main():
 os.umask(0o077);ap=argparse.ArgumentParser();ap.add_argument('--list',action='store_true');ap.add_argument('--expect-down',action='store_true');args=ap.parse_args()
 var=ROOT/'.local-state/mcp';var.mkdir(parents=True,exist_ok=True)
 with (var/'stderr.log').open('ab') as err:
  trace=var/'requests.jsonl';trace_offset=trace.stat().st_size if trace.exists() else 0
  p=subprocess.Popen([str(ROOT/'local-plugin/bin/firecrawl-mcp')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,bufsize=0)
  sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ);buffer=b'';seq=0;records=[]
  def rpc(method,params,timeout=150):
   nonlocal buffer,seq
   seq+=1;request_id=seq;p.stdin.write((json.dumps({'jsonrpc':'2.0','id':request_id,'method':method,'params':params})+'\n').encode());p.stdin.flush();until=time.monotonic()+timeout
   while time.monotonic()<until:
    while b'\n' in buffer:
     line,buffer=buffer.split(b'\n',1)
     if not line:continue
     message=json.loads(line)
     if message.get('id')==request_id:
      if 'error' in message:raise RuntimeError('MCP protocol returned an error')
      return message['result']
    if not sel.select(max(0,until-time.monotonic())):break
    data=os.read(p.stdout.fileno(),65536)
    if not data:raise RuntimeError('MCP process exited')
    buffer+=data
   raise RuntimeError('MCP operation timed out')
  def tool(name,arguments):
   result=rpc('tools/call',{'name':name,'arguments':arguments})
   if result.get('isError'):raise ToolError(json.dumps(result))
   for item in result.get('content',[]):
    if item.get('type')=='text':
     try:return json.loads(item['text'])
     except json.JSONDecodeError:pass
   return result.get('structuredContent',{})
  try:
   init=rpc('initialize',{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'firecrawl-local-acceptance','version':'1.0'}})
   p.stdin.write((json.dumps({'jsonrpc':'2.0','method':'notifications/initialized'})+'\n').encode());p.stdin.flush()
   listed=rpc('tools/list',{});names=[t['name'] for t in listed['tools']];assert set(TOOLS)<=set(names),'Required core tools missing'
   records.append({'check':'initialize-and-tools','status':'passed','server':init.get('serverInfo'),'core_tools':TOOLS,'listed_count':len(names)})
   if args.expect_down:
    try:tool('firecrawl_scrape',{'url':ORIGIN+'/static.html','formats':['markdown'],'maxAge':0})
    except ToolError as exc:
     assert re.search(r'ECONNREFUSED|connection refused|could not connect|connect failed|network error|socket hang up|ECONNRESET|fetch failed',str(exc),re.I),'Expected local connection failure missing'
     with trace.open('rb') as f:f.seek(trace_offset);attempts=[json.loads(v) for v in f.read().splitlines() if v]
     assert attempts and all(v['url'].startswith('http://127.0.0.1:3012/') and v['transport']!='blocked' for v in attempts),'Unexpected MCP outbound destination'
     try:urllib.request.urlopen('http://127.0.0.1:3012/v0/health/readiness',timeout=2)
     except Exception:pass
     else:raise RuntimeError('Local API was still responding')
     records.append({'check':'API-stopped','status':'passed','behavior':'explicit local connection error','local_attempts':len(attempts),'nonlocal_attempts':0})
    else:raise RuntimeError('MCP unexpectedly succeeded with API stopped')
   elif not args.list:
    marker=uuid.uuid4().hex
    d=tool('firecrawl_scrape',{'url':ORIGIN+'/static.html?mcp_probe='+marker,'formats':['markdown'],'maxAge':0})
    if 'data' in d and isinstance(d['data'],dict):d=d['data']
    assert 'alpha-marker-7319' in d.get('markdown',''),'MCP scrape content missing'
    records.append({'check':'scrape','status':'passed','correlation_marker':marker})
    d=tool('firecrawl_map',{'url':ORIGIN,'sitemap':'only','limit':10});links=d.get('links',d.get('data',{}).get('links',[]))
    urls={v.rstrip('/') if isinstance(v,str) else v['url'].rstrip('/') for v in links};assert {ORIGIN+p for p in ['', '/static.html','/javascript.html','/guide.html','/about.html']}<=urls,'MCP map omitted fixture URLs';records.append({'check':'map','status':'passed','urls':len(links)})
    d=tool('firecrawl_crawl',{'url':ORIGIN,'limit':5,'sitemap':'include','allowExternalLinks':False,'allowSubdomains':False,'scrapeOptions':{'formats':['markdown'],'maxAge':0,'waitFor':1200}})
    assert d.get('status')=='completed' and len(d.get('data',[]))==5,'MCP crawl did not complete with five pages'
    found={v.get('metadata',{}).get('sourceURL','').rstrip('/'):v.get('markdown','') for v in d['data']}
    for path,marker in [('', 'index-marker-1182'),('/static.html','alpha-marker-7319'),('/javascript.html','js-marker-4826'),('/guide.html','guide-marker-2251'),('/about.html','about-marker-6314')]:assert marker in found.get(ORIGIN+path,''),'MCP crawl content missing'
    job=d.get('id');assert job,'MCP crawl ID missing'
    records.append({'check':'crawl','status':'passed','crawl_id':job,'documents':len(d['data'])})
    d=tool('firecrawl_check_crawl_status',{'id':job});assert d.get('status')=='completed';records.append({'check':'crawl-status','status':'passed'})
   report={'status':'passed','mode':'api-stopped' if args.expect_down else 'list' if args.list else 'live','records':records}
  except Exception as exc:report={'status':'failed','error':str(exc),'records':records}
  finally:
   p.terminate()
   try:p.wait(timeout=5)
   except subprocess.TimeoutExpired:p.kill();p.wait(timeout=5)
   sel.close()
 report_path=var/('verification-'+report['mode']+'.json' if 'mode' in report else 'verification-failed.json');report_path.write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps(report));return 0 if report['status']=='passed' else 1

if __name__=='__main__':raise SystemExit(main())
