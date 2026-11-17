#!/usr/bin/env python3
"""Archive tracked source including working-tree changes; never runtime or secrets."""
import hashlib,json,os,subprocess,sys,tarfile
from pathlib import Path
root=Path(__file__).resolve().parent.parent
destination=Path(sys.argv[1]).resolve()
# Public distributions have their own history. Capture tracked source rather than
# assuming the private installation history or upstream commit is available.
raw=subprocess.check_output(["git","-C",str(root),"ls-files","--cached","-z"])
paths=sorted(set(os.fsdecode(n) for n in raw.split(b"\0") if n))
blocked={".git",".local-state","backups","node_modules","__pycache__"}
selected=[]
for name in paths:
    p=Path(name)
    if p.is_absolute() or ".." in p.parts or blocked.intersection(p.parts): continue
    if p.parts[:2]==("local-bench","var") or name=="local-plugin/runtime/installation.json" or name.endswith(".pyc"): continue
    if p.name.startswith(".env") and not p.name.endswith(".example"): continue
    full=root/p
    if full.is_symlink(): raise SystemExit("Review source symlink before backup: "+name)
    if full.is_file(): selected.append(name)
if not selected: raise SystemExit("No tracked source files found; add reviewed source to Git before export")
tmp=destination.with_name("."+destination.name+".tmp")
with tarfile.open(tmp,"w:gz") as out:
    for name in selected: out.add(root/name,arcname=name,recursive=False)
os.chmod(tmp,0o600);os.replace(tmp,destination)
manifest={"files":[{"path":name,"sha256":hashlib.sha256((root/name).read_bytes()).hexdigest()} for name in selected]}
destination.with_suffix(destination.suffix+".manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
print("Overlay archive verified selection:",len(selected),"source/configuration files; credentials and runtime excluded")
