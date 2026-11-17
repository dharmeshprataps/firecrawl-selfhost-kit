"""Bounded manual monitoring and local API tools; no cloud or scheduler."""
import contextlib, datetime as dt, difflib, fcntl, hashlib, ipaddress, json, os
import re, sqlite3, threading, time, urllib.error, urllib.parse, urllib.request, uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
API = 'http://127.0.0.1:3012'
class LocalToolError(Exception):
    def __init__(self, message, *, code='LOCAL_TOOL_ERROR', http_status=None):
        super().__init__(message)
        self.code=code; self.http_status=http_status
    def response(self):
        return {'success':False,'code':self.code,'error':str(self),**({'httpStatus':self.http_status} if self.http_status is not None else {})}
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise LocalToolError('Unexpected local API redirect refused')
def api_http_error(status,raw):
    code='LOCAL_API_HTTP_ERROR'; message='Local API returned HTTP '+str(status)
    try:
        failure=json.loads(raw[:65536]); supplied=failure.get('code')
        if isinstance(supplied,str) and re.fullmatch(r'[A-Z0-9_]{1,80}',supplied): code=supplied
        detail=failure.get('error')
        if isinstance(detail,str): message+=': '+detail[:500]
    except (ValueError,UnicodeDecodeError,AttributeError): pass
    return LocalToolError(message,code=code,http_status=status)
def local_request(method, path, payload=None, timeout=20):
    if not path.startswith('/') or path.startswith('//'):
        raise LocalToolError('Invalid local API path')
    installation=Path(__file__).resolve().parents[1]/'runtime/installation.json'
    if installation.is_file():
        trace=Path(json.loads(installation.read_text())['checkout'])/'.local-state/mcp/requests.jsonl'
        with trace.open('a') as log: log.write(json.dumps({'time':dt.datetime.now(dt.timezone.utc).isoformat(),'transport':'python-local','url':API+path})+'\n')
        os.chmod(trace,0o600)
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(req, timeout=timeout) as response:
            body = response.read(2*1024*1024+1)
    except urllib.error.HTTPError as exc:
        raise api_http_error(exc.code,exc.read(65537)) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise LocalToolError('Cannot reach local Firecrawl API at ' + API) from exc
    if len(body) > 2*1024*1024: raise LocalToolError('Local response exceeds two MiB limit')
    try: return json.loads(body)
    except (ValueError, UnicodeDecodeError) as exc:
        raise LocalToolError('Local API returned non-JSON content') from exc

def definition(name, description, props=None, required=None, readonly=True, destructive=False):
    schema = {'type':'object','properties':props or {},'additionalProperties':False}
    if required: schema['required'] = required
    return {'name':name,'description':description,'inputSchema':schema,
            'annotations':{'readOnlyHint':readonly,'destructiveHint':destructive,'openWorldHint':False}}
ID={'type':'string','minLength':1,'maxLength':80}
NAME={'type':'string','minLength':1,'maxLength':120}
URLS={'type':'array','minItems':1,'maxItems':5,'items':{'type':'string','maxLength':2048}}
EXPECTED={'type':'array','minItems':1,'maxItems':10,'items':{'type':'string','minLength':1,'maxLength':500}}
BATCH_MAX_AGE=7*24*60*60*1000
BATCH_MARKDOWN_LIMIT=100000
BATCH_OPTIONS={
 'maxAge':{'type':'integer','minimum':0,'maximum':BATCH_MAX_AGE,'default':0,'description':'Maximum accepted Firecrawl cache age in milliseconds. Zero requests a fresh fetch; target/CDN caching is separate.'},
 'storeInCache':{'type':'boolean','default':True,'description':'Whether this fetch may be stored in the local Firecrawl cache. False does not itself force a fresh fetch; pair with maxAge:0 for fresh comparisons.'},
 'timeout':{'type':'integer','minimum':1000,'maximum':20000,'default':15000,'description':'Per-page API timeout in milliseconds. Bounded so five URLs with two workers fit within the gateway deadline.'},
 'onlyMainContent':{'type':'boolean','default':True,'description':'Return the main page content rather than the whole page.'},
}
SELECTORS={'type':'array','minItems':1,'maxItems':10,'items':{'type':'object','properties':{'selector':{'type':'string','minLength':1,'maxLength':500},'attribute':{'type':'string','minLength':1,'maxLength':80}},'required':['selector','attribute'],'additionalProperties':False}}
PAGE={'limit':{'type':'integer','minimum':1,'maximum':50,'default':20},
      'offset':{'type':'integer','minimum':0,'maximum':100000,'default':0}}
