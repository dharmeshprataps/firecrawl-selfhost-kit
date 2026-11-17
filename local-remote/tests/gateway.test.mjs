import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import http from 'node:http';
import {createGateway, MAX_INPUT, validateArguments, validateRuntimeBoundary, assertRuntimeBoundary} from '../gateway.mjs';

const names = ['firecrawl_scrape', 'firecrawl_map', 'firecrawl_crawl', 'firecrawl_check_crawl_status', 'firecrawl_search',
  'local_web_capabilities', 'local_web_status', 'local_web_attributes', 'local_web_batch_scrape', 'local_web_monitor_create',
  'local_web_monitor_list', 'local_web_monitor_get', 'local_web_monitor_update', 'local_web_monitor_run', 'local_web_monitor_delete',
  'local_web_monitor_checks', 'local_web_monitor_check', 'local_web_read'];
function catalogTool(name) {
  return name === 'local_web_read'
    ? {name, description: name, annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: true},
      inputSchema: {type: 'object', properties: {url: {type: 'string'}}, required: ['url'], additionalProperties: false}}
    : {name, description: name, inputSchema: {type: 'object', properties: {}}};
}
const BASE = 'https://firecrawl.example/firecrawl';
const auth = {
  publicBase: BASE,
  async handle() {return false;},
  authenticate(req) {
    if (req.headers.authorization === 'Bearer unit-test') return {subject: 'owner', scopes: ['firecrawl:use'], tokenId: 'test'};
    if (req.headers.authorization === 'Bearer wrong-scope') return {subject: 'owner', scopes: [], tokenId: 'test'};
    return null;
  },
  challenge(res) {res.writeHead(401, {'WWW-Authenticate': 'Bearer resource_metadata="https://firecrawl.example/.well-known/oauth-protected-resource/firecrawl/mcp"'}); res.end();},
};
function bridge(overrides = {}) {
  return {listTools: async () => ({tools: names.map(catalogTool)}),
    callTool: async (name, args) => ({content: [{type: 'text', text: JSON.stringify({name, args})}]}), close: async () => {}, ...overrides};
}
async function fixture(t, options = {}) {
  const gateway = await createGateway({auth, publicBase: BASE, bridge: bridge(), httpRateLimit: 1000, toolRateLimit: 1000, ...options});
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + gateway.server.address().port;
  t.after(async () => {gateway.server.closeIdleConnections(); await gateway.close();});
  async function request(body, options = {}) {
    const headers = {Host: 'firecrawl.example', Authorization: 'Bearer unit-test', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...options.headers};
    return new Promise((resolve, reject) => {
      const req = http.request(base + (options.path ?? '/firecrawl/mcp'), {method: options.method ?? 'POST', headers}, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve(new Response(Buffer.concat(chunks), {status: res.statusCode, headers: res.headers})));
      });
      req.on('error', reject); req.end((options.method ?? 'POST') === 'POST' ? typeof body === 'string' ? body : JSON.stringify(body) : undefined);
    });
  }
  return {gateway, request};
}
const call = (name = 'local_web_status', args = {}, id = 1) => ({jsonrpc: '2.0', id, method: 'tools/call', params: {name, arguments: args}});

