import {isIP} from 'node:net';
import {isAbsolute} from 'node:path';

// Remote access is optional. No public origin is selected automatically.
export function validatePublicBase(value) {
  let base;
  try {base = new URL(value);} catch {throw new Error('Set FIRECRAWL_PUBLIC_BASE to your canonical HTTPS /firecrawl address');}
  const host = base.hostname.toLowerCase();
  if (typeof value !== 'string' || base.protocol !== 'https:' || base.username || base.password
    || base.search || base.hash || /[?#]/.test(value) || base.pathname !== '/firecrawl' || base.href !== value
    || !host.includes('.') || isIP(host) || host.startsWith('[') || host.endsWith('.')
    || host === 'localhost' || /\.(?:localhost|local|internal|test)$/.test(host)) {
    throw new Error('FIRECRAWL_PUBLIC_BASE must be canonical HTTPS with a public hostname and exactly /firecrawl; no credentials, query or fragment');
  }
  return value;
}

export function dockerRuntimeConfig(environment = process.env) {
  const command = environment.FIRECRAWL_DOCKER || '/opt/homebrew/bin/docker';
  const context = environment.FIRECRAWL_DOCKER_CONTEXT || 'colima-firecrawl';
  if ((command !== 'docker' && !isAbsolute(command)) || /[\x00-\x20\x7f]/.test(command)
    || !/^[A-Za-z0-9_.-]{1,128}$/.test(context)) throw new Error('Invalid Docker executable or explicit context');
  return {command, context};
}
