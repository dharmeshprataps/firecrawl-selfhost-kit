// Bounded timing records only: no URLs, arguments, tokens, page bodies or OAuth data.
import {mkdirSync,appendFileSync,existsSync,statSync,renameSync,unlinkSync,chmodSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
const names=new Set(['firecrawl_scrape','firecrawl_map','firecrawl_crawl','firecrawl_check_crawl_status','firecrawl_search','local_web_capabilities','local_web_status','local_web_attributes','local_web_batch_scrape','local_web_monitor_create','local_web_monitor_list','local_web_monitor_get','local_web_monitor_update','local_web_monitor_run','local_web_monitor_delete','local_web_monitor_checks','local_web_monitor_check','local_web_read']);
const durations=['queueMs','bridgeMs','totalMs','proxyQueueMs','proxyServiceMs'];
export function timingRecord(input){
  if(!names.has(input?.tool)||!Number.isFinite(Date.parse(input.receivedAt)))throw new Error('Invalid timing record');
  const clean={receivedAt:new Date(input.receivedAt).toISOString(),tool:input.tool,isError:input.isError===true};
  for(const key of durations)if(Number.isFinite(input[key])&&input[key]>=0)clean[key]=Math.round(input[key]);
  if(Number.isInteger(input.activeCalls)&&input.activeCalls>=0&&input.activeCalls<=2)clean.activeCalls=input.activeCalls;
  if(typeof input.executionStarted==='boolean')clean.executionStarted=input.executionStarted;
  if(['started','full','timeout'].includes(input.queueOutcome))clean.queueOutcome=input.queueOutcome;
  return clean;
}
export function createTimingSink(directory,{maxBytes=10000000}={}){
  if(!Number.isInteger(maxBytes)||maxBytes<256)throw new Error('Invalid timing log bound');
  mkdirSync(directory,{recursive:true,mode:0o700});
  const file=join(directory,'timings.jsonl');
  return input=>{
    const line=JSON.stringify(timingRecord(input))+'\n';
    if(Buffer.byteLength(line)>maxBytes)throw new Error('Timing record exceeds configured bound');
    for(const suffix of['','.1','.2'])if(existsSync(file+suffix)&&lstatSync(file+suffix).isSymbolicLink())throw new Error('Timing paths must not be symlinks');
    if(existsSync(file)&&statSync(file).size+Buffer.byteLength(line)>maxBytes){
      if(existsSync(file+'.2'))unlinkSync(file+'.2');
      if(existsSync(file+'.1'))renameSync(file+'.1',file+'.2');
      renameSync(file,file+'.1');
    }
    appendFileSync(file,line,{mode:0o600});chmodSync(file,0o600);
  };
}
