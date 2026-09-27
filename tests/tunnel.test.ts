import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { tunnel, configureTunnel, getTunnelStats } from '../src/tunnel.js';

const html = `<html><body><article>${'A research paper provides detailed evidence. '.repeat(20)}</article></body></html>`;

async function serve(handler: (res: ServerResponse, count: number) => void, run: (url: string, count: () => number) => Promise<void>) {
  let count = 0;
  const server = createServer((_req, res) => handler(res, ++count));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  configureTunnel({ minJitter: 0, maxJitter: 0, timeout: 1000, maxRetries: 2, retryDelayMs: 1, maxRetryDelayMs: 50, maxResponseBytes: 10000 });
  try { await run(`http://127.0.0.1:${addr.port}`, () => count); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    assert.equal(getTunnelStats().active, 0, 'every request releases its concurrency slot');
  }
}

test('429 honors Retry-After and then returns extracted HTML', async () => {
  await serve((res, n) => {
    if (n === 1) { res.writeHead(429, { 'Retry-After': '0' }); res.end('slow down'); }
    else res.end(html);
  }, async (url, count) => {
    const result = await tunnel(url);
    assert.equal(result.success, true);
    assert.equal(result.attempts, 2);
    assert.equal(count(), 2);
    assert.ok(result.content.includes('research paper'));
  });
});

test('503 retries are bounded', async () => {
  await serve(res => { res.writeHead(503); res.end('unavailable'); }, async (url, count) => {
    const result = await tunnel(url);
    assert.equal(result.success, false);
    assert.equal(result.status, 503);
    assert.equal(result.attempts, 3);
    assert.equal(count(), 3);
  });
});

test('does not retry before an excessive Retry-After has elapsed', async () => {
  await serve(res => { res.writeHead(429, { 'Retry-After': '120' }); res.end(); }, async (url, count) => {
    assert.equal((await tunnel(url)).success, false);
    assert.equal(count(), 1);
  });
});

test('HTTP-date Retry-After beyond the budget also declines retry', async () => {
  await serve(res => { res.writeHead(503, { 'Retry-After': new Date(Date.now() + 60_000).toUTCString() }); res.end(); }, async (url, count) => {
    assert.equal((await tunnel(url)).success, false);
    assert.equal(count(), 1);
  });
});

test('404 and challenge HTML are failures without escalation or retries', async () => {
  await serve(res => { res.writeHead(404); res.end(); }, async (url, count) => {
    assert.equal((await tunnel(url)).status, 404);
    assert.equal(count(), 1);
  });
  await serve(res => res.end('<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing</body></html>'), async (url, count) => {
    const result = await tunnel(url);
    assert.equal(result.success, false);
    assert.equal(result.content, '');
    assert.equal(count(), 1);
  });
});

test('timeout covers a stalled response body, not only response headers', { timeout: 2000 }, async () => {
  await serve(res => { res.writeHead(200); res.flushHeaders(); res.write('<html>'); }, async url => {
    configureTunnel({ timeout: 40 });
    const started = Date.now();
    const result = await tunnel(url);
    assert.equal(result.success, false);
    assert.ok(Date.now() - started < 1000);
  });
});

test('response body has a byte limit', async () => {
  await serve(res => res.end(html), async url => {
    configureTunnel({ maxResponseBytes: 100 });
    const result = await tunnel(url);
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /too large/);
  });
});

test('invalid fetch policy is rejected before queueing', () => {
  assert.throws(() => configureTunnel({ maxConcurrent: 0 }));
  assert.throws(() => configureTunnel({ maxRetries: 99 }));
  assert.throws(() => configureTunnel({ timeout: NaN }));
  assert.throws(() => configureTunnel({ minJitter: 10, maxJitter: 1 }));
});
