#!/usr/bin/env python3
"""Bounded sampler of this deployment only, without environment or page data."""
import datetime,json,subprocess,time,urllib.request
from pathlib import Path
r=Path(__file__).resolve().parents[1];out=r/'local-bench/var/enhancement/resources.json';stop=out.with_suffix('.stop');stop.unlink(missing_ok=True);rows=[]
for _ in range(120):
 if stop.exists():break
 stamp=datetime.datetime.now(datetime.timezone.utc).isoformat()
 p=subprocess.run(['/opt/homebrew/bin/docker','--context','colima-firecrawl','stats','--no-stream','--format','{{json .}}'],capture_output=True,text=True,timeout=15)
 containers=[]
 for line in p.stdout.splitlines():
  d=json.loads(line)
  if d['Name'].startswith('firecrawl-'):containers.append({k:d[k] for k in ['Name','CPUPerc','MemUsage','PIDs']})
 try:
  with urllib.request.urlopen('http://127.0.0.1:11435/api/ps',timeout=3) as f:models=[{k:m.get(k) for k in ['name','size','size_vram','context_length']} for m in json.load(f).get('models',[])]
 except Exception:models=[]
 rows.append({'at':stamp,'containers':containers,'local_models':models})
 out.write_text(json.dumps({'samples':rows},indent=2)+'\n');out.chmod(0o600)
 for _ in range(30):
  if stop.exists():break
  time.sleep(.1)
print(json.dumps({'report':str(out),'samples':len(rows)}))
