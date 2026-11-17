#!/usr/bin/env python3
"""Manage only the reviewed remote gateway launch agent; retain private state."""
import argparse,fcntl,json,os,plistlib,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'local-ops'))
from launchd_config import render_agent,remote_public_base
LABEL='com.localcrawler.remote'
SOURCE=ROOT/'local-ops/schedulers'/f'{LABEL}.plist'
DEST=Path.home()/'Library/LaunchAgents'/SOURCE.name
TARGET=f'gui/{os.getuid()}/{LABEL}'
def call(*args,check=True):
 return subprocess.run(['/bin/launchctl',*args],capture_output=True,text=True,check=check)
def main():
 os.umask(0o077)
 ap=argparse.ArgumentParser();ap.add_argument('action',choices=['install','start','stop','status','uninstall']);args=ap.parse_args()
 guard=None
 public_base=remote_public_base(ROOT) if args.action in ['install','start'] else None
 if args.action in ['install','start']:
  state=ROOT/'.local-state/remote-gateway';state.mkdir(parents=True,exist_ok=True,mode=0o700)
  guard=(state/'fixture-tests.lock').open('a')
  try:fcntl.flock(guard,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise SystemExit('Fixture tests are running; remote gateway remains stopped')
  boundary=subprocess.run(['/opt/homebrew/bin/node','--input-type=module','-e',"import {assertRuntimeBoundary} from './local-remote/gateway.mjs'; await assertRuntimeBoundary();"],cwd=ROOT,capture_output=True,env={**os.environ,'FIRECRAWL_PUBLIC_BASE':public_base})
  if boundary.returncode:raise SystemExit('Running API and browser must both disable fixture access before gateway startup')
 loaded=call('print',TARGET,check=False).returncode==0
 if args.action=='install':
  config=render_agent(SOURCE,root=ROOT,public_base=public_base)
  assert config['Label']==LABEL and config['WorkingDirectory']==str(ROOT)
  assert config['ProgramArguments']==['/opt/homebrew/bin/node','--max-old-space-size=384',str(ROOT/'local-remote/gateway.mjs')]
  assert all(Path(config[k]).parent==ROOT/'.local-state/remote-gateway' for k in ['StandardOutPath','StandardErrorPath'])
  assert (ROOT/'.local-state/remote-gateway/node_modules/@modelcontextprotocol/server/package.json').is_file(),'Install pinned gateway dependencies first'
  (ROOT/'.local-state/remote-gateway').mkdir(parents=True,exist_ok=True,mode=0o700)
  DEST.parent.mkdir(parents=True,exist_ok=True)
  assert not DEST.is_symlink(),'Launch agent destination must not be a symlink'
  assert not DEST.exists() or plistlib.loads(DEST.read_bytes())==config,'Existing launch agent differs; review and uninstall it explicitly before replacement'
  if loaded:call('bootout',TARGET)
  DEST.write_bytes(plistlib.dumps(config));DEST.chmod(0o600)
  call('enable',TARGET);call('bootstrap',f'gui/{os.getuid()}',str(DEST))
 elif args.action=='start':
  assert DEST.is_file() and not DEST.is_symlink(),'Install the reviewed launch agent first'
  assert plistlib.loads(DEST.read_bytes())==render_agent(SOURCE,root=ROOT,public_base=public_base),'Installed launch agent differs; review and reinstall it after changing public configuration'
  call('enable',TARGET)
  if not loaded:call('bootstrap',f'gui/{os.getuid()}',str(DEST))
  else:call('kickstart',TARGET)
 elif args.action in ['stop','uninstall']:
  call('disable',TARGET)
  if loaded:call('bootout',TARGET)
  if args.action=='uninstall':DEST.unlink(missing_ok=True)
  print(json.dumps({'gateway':'stopped','private_state':'retained','domain_routes':'unchanged; remove your reverse-proxy routes separately after review'}));return
 current=call('print',TARGET,check=False)
 print(json.dumps({'loaded':current.returncode==0,'running':'state = running' in current.stdout,'label':LABEL,'loopback_port':3013,'owner_password_file':str(ROOT/'.local-state/remote-gateway/auth/owner-password.txt')}))
if __name__=='__main__':main()
