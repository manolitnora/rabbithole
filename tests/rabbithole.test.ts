/**
 * Rabbithole Tests — DAG, tunnel config, search client, dive engine
 *
 * Note: Tests that hit the network (Brave Search, tunnel) are skipped
 * unless BRAVE_API_KEY is set. DAG tests are fully local.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  resetDAG, createRootNode, addChildNode, getStats,
  exportToMarkdown, getAllNodes, canAddNode, getPendingNodes,
  markResearching, updateNodeWithResults, markFailed,
  MAX_DEPTH, MAX_NODES,
} from '../src/dag.js';

import { configureTunnel, getTunnelStats } from '../src/tunnel.js';

// ═══════════════════════════════════════════════════════════════════
// DAG TESTS
// ═══════════════════════════════════════════════════════════════════

describe('Research DAG', () => {
  test('create root node', () => {
    resetDAG();
    const root = createRootNode('episodic memory in LLM agents');
    assert.ok(root);
    assert.equal(root.topic, 'episodic memory in LLM agents');
    assert.equal(root.depth, 0);
    assert.equal(root.status, 'pending');
    assert.equal(root.parentId, null);
  });

  test('add child node', () => {
    resetDAG();
    const root = createRootNode('parent topic');
    assert.ok(root);
    const child = addChildNode(root.id, 'child topic');
    assert.ok(child);
    assert.equal(child.depth, 1);
    assert.equal(child.parentId, root.id);
  });

  test('enforces MAX_DEPTH', () => {
    resetDAG();
    let current = createRootNode('depth-0');
    assert.ok(current);

    for (let i = 1; i <= MAX_DEPTH; i++) {
      const child = addChildNode(current.id, `depth-${i}`);
      if (i <= MAX_DEPTH) {
        current = child!;
      }
    }

    // One more should fail
    const tooDeep = addChildNode(current.id, 'too-deep');
    assert.equal(tooDeep, null);
  });

  test('enforces MAX_NODES', () => {
    resetDAG();
    const root = createRootNode('root');
    assert.ok(root);

    for (let i = 1; i < MAX_NODES; i++) {
      addChildNode(root.id, `node-${i}`);
    }

    assert.equal(canAddNode(), false);
    const overflow = addChildNode(root.id, 'overflow');
    assert.equal(overflow, null);
  });

  test('prevents duplicate topics', () => {
    resetDAG();
    const root = createRootNode('unique topic');
    assert.ok(root);
    const dupe = createRootNode('unique topic');
    assert.equal(dupe, null);
  });

  test('node lifecycle: pending → researching → complete', () => {
    resetDAG();
    const root = createRootNode('lifecycle test');
    assert.ok(root);
    assert.equal(root.status, 'pending');

    markResearching(root.id);
    const afterResearch = getAllNodes().find(n => n.id === root.id);
    assert.equal(afterResearch?.status, 'researching');

    updateNodeWithResults(root.id, 'some content', ['source.com'], ['sub1', 'sub2']);
    const afterUpdate = getAllNodes().find(n => n.id === root.id);
    assert.equal(afterUpdate?.status, 'complete');
    assert.equal(afterUpdate?.content, 'some content');
    assert.deepEqual(afterUpdate?.subTopics, ['sub1', 'sub2']);
  });

  test('node failure', () => {
    resetDAG();
    const root = createRootNode('fail test');
    assert.ok(root);
    markFailed(root.id);
    const failed = getAllNodes().find(n => n.id === root.id);
    assert.equal(failed?.status, 'failed');
  });

  test('getPendingNodes returns only pending', () => {
    resetDAG();
    const root = createRootNode('root');
    assert.ok(root);
    const child = addChildNode(root.id, 'child');
    assert.ok(child);
    markResearching(root.id);

    const pending = getPendingNodes();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, child.id);
  });

  test('stats are accurate', () => {
    resetDAG();
    const root = createRootNode('stats root');
    assert.ok(root);
    addChildNode(root.id, 'child1');
    addChildNode(root.id, 'child2');
    markResearching(root.id);
    updateNodeWithResults(root.id, 'done', [], []);

    const stats = getStats();
    assert.equal(stats.totalNodes, 3);
    assert.equal(stats.completeNodes, 1);
    assert.equal(stats.pendingNodes, 2);
    assert.equal(stats.maxDepth, 1);
  });

  test('export to markdown', () => {
    resetDAG();
    const root = createRootNode('markdown test');
    assert.ok(root);
    updateNodeWithResults(root.id, 'Research content here', ['https://example.com'], ['sub']);

    const md = exportToMarkdown();
    assert.ok(md.includes('markdown test'));
    assert.ok(md.includes('Research content here'));
    assert.ok(md.includes('example.com'));
  });

  test('reset clears all state', () => {
    resetDAG();
    createRootNode('before reset');
    assert.equal(getStats().totalNodes, 1);

    resetDAG();
    assert.equal(getStats().totalNodes, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TUNNEL CONFIG TESTS
// ═══════════════════════════════════════════════════════════════════

describe('Tunnel', () => {
  test('configure updates settings', () => {
    configureTunnel({ minJitter: 1000, maxJitter: 3000 });
    const stats = getTunnelStats();
    assert.equal(stats.config.minJitter, 1000);
    assert.equal(stats.config.maxJitter, 3000);

    // Reset
    configureTunnel({ minJitter: 2000, maxJitter: 5000 });
  });

  test('stats reports zero active', () => {
    const stats = getTunnelStats();
    assert.equal(stats.active, 0);
  });
});
