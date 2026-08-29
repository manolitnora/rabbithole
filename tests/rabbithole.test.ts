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

import { configureTunnel, getTunnelStats, type TunnelResult } from '../src/tunnel.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dive, extractSubTopics, isValidTopic, type EngineDeps } from '../src/rabbithole.js';
import { extractGeneric } from '../src/extract.js';
import type { SearchResult } from '../src/brave.js';

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


// ═══════════════════════════════════════════════════════════════════
// CHROME BIGRAM REJECTION
// ═══════════════════════════════════════════════════════════════════

describe('extractSubTopics chrome rejection', () => {
  test('rejects HTML/chrome bigrams (span class, pages using, ...)', () => {
    const chrome = [
      'span class span class span class',
      'pages using pages using pages using',
      'wiki jump wiki jump wiki jump',
      'click share click share click share',
      'listen cookie listen cookie',
      'privacy navigation privacy navigation',
      'footer header footer header',
      'script href script href',
    ].join(' ');
    const topics = extractSubTopics(chrome, 'some claim');
    assert.deepEqual(topics, []);
  });

  test('accepts real 2-word alphabetic topics', () => {
    const prose = Array.from({ length: 8 }, () => 'memory consolidation hippocampal replay').join(' ');
    const topics = extractSubTopics(prose, 'brain research');
    assert.ok(topics.includes('memory consolidation') || topics.includes('hippocampal replay'),
      `expected real topics, got ${JSON.stringify(topics)}`);
    assert.ok(topics.every(t => isValidTopic(t)));
    assert.ok(!topics.some(t => /span|class|pages|using|wiki/.test(t)));
  });

  test('returns [] when nothing alphabetic length>=4 survives', () => {
    const junk = 'a b c div href 123 456 ok go';
    assert.deepEqual(extractSubTopics(junk, 'x'), []);
  });
});

// ═══════════════════════════════════════════════════════════════════
// KILL MODE
// ═══════════════════════════════════════════════════════════════════

function okPage(url: string, content: string): TunnelResult {
  return {
    success: true,
    url,
    title: 'page',
    content,
    excerpt: content.slice(0, 200),
    timestamp: Date.now(),
    links: [],
    selector: 'article',
    usedRecipe: false,
    yieldChars: content.length,
    error: null,
  };
}

describe('kill mode', () => {
  test('search+tunnel only — no children even when content has fertile bigrams', async () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'rh-kill-')), 'state.db');
    const fertile = Array.from({ length: 8 }, () => 'memory consolidation hippocampal replay synaptic plasticity').join(' ');
    const deps: EngineDeps = {
      search: async (query: string, _count: number): Promise<SearchResult[]> => {
        void _count;
        return [{ title: `hit for ${query}`, url: 'https://example.test/kill', description: 'desc' }];
      },
      fetchPage: async (url: string) => okPage(url, fertile),
    };
    const result = await dive(
      'claim that agents never forget',
      {
        mode: 'kill',
        searchQuery: 'evidence of catastrophic forgetting',
        maxDepth: 1,
        maxNodes: 1,
        minJitter: 0,
        maxJitter: 0,
        storePath,
      },
      deps,
    );
    assert.equal(result.nodes.length, 1, 'kill mode must not spawn children');
    assert.equal(result.nodes[0].depth, 0);
    assert.deepEqual(result.nodes[0].subTopics, []);
    assert.ok(result.nodes[0].sources.includes('https://example.test/kill'));
    assert.ok(result.nodes[0].content.includes('memory consolidation'));
    assert.ok(result.markdown.includes('claim that agents never forget'));
    assert.equal(result.maxDepthReached, 0);
  });
});

describe('extractGeneric fixture', () => {
  test('tiny HTML yields prose not nav', () => {
    const html = `<!doctype html><html><head><title>T</title></head><body>
      <nav><a href="/home">Home</a> <a href="/jump">Jump to content</a></nav>
      <article><p>${'Episodic memory systems retrieve past episodes. '.repeat(20)}</p></article>
      <footer>copyright nobody</footer>
    </body></html>`;
    const ex = extractGeneric(html);
    assert.ok(ex.content.includes('Episodic memory systems'));
    assert.ok(!ex.content.includes('Jump to content'), 'nav chrome must not dominate');
    assert.ok(!ex.content.includes('copyright nobody') || ex.content.indexOf('Episodic') < ex.content.indexOf('copyright'));
  });
});
