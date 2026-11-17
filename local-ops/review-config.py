#!/usr/bin/env python3
import json,os,subprocess
from pathlib import Path
r=Path(__file__).resolve().parents[1]
env={"HOME":os.environ["HOME"],"PATH":"/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"}
cmd=["/opt/homebrew/bin/docker","--context","colima-firecrawl","compose","--project-directory",str(r),"--project-name","firecrawl","--env-file",str(r/".env.local"),"-f",str(r/"docker-compose.yaml"),"-f",str(r/"compose.override.yaml"),"config","--format","json"]
p=subprocess.run(cmd,text=True,capture_output=True,env=env,check=True);d=json.loads(p.stdout);s=d["services"]
assert set(s)=={"api","redis","rabbitmq","nuq-postgres","playwright-service","fixtures","searxng"},"Unexpected service set"
ports=[(k,p) for k,v in s.items() for p in v.get("ports",[])]
assert len(ports)==1 and ports[0][0]=="api" and ports[0][1]["host_ip"]=="127.0.0.1" and str(ports[0][1]["published"])=="3012" and ports[0][1]["target"]==3002,"Unexpected published endpoint"
a=s["api"]["environment"]
assert a["NUQ_BACKEND"]=="pg" and a["USE_DB_AUTHENTICATION"]=="false" and a["NUQ_WORKER_COUNT"]=="2" and a["CRAWL_CONCURRENT_REQUESTS"]=="2"
assert int(s["api"]["mem_limit"])==5368709120 and int(s["playwright-service"]["mem_limit"])==3221225472
for k,v in s.items():
 assert v["platform"]=="linux/arm64" and v["restart"]=="unless-stopped"
 assert v["logging"]["options"]["max-size"]=="10m" and v["logging"]["options"]["max-file"]=="3"
for k in ("OPENAI_API_KEY","PROXY_SERVER","SUPABASE_SERVICE_TOKEN"):assert not a.get(k),"Unexpected provider configuration"
assert a["PDF_RUST_EXTRACT_ENABLE"]=="true"
assert a["SEARXNG_ENDPOINT"]=="http://searxng:8080" and a["OLLAMA_BASE_URL"]=="http://host.lima.internal:11435/api" and a["MODEL_NAME"]=="qwen2.5:3b"
assert int(s["searxng"]["mem_limit"])==536870912 and not s["searxng"].get("ports")
assert (r/".local-state/searxng/settings.yml").stat().st_mode&511==384
for service in ("api","playwright-service"):
 assert s[service]["environment"]["ALLOW_LOCAL_WEBHOOKS"]=="false" and not s[service]["environment"].get("LOCAL_FIXTURE_ORIGIN"),"Production must not permit private fixture access"
assert (r/".env.local").stat().st_mode&511==384
for k in ("POSTGRES_PASSWORD","BULL_AUTH_KEY"):
 assert len(a[k])>=32 and "generate" not in a[k].lower(),"Credential placeholder"
print(json.dumps({"review":"passed","services":sorted(s),"endpoint":"http://127.0.0.1:3012","queue":"pg","api_bytes":int(s["api"]["mem_limit"]),"browser_bytes":int(s["playwright-service"]["mem_limit"]),"fixture_exception":"disabled in production","secrets":"private, generated"},indent=2))