LOCAL_TOOLS=[
 definition('local_web_capabilities','Report verified local capabilities and unavailable providers. No network request.'),
 definition('local_web_status','Check fixed local API readiness. Does not start services.'),
 definition('local_web_attributes','Extract one to ten CSS-selected attributes from one public URL through the local API. Returns attributes and metadata only.',{'url':{'type':'string','minLength':1,'maxLength':2048},'selectors':SELECTORS},['url','selectors']),
 definition('local_web_batch_scrape','Read one to five public URLs with at most two local requests in flight. Retains target HTTP status, metadata, content-readiness warnings and partial errors. Optional expectedContent must appear in every result. Optional maxAge, storeInCache, timeout and onlyMainContent apply to every URL; maxAge:0 requests fresh content. This is not an asynchronous batch job.',{'urls':URLS,'expectedContent':EXPECTED,**BATCH_OPTIONS},['urls']),
 definition('local_web_monitor_create','Save a manual monitor for one to five public URLs. Creates no schedule or notifications.',{'name':NAME,'urls':URLS},['name','urls'],False),
 definition('local_web_monitor_list','List saved local monitors.',PAGE),
 definition('local_web_monitor_get','Read a monitor and latest check.',{'id':ID},['id']),
 definition('local_web_monitor_update','Change name, URLs or active flag; does not schedule checks.',{'id':ID,'name':NAME,'urls':URLS,'active':{'type':'boolean'}},['id'],False),
 definition('local_web_monitor_run','Manually check up to five pages sequentially. Compare hashes and short excerpts; retain no full bodies. No LLM judging or notifications.',{'id':ID},['id'],False),
 definition('local_web_monitor_delete','Permanently delete a monitor and retained history.',{'id':ID},['id'],False,True),
 definition('local_web_monitor_checks','List bounded check history.',{'id':ID,**PAGE},['id']),
 definition('local_web_monitor_check','Read one retained check.',{'id':ID,'checkId':ID},['id','checkId'])]
LOCAL_NAMES={t['name'] for t in LOCAL_TOOLS}
def now(): return dt.datetime.now(dt.timezone.utc).isoformat()
def name_value(value):
    if not isinstance(value,str) or not 1<=len(value.strip())<=120:
        raise LocalToolError('Name must contain one to 120 characters')
    return value.strip()
def urls_value(value):
    if not isinstance(value,list) or not 1<=len(value)<=5: raise LocalToolError('Supply one to five public URLs')
    result=[]
    for raw in value:
        if not isinstance(raw,str) or not 1<=len(raw)<=2048 or any(ord(c)<32 for c in raw):
            raise LocalToolError('Invalid URL string')
        try:
            p=urllib.parse.urlsplit(raw); port=p.port
            if p.scheme not in {'http','https'} or not p.hostname or p.username or p.password or (port is not None and not 1<=port<=65535): raise ValueError()
            host=p.hostname.lower().rstrip('.')
            if host=='localhost' or host.endswith(('.localhost','.local','.internal','.test')): raise ValueError()
            try:
                address=ipaddress.ip_address(host)
                if not address.is_global: raise ValueError()
            except ValueError as exc:
                if re.fullmatch(r'[0-9a-fA-F:.]+',host): raise ValueError() from exc
            url=urllib.parse.urlunsplit((p.scheme,p.netloc,p.path or '/',p.query,''))
        except ValueError as exc: raise LocalToolError('Supply public HTTP(S) URLs without credentials or private hosts') from exc
        if url not in result: result.append(url)
    return result

def pagination(args):
    limit,offset=args.get('limit',20),args.get('offset',0)
    if type(limit) is not int or not 1<=limit<=50 or type(offset) is not int or not 0<=offset<=100000: raise LocalToolError('Invalid pagination bounds')
    return limit,offset

