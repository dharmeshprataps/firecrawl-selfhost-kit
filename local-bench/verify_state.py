#!/usr/bin/env python3
"""Verify application/store persistence without deleting project volumes."""
import argparse, datetime, json, os, subprocess, time, urllib.request, uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
API="http://127.0.0.1:3012"
DOCKER=["/opt/homebrew/bin/docker","--context","colima-firecrawl"]
COMPOSE=DOCKER+["compose","--project-directory",str(ROOT),"--project-name","firecrawl","--env-file",str(ROOT/".env.local"),"-f",str(ROOT/"docker-compose.yaml"),"-f",str(ROOT/"compose.override.yaml")]
ENV={k:os.environ[k] for k in ("HOME","USER","TMPDIR") if k in os.environ}
ENV["PATH"]="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

def call(args, data=None, timeout=300):
    r=subprocess.run(args,input=data,text=True,capture_output=True,timeout=timeout,env=ENV)
    if r.returncode:
        raise RuntimeError("Local verification command failed (exit %s; command %s)"%(r.returncode,args[len(DOCKER)] if args[:len(DOCKER)]==DOCKER else args[0]))
    return r.stdout.strip()

def pg(sql):
    return call(COMPOSE+["exec","-T","nuq-postgres","sh","-c",'exec psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],sql)

def get(path):
    with urllib.request.urlopen(API+path,timeout=30) as r: return json.load(r)

def ready():
    deadline=time.monotonic()+180
    while time.monotonic()<deadline:
        try:
            if get("/v0/health/readiness").get("status")=="ok": return
        except Exception: pass
        time.sleep(2)
    raise RuntimeError("Readiness did not recover")

def queue(mode, key):
    js=r"""
const [mode,key]=process.argv.slice(1);
const u=new URL(process.env.NUQ_RABBITMQ_URL);
const auth=Buffer.from(decodeURIComponent(u.username)+':'+decodeURIComponent(u.password)).toString('base64');
async function req(path,method='GET',body){
 const r=await fetch('http://rabbitmq:15672/api/'+path,{method,headers:{Authorization:'Basic '+auth,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const text=await r.text(); if(!r.ok)throw new Error('RabbitMQ management status '+r.status); return text?JSON.parse(text):null;
}
(async()=>{
 const path='queues/%2F/'+key;
 if(mode==='create'){
  await req(path,'PUT',{durable:true,auto_delete:false,arguments:{}});
  const r=await req('exchanges/%2F/amq.default/publish','POST',{properties:{delivery_mode:2},routing_key:key,payload:key,payload_encoding:'string'});
  if(!r.routed)throw new Error('Probe message not routed');
  console.log(JSON.stringify({created:true}));
 }else if(mode==='check'){
  const q=await req(path); const m=await req(path+'/get','POST',{count:1,ackmode:'ack_requeue_true',encoding:'auto',truncate:500});
  if(!q.durable||m.length!==1||m[0].payload!==key||m[0].properties.delivery_mode!==2)throw new Error('Durable queue/message missing');
  console.log(JSON.stringify({durable:true,message_preserved:true}));
 }else{await req(path,'DELETE');console.log('{}');}
})().catch(()=>{console.error('Local RabbitMQ persistence probe failed');process.exit(1)});
"""
    return json.loads(call(COMPOSE+["exec","-T","api","node","-e",js,mode,key]))

def snapshot(label):
    ids=call(COMPOSE+["ps","-q"]).split()
    inspected=json.loads(call(DOCKER+["inspect"]+ids)) if ids else []
    containers=[]
    for c in inspected:
        containers.append({"name":c["Name"],"image":c["Image"],"restarts":c["RestartCount"],"oom_killed":c["State"]["OOMKilled"],"memory_limit":c["HostConfig"]["Memory"],"ports":c["NetworkSettings"]["Ports"],"mounts":[{"name":m.get("Name"),"destination":m["Destination"]} for m in c["Mounts"]],"logging":c["HostConfig"]["LogConfig"]})
    stats=call(DOCKER+["stats","--no-stream","--format","{{json .}}"]+ids,timeout=60)
    return {"phase":label,"timestamp":datetime.datetime.now(datetime.timezone.utc).isoformat(),"containers":containers,"stats":[json.loads(x) for x in stats.splitlines() if x],"host_memory":call(["/usr/bin/memory_pressure","-Q"]),"host_disk":call(["/bin/df","-h","/System/Volumes/Data"])}

def main():
    os.umask(0o077)
    ap=argparse.ArgumentParser();ap.add_argument("--crawl-id");ap.add_argument("--snapshot",action="store_true");args=ap.parse_args()
    outdir=ROOT/"local-bench/var/acceptance";outdir.mkdir(parents=True,exist_ok=True)
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    report={"started_at":stamp,"phases":[]}
    if args.snapshot:
        report["phases"].append(snapshot("snapshot"));report["status"]="passed"
    else:
        ready();key="firecrawl-installation-"+uuid.uuid4().hex;table="local_install_probe_"+uuid.uuid4().hex[:12]
        def check():
            assert pg("SELECT id FROM %s;"%table)==key
            assert call(COMPOSE+["exec","-T","redis","redis-cli","GET",key])==key
            q=queue("check",key)
            crawl=None
            if args.crawl_id:
                c=get("/v1/crawl/"+args.crawl_id)
                assert c.get("status")=="completed" and len(c.get("data",[]))>=3
                crawl={"id":args.crawl_id,"status":c["status"],"documents":len(c["data"])}
            settings=json.loads(pg("SELECT json_agg(json_build_object('name',name,'setting',setting,'unit',unit,'source',source)) FROM pg_settings WHERE name IN ('cron.database_name','min_wal_size','max_wal_size','wal_buffers');"))
            settings_by_name={s["name"]:s["setting"] for s in settings}
            assert settings_by_name.get("cron.database_name")=="firecrawl"
            assert settings_by_name.get("min_wal_size")=="256"
            assert settings_by_name.get("max_wal_size")=="1024"
            assert settings_by_name.get("wal_buffers")=="2048"
            assert all(v["source"]=="command line" for v in settings)
            assert int(pg("SELECT count(*) FROM cron.job;"))>0
            info=call(COMPOSE+["exec","-T","redis","redis-cli","INFO","persistence"])
            assert "aof_enabled:1" in info and "aof_last_write_status:ok" in info
            assert pg("SELECT extname FROM pg_extension WHERE extname='pg_cron';")=="pg_cron"
            return {"postgres":True,"redis":True,"rabbitmq":q,"crawl":crawl,"postgres_settings":settings}
        try:
            pg("CREATE TABLE %s(id text PRIMARY KEY); INSERT INTO %s VALUES ('%s');"%(table,table,key))
            assert call(COMPOSE+["exec","-T","redis","redis-cli","SET",key,key])=="OK"
            assert call(COMPOSE+["exec","-T","redis","redis-cli","CONFIG","GET","appendonly"]).splitlines()[-1]=="yes"
            time.sleep(2)
            queue("create",key)
            baseline=snapshot("before");baseline["persistence"]=check();report["phases"].append(baseline)
            call(COMPOSE+["stop"],timeout=180);call(COMPOSE+["up","-d","--no-build"],timeout=180);ready()
            phase=snapshot("after-stop-start");phase["persistence"]=check();report["phases"].append(phase)
            call(COMPOSE+["up","-d","--no-build","--force-recreate"],timeout=240);ready()
            phase=snapshot("after-container-recreation");phase["persistence"]=check();report["phases"].append(phase)
            initial_mounts=sorted((c["name"],m["name"],m["destination"]) for c in baseline["containers"] for m in c["mounts"] if m["name"])
            for phase in report["phases"][1:]:
                mounts=sorted((c["name"],m["name"],m["destination"]) for c in phase["containers"] for m in c["mounts"] if m["name"])
                assert mounts==initial_mounts
            report["status"]="passed"
        except Exception as exc:
            report["status"]="failed";report["error"]=str(exc)[:300]
        finally:
            try:
                call(COMPOSE+["up","-d","--no-build"],timeout=180);ready()
                pg("DROP TABLE IF EXISTS %s;"%table)
                call(COMPOSE+["exec","-T","redis","redis-cli","DEL",key]);queue("cleanup",key)
                report["probe_cleanup"]="passed"
            except Exception: report["probe_cleanup"]="failed";report["status"]="failed"
    dest=outdir/("state-"+stamp+".json");dest.write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({"status":report["status"],"report":str(dest),"phases":len(report["phases"])}))
    return 0 if report["status"]=="passed" else 1

if __name__=="__main__":raise SystemExit(main())
