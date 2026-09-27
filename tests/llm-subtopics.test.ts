import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dive, extractSubTopics, isValidTopic, type EngineDeps } from '../src/rabbithole.js';
import { Store } from '../src/store.js';

function tempStorePath(t: TestContext): string {
  const dir = mkdtempSync(join(process.cwd(), '.llm-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'state.db');
}

function fakeWeb(content: string): EngineDeps {
  return {
    search: async (query: string) => [
      { title: `result ${query}`, url: `https://site.test/${encodeURIComponent(query)}`, description: 'desc' },
    ],
    fetchPage: async (url: string) => ({
      success: true, url, title: 'page', content, links: [], selector: null,
      usedRecipe: false, yieldChars: content.length, error: null, timestamp: Date.now(),
    }),
  };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
}

async function llmServer(t: TestContext, reply: string, options: {
  status?: number; rawBody?: string; hang?: boolean; expectedCalls?: number;
} = {}): Promise<string> {
  const requests: Array<{ path?: string; method?: string; body: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ path: req.url, method: req.method, body });
      if (options.hang) return;
      res.writeHead(options.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(options.rawBody ?? JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
  });
  t.after(async () => {
    await close(server);
    if (options.expectedCalls !== undefined) assert.equal(requests.length, options.expectedCalls);
    else assert.ok(requests.length > 0);
    for (const request of requests) {
      assert.equal(request.path, '/chat/completions');
      assert.equal(request.method, 'POST');
      const payload = JSON.parse(request.body);
      assert.equal(payload.model, 'test-model');
      assert.ok(Array.isArray(payload.messages));
      assert.ok(payload.messages.some((message: { role: string; content: string }) =>
        message.role === 'user' && typeof message.content === 'string' && message.content.trim().length > 0));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

test('isValidTopic accepts clean phrases and rejects chrome or short input', () => {
  assert.equal(isValidTopic('memory consolidation'), true);
  assert.equal(isValidTopic('span class'), false);
  assert.equal(isValidTopic('pages using'), false);
  assert.equal(isValidTopic('singleword'), false);
});

test('bigram fallback rejects chrome and pure-number tokens', () => {
  const chrome = 'span class span class pages using pages using 2026 1234 2026 1234';
  assert.deepEqual(extractSubTopics(chrome, 'some claim'), []);
});

test('a configured endpoint drives mitosis with LLM sub-topics', async t => {
  const base = await llmServer(t, '  ["memory consolidation", "replay buffers"]  ');
  const run = await dive('topic theta', {
    storePath: tempStorePath(t), maxNodes: 4, maxDepth: 1, llmBaseUrl: base, llmModel: 'test-model',
  }, fakeWeb('plain page prose without any repeated bigrams in it'));
  const topics = run.nodes.map(n => n.topic);
  assert.ok(topics.includes('memory consolidation'));
  assert.ok(topics.includes('replay buffers'));
});

const fallbackContent = 'evidence mapping '.repeat(8);
const fallbackCases = [
  { name: 'non-2xx response', reply: '["memory consolidation"]', status: 503 },
  { name: 'unparseable response body', reply: '', rawBody: 'not JSON' },
  { name: 'unparseable model output', reply: 'not JSON' },
  { name: 'empty array', reply: '[]' },
  { name: 'invalid phrases', reply: '["span class", "no"]' },
  { name: 'non-array output', reply: '{"topic":"memory consolidation"}' },
  { name: 'trailing garbage', reply: '["memory consolidation"] trailing garbage' },
  { name: 'prose-wrapped array', reply: 'Here are topics: ["memory consolidation"]' },
  { name: 'all topics already researched', reply: '["memory consolidation"]', seed: true },
  { name: 'timeout', reply: '["memory consolidation"]', hang: true },
];

for (const scenario of fallbackCases) {
  test(`${scenario.name} falls back to bigrams`, { timeout: 15000 }, async t => {
    const storePath = tempStorePath(t);
    if (scenario.seed) {
      await dive('memory consolidation', { storePath, mode: 'kill' }, fakeWeb('prior evidence'));
    }
    const base = await llmServer(t, scenario.reply, { ...scenario, expectedCalls: 1 });
    const started = performance.now();
    const run = await dive('topic fallback', {
      storePath, maxNodes: 1, maxDepth: 0, llmBaseUrl: base, llmModel: 'test-model',
    }, fakeWeb(fallbackContent));
    assert.deepEqual(run.nodes[0].subTopics, ['evidence mapping', 'mapping evidence']);
    assert.equal(run.nodes[0].status, 'complete');
    if (scenario.hang) {
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= 7500 && elapsed < 12000, `timeout elapsed: ${elapsed}ms`);
    }
  });
}

for (const llmBaseUrl of [undefined, 'http://127.0.0.1:9']) {
  test(`${llmBaseUrl ? 'unreachable' : 'absent'} endpoint uses bigrams`, async t => {
    const run = await dive('topic fallback', {
      storePath: tempStorePath(t), maxNodes: 3, maxDepth: 1, llmBaseUrl, llmModel: 'test-model',
    }, fakeWeb(fallbackContent));
    assert.ok(run.nodes.some(n => n.topic === 'evidence mapping'));
  });
}

for (const content of ['', ' \n\t ']) {
  test(`blank content ${JSON.stringify(content)} skips the endpoint`, async t => {
    const base = await llmServer(t, '["memory consolidation"]', { expectedCalls: 0 });
    const run = await dive('blank page', {
      storePath: tempStorePath(t), maxNodes: 4, maxDepth: 1, llmBaseUrl: base, llmModel: 'test-model',
    }, fakeWeb(content));
    assert.equal(run.nodes.length, 1);
    assert.deepEqual(run.nodes[0].subTopics, []);
  });
}

test('a rejected HTTP-200 challenge creates no children with an LLM configured', async t => {
  const storePath = tempStorePath(t);
  const base = await llmServer(t, '["memory consolidation"]', { expectedCalls: 0 });
  const origin = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><title>Just a moment...</title></head><body><div id="cf-browser-verification">Please wait</div></body></html>');
  });
  t.after(() => close(origin));
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const address = origin.address();
  assert.ok(address && typeof address === 'object');
  const run = await dive('challenge page', {
    storePath, maxNodes: 4, maxDepth: 1, minJitter: 0, maxJitter: 0,
    llmBaseUrl: base, llmModel: 'test-model',
  }, { search: async () => [{ title: 'Candidate', url: `http://127.0.0.1:${address.port}/article`, description: 'evidence mapping '.repeat(8) }] });
  assert.equal(run.nodes.length, 1);
  assert.equal(run.nodes[0].status, 'complete');
  assert.equal(run.nodes[0].content, '');
  assert.deepEqual(run.nodes[0].subTopics, []);
  const store = new Store(storePath);
  try {
    assert.deepEqual([...store.knownTopics()], ['challenge page']);
    assert.deepEqual(store.getNodeByTopic('challenge page')?.subtopics, []);
  } finally {
    store.close();
  }
});
