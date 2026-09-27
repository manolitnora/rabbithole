import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dive, extractSubTopics, isValidTopic, type EngineDeps, type SearchResult } from '../src/rabbithole.js';

function tempStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'rh-llm-')), 'state.db');
}

function okPage(url: string, content: string) {
  return {
    success: true, url, title: 'page', content, links: [], selector: null,
    usedRecipe: false, yieldChars: content.length, error: null, timestamp: Date.now(),
  };
}

function fakeWeb(content: string): EngineDeps {
  return {
    search: async (query: string): Promise<SearchResult[]> => [
      { title: `result ${query}`, url: `https://site.test/${encodeURIComponent(query)}`, description: 'desc' },
    ],
    fetchPage: async (url: string) => okPage(url, content),
  };
}

async function llmServer(reply: string): Promise<{ base: string; server: Server }> {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { base: `http://127.0.0.1:${address.port}`, server };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
}

test('isValidTopic accepts clean phrases and rejects chrome or short input', () => {
  assert.equal(isValidTopic('memory consolidation'), true);
  assert.equal(isValidTopic('span class'), false);
  assert.equal(isValidTopic('pages using'), false);
  assert.equal(isValidTopic('singleword'), false);
});

test('bigram fallback rejects chrome tokens', () => {
  const chrome = 'span class span class span class pages using pages using pages using';
  assert.deepEqual(extractSubTopics(chrome, 'some claim'), []);
});

test('a configured endpoint drives mitosis with LLM sub-topics', async () => {
  const { base, server } = await llmServer('["memory consolidation", "replay buffers"]');
  try {
    const run = await dive(
      'topic theta',
      { storePath: tempStorePath(), maxNodes: 4, maxDepth: 1, llmBaseUrl: base, llmModel: 'test-model' },
      fakeWeb('plain page prose without any repeated bigrams in it'),
    );
    const topics = run.nodes.map(n => n.topic);
    assert.ok(topics.includes('memory consolidation'), `topics: ${topics.join(', ')}`);
    assert.ok(topics.includes('replay buffers'), `topics: ${topics.join(', ')}`);
  } finally {
    await close(server);
  }
});

test('an unreachable endpoint falls back to the bigram heuristic', async () => {
  const run = await dive(
    'topic iota',
    { storePath: tempStorePath(), maxNodes: 4, maxDepth: 1, llmBaseUrl: 'http://127.0.0.1:9', llmModel: 'test-model' },
    fakeWeb(`${Array.from({ length: 8 }, () => 'spike sorting').join(' ')} tail prose.`),
  );
  assert.ok(run.nodes.some(n => n.topic === 'spike sorting'), `topics: ${run.nodes.map(n => n.topic).join(', ')}`);
});

test('LLM output that fails validation falls back to bigrams', async () => {
  const { base, server } = await llmServer('["span class", "no"]');
  try {
    const run = await dive(
      'topic kappa',
      { storePath: tempStorePath(), maxNodes: 4, maxDepth: 1, llmBaseUrl: base, llmModel: 'test-model' },
      fakeWeb(`${Array.from({ length: 8 }, () => 'evidence mapping').join(' ')} tail prose.`),
    );
    assert.ok(run.nodes.some(n => n.topic === 'evidence mapping'), `topics: ${run.nodes.map(n => n.topic).join(', ')}`);
  } finally {
    await close(server);
  }
});
