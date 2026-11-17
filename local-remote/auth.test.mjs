import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth } from './auth.mjs';

const BASE = 'https://firecrawl.example/firecrawl';
const RESOURCE = `${BASE}/mcp`;
const ISSUER = `${BASE}/oauth`;
const CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
const verifier = () => randomBytes(32).toString('base64url');
const challenge = value => createHash('sha256').update(value).digest('base64url');

async function fixture(t) {
  const stateDir = mkdtempSync(join(tmpdir(), 'local-firecrawl-oauth-test-'));
  let time = Date.now();
  let auth = createAuth({ publicBase: BASE, stateDir, now: () => time, scryptN: 1024 });
  const server = createServer(async (req, res) => {
    if (!(await auth.handle(req, res))) {
      if (req.url === '/firecrawl/mcp') {
        const info = auth.authenticate(req);
        if (!info) auth.challenge(res);
        else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(info)); }
      } else { res.statusCode = 404; res.end(); }
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(stateDir, { recursive: true, force: true }); });
  const send = (path, { method = 'GET', data, format = 'application/x-www-form-urlencoded', headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = data === undefined ? undefined : format === 'application/json' ? JSON.stringify(data) : new URLSearchParams(data).toString();
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: { ...(payload === undefined ? {} : { 'Content-Type': format, 'Content-Length': Buffer.byteLength(payload) }), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let body; try { body = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, body }); });
    });
    req.on('error', reject); req.end(payload);
  });
  const register = async (data = {}, headers = {}) => {
    const res = await send('/firecrawl/oauth/register', { method: 'POST', format: 'application/json', data: { redirect_uris: [CALLBACK], client_name: 'ChatGPT test', token_endpoint_auth_method: 'none', ...data }, headers });
    return res;
  };
  const flow = async (clientId, changes = {}) => {
    const value = verifier();
    const params = { client_id: clientId, redirect_uri: CALLBACK, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(value), resource: RESOURCE, scope: 'firecrawl:use', state: 'state-from-chatgpt-123', ...changes };
    const res = await send(`/firecrawl/oauth/authorize?${new URLSearchParams(params)}`);
    return { res, verifier: value, cookie: res.headers['set-cookie']?.[0]?.split(';')[0], csrf: res.text.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1], params };
  };
  const approve = async (f, data = {}, headers = {}) => send('/firecrawl/oauth/authorize', { method: 'POST', data: { csrf: f.csrf, password: readFileSync(join(stateDir, 'owner-password.txt'), 'utf8').trim(), decision: 'approve', ...data }, headers: { Cookie: f.cookie, Origin: new URL(BASE).origin, ...headers } });
  const code = async clientId => {
    const f = await flow(clientId); assert.equal(f.res.status, 200);
    const res = await approve(f); assert.equal(res.status, 302);
    return { code: new URL(res.headers.location).searchParams.get('code'), verifier: f.verifier, redirect: new URL(res.headers.location) };
  };
  const exchange = async (clientId, grant, changes = {}) => send('/firecrawl/oauth/token', { method: 'POST', data: { grant_type: 'authorization_code', client_id: clientId, code: grant.code, code_verifier: grant.verifier, redirect_uri: CALLBACK, resource: RESOURCE, ...changes } });
  const tokens = async clientId => { const grant = await code(clientId); const res = await exchange(clientId, grant); assert.equal(res.status, 200); return res.body; };
  const refresh = (clientId, token, changes = {}) => send('/firecrawl/oauth/token', { method: 'POST', data: { grant_type: 'refresh_token', client_id: clientId, refresh_token: token, resource: RESOURCE, ...changes } });
  return { stateDir, send, register, flow, approve, code, exchange, tokens, refresh, advance: milliseconds => { time += milliseconds; }, restart: () => { auth = createAuth({ publicBase: BASE, stateDir, now: () => time }); } };
}