def expected_content(value):
    if value is None: return []
    if not isinstance(value,list) or not 1<=len(value)<=10 or any(not isinstance(v,str) or not v.strip() or len(v)>500 or any(ord(c)<32 and c not in '\n\t' for c in v) for v in value):
        raise LocalToolError('expectedContent requires one to ten nonempty strings of at most 500 characters')
    return value

def batch_scrape_options(args):
    # Forward only reviewed fields; preserve explicit zero and false values.
    options={'onlyMainContent':args.get('onlyMainContent',True),'maxAge':args.get('maxAge',0),'timeout':args.get('timeout',15000)}
    if type(options['maxAge']) is not int or not 0<=options['maxAge']<=BATCH_MAX_AGE:
        raise LocalToolError('maxAge must be an integer from zero to 604800000 milliseconds',code='INVALID_ARGUMENT')
    if type(options['timeout']) is not int or not 1000<=options['timeout']<=20000:
        raise LocalToolError('timeout must be an integer from 1000 to 20000 milliseconds per page',code='INVALID_ARGUMENT')
    if type(options['onlyMainContent']) is not bool:
        raise LocalToolError('onlyMainContent must be boolean',code='INVALID_ARGUMENT')
    # Omission retains the API's existing default rather than changing the request.
    if 'storeInCache' in args:
        if type(args['storeInCache']) is not bool:
            raise LocalToolError('storeInCache must be boolean',code='INVALID_ARGUMENT')
        options['storeInCache']=args['storeInCache']
    return options

def bounded_metadata(metadata):
    if len(json.dumps(metadata).encode())<=16384: return metadata,False
    keys=['statusCode','sourceURL','url','title','contentType','language','error','errorCode','warning']
    return {key:value[:1000] if isinstance(value,str) else value for key in keys if isinstance((value:=metadata.get(key)),(str,int,float,bool))},True

def content_check(document, expected=None):
    """Conservative evidence of incomplete content, not a truth/accuracy score."""
    metadata=document.get('metadata') if isinstance(document,dict) else None
    metadata=metadata if isinstance(metadata,dict) else {}
    status=metadata.get('statusCode')
    status=status if type(status) is int and 100<=status<=599 else None
    result={'status':'not_assessed','basis':'heuristic','httpStatus':status,'reasons':[]}
    if status is not None and status>=400:
        return {**result,'status':'failed','reasons':['target_http_error']}
    markdown=document.get('markdown') if isinstance(document,dict) else None
    if not isinstance(markdown,str): return {**result,'status':'incomplete','reasons':['expected_content_not_available'],'missingExpectedContent':expected} if expected else result
    if not markdown.strip(): return {**result,'status':'incomplete','reasons':['empty_markdown']}
    reasons=[]; expected=expected or []
    missing=[text for text in expected if text.casefold() not in markdown.casefold()]
    if missing: reasons.append('expected_content_missing');result['missingExpectedContent']=missing
    # Only flag exact placeholder cells in a table with no populated data row.
    # Merely mentioning "loading" in documentation is not a readiness failure.
    visible=re.sub(r'(?ms)^(`{3,}|~{3,})[^\n]*\n.*?^\1\s*$', '', markdown)
    for table in re.findall(r'(?:^\s*\|[^\n]*\|\s*$\n?){2,}',visible,re.M):
        rows=[line.strip() for line in table.splitlines() if line.strip()]
        if len(rows)<2 or not re.fullmatch(r'[| :\-]+',rows[1]): continue
        data=rows[2:]; placeholder=False; populated=False
        for row in data:
            cells=[re.sub(r'[*_`\s]','',c).lower().strip('.…!') for c in row.strip('|').split('|')]
            nonempty=[c for c in cells if c]
            if nonempty and all(c in {'loading','loadingdata','pleasewait','fetchingdata','--','-'} for c in nonempty): placeholder=True
            elif nonempty: populated=True
        if placeholder and not populated: reasons.append('loading_table_without_rows');break
    compact=re.sub(r'[*_`#\s]','',markdown).lower().strip('.!…')
    if compact in {'loading','loadingdata','pleasewait','fetchingdata'}: reasons.append('loading_placeholder')
    if len(markdown.strip())<500 and re.match(r'^\s*(?:#+\s*)?(?:404\s*[-:]?\s*)?(?:page\s+)?not\s+found\b',markdown,re.I): reasons.append('not_found_page')
    result['reasons']=list(dict.fromkeys(reasons))
    result['status']='incomplete' if reasons else 'checked'
    if expected: result['basis']='expected_content_and_heuristics'
    result['accuracyVerified']=False
    return result

