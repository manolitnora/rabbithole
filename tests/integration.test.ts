import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dive, Store, configureTunnel, previewJevResearch, evaluateJevResearch } from '../src/index.js';

const prose = 'Memory consolidation connects observations to previous evidence. '.repeat(20);

test('dive learns and reuses adaptive memory through real HTTP and SQLite, then prepares gated Jev review', async () => {
  let changed = false;
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    if (hits === 1) { res.writeHead(503, { 'Retry-After': '0' }); res.end(); return; }
    const distractor = changed ? `<div>${'Unrelated advert. '.repeat(250)}</div>` : '';
    res.end(`<html><head><title>Research</title></head><body>${distractor}<article id="${changed ? 'new' : 'old'}" class="story" role="main"><p>${prose}</p></article></body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/article`;
  const path = join(mkdtempSync(join(tmpdir(), 'rh-full-')), 'state.db');
  const options = { mode: 'kill' as const, minJitter: 0, maxJitter: 0, maxNodes: 1, storePath: path };
  const deps = { search: async () => [{ title: 'Research', url, description: 'Candidate source' }] };
  configureTunnel({ maxRetries: 2 });
  try {
    const first = await dive('first research', options, deps);
    assert.equal(first.nodesComplete, 1);
    assert.equal(hits, 2, 'first fetch must recover from the real 503');
    const firstStore = new Store(path);
    try { assert.ok(firstStore.getRecipe('127.0.0.1')?.fingerprint); }
    finally { firstStore.close(); }
    changed = true;
    const second = await dive('second research', options, deps);
    assert.equal(second.nodesComplete, 1);
    assert.equal(second.nodes[0].content, prose.trim());
    assert.ok(!second.markdown.includes('advert'));
    const secondStore = new Store(path);
    try { assert.equal(secondStore.getRecipe('127.0.0.1')?.selector, 'article#new'); }
    finally { secondStore.close(); }
    const before = JSON.stringify(second.nodes);
    const preview = previewJevResearch(second.topic, second.nodes);
    const review = await evaluateJevResearch(second.topic, second.nodes, { getApiKey: () => { throw new Error('must not read'); } });
    assert.equal(review.status, 'not_approved');
    assert.ok('preview' in review);
    assert.deepEqual(review.preview, preview);
    assert.equal(JSON.stringify(second.nodes), before);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
