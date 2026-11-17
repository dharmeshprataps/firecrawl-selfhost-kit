import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePublicBase, dockerRuntimeConfig} from '../config.mjs';

test('remote access requires an explicit canonical HTTPS origin and fixed path', () => {
  assert.equal(validatePublicBase('https://firecrawl.example/firecrawl'), 'https://firecrawl.example/firecrawl');
  assert.equal(validatePublicBase('https://crawl.example:8443/firecrawl'), 'https://crawl.example:8443/firecrawl');
  for (const value of [undefined, '', 'http://firecrawl.example/firecrawl', 'https://firecrawl.example/',
    'https://firecrawl.example/firecrawl/', 'https://firecrawl.example/firecrawl?secret=1',
    'https://firecrawl.example/firecrawl?', 'https://firecrawl.example/firecrawl#',
    'https://user:password@firecrawl.example/firecrawl', 'https://localhost/firecrawl',
    'https://service.local/firecrawl', 'https://127.0.0.1/firecrawl', 'https://[::1]/firecrawl',
    'https://firecrawl.example:443/firecrawl', 'https://FIRECRAWL.example/firecrawl']) {
    assert.throws(() => validatePublicBase(value), /FIRECRAWL_PUBLIC_BASE/, String(value));
  }
});

test('Docker runtime remains explicit and invokes an executable without a shell', () => {
  assert.deepEqual(dockerRuntimeConfig({}), {command: '/opt/homebrew/bin/docker', context: 'colima-firecrawl'});
  assert.deepEqual(dockerRuntimeConfig({FIRECRAWL_DOCKER: '/usr/local/bin/docker', FIRECRAWL_DOCKER_CONTEXT: 'default'}),
    {command: '/usr/local/bin/docker', context: 'default'});
  assert.deepEqual(dockerRuntimeConfig({FIRECRAWL_DOCKER: 'docker'}), {command: 'docker', context: 'colima-firecrawl'});
  for (const environment of [{FIRECRAWL_DOCKER: 'docker --host remote'},
    {FIRECRAWL_DOCKER: '../docker'}, {FIRECRAWL_DOCKER: '/tmp/docker\nother'},
    {FIRECRAWL_DOCKER_CONTEXT: 'default --host attacker'}, {FIRECRAWL_DOCKER_CONTEXT: '../default'}]) {
    assert.throws(() => dockerRuntimeConfig(environment), /Invalid Docker/);
  }
});
