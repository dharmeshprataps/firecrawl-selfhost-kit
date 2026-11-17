import {spawn} from 'node:child_process';
import {join} from 'node:path';

export const MAX_OUTPUT = 8 * 1024 * 1024;
export class LocalBridge {
  constructor({checkout, deadlineMs = 90000, launcher} = {}) {
    this.launcher = launcher ?? join(checkout, 'local-plugin/bin/firecrawl-mcp');
    this.deadlineMs = deadlineMs; this.pending = new Map(); this.sequence = 0;
    this.child = null; this.ready = null; this.closed = false;
  }
  async start() {
    if (this.closed) throw new Error('Local MCP bridge is closed');
    if (this.ready) return this.ready;
    this.ready = this.initialize().catch(error => {this.ready = null; if (this.child) this.fail(this.child, error); throw error;});
    return this.ready;
  }
  async initialize() {
    const child = spawn(this.launcher, [], {
      env: {HOME: process.env.HOME, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
        LANG: 'en_US.UTF-8', FIRECRAWL_API_URL: 'http://127.0.0.1:3012'},
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.child = child;
    let buffered = Buffer.alloc(0);
    child.stdin.on('error', () => this.fail(child, new Error('Local MCP input failed')));
    child.stdout.on('error', () => this.fail(child, new Error('Local MCP output failed')));
    child.on('error', () => this.fail(child, new Error('Local MCP process could not start')));
    child.on('exit', () => this.fail(child, new Error('Local MCP process stopped')));
    child.stdout.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      let newline;
      while ((newline = buffered.indexOf(10)) !== -1) {
        const line = buffered.subarray(0, newline); buffered = buffered.subarray(newline + 1);
        if (line.length > MAX_OUTPUT) {this.fail(child, new Error('Local MCP response exceeds limit')); return;}
        let message;
        try {message = JSON.parse(line.toString('utf8'));}
        catch {this.fail(child, new Error('Local MCP returned invalid JSON')); return;}
        if (!message || typeof message !== 'object' || !Object.hasOwn(message, 'id')) continue;
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error('Local MCP request failed'));
        else pending.resolve(message.result);
      }
      if (buffered.length > MAX_OUTPUT) this.fail(child, new Error('Local MCP response exceeds limit'));
    });
    const result = await this.rpc('initialize', {protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: {name: 'local-firecrawl-remote-gateway', version: '0.1.0'}}, 30000);
    if (!result || typeof result !== 'object' || !result.serverInfo) throw new Error('Local MCP initialization failed');
    this.notify('notifications/initialized');
    return result;
  }
  notify(method, params) {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(JSON.stringify({jsonrpc: '2.0', method, ...(params ? {params} : {})}) + '\n');
  }
  rpc(method, params, timeout = this.deadlineMs) {
    const child = this.child;
    if (!child?.stdin.writable) return Promise.reject(new Error('Local MCP unavailable'));
    if (this.pending.size >= 6) return Promise.reject(new Error('Local MCP pending request limit reached'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.notify('notifications/cancelled', {requestId: id, reason: 'Gateway deadline exceeded'});
        this.fail(child, new Error('Local MCP deadline exceeded'));
      }, timeout);
      timer.unref(); this.pending.set(id, {resolve, reject, timer});
      child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n', error => {
        if (error) this.fail(child, new Error('Local MCP input failed'));
      });
    });
  }
  async listTools() {await this.start(); return this.rpc('tools/list', {});}
  async callTool(name, args) {await this.start(); return this.rpc('tools/call', {name, arguments: args});}
  fail(child, error) {
    if (this.child !== child) return;
    this.child = null; this.ready = null;
    for (const entry of this.pending.values()) {clearTimeout(entry.timer); entry.reject(error);}
    this.pending.clear();
    if (!child.killed) child.kill('SIGTERM');
    const timer = setTimeout(() => {if (child.exitCode === null) child.kill('SIGKILL');}, 3000);
    timer.unref();
  }
  async close() {this.closed = true; if (this.child) this.fail(this.child, new Error('Gateway stopped'));}
}