test('path-aware metadata identifies the same issuer, resource, S256 and public client method', async t => {
  const f = await fixture(t);
  const metadata = await f.send('/.well-known/oauth-authorization-server/firecrawl/oauth');
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.issuer, ISSUER);
  assert.equal(metadata.body.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(metadata.body.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(metadata.body.token_endpoint_auth_methods_supported, ['none']);
  const resource = await f.send('/.well-known/oauth-protected-resource/firecrawl/mcp');
  assert.equal(resource.body.resource, RESOURCE);
  assert.deepEqual(resource.body.authorization_servers, [ISSUER]);
  assert.equal((await f.send('/firecrawl/oauth/.well-known/oauth-authorization-server')).status, 200);
  assert.equal((await f.send('/firecrawl/.well-known/oauth-protected-resource')).status, 200);
  assert.equal((await f.send('/.well-known/oauth-authorization-server')).status, 404);
  const denied = await f.send('/firecrawl/mcp');
  assert.equal(denied.status, 401);
  assert.match(denied.headers['www-authenticate'], /oauth-protected-resource\/firecrawl\/mcp/);
});

test('DCR accepts only exact documented ChatGPT callback and rejects unsafe client metadata', async t => {
  const f = await fixture(t);
  const good = await f.register(); assert.equal(good.status, 201);
  assert.equal(good.body.client_secret, undefined);
  for (const changes of [
    { redirect_uris: ['http://chatgpt.com/connector_platform_oauth_redirect'] },
    { redirect_uris: [`${CALLBACK}/`] },
    { redirect_uris: [`${CALLBACK}?next=https://example.com`] },
    { redirect_uris: ['https://chatgpt.com.evil.example/connector_platform_oauth_redirect'] },
    { redirect_uris: [CALLBACK, 'https://example.com/callback'] },
    { grant_types: ['client_credentials'] },
    { response_types: ['token'] },
    { token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_signing_alg: 'none' },
    { token_endpoint_auth_signing_alg: 'none' },
    { client_secret: 'not-supported' },
  ]) {
    // Each case has an independent test IP so client-policy cases do not hit the DCR limiter.
    const ip = `192.0.2.${2 + Object.keys(changes).join('').length}`;
    assert.equal((await f.register(changes, { 'cf-connecting-ip': ip })).status, 400);
  }
});

test('DCR enforces persistent registration rate limits and bounded client storage', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await f.register()).status, 201);
  assert.equal((await f.register()).status, 429);
  f.restart(); assert.equal((await f.register()).status, 429);
  f.advance(61_000); assert.equal((await f.register()).status, 201);
  // Fill the remaining quota using separate fixed windows, then fail closed.
  let count = 11;
  while (count < 200) {
    f.advance(61_000);
    for (let i = 0; i < Math.min(10, 200 - count); i++) {
      assert.equal((await f.register()).status, 201);
    }
    count = Object.keys(JSON.parse(readFileSync(join(f.stateDir, 'state.json'))).clients).length;
  }
  f.advance(61_000); assert.equal((await f.register()).status, 503);
  assert.equal(Object.keys(JSON.parse(readFileSync(join(f.stateDir, 'state.json'))).clients).length, 200);
});

test('authorization requires a registered client, exact resource and redirect, code and S256', async t => {
  const f = await fixture(t), client = (await f.register()).body.client_id;
  for (const changes of [
    { client_id: 'unregistered' }, { response_type: 'token' }, { code_challenge_method: 'plain' },
    { resource: 'https://example.com/mcp' }, { scope: 'admin' }, { redirect_uri: 'https://example.com/callback' },
    { code_challenge: 'short' }, { request_uri: 'https://example.com/request' }, { state: '' },
  ]) assert.equal((await f.flow(client, changes)).res.status, 400);
  const duplicate = await f.send(`/firecrawl/oauth/authorize?client_id=${client}&client_id=${client}`);
  assert.equal(duplicate.status, 400);
});

