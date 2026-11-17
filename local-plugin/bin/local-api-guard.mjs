import http from 'node:http';
import https from 'node:https';
import {urlToHttpOptions} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const origin='http://127.0.0.1:3012';
const installation=JSON.parse(readFileSync(new URL('../runtime/installation.json',import.meta.url),'utf8'));
if(installation.api_url!==origin||!installation.checkout.startsWith('/'))throw new Error('Invalid local installation metadata');
const tracePath=resolve(installation.checkout,'.local-state/mcp/requests.jsonl');
function reject(){trace('blocked-nonlocal-or-custom-transport','blocked');throw new Error('MCP outbound request blocked: only the local Firecrawl API is permitted');}
function trace(url,transport){appendFileSync(tracePath,JSON.stringify({time:new Date().toISOString(),transport,url})+'\n',{mode:0o600});}
const originalFetch=globalThis.fetch;
globalThis.fetch=function(input,init){
 const u=new URL(input instanceof Request?input.url:String(input));
 if(u.origin!==origin||u.username||u.password||init?.dispatcher)reject();
 trace(u.href,'fetch');return originalFetch.call(globalThis,input,{...init,redirect:'error'});
};
for(const [mod,protocol] of [[http,'http:'],[https,'https:']]){
 for(const method of ['request','get']){
  const original=mod[method];
  mod[method]=function(input,options,...rest){
   let o=(typeof input==='string'||input instanceof URL)?urlToHttpOptions(new URL(input)):{...input};
   if((typeof input==='string'||input instanceof URL)&&options&&typeof options==='object')o={...o,...options};
   const host=o.hostname??o.host??'localhost';const scheme=o.protocol??protocol;const port=String(o.port??(scheme==='https:'?443:80));
   if(scheme!=='http:'||host!=='127.0.0.1'||port!=='3012'||o.auth||o.socketPath||o.createConnection||(o.agent&&o.agent!==mod.globalAgent))reject();
   trace(origin+(o.path??'/'),'node-http');
   return original.call(this,input,options,...rest);
  };
 }
}
syncBuiltinESMExports();
