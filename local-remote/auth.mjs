// Personal, single-owner OAuth authorization server. No cloud identity service.
// Callback contract: https://developers.openai.com/plugins/build/auth (2026-11-14).
import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync, existsSync, lstatSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import {validatePublicBase} from './config.mjs';

const scryptAsync = promisify(scrypt);
const SCOPE = 'firecrawl:use';
const CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
const COOKIE = '__Secure-firecrawl-oauth-flow';
const hash = value => createHash('sha256').update(value).digest('hex');
const opaque = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const text = (value, max = 1024) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

function privatePath(path) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('OAuth state must not use symbolic links');
}
function atomicJson(path, value) {
  privatePath(path);
  const tmp = `${path}.${opaque()}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(tmp, path); chmodSync(path, 0o600); } catch (error) { try { unlinkSync(tmp); } catch {} throw error; }
}
function headers(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Preserve Origin on same-origin browser form POSTs without sending a referrer cross-origin.
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${CALLBACK}; frame-ancestors 'none'; base-uri 'none'`);
}
function json(res, status, body) { headers(res); res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); }
function html(res, status, body) { headers(res); res.statusCode = status; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(body); }
function failure(res, error = 'invalid_request', status = 400) { json(res, status, { error, error_description: 'The authorization request could not be completed.' }); }
function singleValues(params) {
  for (const key of new Set(params.keys())) if (params.getAll(key).length !== 1) throw new Error('Duplicate parameter');
  return Object.fromEntries(params);
}
async function body(req, format) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== format) throw new Error('Unsupported content type');
  const value = await new Promise((resolve, reject) => {
    let chunks = [], length = 0;
    const cleanup = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); };
    const error = reason => { cleanup(); reject(reason); };
    const aborted = () => error(new Error('Request aborted'));
    const data = chunk => {
      length += chunk.length;
      if (length > 16_384) { chunks = []; cleanup(); req.resume(); reject(Object.assign(new Error('Request body too large'), { status: 413 })); return; }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
    const timer = setTimeout(() => { cleanup(); req.resume(); reject(Object.assign(new Error('Request timed out'), { status: 408 })); }, 10_000);
    timer.unref();
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
  });
  if (format === 'application/json') {
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Invalid object');
    return parsed;
  }
  return singleValues(new URLSearchParams(value));
}
function sourceIp(req) {
  const remote = req.socket?.remoteAddress || 'unknown';
  const forwarded = req.headers['cf-connecting-ip'];
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) && typeof forwarded === 'string' && isIP(forwarded)) return forwarded;
  return remote;
}
function cookieValue(req) {
  const entries = String(req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${COOKIE}=`));
  if (entries.length !== 1) return null;
  const value = entries[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export function createAuth({ publicBase, stateDir, now = () => Date.now(), scryptN = 16_384 } = {}) {
  validatePublicBase(publicBase);
  const base = new URL(publicBase);
  if (!stateDir) throw new Error('OAuth private stateDir is required');
  const prefix = base.pathname;
  const issuer = `${publicBase}/oauth`;
  const issuerPath = `${prefix}/oauth`;
  const resource = `${publicBase}/mcp`;
  const protectedPath = `/.well-known/oauth-protected-resource${prefix}/mcp`;
  const metadataPath = `/.well-known/oauth-authorization-server${issuerPath}`;
  privatePath(stateDir); mkdirSync(stateDir, { recursive: true, mode: 0o700 }); chmodSync(stateDir, 0o700);
  const storePath = join(stateDir, 'state.json');
  const passwordPath = join(stateDir, 'owner-password.txt');
  let state;
  privatePath(storePath); privatePath(passwordPath);
  if (existsSync(storePath)) {
    if (lstatSync(storePath).size > 8_000_000) throw new Error('OAuth state exceeds the storage bound');
    state = JSON.parse(readFileSync(storePath, 'utf8'));
    if (state.version !== 1 || state.issuer !== issuer || state.resource !== resource || !state.owner || !state.clients || !state.codes || !state.access || !state.refresh || !state.families || !state.limits) throw new Error('Invalid or mismatched OAuth state');
    chmodSync(storePath, 0o600);
  } else {
    if (existsSync(passwordPath)) throw new Error('Existing owner password without state requires manual recovery');
    const password = opaque();
    const salt = randomBytes(16).toString('hex');
    const options = { N: scryptN, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
    const derived = scryptSync(password, salt, 32, options).toString('hex');
    state = { version: 1, issuer, resource, owner: { salt, hash: derived, N: scryptN }, clients: {}, codes: {}, access: {}, refresh: {}, families: {}, limits: {} };
    writeFileSync(passwordPath, `${password}\n`, { mode: 0o600, flag: 'wx' });
    atomicJson(storePath, state);
  }
  if (existsSync(passwordPath)) chmodSync(passwordPath, 0o600);
  const flows = new Map();
  const save = () => atomicJson(storePath, state);
  const seconds = () => Math.floor(now() / 1000);
  const cleanup = () => {
    const t = seconds();
    for (const group of ['codes', 'access', 'refresh', 'families', 'limits']) {
      for (const [key, item] of Object.entries(state[group])) if (item.expires <= t) delete state[group][key];
    }
    for (const [key, item] of Object.entries(state.clients)) if (item.lastUsed + 90 * 86400 <= t) delete state.clients[key];
    for (const [key, item] of flows) if (item.expires <= t) flows.delete(key);
  };
  // Fixed windows are persisted, so restarting the process cannot clear lockouts.
  const limited = (kind, req, maximum, window) => {
    cleanup();
    const key = `${kind}:${hash(sourceIp(req))}`;
    let item = state.limits[key];
    if (!item) {
      if (Object.keys(state.limits).length >= 5000) return true;
      state.limits[key] = item = { count: 0, expires: seconds() + window };
    }
    if (item.count >= maximum) return true;
    item.count++; save(); return false;
  };
  const registered = id => typeof id === 'string' && Object.hasOwn(state.clients, id) ? state.clients[id] : null;
  const validScope = scope => scope === undefined || scope === SCOPE;
  const validResource = value => value === resource;
  const clearCookie = res => res.setHeader('Set-Cookie', `${COOKIE}=; Path=${issuerPath}; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
  const redirect = (res, flow, result) => {
    const target = new URL(flow.redirect_uri);
    target.searchParams.set('state', flow.state);
    target.searchParams.set('iss', issuer);
    for (const [key, value] of Object.entries(result)) target.searchParams.set(key, value);
    headers(res); clearCookie(res); res.statusCode = 302; res.setHeader('Location', target.href); res.end();
  };
  const consent = (res, flow, status = 200, error = '') => {
    const client = registered(flow.client_id);
    html(res, status, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Local Web Crawler</title><style>body{font:17px system-ui;max-width:42rem;margin:3rem auto;padding:0 1.2rem;line-height:1.6;color:#182334}input{font:inherit;width:95%;padding:.6rem}button{font:inherit;padding:.7rem 1rem;margin:.6rem .6rem .6rem 0}code{overflow-wrap:anywhere}label{display:block}aside{padding:1rem;background:#eef3f7;border-radius:.5rem}</style><h1>Connect Local Web Crawler</h1><p>This is a single-owner, self-hosted Firecrawl gateway.</p><aside><strong>App requesting access:</strong> ${esc(client?.name || 'ChatGPT')}<br><strong>Service:</strong> ${esc(publicBase)}<br><strong>Callback:</strong> ${esc(flow.redirect_uri)}<br><strong>Permission:</strong> ${esc(SCOPE)} — public-web research, scraping, bounded crawling, extraction, screenshots and saved change checks through this host.</aside><p>Approve only if you initiated this connection in your own ChatGPT account. Anyone you authorize can use these tools while the connection is valid.</p>${error ? `<p role="alert">${esc(error)}</p>` : ''}<form method="post" action="${esc(issuerPath)}/authorize"><input type="hidden" name="csrf" value="${esc(flow.csrf)}"><label for="password">Gateway owner password</label><input id="password" type="password" name="password" autocomplete="current-password" maxlength="256" required><p>This is the private gateway password stored on the server. It is separate from your ChatGPT and operating system passwords.</p><button name="decision" value="approve">Authorize this connection</button><button name="decision" value="deny" formnovalidate>Cancel</button></form></html>`);
  };
  const authorization = query => {
    const client = registered(query.client_id);
    if (!client || query.redirect_uri !== CALLBACK || !client.redirect_uris.includes(query.redirect_uri)) return null;
    if (query.response_type !== 'code' || query.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge || '') || !validScope(query.scope) || !validResource(query.resource) || !text(query.state, 1024)) return null;
    if (['request', 'request_uri', 'client_secret', 'client_assertion', 'access_token', 'refresh_token', 'token', 'password', 'code_verifier'].some(key => key in query)) return null;
    return { client_id: query.client_id, redirect_uri: query.redirect_uri, code_challenge: query.code_challenge, state: query.state, resource, scope: SCOPE };
  };
  const revokeFamily = family => {
    if (state.families[family]) state.families[family].revoked = true;
    for (const [key, token] of Object.entries(state.access)) if (token.family === family) delete state.access[key];
  };
  const issueTokens = (clientId, family, redirectUri) => {
    if (Object.keys(state.access).length >= 2000 || Object.keys(state.refresh).length >= 4000) return null;
    const t = seconds(), access = opaque(), refresh = opaque();
    const duration = Math.min(3600, state.families[family].expires - t);
    state.access[hash(access)] = { clientId, family, resource, scope: SCOPE, expires: t + duration, tokenId: opaque() };
    state.refresh[hash(refresh)] = { clientId, family, redirectUri, resource, scope: SCOPE, expires: state.families[family].expires, used: false };
    state.clients[clientId].lastUsed = t;
    return { access_token: access, token_type: 'Bearer', expires_in: duration, refresh_token: refresh, scope: SCOPE };
  };

  function authenticate(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/i.test(header)) return null;
    const token = state.access[hash(header.slice(7))];
    const family = token && state.families[token.family];
    if (!token || token.expires <= seconds() || token.resource !== resource || token.scope !== SCOPE || !family || family.revoked || family.expires <= seconds() || !registered(token.clientId)) return null;
    return { subject: 'owner', scopes: [SCOPE], tokenId: token.tokenId };
  }
  function challenge(res) {
    headers(res); res.statusCode = 401;
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${base.origin}${protectedPath}", scope="${SCOPE}"`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'unauthorized' }));
  }

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, base.origin); } catch { return false; }
    const path = url.pathname;
    const protectedAliases = new Set([protectedPath, `${prefix}/.well-known/oauth-protected-resource`, `${prefix}/.well-known/oauth-protected-resource/mcp`]);
    const metadataAliases = new Set([metadataPath, `${issuerPath}/.well-known/oauth-authorization-server`, `${prefix}/.well-known/oauth-authorization-server`]);
    if (req.method === 'GET' && protectedAliases.has(path)) {
      json(res, 200, { resource, authorization_servers: [issuer], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'Dharmesh’s Local Web Crawler' }); return true;
    }
    if (req.method === 'GET' && metadataAliases.has(path)) {
      json(res, 200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`, revocation_endpoint: `${issuer}/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: [SCOPE], authorization_response_iss_parameter_supported: true }); return true;
    }
    if (!path.startsWith(`${issuerPath}/`)) return false;
    cleanup();
    try {
      if (req.method === 'POST' && url.search) { failure(res); return true; }
      if (path === `${issuerPath}/register` && req.method === 'POST') {
        if (limited('register', req, 10, 60)) { failure(res, 'temporarily_unavailable', 429); return true; }
        const input = await body(req, 'application/json');
        const redirects = input.redirect_uris;
        if (!Array.isArray(redirects) || redirects.length !== 1 || redirects[0] !== CALLBACK || (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== 'none') || (input.grant_types !== undefined && (!Array.isArray(input.grant_types) || input.grant_types.length < 1 || input.grant_types.some(v => !['authorization_code', 'refresh_token'].includes(v)) || !input.grant_types.includes('authorization_code'))) || (input.response_types !== undefined && (!Array.isArray(input.response_types) || input.response_types.length !== 1 || input.response_types[0] !== 'code')) || (input.scope !== undefined && input.scope !== SCOPE) || (input.client_name !== undefined && !text(input.client_name, 100)) || ['client_secret', 'client_assertion', 'token_endpoint_auth_signing_alg', 'jwks', 'jwks_uri', 'software_statement'].some(k => k in input)) {
          failure(res, 'invalid_client_metadata'); return true;
        }
        if (Object.keys(state.clients).length >= 200) { failure(res, 'temporarily_unavailable', 503); return true; }
        const id = opaque();
        state.clients[id] = { name: input.client_name || 'ChatGPT', redirect_uris: [CALLBACK], created: seconds(), lastUsed: seconds() };
        save();
        json(res, 201, { client_id: id, client_id_issued_at: seconds(), client_name: state.clients[id].name, redirect_uris: [CALLBACK], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: SCOPE }); return true;
      }
      if (path === `${issuerPath}/authorize` && req.method === 'GET') {
        const input = singleValues(url.searchParams);
        const grant = authorization(input);
        if (!grant) { failure(res); return true; }
        if (flows.size >= 200 || limited('flow', req, 20, 60)) { failure(res, 'temporarily_unavailable', 429); return true; }
        const cookie = opaque();
        const flow = { ...grant, csrf: opaque(), expires: seconds() + 600, processing: false };
        flows.set(hash(cookie), flow);
        res.setHeader('Set-Cookie', `${COOKIE}=${cookie}; Path=${issuerPath}; Secure; HttpOnly; SameSite=Lax; Max-Age=600`);
        consent(res, flow); return true;
      }
      if (path === `${issuerPath}/authorize` && req.method === 'POST') {
        if (req.headers.origin !== base.origin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) { failure(res, 'access_denied', 403); return true; }
        const input = await body(req, 'application/x-www-form-urlencoded');
        const cookie = cookieValue(req);
        const flow = cookie && flows.get(hash(cookie));
        if (!flow || flow.processing || !equal(input.csrf, flow.csrf) || !['approve', 'deny'].includes(input.decision)) { failure(res, 'access_denied', 403); return true; }
        if (input.decision === 'deny') { flows.delete(hash(cookie)); redirect(res, flow, { error: 'access_denied' }); return true; }
        if (limited('owner', req, 5, 900)) { failure(res, 'access_denied', 429); return true; }
        flow.processing = true;
        const password = typeof input.password === 'string' && input.password.length <= 256 ? input.password.trim() : '';
        const derived = await scryptAsync(password, state.owner.salt, 32, { N: state.owner.N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        if (flow.expires <= seconds()) { flows.delete(hash(cookie)); failure(res, 'access_denied', 403); return true; }
        if (!equal(derived.toString('hex'), state.owner.hash)) { flow.processing = false; consent(res, flow, 401, 'Authorization could not be completed. Check the owner password or try again later.'); return true; }
        flows.delete(hash(cookie));
        if (Object.keys(state.codes).length >= 200) { failure(res, 'temporarily_unavailable', 503); return true; }
        const code = opaque();
        const { csrf, processing, ...grant } = flow;
        state.codes[hash(code)] = { ...grant, expires: seconds() + 180 };
        save(); redirect(res, flow, { code }); return true;
      }
      if (path === `${issuerPath}/token` && req.method === 'POST') {
        const input = await body(req, 'application/x-www-form-urlencoded');
        if (req.headers.authorization || input.client_secret || input.client_assertion || !registered(input.client_id)) { failure(res, 'invalid_client', 401); return true; }
        if (!validResource(input.resource) || !validScope(input.scope)) { failure(res, 'invalid_target'); return true; }
        if (input.grant_type === 'authorization_code') {
          const codeHash = typeof input.code === 'string' ? hash(input.code) : '';
          const grant = state.codes[codeHash];
          if (!grant || grant.expires <= seconds() || grant.client_id !== input.client_id || grant.redirect_uri !== input.redirect_uri || grant.resource !== input.resource || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier || '') || !equal(createHash('sha256').update(input.code_verifier).digest('base64url'), grant.code_challenge)) { failure(res, 'invalid_grant'); return true; }
          if (Object.keys(state.families).length >= 1000 || Object.keys(state.access).length >= 2000 || Object.keys(state.refresh).length >= 4000) { failure(res, 'temporarily_unavailable', 503); return true; }
          delete state.codes[codeHash];
          const family = opaque();
          state.families[family] = { clientId: input.client_id, expires: seconds() + 7 * 86400, revoked: false };
          const tokens = issueTokens(input.client_id, family, grant.redirect_uri);
          save(); json(res, 200, tokens); return true;
        }
        if (input.grant_type === 'refresh_token') {
          const key = typeof input.refresh_token === 'string' ? hash(input.refresh_token) : '';
          const previous = state.refresh[key];
          if (!previous || previous.clientId !== input.client_id || previous.resource !== input.resource || previous.expires <= seconds() || (input.redirect_uri !== undefined && input.redirect_uri !== previous.redirectUri)) { failure(res, 'invalid_grant'); return true; }
          const family = state.families[previous.family];
          if (!family || family.revoked || family.expires <= seconds()) { failure(res, 'invalid_grant'); return true; }
          if (previous.used) { revokeFamily(previous.family); save(); failure(res, 'invalid_grant'); return true; }
          const tokens = issueTokens(input.client_id, previous.family, previous.redirectUri);
          if (!tokens) { failure(res, 'temporarily_unavailable', 503); return true; }
          previous.used = true; save(); json(res, 200, tokens); return true;
        }
        failure(res, 'unsupported_grant_type'); return true;
      }
      if (path === `${issuerPath}/revoke` && req.method === 'POST') {
        const input = await body(req, 'application/x-www-form-urlencoded');
        if (!registered(input.client_id) || req.headers.authorization || input.client_secret || typeof input.token !== 'string') { failure(res, 'invalid_client', 401); return true; }
        const key = hash(input.token), token = state.refresh[key] || state.access[key];
        if (token?.clientId === input.client_id) { revokeFamily(token.family); save(); }
        json(res, 200, {}); return true;
      }
      failure(res, 'invalid_request', 404); return true;
    } catch (error) { failure(res, 'invalid_request', [408, 413].includes(error?.status) ? error.status : 400); return true; }
  }
  return { publicBase, handle, authenticate, challenge };
}