def annotate_scrape_message(message, expected=None):
    """Keep useful source content while surfacing failed/incomplete HTTP200 pages."""
    result=message.get('result')
    if not isinstance(result,dict) or result.get('isError'): return message
    payload=result.get('structuredContent')
    if not isinstance(payload,dict):
        for block in result.get('content',[]):
            if block.get('type')=='text':
                try: candidate=json.loads(block.get('text',''))
                except (ValueError,TypeError): continue
                if isinstance(candidate,dict): payload=candidate;break
    if not isinstance(payload,dict): return message
    document=payload.get('data') if isinstance(payload.get('data'),dict) else payload
    check=content_check(document,expected)
    metadata=document.get('metadata');metadata=metadata if isinstance(metadata,dict) else {}
    document['metadata']={**metadata,'localContentCheck':check}
    if check['status'] in {'incomplete','failed'}:
        warning='Content '+check['status']+': '+', '.join(check['reasons'])+'. HTTP success alone does not establish content readiness.'
        payload['warning']=' '.join(str(x) for x in [payload.get('warning'),warning] if x)
        result['isError']=True
    result['structuredContent']=payload
    result['content']=[{'type':'text','text':json.dumps(payload)},*[b for b in result.get('content',[]) if b.get('type')!='text']]
    return message

