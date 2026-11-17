#!/usr/bin/env python3
import html,json,re,threading
from pathlib import Path
import time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlsplit,parse_qs,quote
ORIGIN="http://fixtures.firecrawl.test:8765"
PATHS=["/","/static.html","/javascript.html","/guide.html","/about.html"]
MARKERS=["index-marker-1182","alpha-marker-7319","js-marker-4826","guide-marker-2251","about-marker-6314"]
COUNTS={};LOCK=threading.Lock()

def page(path):
 i=PATHS.index(path);title=["Fixture Index","Deterministic Static Fixture","Deterministic JavaScript Fixture","Fixture Guide","Fixture About"][i]
 body="<h1>"+title+"</h1>"
 if path=="/javascript.html": body+="<p id='content'>waiting-for-script</p><script>setTimeout(()=>document.getElementById('content').textContent='js-marker-4826',250)</script>"
 else: body+="<p>"+MARKERS[i]+"</p>"
 if path=="/static.html":body+="<h2>Feature Matrix</h2><table><tr><th>Feature</th><th>Status</th></tr><tr><td>Markdown</td><td>Verified fixture</td></tr></table>"
 body+="<nav>"+" ".join("<a href='"+p+"'>"+(p.strip('/') or 'Home')+"</a>" for p in PATHS)+"</nav>"
 return "<!doctype html><html><head><title>"+title+"</title><meta name='description' content='A stable Firecrawl regression fixture.'><link rel='canonical' href='"+ORIGIN+path+"'></head><body>"+body+"</body></html>"

