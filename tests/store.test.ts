/**
 * Store Tests — persistence round-trips, uniqueness, staleness, runs.
 * Fully local: temp SQLite file per test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store, normalizeTopic, type StoredNode } from '../src/store.js';

function tempStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'rh-store-'));
  return new Store(join(dir, 'state.db'));
}

let seq = 0;

function makeNode(overrides: Partial<StoredNode> = {}): StoredNode {
  const now = Date.now();
  const topic = overrides.topic ?? `topic ${++seq}`;
  return {
    topic,
    rootTopic: 'root topic',
    parentTopic: null,
    status: 'pending',
    depth: 0,
    contentHash: null,
    probeHash: null,
    content: null,
    sources: [],
    subtopics: [],
    fetchError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Store nodes', () => {
  test('round-trip preserves all fields', () => {
    const store = tempStore();
    const n = makeNode({
      topic: 'episodic memory',
      status: 'complete',
      depth: 2,
      parentTopic: 'llm agents',
      contentHash: 'deadbeef',
      content: 'some content',
      sources: ['https://a.example', 'https://b.example'],
      subtopics: ['sub one', 'sub two'],
    });
    store.upsertNode(n);
    const got = store.getNodeByTopic('Episodic Memory'); // lookup normalizes case
    assert.ok(got);
    assert.equal(got.status, 'complete');
    assert.equal(got.depth, 2);
    assert.equal(got.parentTopic, 'llm agents');
    assert.equal(got.contentHash, 'deadbeef');
    assert.deepEqual(got.subtopics, ['sub one', 'sub two']);
    store.close();
  });

  test('upsert on same topic updates in place, keeps created_at', () => {
    const store = tempStore();
    store.upsertNode(makeNode({ topic: 'x', status: 'pending' }));
    const first = store.getNodeByTopic('x');
    store.upsertNode(makeNode({ topic: 'X', status: 'complete', contentHash: 'h1', createdAt: 1 }));
    const got = store.getNodeByTopic('x');
    assert.equal(got?.status, 'complete');
    assert.equal(got?.contentHash, 'h1');
    assert.equal(got?.createdAt, first?.createdAt); // conflict rule preserves created_at
    store.close();
  });

  test('getNodesByRoot ordered by depth then creation', () => {
    const store = tempStore();
    store.upsertNode(makeNode({ topic: 'root', rootTopic: 'root', depth: 0 }));
    store.upsertNode(makeNode({ topic: 'child one', rootTopic: 'root', parentTopic: 'root', depth: 1 }));
    store.upsertNode(makeNode({ topic: 'grandchild', rootTopic: 'root', parentTopic: 'child one', depth: 2 }));
    store.upsertNode(makeNode({ topic: 'child two', rootTopic: 'root', parentTopic: 'root', depth: 1 }));
    const nodes = store.getNodesByRoot('ROOT');
    assert.deepEqual(nodes.map(n => n.topic), ['root', 'child one', 'child two', 'grandchild']);
    store.close();
  });

  test('stale candidates filter by age and status, oldest first, limited', () => {
    const store = tempStore();
    const old = Date.now() - 10 * 24 * 3600_000;
    const recent = Date.now() - 1000;
    store.upsertNode(makeNode({ topic: 'old complete', status: 'complete', updatedAt: old }));
    store.upsertNode(makeNode({ topic: 'recent complete', status: 'complete', updatedAt: recent }));
    store.upsertNode(makeNode({ topic: 'old failed', status: 'failed', updatedAt: old }));
    store.upsertNode(makeNode({ topic: 'old pending', status: 'pending', updatedAt: old }));
    const stale = store.getStaleCandidates('root topic', 7 * 24 * 3600_000, 10);
    assert.deepEqual(stale.map(n => n.topic), ['old complete']);
    store.upsertNode(makeNode({ topic: 'older complete', status: 'complete', updatedAt: old - 5000 }));
    const limited = store.getStaleCandidates('root topic', 7 * 24 * 3600_000, 1);
    assert.deepEqual(limited.map(n => n.topic), ['older complete']);
    store.close();
  });

  test('touchNode bumps updated_at only', () => {
    const store = tempStore();
    const t0 = Date.now() - 100_000;
    store.upsertNode(makeNode({ topic: 't', status: 'complete', updatedAt: t0 }));
    const t1 = Date.now();
    store.touchNode('T', t1);
    const got = store.getNodeByTopic('t');
    assert.equal(got?.updatedAt, t1);
    assert.equal(got?.status, 'complete');
    store.close();
  });

  test('knownTopics returns normalized set across roots', () => {
    const store = tempStore();
    store.upsertNode(makeNode({ topic: 'Mixed Case Topic', rootTopic: 'r1' }));
    store.upsertNode(makeNode({ topic: 'other', rootTopic: 'r2' }));
    const known = store.knownTopics();
    assert.ok(known.has('mixed case topic'));
    assert.ok(known.has('other'));
    assert.ok(!known.has('mixed case topics'));
    store.close();
  });
});

describe('Store recipes', () => {
  test('recipe round-trip and upsert', () => {
    const store = tempStore();
    assert.equal(store.getRecipe('example.com'), null);
    store.saveRecipe({ domain: 'example.com', selector: 'article', yieldChars: 4200, fallbackStreak: 0, wins: 3, updatedAt: Date.now() });
    let r = store.getRecipe('example.com');
    assert.equal(r?.selector, 'article');
    assert.equal(r?.yieldChars, 4200);
    store.saveRecipe({ domain: 'example.com', selector: 'main', yieldChars: 5100, fallbackStreak: 0, wins: 4, updatedAt: Date.now() });
    r = store.getRecipe('example.com');
    assert.equal(r?.selector, 'main');
    assert.equal(r?.wins, 4);
    store.close();
  });
});

describe('Store runs', () => {
  test('save and retrieve last run delta', () => {
    const store = tempStore();
    const delta = { skippedResearched: 20, revalidated: 3, changedNodes: 2, expandedNodes: 5, failedNodes: 1 };
    store.saveRun({ id: 'run-1', rootTopic: 't', startedAt: 1, finishedAt: 2, delta });
    const last = store.getLastRun('T');
    assert.deepEqual(last?.delta, delta);
    store.saveRun({ id: 'run-2', rootTopic: 't', startedAt: 3, finishedAt: 4, delta: { ...delta, skippedResearched: 25 } });
    assert.equal(store.getLastRun('t')?.id, 'run-2');
    store.close();
  });
});