class LocalTools:
    def __init__(self,state_root,capabilities,request=local_request):
        self.root=Path(state_root);self.caps=capabilities;self.request=request
        self.read_slots=threading.BoundedSemaphore(2)
    def fetch(self,method,path,payload=None,timeout=20):
        with self.read_slots: return self.request(method,path,payload,timeout=timeout)
    def database(self):
        self.root.mkdir(mode=0o700,parents=True,exist_ok=True)
        path=self.root/'monitors.sqlite3';db=sqlite3.connect(path,timeout=5)
        os.chmod(path,0o600);db.row_factory=sqlite3.Row;db.execute('PRAGMA foreign_keys=ON')
        db.executescript('''CREATE TABLE IF NOT EXISTS monitors(id TEXT PRIMARY KEY,name TEXT NOT NULL,urls TEXT NOT NULL,active INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checks(id TEXT PRIMARY KEY,monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,created_at TEXT NOT NULL,status TEXT NOT NULL,summary TEXT NOT NULL,pages TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS checks_by_monitor ON checks(monitor_id,created_at DESC);
CREATE TABLE IF NOT EXISTS snapshots(monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,url TEXT NOT NULL,hash TEXT NOT NULL,excerpt TEXT NOT NULL,PRIMARY KEY(monitor_id,url));''')
        return db
    @contextlib.contextmanager
    def locked(self):
        self.root.mkdir(mode=0o700,parents=True,exist_ok=True)
        with (self.root/'monitor-operation.lock').open('a') as lock:
            os.chmod(lock.name,0o600)
            try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError as exc: raise LocalToolError('Another monitor operation is running; retry later') from exc
            try: yield
            finally: fcntl.flock(lock,fcntl.LOCK_UN)
    def monitor(self,db,identifier):
        if not isinstance(identifier,str) or not 1<=len(identifier)<=80: raise LocalToolError('Invalid monitor ID')
        row=db.execute('SELECT * FROM monitors WHERE id=?',(identifier,)).fetchone()
        if row is None: raise LocalToolError('Local monitor not found')
        m=dict(row);m['urls']=json.loads(m['urls']);m['active']=bool(m['active']);m.update(schedule=None,notifications='none')
        latest=db.execute('SELECT id,created_at,status,summary FROM checks WHERE monitor_id=? ORDER BY created_at DESC LIMIT 1',(identifier,)).fetchone()
        if latest: m['latest_check']={**dict(latest),'summary':json.loads(latest['summary'])}
        return m
    def call(self,name,args):
        if name not in LOCAL_NAMES or not isinstance(args,dict): raise LocalToolError('Unknown tool or arguments')
        schema=next(t for t in LOCAL_TOOLS if t['name']==name)['inputSchema']
        if set(args)-set(schema['properties']): raise LocalToolError('Unknown parameter; schedules, email and webhooks are unsupported')
        if any(k not in args for k in schema.get('required',[])): raise LocalToolError('Required parameter missing')
        if name=='local_web_capabilities': return {'api_url':API,'official_mcp_version':'3.36.1','capabilities':self.caps,'local_tools':sorted(LOCAL_NAMES),'execution':'local Mac service through reviewed stdio or authenticated gateway','cloud_fallback':False}
        if name=='local_web_status':
            try: return {'api_url':API,'ready':True,'readiness':self.request('GET','/v0/health/readiness',timeout=5),'cloud_fallback':False}
            except LocalToolError as exc: return {'api_url':API,'ready':False,'error':str(exc),'cloud_fallback':False}
        if name=='local_web_attributes': return self.attributes(args)
        if name=='local_web_batch_scrape': return self.batch_scrape(args)
        if name=='local_web_monitor_run': return self.run(args['id'])
        mutation=name in {'local_web_monitor_create','local_web_monitor_update','local_web_monitor_delete'}
        with self.locked() if mutation else contextlib.nullcontext():
            with contextlib.closing(self.database()) as db, db:
                if name=='local_web_monitor_create':
                    if db.execute('SELECT COUNT(*) FROM monitors').fetchone()[0]>=50: raise LocalToolError('Limit of 50 monitors reached')
                    identifier,stamp=uuid.uuid4().hex,now()
                    db.execute('INSERT INTO monitors VALUES(?,?,?,?,?,?)',(identifier,name_value(args['name']),json.dumps(urls_value(args['urls'])),1,stamp,stamp))
                    return self.monitor(db,identifier)
                if name=='local_web_monitor_list':
                    limit,offset=pagination(args);ids=[r[0] for r in db.execute('SELECT id FROM monitors ORDER BY created_at DESC LIMIT ? OFFSET ?',(limit,offset))]
                    return {'monitors':[self.monitor(db,i) for i in ids],'total':db.execute('SELECT COUNT(*) FROM monitors').fetchone()[0],'limit':limit,'offset':offset}
                m=self.monitor(db,args['id'])
                if name=='local_web_monitor_get': return m
                if name=='local_web_monitor_delete':
                    db.execute('DELETE FROM monitors WHERE id=?',(m['id'],));return {'id':m['id'],'deleted':True}
                if name=='local_web_monitor_update':
                    if set(args)=={'id'}: raise LocalToolError('Supply a change')
                    if 'active' in args and type(args['active']) is not bool: raise LocalToolError('active must be boolean')
                    m['name']=name_value(args.get('name',m['name']));m['urls']=urls_value(args.get('urls',m['urls']));m['active']=args.get('active',m['active'])
                    db.execute('UPDATE monitors SET name=?,urls=?,active=?,updated_at=? WHERE id=?',(m['name'],json.dumps(m['urls']),int(m['active']),now(),m['id']))
                    for row in db.execute('SELECT url FROM snapshots WHERE monitor_id=?',(m['id'],)).fetchall():
                        if row[0] not in m['urls']: db.execute('DELETE FROM snapshots WHERE monitor_id=? AND url=?',(m['id'],row[0]))
                    return self.monitor(db,m['id'])
                if name=='local_web_monitor_checks':
                    limit,offset=pagination(args);rows=db.execute('SELECT id,created_at,status,summary FROM checks WHERE monitor_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?',(m['id'],limit,offset))
                    return {'id':m['id'],'checks':[{**dict(r),'summary':json.loads(r['summary'])} for r in rows],'limit':limit,'offset':offset,'retention':50}
                if name=='local_web_monitor_check':
                    if not isinstance(args['checkId'],str) or not 1<=len(args['checkId'])<=80: raise LocalToolError('Invalid check ID')
                    row=db.execute('SELECT * FROM checks WHERE monitor_id=? AND id=?',(m['id'],args['checkId'])).fetchone()
                    if row is None: raise LocalToolError('Local check not found')
                    return {**dict(row),'summary':json.loads(row['summary']),'pages':json.loads(row['pages'])}
        raise LocalToolError('Unsupported operation')
    def attributes(self,args):
        url=urls_value([args['url']])[0]
        selectors=args['selectors']
        if not isinstance(selectors,list) or not 1<=len(selectors)<=10:
            raise LocalToolError('Supply one to ten selector/attribute pairs')
        checked=[]
        for pair in selectors:
            if not isinstance(pair,dict) or set(pair)!={'selector','attribute'}:
                raise LocalToolError('Each selector requires exactly selector and attribute')
            for key,limit in [('selector',500),('attribute',80)]:
                value=pair[key]
                if not isinstance(value,str) or not 1<=len(value)<=limit or not value.strip() or any(ord(c)<32 for c in value):
                    raise LocalToolError('Invalid '+key+' value')
            checked.append({'selector':pair['selector'],'attribute':pair['attribute']})
        result=self.fetch('POST','/v2/scrape',{'url':url,'formats':[{'type':'attributes','selectors':checked}],'maxAge':0,'timeout':15000},timeout=20)
        if not isinstance(result,dict) or result.get('success') is not True:
            raise LocalToolError('Local attribute scrape failed')
        doc=result.get('data')
        if not isinstance(doc,dict) or not isinstance(doc.get('attributes'),list):
            raise LocalToolError('Local API returned no attributes list')
        metadata=doc.get('metadata',{})
        if not isinstance(metadata,dict): raise LocalToolError('Local API returned invalid metadata')
        status=metadata.get('statusCode')
        if type(status) is int and status>=400: raise LocalToolError('Attribute target returned HTTP '+str(status),code='TARGET_HTTP_ERROR',http_status=status)
        return {'attributes':doc['attributes'],'metadata':metadata}
    def batch_scrape(self,args):
        urls=urls_value(args['urls']);expected=expected_content(args.get('expectedContent'))
        options=batch_scrape_options(args)
        transport_timeout=options['timeout']/1000+5
        def scrape_one(url):
            started=time.perf_counter(); page={'url':url}
            try:
                result=self.fetch('POST','/v2/scrape',{'url':url,'formats':['markdown'],**options},timeout=transport_timeout)
                if not isinstance(result,dict) or result.get('success') is not True:
                    raise LocalToolError('Local scrape failed')
                doc=result.get('data');markdown=doc.get('markdown') if isinstance(doc,dict) else None
                metadata=doc.get('metadata',{}) if isinstance(doc,dict) else {}
                if not isinstance(metadata,dict): raise LocalToolError('Local API returned invalid metadata')
                page['metadata'],page['metadata_truncated']=bounded_metadata(metadata)
                page['http_status']=metadata.get('statusCode') if type(metadata.get('statusCode')) is int else None
                check=content_check(doc,expected);page['content_check']=check
                if check['status']!='failed' and isinstance(markdown,str) and len(markdown)>BATCH_MARKDOWN_LIMIT and expected:
                    returned=markdown[:BATCH_MARKDOWN_LIMIT].casefold();full=markdown.casefold()
                    not_returned=[text for text in expected if text.casefold() not in returned and text.casefold() in full]
                    if not_returned:
                        check['status']='incomplete'
                        check['reasons'].append('expected_content_not_returned_due_to_truncation')
                        check['missingReturnedExpectedContent']=not_returned
                if check['status']=='failed': raise LocalToolError('Target returned HTTP '+str(page['http_status']),code='TARGET_HTTP_ERROR',http_status=page['http_status'])
                if not isinstance(markdown,str) or not markdown.strip(): raise LocalToolError('No useful Markdown returned')
                page.update(status='incomplete' if check['status']=='incomplete' else 'completed',markdown=markdown[:BATCH_MARKDOWN_LIMIT],characters=len(markdown),returned_characters=min(len(markdown),BATCH_MARKDOWN_LIMIT),truncated=len(markdown)>BATCH_MARKDOWN_LIMIT)
                if check['status']=='incomplete': page['warning']='Content readiness check failed: '+', '.join(check['reasons'])
            except (LocalToolError,ValueError,TypeError,KeyError,TimeoutError,OSError) as exc:
                page.update(status='error',error=str(exc)[:300],error_code=getattr(exc,'code','LOCAL_TOOL_ERROR'))
                if getattr(exc,'http_status',None) is not None: page['http_status']=exc.http_status
            page['elapsed_ms']=round((time.perf_counter()-started)*1000)
            return page
        with ThreadPoolExecutor(max_workers=2,thread_name_prefix='local-batch') as pool: documents=list(pool.map(scrape_one,urls))
        completed=sum(d['status']=='completed' for d in documents)
        failed=sum(d['status']=='error' for d in documents);incomplete=sum(d['status']=='incomplete' for d in documents)
        return {'status':'completed' if completed==len(documents) else 'partial' if completed else 'failed','execution':'bounded parallel local scrapes','concurrency':2,'scrape_options':options,'documents':documents,'completed':completed,'failed':failed,'incomplete':incomplete,'cloud_fallback':False}
    def run(self,identifier):
        with self.locked(),contextlib.closing(self.database()) as db:
            m=self.monitor(db,identifier)
            if not m['active']: raise LocalToolError('Monitor paused')
            pages=[];snapshots=[]
            for url in m['urls']:
                try:
                    result=self.fetch('POST','/v2/scrape',{'url':url,'formats':['markdown'],'onlyMainContent':True,'maxAge':0,'timeout':15000},timeout=20)
                    if not isinstance(result,dict) or result.get('success') is False: raise LocalToolError('Local scrape failed')
                    doc=result.get('data',result);markdown=doc.get('markdown') if isinstance(doc,dict) else None
                    if not isinstance(markdown,str) or not markdown.strip(): raise LocalToolError('No useful Markdown returned')
                    readiness=content_check(doc)
                    if readiness['status'] in {'failed','incomplete'}: raise LocalToolError('Monitor content unavailable: '+', '.join(readiness['reasons']),code='CONTENT_NOT_READY',http_status=readiness['httpStatus'])
                    if len(markdown)>500000: raise LocalToolError('Page exceeds 500000-character monitor limit')
                    normalized=re.sub(r'\s+',' ',markdown).strip();digest=hashlib.sha256(normalized.encode()).hexdigest();excerpt=normalized[:400]
                    previous=db.execute('SELECT hash,excerpt FROM snapshots WHERE monitor_id=? AND url=?',(identifier,url)).fetchone()
                    state='new' if previous is None else 'same' if previous['hash']==digest else 'changed'
                    page={'url':url,'status':state,'sha256':digest,'excerpt':excerpt,'characters':len(markdown)}
                    if previous is not None and state=='changed':
                        page['excerpt_diff']='\n'.join(difflib.unified_diff([previous['excerpt']],[excerpt],fromfile='previous excerpt',tofile='current excerpt',lineterm=''))[:1200]
                        page['diff_scope']='First 400 normalized characters; hash changes may occur beyond excerpt'
                    pages.append(page);snapshots.append((identifier,url,digest,excerpt))
                except (LocalToolError,ValueError,TypeError,KeyError) as exc: pages.append({'url':url,'status':'error','error':str(exc)[:300]})
            summary={s:sum(p['status']==s for p in pages) for s in ['new','same','changed','error']}
            status='completed' if not summary['error'] else 'failed' if summary['error']==len(pages) else 'partial'
            check_id,stamp=uuid.uuid4().hex,now()
            with db:
                db.executemany('INSERT OR REPLACE INTO snapshots VALUES(?,?,?,?)',snapshots)
                db.execute('INSERT INTO checks VALUES(?,?,?,?,?,?)',(check_id,identifier,stamp,status,json.dumps(summary),json.dumps(pages)))
                db.execute('DELETE FROM checks WHERE monitor_id=? AND id NOT IN (SELECT id FROM checks WHERE monitor_id=? ORDER BY created_at DESC LIMIT 50)',(identifier,identifier))
            return {'id':identifier,'checkId':check_id,'created_at':stamp,'status':status,'summary':summary,'pages':pages,'retention':50,'schedule':None,'notifications':'none'}