class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def send(self,body,kind="text/html; charset=utf-8",code=200,location=None):
  data=body if isinstance(body,bytes) else body.encode();self.send_response(code);self.send_header("Content-Type",kind);self.send_header("Content-Length",str(len(data)));self.send_header("Cache-Control","no-store")
  if location:self.send_header("Location",location)
  self.end_headers()
  if self.command!="HEAD":
   try:self.wfile.write(data)
   except (BrokenPipeError,ConnectionResetError):pass
 def do_HEAD(self):self.do_GET()
 def do_GET(self):
  u=urlsplit(self.path);q=parse_qs(u.query);path=u.path
  if path=="/search":
   query=q.get("q",[""])[0]
   if "LOCAL_SEARCH_FIXTURE_FAILURE" in query:return self.send(json.dumps({"error":"controlled provider failure"}),"application/json",503)
   if "LOCAL_SEARCH_FIXTURE_EMPTY" in query:return self.send(json.dumps({"results":[]}),"application/json")
   if "LOCAL_SEARCH_FIXTURE_MALFORMED" in query:return self.send(json.dumps({"unexpected":"missing-results"}),"application/json")
   if "LOCAL_SEARCH_FIXTURE_ALLFAILED" in query:return self.send(json.dumps({"results":[],"unresponsive_engines":[["fixture","controlled failure"]]}),"application/json")
   if "LOCAL_SEARCH_FIXTURE_TIMEOUT" in query:
    time.sleep(16)
    return self.send(json.dumps({"results":[]}),"application/json")
   if "LOCAL_SEARCH_FIXTURE_PARTIAL" in query:return self.send(json.dumps({"results":[{"url":"https://docs.python.org/3/","title":"Python docs","content":"Successful engine result"}],"unresponsive_engines":[["fixture","controlled partial failure"]]}),"application/json")
   return self.send(json.dumps({"results":[{"url":"https://docs.python.org/3/","title":"Python docs","content":"LOCAL_SEARCH_FIXTURE_OK"},{"url":"https://docs.python.org/3/","title":"Duplicate","content":"duplicate"},{"url":"javascript:alert(1)","title":"Invalid","content":"invalid"},{"url":"https://docs.python.org/3/library/","title":"Python library","content":"Library documentation"}]}),"application/json")
  if path=="/structured.html":return self.send("<html><head><title>Orchid Local Project</title><meta name='description' content='A deterministic local extraction fixture.'></head><body><main><h1>Orchid Local</h1><p id='facts' data-count='42' data-active='false'>Project: Orchid Local. Value: 42. Active: false.</p><a href='https://docs.python.org/3/'>Python documentation</a><img src='https://example.com/logo.png' alt='Sample image'></main></body></html>")
  if path=="/sample.pdf":return self.send((Path(__file__).parent/"sample.pdf").read_bytes(),"application/pdf")
  if path=="/pdf-page-limits.pdf":return self.send((Path(__file__).parent/"pdf-page-limits.pdf").read_bytes(),"application/pdf")
  if path=="/code-fidelity.html":return self.send((Path(__file__).parent/"code-fidelity.html").read_text())
  if path=="/quarterly-results.html":return self.send((Path(__file__).parent/"quarterly-results.html").read_text())
  if path in ("/loading-table.html","/dynamic-table.html"):
   script="<script>setTimeout(()=>document.querySelector('tbody').innerHTML='<tr data-ready=\"true\"><td>NIFTY 50</td><td>12345.67</td></tr>',300)</script>" if path=="/dynamic-table.html" else ""
   return self.send("<html><head><title>Market table fixture</title></head><body><h1>Market prices</h1><table><thead><tr><th>Symbol</th><th>Price</th></tr></thead><tbody><tr><td colspan='2'>Loading…</td></tr></tbody></table><footer>Test market data; deterministic fixture.</footer>"+script+"</body></html>")
  if path=="/delayed.html":
   try:delay=max(0,min(1000,int(q.get("ms",["300"])[0])))
   except ValueError:return self.send("Bad delay",code=400)
   time.sleep(delay/1000)
   return self.send("<html><head><title>Delayed fixture</title></head><body><h1>delayed-content-ready</h1><p>Bounded delay fixture.</p></body></html>")
  if path=="/interactive.html":return self.send("<html><head><title>Interactive Fixture</title></head><body><h1>Interactive fixture</h1><button id='reveal' onclick=\"document.getElementById('result').textContent='clicked-marker-6204'\">Reveal content</button><p id='result'>before-click-marker</p><input id='editor' aria-label='Editor' oninput=\"document.getElementById('typed').textContent=this.value\" onkeydown=\"if(event.key==='Enter')document.getElementById('pressed').textContent='enter-marker-9217'\"><p id='typed'></p><p id='pressed'></p><a id='denied' href='http://fixtures-denied.firecrawl.test:8765/security/probe?token=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'>Denied</a></body></html>")
  if path in PATHS:return self.send(page(path))
  if path=="/robots.txt":return self.send("User-agent: *\nAllow: /\nSitemap: "+ORIGIN+"/sitemap.xml\n","text/plain")
  if path=="/sitemap.xml":return self.send('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+''.join('<url><loc>'+ORIGIN+p+'</loc></url>' for p in PATHS)+'</urlset>',"application/xml")
  if path=="/security/health":return self.send(json.dumps({"ports":[8765,8766]}),"application/json")
  token=(path.removeprefix("/security/audit/") if path.startswith("/security/audit/") else q.get("token",[""])[0])
  if not re.fullmatch('[a-f0-9]{32}',token):return self.send("Not found",code=404)
  if path.startswith("/security/audit/"):
   with LOCK:count=COUNTS.get(token,0)
   return self.send('<html><body><h1>Security audit</h1><p>canary-count-'+str(count)+'</p></body></html>')
  if path in ("/security/probe","/security/probe.js"):
   with LOCK:COUNTS[token]=COUNTS.get(token,0)+1
   if path.endswith('.js'):return self.send("document.body.append('private-subresource-leaked');","application/javascript")
   return self.send('<html><body><h1>private-canary-leaked</h1></body></html>')
  destinations={"denied-host":"http://fixtures-denied.firecrawl.test:8765","alternate-port":"http://fixtures.firecrawl.test:8766"}
  if path=="/security/redirect":
   target=destinations.get(q.get("target",[""])[0])
   return self.send("Redirect",code=302,location=target+'/security/probe?token='+token) if target else self.send("Bad target",code=400)
  if path=="/security/browser":
   body='<html><body><h1>browser-safety-marker</h1><p id=rendered>waiting-for-browser</p><script>setTimeout(()=>document.getElementById("rendered").textContent="browser-rendered-marker",250)</script>'
   for target in destinations.values():
    body+='<script src="'+target+'/security/probe.js?token='+token+'"></script><script>fetch("'+target+'/security/probe?token='+token+'").catch(()=>{});</script>'
   return self.send(body+'</body></html>')
  return self.send("Not found",code=404)

if __name__=="__main__":
 for port in (8765,8766):
  server=ThreadingHTTPServer(("0.0.0.0",port),Handler)
  threading.Thread(target=server.serve_forever,daemon=True).start()
 print("Private deterministic fixtures ready on8765/8766",flush=True)
 threading.Event().wait()