test('public health is generic and raw REST is unavailable', async t => {
  const {request} = await fixture(t);
  const health = await request(null, {path: '/firecrawl/health', method: 'GET', headers: {Authorization: ''}});
  assert.equal(health.status, 200); assert.deepEqual(await health.json(), {status: 'ok', service: 'local-firecrawl-gateway'});
  assert.equal((await request({}, {path: '/firecrawl/api/v2/scrape'})).status, 404);
});
test('MCP authenticates every method before parsing', async t => {
  const {request} = await fixture(t);
  for (const method of ['GET', 'DELETE', 'POST']) {
    const response = await request('invalid json', {method, headers: {Authorization: ''}});
    assert.equal(response.status, 401); assert.match(response.headers.get('www-authenticate'), /resource_metadata=/);
  }
  assert.equal((await request(call(), {headers: {Authorization: 'Bearer wrong-scope'}})).status, 403);
});
test('host and browser origin are validated', async t => {
  const {request} = await fixture(t);
  assert.equal((await request(call(), {headers: {Host: 'attacker.invalid'}})).status, 403);
  assert.equal((await request(call(), {headers: {Origin: 'https://attacker.invalid'}})).status, 403);
  assert.equal((await request(call(), {headers: {Origin: 'null'}})).status, 403);
  assert.equal((await request(call(), {headers: {Origin: 'https://chatgpt.com'}})).status, 200);
  assert.equal((await request(call(), {headers: {Origin: 'https://firecrawl.example'}})).status, 200);
  assert.equal((await request(call(), {headers: {Host: 'firecrawl.example:443'}})).status, 200);
  assert.equal((await request(call(), {headers: {Host: 'firecrawl.example:8443'}})).status, 403);
  assert.equal((await request(call(), {headers: {Host: 'firecrawl.example.attacker.invalid'}})).status, 403);
});
test('gateway requires explicit public configuration matching its OAuth issuer', async () => {
  await assert.rejects(createGateway({auth, publicBase: '', bridge: bridge()}), /FIRECRAWL_PUBLIC_BASE/);
  await assert.rejects(createGateway({auth, publicBase: 'https://other.example/firecrawl', bridge: bridge()}), /Matching reviewed OAuth/);
  await assert.rejects(createGateway({auth, publicBase: 'http://firecrawl.example/firecrawl', bridge: bridge()}), /FIRECRAWL_PUBLIC_BASE/);
});
test('a configured nonstandard HTTPS port has an exact host and origin boundary', async t => {
  const publicBase = 'https://firecrawl.example:8443/firecrawl';
  const {request} = await fixture(t, {publicBase, auth: {...auth, publicBase}});
  assert.equal((await request(call(), {headers: {Host: 'firecrawl.example:8443', Origin: 'https://firecrawl.example:8443'}})).status, 200);
  assert.equal((await request(call(), {headers: {Host: 'firecrawl.example'}})).status, 403);
  assert.equal((await request(call(), {headers: {Host: 'firecrawl.example:8443', Origin: 'https://firecrawl.example'}})).status, 403);
});
test('stateless initialization has truthful remote instructions', async t => {
  const {request} = await fixture(t);
  const response = await request({jsonrpc: '2.0', id: 7, method: 'initialize', params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'unit', version: '1'}}});
  assert.equal(response.status, 200); assert.equal(response.headers.get('mcp-session-id'), null);
  const result = await response.json(); assert.equal(result.id, 7); assert.equal(result.result.serverInfo.name, 'local-web-crawler-remote');
  assert.match(result.result.instructions, /authenticated remote/);
});
test('catalog preserves the exact reviewed eighteen tools and remote crawl cap', async t => {
  const {request} = await fixture(t);
  const response = await request({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}});
  const result = await response.json(); assert.equal(result.result.tools.length, 18);
  assert.deepEqual(new Set(result.result.tools.map(tool => tool.name)), new Set(names));
  assert.deepEqual(result.result.tools[0].securitySchemes, [{type: 'oauth2', scopes: ['firecrawl:use']}]);
  assert.equal(result.result.tools.find(tool => tool.name === 'firecrawl_crawl').inputSchema.properties.limit.maximum, 5);
  assert.deepEqual(result.result.tools.find(tool => tool.name === 'local_web_read').annotations,
    {readOnlyHint: true, destructiveHint: false, openWorldHint: true});
});
test('unreviewed tools and arbitrary RPC methods cannot reach the bridge', async t => {
  let calls = 0; const {request} = await fixture(t, {bridge: bridge({callTool: async () => {calls++;}})});
  const hidden = await (await request(call('firecrawl_agent'))).json(); assert.equal(hidden.result.isError, true); assert.equal(calls, 0);
  const arbitrary = await (await request({jsonrpc: '2.0', id: 9, method: 'remote/exec', params: {}})).json(); assert.equal(arbitrary.error.code, -32601);
});
test('tool calls preserve independent client RPC IDs', async t => {
  const {request} = await fixture(t);
  const results = await Promise.all([request(call('local_web_status', {}, 'same')), request(call('local_web_capabilities', {}, 'same'))]);
  const bodies = await Promise.all(results.map(response => response.json()));
  assert.ok(bodies.every(body => body.id === 'same')); assert.match(bodies[0].result.content[0].text, /local_web_status/); assert.match(bodies[1].result.content[0].text, /local_web_capabilities/);
});
test('remote URL and crawl limits reject private fixture arguments', () => {
  for (const url of ['http://fixtures.firecrawl.test:8765/', 'http://127.0.0.1:3012/', 'http://0x7f000001/', 'http:\\127.0.0.1/', 'http://10.1.1.1/', 'http://172.16.1.1/', 'http://192.168.2.3/', 'http://169.254.169.254/', 'http://[::1]/', 'file:///etc/passwd', 'http://user:pass@example.com/']) {
    assert.throws(() => validateArguments('firecrawl_scrape', {url}));
  }
  assert.throws(() => validateArguments('firecrawl_scrape', {url: 'https://example.org', actions: [{selector: 'http%3A%2F%2Ffixtures.firecrawl.test%3A8765%2F'}]}));
  assert.throws(() => validateArguments('firecrawl_crawl', {url: 'https://example.org', limit: 6}));
  assert.equal(validateArguments('firecrawl_crawl', {url: 'https://example.org'}).limit, 5);
});
test('read-only reads retain public URL policy and reject interactive/provider options', async t => {
  for (const url of ['http://fixtures.firecrawl.test:8765/', 'http://127.0.0.1/', 'http://0x7f000001/', 'http://[::1]/', 'file:///etc/passwd', 'http://user:pass@example.org/']) {
    assert.throws(() => validateArguments('local_web_read', {url}));
  }
  let calls = 0;
  const {request} = await fixture(t, {bridge: bridge({callTool: async () => {calls++; return {content: []};}})});
  for (const option of ['actions', 'profile', 'session', 'headers', 'webhook', 'proxy', 'alexandria', 'requestId', 'domainTools', 'toolDetail', 'zeroDataRetention']) {
    const body = await (await request(call('local_web_read', {url: 'https://example.org/', [option]: option === 'actions' ? [] : null}))).json();
    assert.equal(body.result.isError, true, option); assert.equal(calls, 0, option);
  }
  // The existing interactive tool keeps its reviewed action contract.
  const original = {url: 'https://example.org/', actions: [{type: 'click', selector: 'a.next'}]};
  assert.equal(validateArguments('firecrawl_scrape', original), original);
});
test('read-only nested options reject hidden writes while JSON schema remains data', () => {
  const url = 'https://example.org/';
  for (const options of [
    {jsonOptions: {prompt: 'Read title', actions: []}},
    {queryOptions: {prompt: 'Read title', headers: {Authorization: 'unreviewed'}}},
    {screenshotOptions: {headers: {}}},
    {screenshotOptions: {viewport: {width: 800, height: 600, actions: []}}},
    {pdfOptions: {maxPages: 2, webhook: 'https://example.org/'}},
    {location: {country: 'IN', profile: {name: 'saved'}}},
    {formats: [{type: 'json', actions: []}]},
  ]) assert.throws(() => validateArguments('local_web_read', {url, ...options}), /read-only options/);
  const schema = {type: 'object', properties: {actions: {type: 'string'}, headers: {type: 'string'}}};
  const args = {url, formats: ['markdown', 'json'], jsonOptions: {prompt: 'Read literal source fields', schema}};
  assert.deepEqual(validateArguments('local_web_read', args), args);
});
test('read-only full-format option values are checked before forwarding', () => {
  const args = {url: 'https://example.org/document.pdf', formats: ['markdown', 'html', 'rawHtml', 'links', 'images', 'json', 'summary', 'screenshot'],
    jsonOptions: {prompt: 'Read title', schema: {type: 'object'}}, queryOptions: {prompt: 'Read title', mode: 'freeform'},
    screenshotOptions: {fullPage: true, quality: 80, viewport: {width: 800, height: 600}}, pdfOptions: {maxPages: 2}, parsers: ['pdf'],
    onlyMainContent: true, redactPII: false, includeTags: ['main'], excludeTags: ['nav'], waitFor: 250, mobile: false,
    skipTlsVerification: false, removeBase64Images: true, location: {country: 'IN', languages: ['en']}, storeInCache: false,
    maxAge: 0, lockdown: false, timeout: 45000, expectedContent: ['Expected title']};
  assert.deepEqual(validateArguments('local_web_read', args), args);
  for (const options of [{timeout: 0}, {timeout: 1.5}, {maxAge: -1}, {waitFor: NaN}, {onlyMainContent: 'true'},
    {includeTags: [null]}, {formats: ['branding']}, {parsers: ['pdf', 'pdf']}, {pdfOptions: {maxPages: 0}},
    {pdfOptions: {maxPages: true}}, {jsonOptions: {schema: []}}, {queryOptions: {mode: 'freeform'}},
    {queryOptions: {prompt: 'x', mode: 'other'}}, {screenshotOptions: {viewport: {width: 0, height: 600}}},
    {location: {languages: 'en'}}, {expectedContent: []}]) {
    assert.throws(() => validateArguments('local_web_read', {url: args.url, ...options}), /read-only options/);
  }
});
test('read-only calls keep their tool identity, independent RPC IDs and local timings', async t => {
  const records = [];
  const {request} = await fixture(t, {timingSink: record => records.push(record)});
  const result = await (await request(call('local_web_read', {url: 'https://example.org/', formats: ['html'], storeInCache: false}, 'read-37'))).json();
  assert.equal(result.id, 'read-37'); assert.equal(result.result.isError, undefined);
  const forwarded = JSON.parse(result.result.content[0].text);
  assert.equal(forwarded.name, 'local_web_read'); assert.equal(forwarded.args.storeInCache, false);
  assert.equal(result.result._meta.localGateway.activeCalls, 1);
  assert.equal(records.length, 1); assert.equal(records[0].tool, 'local_web_read');
  assert.equal('arguments' in records[0], false);
});
test('invalid JSON, batches and oversized inputs are bounded', async t => {
  const {request} = await fixture(t);
  assert.equal((await request('not-json')).status, 400);
  assert.equal((await request([])).status, 400);
  assert.equal((await request('x'.repeat(MAX_INPUT + 1))).status, 413);
});
test('authenticated GET and DELETE explicitly reject unsupported transport methods', async t => {
  const {request} = await fixture(t);
  for (const method of ['GET', 'DELETE']) assert.equal((await request(null, {method})).status, 405);
});
test('HTTP and owner tool rate limits are enforced', async t => {
  const one = await fixture(t, {httpRateLimit: 2});
  assert.equal((await one.request(call())).status, 200); assert.equal((await one.request(call())).status, 200); assert.equal((await one.request(call())).status, 429);
  const two = await fixture(t, {toolRateLimit: 1});
  assert.equal((await (await two.request(call())).json()).result.isError, undefined);
  const limited = await (await two.request(call())).json(); assert.equal(limited.result.isError, true); assert.match(limited.result.content[0].text, /rate exceeded/);
});
test('two active tools and at most four queued calls per owner', async t => {
  let active = 0, peak = 0, release; const gate = new Promise(resolve => {release = resolve;});
  const records = [];
  const {request} = await fixture(t, {timingSink: record => records.push(record), bridge: bridge({callTool: async () => {active++; peak = Math.max(peak, active); await gate; active--; return {content: [{type: 'text', text: 'done'}]};}})});
  const pending = Array.from({length: 8}, (_, id) => request(call('local_web_status', {}, id)).then(response => response.json()));
  await delay(100); assert.equal(active, 2); release();
  const results = await Promise.all(pending); assert.equal(peak, 2); assert.equal(results.filter(body => body.result.isError).length, 2);
  assert.equal(records.length, 8);
  const refused = records.filter(record => record.queueOutcome === 'full');
  assert.equal(refused.length, 2); assert.ok(refused.every(record => record.executionStarted === false && record.bridgeMs === 0 && record.isError));
});
test('a bounded longer queue admits all four slow reads without increasing execution capacity', async t => {
  for (const [queueWaitMs, expectedErrors] of [[20, 2], [200, 0]]) {
    let active = 0, peak = 0, calls = 0;
    const records = [];
    const {request} = await fixture(t, {queueWaitMs, toolDeadlineMs: 1000, timingSink: record => records.push(record),
      bridge: bridge({callTool: async () => {calls++; active++; peak = Math.max(peak, active); await delay(60); active--; return {content: [{type: 'text', text: 'page'}]};}})});
    const results = await Promise.all(Array.from({length: 4}, (_, id) => request(call('local_web_read', {url: 'https://example.org/' + id}, id)).then(response => response.json())));
    assert.equal(results.filter(body => body.result.isError).length, expectedErrors, 'queue wait ' + queueWaitMs);
    assert.equal(calls, 4 - expectedErrors); assert.equal(peak, 2); assert.equal(records.length, 4);
    assert.equal(records.filter(record => !record.executionStarted).length, expectedErrors);
  }
});
test('queue expiry emits one failure record and does not dispatch expired work', async t => {
  let calls = 0, release; const gate = new Promise(resolve => {release = resolve;});
  const records = [];
  const {request} = await fixture(t, {queueWaitMs: 20, toolDeadlineMs: 1000, timingSink: record => records.push(record),
    bridge: bridge({callTool: async () => {calls++; await gate; return {content: [{type: 'text', text: 'page'}]};}})});
  const first = [request(call('local_web_read', {url: 'https://example.org/a'}, 1)), request(call('local_web_read', {url: 'https://example.org/b'}, 2))];
  const until = Date.now() + 500; while (calls < 2 && Date.now() < until) await delay(1);
  assert.equal(calls, 2);
  const expired = await (await request(call('local_web_read', {url: 'https://example.org/expired'}, 3))).json();
  assert.equal(expired.result.isError, true); assert.match(expired.result.content[0].text, /queue wait exceeded/);
  assert.equal(calls, 2); assert.equal(records.length, 1);
  assert.deepEqual(Object.fromEntries(['executionStarted', 'queueOutcome', 'bridgeMs', 'activeCalls', 'isError'].map(key => [key, records[0][key]])),
    {executionStarted: false, queueOutcome: 'timeout', bridgeMs: 0, activeCalls: 0, isError: true});
  assert.equal(expired.result._meta.localGateway.executionStarted, false);
  release(); await Promise.all(first.map(async response => (await response).json()));
  assert.equal(records.length, 3); assert.equal(records.filter(record => record.queueOutcome === 'timeout').length, 1);
  const next = await (await request(call('local_web_read', {url: 'https://example.org/next'}, 4))).json();
  assert.equal(next.result.isError, undefined); assert.equal(calls, 3);
});
test('tool deadlines and bridge errors return safe generic failures', async t => {
  const {request} = await fixture(t, {toolDeadlineMs: 20, bridge: bridge({callTool: async () => new Promise(() => {})})});
  const timeout = await (await request(call())).json(); assert.equal(timeout.result.isError, true); assert.match(timeout.result.content[0].text, /deadline exceeded/);
  const failing = await fixture(t, {bridge: bridge({callTool: async () => {throw new Error('secret-value-must-not-escape');}})});
  const error = await (await failing.request(call())).json(); assert.equal(error.result.isError, true); assert.doesNotMatch(JSON.stringify(error), /secret-value/);
});
test('oversized outputs are rejected before remote transmission', async t => {
  const {request} = await fixture(t, {bridge: bridge({callTool: async () => ({content: [{type: 'text', text: 'x'.repeat(8 * 1024 * 1024)}]})})});
  const result = await (await request(call())).json(); assert.equal(result.result.isError, true); assert.match(result.result.content[0].text, /remote limit/);
});
test('catalog drift fails closed', async t => {
  const {request} = await fixture(t, {bridge: bridge({listTools: async () => ({tools: names.map(name => ({name: name === 'firecrawl_search' ? 'firecrawl_agent' : name, inputSchema: {type: 'object'}}))})})});
  const result = await (await request(call())).json(); assert.equal(result.result.isError, true);
});
test('read-only catalog drift cannot mislabel an interactive tool as read-only', async t => {
  for (const change of [tool => {tool.annotations.readOnlyHint = false;}, tool => {delete tool.annotations;},
    tool => {tool.annotations.openWorldHint = false;}, tool => {tool.inputSchema.properties.actions = {type: 'array'};},
    tool => {tool.inputSchema.additionalProperties = true;}]) {
    const tools = names.map(catalogTool); change(tools.find(tool => tool.name === 'local_web_read'));
    let calls = 0;
    const {request} = await fixture(t, {bridge: bridge({listTools: async () => ({tools}), callTool: async () => {calls++;}})});
    const result = await (await request(call('local_web_read', {url: 'https://example.org/'}))).json();
    assert.equal(result.result.isError, true); assert.equal(calls, 0);
  }
});
test('runtime public boundary requires both reviewed running services with fixtures explicitly disabled', async () => {
  const good = [
    {name: '/firecrawl-api-1', running: true, project: 'firecrawl', service: 'api', fixtureValues: ['LOCAL_FIXTURE_ORIGIN=']},
    {name: '/firecrawl-playwright-service-1', running: true, project: 'firecrawl', service: 'playwright-service', fixtureValues: ['LOCAL_FIXTURE_ORIGIN=']},
  ];
  assert.equal(validateRuntimeBoundary(good), true);
  for (const bad of [[], good.slice(0, 1), [good[0], {...good[1], running: false}], [good[0], {...good[1], fixtureValues: []}], [good[0], {...good[1], fixtureValues: ['LOCAL_FIXTURE_ORIGIN=http://fixtures.firecrawl.test:8765']}], [good[0], {...good[1], project: 'unreviewed'}]]) assert.throws(() => validateRuntimeBoundary(bad));
  const inspect = async (command, args) => {assert.equal(command, '/opt/homebrew/bin/docker'); assert.equal(args[1], 'colima-firecrawl'); return {stdout: good.map(value => JSON.stringify(value)).join('\n')};};
  assert.equal(await assertRuntimeBoundary(inspect), true);
  await assert.rejects(assertRuntimeBoundary(async () => {throw new Error('secret must not escape');}), /startup refused/);
});


test('gateway records queue and bridge timings without tool arguments', async t => {
  const records=[];
  const {request}=await fixture(t,{timingSink:record=>records.push(record),bridge:bridge({callTool:async()=>{await delay(20);return{content:[{type:'text',text:'ready'}],_meta:{localExecution:{queueMs:3,serviceMs:10}}};}})});
  const response=await(await request(call('firecrawl_scrape',{url:'https://example.org'}))).json();
  assert.equal(response.result._meta.localGateway.activeCalls,1);
  assert.ok(response.result._meta.localGateway.bridgeMs>=15);
  assert.equal(records.length,1);assert.equal(records[0].proxyQueueMs,3);assert.equal(records[0].proxyServiceMs,10);
  assert.equal(records[0].tool,'firecrawl_scrape');assert.equal('arguments' in records[0],false);assert.equal('url' in records[0],false);
});
