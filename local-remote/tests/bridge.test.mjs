import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalBridge} from '../bridge.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'local-firecrawl-bridge-test-'));
  const launcher = join(dir, 'fake.mjs');
  await writeFile(launcher, '#!' + process.execPath + '\n' + `
import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line); if(!Object.hasOwn(request,'id'))return;
 let result;
 if(request.method==='initialize') result={serverInfo:{name:'test',version:'1'},capabilities:{},protocolVersion:'2025-11-25'};
 else if(request.method==='tools/list') result={tools:[]};
 else if(request.params.name==='stall') return;
 else if(request.params.name==='crash') process.exit(1);
 else if(request.params.name==='oversized') result={content:[{type:'text',text:'x'.repeat(9*1024*1024)}]};
 else result={content:[{type:'text',text:JSON.stringify({name:request.params.name,args:request.params.arguments})}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});
`, {mode: 0o700});
  const bridge = new LocalBridge({launcher, ...options});
  t.after(async () => {await bridge.close(); await rm(dir, {recursive: true, force: true});});
  return bridge;
}
test('stdio bridge initializes once and correlates independent tool calls', async t => {
  const bridge = await fixture(t);
  const results = await Promise.all([bridge.callTool('one', {value: 1}), bridge.callTool('two', {value: 2})]);
  assert.equal(JSON.parse(results[0].content[0].text).name, 'one'); assert.equal(JSON.parse(results[1].content[0].text).args.value, 2);
  assert.deepEqual(await bridge.listTools(), {tools: []});
});
test('stdio deadline fails pending requests and allows clean child restart', async t => {
  const bridge = await fixture(t, {deadlineMs: 25});
  await assert.rejects(bridge.callTool('stall', {}), /deadline/);
  const result = await bridge.callTool('restarted', {}); assert.match(result.content[0].text, /restarted/);
});
test('stdio child exit rejects requests without exposing stderr', async t => {
  const bridge = await fixture(t);
  await assert.rejects(bridge.callTool('crash', {}), /stopped/);
  assert.match((await bridge.callTool('again', {})).content[0].text, /again/);
});
test('stdio response limit terminates an oversized child response', async t => {
  const bridge = await fixture(t);
  await assert.rejects(bridge.callTool('oversized', {}), /exceeds limit/);
});
test('stdio pending request limit is global and bounded', async t => {
  const bridge = await fixture(t);
  await bridge.start();
  const pending = Array.from({length: 6}, () => bridge.rpc('tools/call', {name: 'stall', arguments: {}}));
  const settled = Promise.allSettled(pending);
  await assert.rejects(bridge.rpc('tools/call', {name: 'stall', arguments: {}}), /pending request limit/);
  await bridge.close(); assert.equal((await settled).filter(result => result.status === 'rejected').length, 6);
});
