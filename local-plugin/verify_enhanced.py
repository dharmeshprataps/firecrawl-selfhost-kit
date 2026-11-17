#!/usr/bin/env python3
"""Functional stdio checks against the installed cache; never logs page bodies."""
import argparse, json, os, selectors, subprocess, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
ORIGIN='http://fixtures.firecrawl.test:8765'
def main():
 os.umask(0o077);ap=argparse.ArgumentParser();ap.add_argument('--launcher',type=Path,default=ROOT/'local-plugin/bin/firecrawl-mcp');args=ap.parse_args()
 out=ROOT/'local-bench/var/enhancement';out.mkdir(parents=True,exist_ok=True);records=[]
 with (out/'mcp-enhanced.stderr.log').open('ab') as err:
  p=subprocess.Popen([str(args.launcher)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,bufsize=0)
  sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ);buf=b'';seq=0
  def rpc(method,params,timeout=170):
   nonlocal seq,buf
   seq+=1;i=seq;p.stdin.write((json.dumps({'jsonrpc':'2.0','id':i,'method':method,'params':params})+'\n').encode());p.stdin.flush();end=time.monotonic()+timeout
   while time.monotonic()<end:
    while b'\n' in buf:
     line,buf=buf.split(b'\n',1)
     if not line:continue
     d=json.loads(line)
     if d.get('id')==i:
      if 'error'in d:raise RuntimeError('MCP protocol error')
      return d['result']
    if not sel.select(max(0,end-time.monotonic())):break
    data=os.read(p.stdout.fileno(),65536)
    if not data:raise RuntimeError('MCP process exited')
    buf+=data
   raise RuntimeError('MCP operation timed out')
  def result(name,a):return rpc('tools/call',{'name':name,'arguments':a})
  def tool(name,a):
   d=result(name,a)
   if d.get('isError'):raise RuntimeError('Local tool failed: '+name)
   if isinstance(d.get('structuredContent'),dict):return d['structuredContent']
   for b in d.get('content',[]):
    if b.get('type')=='text':
     try:return json.loads(b['text'])
     except ValueError:pass
   raise RuntimeError('Tool returned no JSON')
  def doc(d):return d.get('data',d)
  def check(name,fn,optional=False):
   started=time.monotonic()
   try:details=fn() or {};r={'check':name,'status':'passed',**details}
   except Exception as exc:r={'check':name,'status':'blocked' if optional else 'failed','error':str(exc)[:220]}
   r['seconds']=round(time.monotonic()-started,3);records.append(r);print(json.dumps(r),flush=True)
  monitor=None
  try:
   init=rpc('initialize',{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'local-enhancement-verifier','version':'1'}})
   p.stdin.write((json.dumps({'jsonrpc':'2.0','method':'notifications/initialized'})+'\n').encode());p.stdin.flush()
   catalog=rpc('tools/list',{})['tools'];names={t['name'] for t in catalog}
   assert 'firecrawl_search'in names and 'local_web_monitor_run'in names and 'firecrawl_agent'not in names
   assert 'Cloud'not in init.get('instructions','').replace('Firecrawl Cloud','') or 'Never' in init.get('instructions','')
   records.append({'check':'installed-cache-catalog','status':'passed','tools':sorted(names),'launcher':str(args.launcher)})
   def status():
    d=tool('local_web_status',{});assert d['ready'] is True;return {'ready':True}
   check('readiness',status)
   def extraction():
    d=doc(tool('firecrawl_scrape',{'url':ORIGIN+'/structured.html','formats':['json','summary'],'jsonOptions':{'schema':{'type':'object','properties':{'project':{'type':'string'},'value':{'type':'number'},'active':{'type':'boolean'}},'required':['project','value','active'],'additionalProperties':False},'prompt':'Extract the exact project, value and active facts.'},'maxAge':0}))
    assert d['json']=={'project':'Orchid Local','value':42,'active':False};assert '42'in d['summary'];return {'schema_valid':True,'facts_exact':True}
   check('official-mcp-json-summary',extraction)
   def browser():
    d=result('firecrawl_scrape',{'url':ORIGIN+'/interactive.html','formats':['markdown'],'actions':[{'type':'click','selector':'#editor'},{'type':'write','text':'typed-marker-6182'},{'type':'press','key':'Enter'},{'type':'scroll','direction':'down'},{'type':'wait','milliseconds':50},{'type':'scrape'},{'type':'click','selector':'#reveal'},{'type':'screenshot','fullPage':True}],'maxAge':0})
    assert not d.get('isError');text=' '.join(b.get('text','') for b in d['content'] if b.get('type')=='text');images=[b for b in d['content'] if b.get('type')=='image'];assert 'clicked-marker-6204'in text and 'typed-marker-6182'in text and 'enter-marker-9217'in text
    assert len(images)==1 and images[0]['mimeType']=='image/jpeg';assert 'data:image/jpeg;base64'not in text;return {'image_blocks':1,'actions_verified':['wait','click','write','press','scroll','scrape','screenshot']}
   check('official-mcp-actions-image',browser)
   def search():
    d=tool('firecrawl_search',{'query':'Python asyncio official documentation','limit':3});s=json.dumps(d);assert 'docs.python.org'in s;return {'contains_official_source':True}
   check('local-mcp-search',search,True)
   def attributes():
    d=tool('local_web_attributes',{'url':'https://example.com','selectors':[{'selector':'a','attribute':'href'}]});assert d['attributes'];return {'selectors':len(d['attributes'])}
   check('attributes-companion',attributes)
   def batch():
    d=tool('local_web_batch_scrape',{'urls':['https://example.com','https://docs.python.org/3/library/asyncio.html']});assert d['status']=='completed';return {'pages':len(d['documents'])}
   check('batch-companion',batch)
   def monitors():
    nonlocal monitor
    m=tool('local_web_monitor_create',{'name':'Temporary enhancement acceptance','urls':['https://example.com']});monitor=m['id'];assert m['schedule']is None
    first=tool('local_web_monitor_run',{'id':monitor});second=tool('local_web_monitor_run',{'id':monitor});assert first['summary']['new']==1 and second['summary']['same']==1
    history=tool('local_web_monitor_checks',{'id':monitor});assert len(history['checks'])==2;tool('local_web_monitor_delete',{'id':monitor});monitor=None;return {'new_then_unchanged':True,'history':2,'temporary_monitor_deleted':True}
   check('manual-monitor-live',monitors)
   def guards():
    for name,a in [('firecrawl_agent',{'prompt':'hidden'}),('firecrawl_scrape',{'url':'https://example.com','formats':'markdown'}),('firecrawl_crawl',{'url':'https://example.com','scrapeOptions':{'formats':['audio']}}),('local_web_monitor_create',{'name':'private','urls':['http://127.0.0.1']})]:assert result(name,a).get('isError') is True
    return {'rejected_calls':4}
   check('local-policy-guards',guards)
  finally:
   if monitor:
    try:tool('local_web_monitor_delete',{'id':monitor})
    except Exception:pass
   p.terminate()
   try:p.wait(timeout=5)
   except subprocess.TimeoutExpired:p.kill();p.wait(timeout=5)
   sel.close()
 report={'status':'failed' if any(r['status']=='failed'for r in records)else 'passed','checks':records}
 dest=out/'mcp-enhanced.json';dest.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'report':str(dest),'status':report['status']}));return report['status']=='failed'
if __name__=='__main__':raise SystemExit(main())