test('owner consent requires secure cookie, same-origin request, CSRF, password and explicit approval', async t => {
  const f = await fixture(t), client = (await f.register({ client_name: '<script>evil</script>' })).body.client_id;
  const flow = await f.flow(client);
  assert.equal(flow.res.status, 200);
  assert.match(flow.res.headers['set-cookie'][0], /Secure; HttpOnly; SameSite=Lax/);
  assert.match(flow.res.text, /&lt;script&gt;evil&lt;\/script&gt;/);
  assert.doesNotMatch(flow.res.text, /<script>/);
  assert.match(flow.res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(flow.res.headers['referrer-policy'], 'same-origin');
  assert.match(flow.res.headers['content-security-policy'], /form-action 'self' https:\/\/chatgpt\.com\/connector_platform_oauth_redirect;/);
  assert.equal((await f.approve(flow, {}, { Cookie: '' })).status, 403);
  assert.equal((await f.approve(flow, { csrf: verifier() })).status, 403);
  assert.equal((await f.approve(flow, {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.approve(flow, {}, { Origin: 'null' })).status, 403);
  assert.equal((await f.send('/firecrawl/oauth/authorize', { method: 'POST', data: { csrf: flow.csrf, decision: 'approve' }, headers: { Cookie: flow.cookie } })).status, 403);
  assert.equal((await f.approve(flow, {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.approve(flow, { password: 'incorrect' })).status, 401);
  const approved = await f.approve(flow); assert.equal(approved.status, 302);
  const target = new URL(approved.headers.location);
  assert.equal(target.origin + target.pathname, CALLBACK);
  assert.equal(target.searchParams.get('state'), flow.params.state);
  assert.equal(target.searchParams.get('iss'), ISSUER);
  assert.equal(target.searchParams.has('access_token'), false);
  assert.equal((await f.approve(flow)).status, 403);
});

test('owner login lockout survives restart and expires after 15 minutes', async t => {
  const f = await fixture(t), client = (await f.register()).body.client_id;
  const flow = await f.flow(client);
  for (let i = 0; i < 5; i++) assert.equal((await f.approve(flow, { password: 'wrong' })).status, 401);
  assert.equal((await f.approve(flow)).status, 429);
  f.restart(); const flow2 = await f.flow(client);
  assert.equal((await f.approve(flow2)).status, 429);
  f.advance(901_000); const flow3 = await f.flow(client);
  assert.equal((await f.approve(flow3)).status, 302);
});

test('cancel returns issuer-bound access_denied without creating an authorization code', async t => {
  const f = await fixture(t), client = (await f.register()).body.client_id, flow = await f.flow(client);
  const denied = await f.approve(flow, { decision: 'deny', password: '' });
  assert.equal(denied.status, 302);
  const target = new URL(denied.headers.location);
  assert.equal(target.searchParams.get('error'), 'access_denied');
  assert.equal(target.searchParams.get('iss'), ISSUER);
  assert.equal(Object.keys(JSON.parse(readFileSync(join(f.stateDir, 'state.json'))).codes).length, 0);
});

test('code exchange binds PKCE, resource, client, redirect and consumes once only after valid PKCE', async t => {
  const f = await fixture(t), client = (await f.register()).body.client_id, other = (await f.register()).body.client_id;
  const grant = await f.code(client);
  assert.equal((await f.exchange(client, grant, { code_verifier: verifier() })).status, 400);
  assert.equal((await f.exchange(other, grant)).status, 400);
  assert.equal((await f.exchange(client, grant, { resource: 'https://evil.example' })).status, 400);
  assert.equal((await f.exchange(client, grant, { redirect_uri: `${CALLBACK}/` })).status, 400);
  assert.equal((await f.exchange(client, grant, { client_secret: 'unsupported' })).status, 401);
  const successes = await Promise.all([f.exchange(client, grant), f.exchange(client, grant)]);
  assert.deepEqual(successes.map(x => x.status).sort(), [200, 400]);
  const tokens = successes.find(x => x.status === 200).body;
  assert.equal(tokens.expires_in, 3600);
  const info = await f.send('/firecrawl/mcp', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(info.status, 200); assert.equal(info.body.subject, 'owner');
  assert.deepEqual(info.body.scopes, ['firecrawl:use']);
  assert.equal((await f.send(`/firecrawl/mcp?access_token=${tokens.access_token}`)).status, 404);
});

test('authorization codes expire after 180 seconds and flows expire after ten minutes', async t => {
  const f = await fixture(t), client = (await f.register()).body.client_id, grant = await f.code(client);
  f.advance(181_000); assert.equal((await f.exchange(client, grant)).status, 400);
  const flow = await f.flow(client); f.advance(601_000);
  assert.equal((await f.approve(flow)).status, 403);
});

test('access survives restart, expires in one hour, and refresh is client/resource bound', async t => {
  const f = await fixture(t), client = (await f.register()).body.client_id, other = (await f.register()).body.client_id;
  const tokens = await f.tokens(client); f.restart();
  assert.equal((await f.send('/firecrawl/mcp', { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 200);
  assert.equal((await f.refresh(other, tokens.refresh_token)).status, 400);
  assert.equal((await f.refresh(client, tokens.refresh_token, { resource: 'https://evil.example/mcp' })).status, 400);
  assert.equal((await f.refresh(client, tokens.refresh_token, { scope: 'admin' })).status, 400);
  f.advance(3601_000);
  assert.equal((await f.send('/firecrawl/mcp', { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 401);
  assert.equal((await f.refresh(client, tokens.refresh_token)).status, 200);
});

test('rotating refresh tokens revoke the entire family on replay and expire after seven days', async t => {
  const f = await fixture(t), client = (await f.register()).body.client_id;
  const tokens = await f.tokens(client), rotated = await f.refresh(client, tokens.refresh_token);
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.refresh_token, tokens.refresh_token);
  assert.equal((await f.send('/firecrawl/mcp', { headers: { Authorization: `Bearer ${rotated.body.access_token}` } })).status, 200);
  assert.equal((await f.refresh(client, tokens.refresh_token)).status, 400);
  assert.equal((await f.send('/firecrawl/mcp', { headers: { Authorization: `Bearer ${rotated.body.access_token}` } })).status, 401);
  assert.equal((await f.refresh(client, rotated.body.refresh_token)).status, 400);
  const fresh = await f.tokens(client); f.advance(7 * 86400_000 + 1000);
  assert.equal((await f.refresh(client, fresh.refresh_token)).status, 400);
});

test('public-client revocation requires knowledge of token and matching client', async t => {
  const f = await fixture(t), client = (await f.register()).body.client_id, other = (await f.register()).body.client_id;
  const tokens = await f.tokens(client);
  const revoke = id => f.send('/firecrawl/oauth/revoke', { method: 'POST', data: { client_id: id, token: tokens.refresh_token } });
  assert.equal((await revoke(other)).status, 200);
  assert.equal((await f.send('/firecrawl/mcp', { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 200);
  assert.equal((await revoke(client)).status, 200);
  assert.equal((await f.send('/firecrawl/mcp', { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 401);
});

test('private state stores hashes instead of bearer/code/password credentials', async t => {
  const f = await fixture(t), client = (await f.register()).body.client_id, grant = await f.code(client);
  let persisted = readFileSync(join(f.stateDir, 'state.json'), 'utf8');
  assert.equal(persisted.includes(grant.code), false);
  const tokens = (await f.exchange(client, grant)).body;
  persisted = readFileSync(join(f.stateDir, 'state.json'), 'utf8');
  for (const secret of [tokens.access_token, tokens.refresh_token, readFileSync(join(f.stateDir, 'owner-password.txt'), 'utf8').trim()]) assert.equal(persisted.includes(secret), false);
  assert.equal(statSync(f.stateDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.stateDir, 'state.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.stateDir, 'owner-password.txt')).mode & 0o777, 0o600);
});

test('malformed requests, duplicate parameters, unsupported grants and query credentials fail closed', async t => {
  const f = await fixture(t), client = (await f.register()).body.client_id;
  assert.equal((await f.send('/firecrawl/oauth/token', { method: 'POST', data: { grant_type: 'password', client_id: client, resource: RESOURCE } })).body.error, 'unsupported_grant_type');
  assert.equal((await f.send('/firecrawl/oauth/token?access_token=forbidden', { method: 'POST', data: { client_id: client } })).status, 400);
  assert.equal((await f.send('/firecrawl/oauth/token', { method: 'POST', format: 'application/json', data: { client_id: client } })).status, 400);
  assert.equal((await f.send('/firecrawl/oauth/register', { method: 'POST', format: 'application/json', data: { padding: 'x'.repeat(17000) } })).status, 413);
  assert.equal((await f.send('/firecrawl/oauth/not-a-route')).status, 404);
  assert.equal((await f.send('/firecrawl/mcp', { headers: { Authorization: 'Bearer not-a-token' } })).status, 401);
});
