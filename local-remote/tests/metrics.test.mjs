import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,readdirSync,statSync}from'node:fs';
import {tmpdir}from'node:os';
import {join}from'node:path';
import {createTimingSink,timingRecord}from'../metrics.mjs';
test('timing records cannot retain arguments, credentials or page contents',()=>{
 const record=timingRecord({receivedAt:'2026-11-16T00:00:00Z',tool:'firecrawl_scrape',queueMs:4,bridgeMs:20,activeCalls:2,authorization:'Bearer must-not-retain',url:'https://private.example',arguments:{password:'secret'},markdown:'body'});
 assert.deepEqual(record,{receivedAt:'2026-11-16T00:00:00.000Z',tool:'firecrawl_scrape',isError:false,queueMs:4,bridgeMs:20,activeCalls:2});
 assert.throws(()=>timingRecord({tool:'unreviewed_tool',receivedAt:'2026-11-16'}));
});
test('private timing log rotates within three bounded files',()=>{
 const directory=mkdtempSync(join(tmpdir(),'crawler-timings-'));
 try{
  const sink=createTimingSink(directory,{maxBytes:512});
  for(let i=0;i<30;i++)sink({receivedAt:new Date().toISOString(),tool:'local_web_status',queueMs:i,bridgeMs:2,totalMs:i+2,activeCalls:1});
  const files=readdirSync(directory);assert.equal(files.length,3);
  for(const file of files){const path=join(directory,file);assert.ok(statSync(path).size<=512);assert.equal(statSync(path).mode&0o777,0o600);for(const line of readFileSync(path,'utf8').trim().split('\n'))assert.equal(JSON.parse(line).tool,'local_web_status');}
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('read-only reader timing identity is retained without page or credential data',()=>{
 const record=timingRecord({receivedAt:'2026-11-16T00:00:00Z',tool:'local_web_read',bridgeMs:15,activeCalls:2,url:'https://private.example',arguments:{actions:['secret']},headers:{authorization:'secret'},markdown:'body'});
 assert.deepEqual(record,{receivedAt:'2026-11-16T00:00:00.000Z',tool:'local_web_read',isError:false,bridgeMs:15,activeCalls:2});
});
test('queue outcomes retain only enumerated state and never error details',()=>{
 const base={receivedAt:'2026-11-16T00:00:00Z',tool:'local_web_read',bridgeMs:0,queueMs:21,totalMs:22,activeCalls:0,isError:true};
 assert.deepEqual(timingRecord({...base,executionStarted:false,queueOutcome:'timeout',error:'private-sentinel',arguments:{token:'private-sentinel'}}),
  {...base,receivedAt:'2026-11-16T00:00:00.000Z',executionStarted:false,queueOutcome:'timeout'});
 const invalid=timingRecord({...base,executionStarted:'false',queueOutcome:'secret-sentinel'});
 assert.equal('executionStarted' in invalid,false);assert.equal('queueOutcome' in invalid,false);
});
