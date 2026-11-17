// Credential-safe end-to-end test. Never follows the ChatGPT authorization callback.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, lstatSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {validatePublicBase} from './config.mjs';

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.FIRECRAWL_PUBLIC_BASE;
const PUBLIC_ORIGIN = BASE ? new URL(validatePublicBase(BASE)).origin : undefined;
const CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
const SCOPE = 'firecrawl:use';
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const must = (condition, code) => { if (!condition) fail(code); };
const hash = value => createHash('sha256').update(value).digest('base64url');

export async function verify({ origin, publicBase = BASE } = {}) {
  validatePublicBase(publicBase);
  const publicUrl = new URL(publicBase), publicOrigin = publicUrl.origin;
  const RESOURCE = `${publicBase}/mcp`, ISSUER = `${publicBase}/oauth`;
  origin ??= publicOrigin;
  must([publicOrigin, 'http://127.0.0.1:3013'].includes(origin), 'UNREVIEWED_ORIGIN');
  const record = { service: 'local-firecrawl-authenticated-gateway', transport: origin === publicOrigin ? 'public-https' : 'loopback-http', startedAt: new Date().toISOString(), checks: [] };
  const passwords = join(CHECKOUT, '.local-state/remote-gateway/auth/owner-password.txt');
  const stat = lstatSync(passwords);
  must(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'OWNER_PASSWORD_PERMISSIONS');
  const password = readFileSync(passwords, 'utf8').trim();
  must(/^[A-Za-z0-9_-]{43}$/.test(password), 'OWNER_PASSWORD_FORMAT');
  const grants = [];
  let clientId, access, counter = 1;
  const send = (path, { method = 'GET', data, format = 'application/json', headers = {} } = {}) => new Promise((resolveResponse, reject) => {
    const url = new URL(path, origin);
    if (url.origin !== origin) { reject(Object.assign(new Error('CROSS_ORIGIN_TEST_REQUEST'), { safeCode: 'CROSS_ORIGIN_TEST_REQUEST' })); return; }
    const bytes = data === undefined ? undefined : format === 'application/x-www-form-urlencoded' ? new URLSearchParams(data).toString() : JSON.stringify(data);
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers: { Host: publicUrl.host, Accept: 'application/json, text/event-stream', ...(bytes === undefined ? {} : { 'Content-Type': format, 'Content-Length': Buffer.byteLength(bytes) }), ...headers } }, res => {
      let chunks = [], size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) { chunks = []; req.destroy(); reject(Object.assign(new Error('RESPONSE_BOUND'), { safeCode: 'RESPONSE_BOUND' })); } else chunks.push(chunk); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body; try { body = JSON.parse(text); } catch {
          // A compliant MCP server may choose SSE rather than JSON responses.
          const data = text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).find(line => line.startsWith('{'));
          if (data) { try { body = JSON.parse(data); } catch {} }
        }
        resolveResponse({ status: res.statusCode, headers: res.headers, text, body });
      });
      res.on('error', () => reject(Object.assign(new Error('RESPONSE_CONNECTION_FAILED'), { safeCode: 'RESPONSE_CONNECTION_FAILED' })));
    });
    req.setTimeout(120_000, () => req.destroy(Object.assign(new Error('REQUEST_TIMEOUT'), { safeCode: 'REQUEST_TIMEOUT' })));
    req.on('error', error => reject(Object.assign(new Error('REQUEST_CONNECTION_FAILED'), { safeCode: error.safeCode || 'REQUEST_CONNECTION_FAILED' })));
    req.end(bytes);
  });
  const check = async (name, fn) => {
    const start = performance.now();
    try { const details = await fn(); record.checks.push({ check: name, status: 'passed', seconds: Number(((performance.now() - start) / 1000).toFixed(3)), ...(details || {}) }); }
    catch (error) { record.checks.push({ check: name, status: 'failed', seconds: Number(((performance.now() - start) / 1000).toFixed(3)), error: error.safeCode || 'CHECK_FAILED' }); throw error; }
  };
  const form = (path, data, headers) => send(path, { method: 'POST', format: 'application/x-www-form-urlencoded', data, headers });
  const login = async () => {
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(24).toString('base64url');
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: CALLBACK, response_type: 'code', resource: RESOURCE, scope: SCOPE, code_challenge_method: 'S256', code_challenge: hash(verifier), state });
    const page = await send(`/firecrawl/oauth/authorize?${query}`);
    must(page.status === 200, 'AUTHORIZE_PAGE_UNAVAILABLE');
    const cookie = page.headers['set-cookie']?.[0]?.split(';')[0];
    const csrf = page.text.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
    must(cookie && csrf && /Secure; HttpOnly; SameSite=Lax/.test(page.headers['set-cookie'][0]), 'CONSENT_COOKIE_OR_CSRF_MISSING');
    const approved = await form('/firecrawl/oauth/authorize', { csrf, password, decision: 'approve' }, { Cookie: cookie, Origin: publicOrigin });
    must(approved.status === 302 && typeof approved.headers.location === 'string', 'OWNER_CONSENT_FAILED');
    const target = new URL(approved.headers.location);
    must(`${target.origin}${target.pathname}` === CALLBACK && target.searchParams.get('state') === state && target.searchParams.get('iss') === ISSUER && !target.searchParams.has('access_token'), 'CALLBACK_BINDING_FAILED');
    const code = target.searchParams.get('code');
    must(typeof code === 'string' && /^[A-Za-z0-9_-]{43}$/.test(code), 'AUTHORIZATION_CODE_MISSING');
    const response = await form('/firecrawl/oauth/token', { grant_type: 'authorization_code', client_id: clientId, redirect_uri: CALLBACK, resource: RESOURCE, code, code_verifier: verifier });
    must(response.status === 200 && response.body?.scope === SCOPE && response.body?.token_type === 'Bearer' && response.body?.expires_in === 3600 && /^[A-Za-z0-9_-]{43}$/.test(response.body?.access_token || '') && /^[A-Za-z0-9_-]{43}$/.test(response.body?.refresh_token || ''), 'CODE_EXCHANGE_FAILED');
    grants.push(response.body.refresh_token);
    return response.body;
  };
  const rpc = async (method, params = {}, token = access) => {
    const response = await send('/firecrawl/mcp', { method: 'POST', data: { jsonrpc: '2.0', id: counter++, method, params }, headers: { Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2025-11-25' } });
    must(response.status === 200 && response.body?.jsonrpc === '2.0' && !response.body.error && response.body.result, 'MCP_REQUEST_FAILED');
    return response.body.result;
  };
  const tool = async (name, args) => rpc('tools/call', { name, arguments: args });
  const toolJson = result => {
    must(!result.isError, 'LOCAL_TOOL_FAILED');
    for (const item of result.content || []) if (item.type === 'text') { try { return JSON.parse(item.text); } catch {} }
    fail('LOCAL_TOOL_JSON_MISSING');
  };
  const bearerStatus = async token => (await send('/firecrawl/mcp', { method: 'POST', data: { jsonrpc: '2.0', id: counter++, method: 'tools/list', params: {} }, headers: { Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2025-11-25' } })).status;
  try {
    await check('anonymous-mcp-denied', async () => {
      const response = await send('/firecrawl/mcp');
      must(response.status === 401 && String(response.headers['www-authenticate']).includes(`${publicOrigin}/.well-known/oauth-protected-resource/firecrawl/mcp`), 'ANONYMOUS_MCP_NOT_DENIED');
      return { httpStatus: response.status };
    });
    await check('path-aware-oauth-discovery', async () => {
      const as = await send('/.well-known/oauth-authorization-server/firecrawl/oauth');
      const pr = await send('/.well-known/oauth-protected-resource/firecrawl/mcp');
      must(as.status === 200 && as.body?.issuer === ISSUER && as.body?.authorization_response_iss_parameter_supported === true && as.body?.authorization_endpoint === `${ISSUER}/authorize` && as.body?.token_endpoint === `${ISSUER}/token` && as.body?.registration_endpoint === `${ISSUER}/register` && as.body?.code_challenge_methods_supported?.includes('S256'), 'AUTHORIZATION_METADATA_INVALID');
      must(pr.status === 200 && pr.body?.resource === RESOURCE && pr.body?.authorization_servers?.[0] === ISSUER, 'RESOURCE_METADATA_INVALID');
      return { issuerMatches: true, resourceMatches: true, pkceS256: true };
    });
    await check('dynamic-public-client-registration', async () => {
      const response = await send('/firecrawl/oauth/register', { method: 'POST', data: { client_name: 'Private deployment acceptance test', redirect_uris: [CALLBACK], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: SCOPE } });
      must(response.status === 201 && /^[A-Za-z0-9_-]{43}$/.test(response.body?.client_id || '') && response.body?.token_endpoint_auth_method === 'none' && !response.body.client_secret, 'PUBLIC_CLIENT_REGISTRATION_FAILED');
      clientId = response.body.client_id; return { registered: true, callbackExact: true };
    });
    let initial;
    await check('owner-consent-and-pkce-exchange', async () => { initial = await login(); access = initial.access_token; return { explicitConsent: true, callbackFollowed: false, expiresInSeconds: initial.expires_in }; });
    await check('authenticated-mcp-initialize', async () => {
      const result = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'private-remote-acceptance', version: '1.0' } });
      must(result.serverInfo?.name === 'local-web-crawler-remote' && result.capabilities?.tools, 'MCP_INITIALIZATION_INVALID');
      return { server: result.serverInfo.name, protocol: result.protocolVersion };
    });
    await check('reviewed-tool-catalog', async () => {
      const result = await rpc('tools/list');
      must(result.tools?.length === 18 && result.tools.every(tool => tool.securitySchemes?.some(scheme => scheme.type === 'oauth2' && scheme.scopes?.includes(SCOPE))), 'MCP_CATALOG_INVALID');
      must(result.tools.some(tool => tool.name === 'firecrawl_scrape') && !result.tools.some(tool => /agent|browser_create/.test(tool.name)), 'MCP_POLICY_CATALOG_INVALID');
      const read = result.tools.find(tool => tool.name === 'local_web_read');
      must(read?.annotations?.readOnlyHint === true && read.annotations.destructiveHint === false && read.annotations.openWorldHint === true && !read.inputSchema?.properties?.actions, 'READ_ONLY_CATALOG_INVALID');
      return { tools: result.tools.length, oauthScoped: true };
    });
    await check('local-api-readiness-through-mcp', async () => {
      const status = toolJson(await tool('local_web_status', {}));
      must(status.ready === true, 'LOCAL_API_NOT_READY'); return { ready: true };
    });
    await check('public-python-page-scrape', async () => {
      const response = toolJson(await tool('local_web_read', { url: 'https://docs.python.org/3/library/asyncio.html', formats: ['markdown'], onlyMainContent: true, maxAge: 0 }));
      const document = response.data || response;
      must(typeof document.markdown === 'string' && document.markdown.length > 1000 && /asyncio/.test(document.markdown), 'PUBLIC_SCRAPE_CONTENT_INVALID');
      return { markdownCharacters: document.markdown.length, expectedContent: true, sourceHost: 'docs.python.org' };
    });
    await check('remote-private-url-denial', async () => {
      for (const url of ['http://127.0.0.1:3012/v0/health/readiness', 'http://fixtures.firecrawl.test:8765/']) must((await tool('firecrawl_scrape', { url, formats: ['markdown'] })).isError === true, 'PRIVATE_URL_NOT_DENIED');
      return { rejectedCalls: 2 };
    });
    let rotated;
    await check('refresh-token-rotation', async () => {
      const response = await form('/firecrawl/oauth/token', { grant_type: 'refresh_token', client_id: clientId, resource: RESOURCE, refresh_token: initial.refresh_token });
      must(response.status === 200 && response.body?.refresh_token !== initial.refresh_token && response.body?.access_token, 'REFRESH_ROTATION_FAILED');
      rotated = response.body; grants.push(rotated.refresh_token);
      must(await bearerStatus(rotated.access_token) === 200, 'ROTATED_ACCESS_INVALID');
      return { rotated: true, accessAccepted: true };
    });
    await check('refresh-replay-revokes-token-family', async () => {
      const replay = await form('/firecrawl/oauth/token', { grant_type: 'refresh_token', client_id: clientId, resource: RESOURCE, refresh_token: initial.refresh_token });
      must(replay.status === 400 && replay.body?.error === 'invalid_grant' && await bearerStatus(rotated.access_token) === 401, 'REFRESH_REPLAY_NOT_REVOKED');
      return { replayRejected: true, descendantAccessRevoked: true };
    });
    await check('explicit-token-revocation', async () => {
      const fresh = await login();
      must(await bearerStatus(fresh.access_token) === 200, 'NEW_ACCESS_INVALID');
      const revoked = await form('/firecrawl/oauth/revoke', { client_id: clientId, token: fresh.refresh_token });
      must(revoked.status === 200 && await bearerStatus(fresh.access_token) === 401, 'EXPLICIT_REVOCATION_FAILED');
      return { activeAccessRevoked: true };
    });
  } catch (error) {
    record.error = error.safeCode || 'VERIFICATION_FAILED';
  } finally {
    let cleaned = true;
    for (const token of grants) {
      try { if ((await form('/firecrawl/oauth/revoke', { client_id: clientId, token })).status !== 200) cleaned = false; } catch { cleaned = false; }
    }
    record.testCredentialsRevoked = cleaned;
  }
  record.finishedAt = new Date().toISOString();
  record.passed = record.checks.filter(check => check.status === 'passed').length;
  record.failed = record.checks.filter(check => check.status === 'failed').length;
  record.status = !record.error && record.testCredentialsRevoked && record.failed === 0 && record.passed === 12 ? 'passed' : 'failed';
  return record;
}

async function main() {
  const args = process.argv.slice(2);
  must(args.length === 0 || args.length === 2 && args[0] === '--origin', 'USAGE_ORIGIN_ONLY');
  const report = await verify({ origin: args[1] || PUBLIC_ORIGIN });
  const directory = join(CHECKOUT, 'local-bench/var/remote-gateway');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${report.transport}.json`;
  writeFileSync(join(directory, filename), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${JSON.stringify({ status: 'failed', error: error.safeCode || 'VERIFIER_SETUP_FAILED' })}\n`); process.exitCode = 1; });
