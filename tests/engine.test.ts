/**
 * Engine Tests — resumable dives, staleness revalidation, cross-run dedup,
 * recipe wiring. Fully offline: fake search + fetchPage injection, temp store.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dive, type EngineDeps, type SearchResult } from '../src/rabbithole.js';
import { Store, normalizeTopic } from '../src/store.js';
import type { RecipeLike } from '../src/extract.js';
import type { TunnelResult } from '../src/tunnel.js';

// ═══════════════════════════════════════════════════════════════════
// FAKE WEB
// ═══════════════════════════════════════════════════════════════════

interface FetchCall {
  url: string;
  recipe: RecipeLike | null;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function okResult(url: string, content: string, overrides: Partial<TunnelResult> = {}): TunnelResult {
  return {
    success: true,
    url,
    title: `page ${url}`,
    content,
    links: [],
    selector: null,
    usedRecipe: false,
    yieldChars: content.length,
    error: null,
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Deterministic fake web: each topic maps to one page URL; content per URL. */
function makeDeps(opts: {
  /** url → content provider (called per fetch; may mutate between runs) */
  pages: Map<string, () => string>;
  /** record of fetchPage calls */
  fetchLog?: FetchCall[];
}): { deps: EngineDeps; urlsFor: (topic: string) => string[] } {
  const { pages, fetchLog } = opts;
  const deps: EngineDeps = {
    search: async (query: string, _count: number): Promise<SearchResult[]> => {
      void _count;
      const url = `https://site.test/p-${slug(query)}`;
      if (!pages.has(url)) pages.set(url, () => `${query} filler text for the fake page about ${query}.`);
      return [{ title: `result ${query}`, url, description: `desc ${query}` }];
    },
    fetchPage: async (url: string, recipe: RecipeLike | null): Promise<TunnelResult> => {
      fetchLog?.push({ url, recipe });
      const provider = pages.get(url);
      if (!provider) return { ...okResult(url, ''), success: false, error: 'no such page in fake web' };
      return okResult(url, provider());
    },
  };
  return { deps, urlsFor: (topic: string) => [`https://site.test/p-${slug(topic)}`] };
}

/**
 * Content whose dominant bigram is `phrase` (8 occurrences vs 1 for every
 * other pair) so extractSubTopics deterministically picks it first.
 */
const BIGRAM_RICH = (phrase: string, tail: string): string =>
  Array.from({ length: 8 }, (_, i) => `${phrase} appears in study ${i}.`).join(' ') +
  ` ${tail}.`;

function tempStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'rh-engine-')), 'state.db');
}

// ═══════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════

describe('dive — compounding semantics', () => {
  test('run 1 explores and persists; run 2 skips everything with zero fetches', async () => {
    const storePath = tempStorePath();
    const pages = new Map<string, () => string>();
    pages.set('https://site.test/p-topic-alpha', () =>
      BIGRAM_RICH('quantum computing', 'alpha context sentence with enough words to matter here.'));

    const run1 = await dive('Topic Alpha', { storePath, maxNodes: 6 }, makeDeps({ pages }).deps);
    assert.equal(run1.nodesExplored >= 2, true, 'run 1 should expand past the root');
    assert.ok(run1.delta);
    assert.ok(run1.delta!.expandedNodes > 0);
    assert.equal(run1.delta!.failedNodes, 0);

    // Everything landed in the store under the normalized root
    const store1 = new Store(storePath);
    const stored = store1.getNodesByRoot('topic alpha');
    assert.ok(stored.length >= 2);
    store1.close();

    // Run 2: nothing is stale yet → zero fetches, all skipped
    const fetchLog: FetchCall[] = [];
    const run2 = await dive('topic alpha', { storePath, resume: true }, makeDeps({ pages, fetchLog }).deps);
    assert.equal(fetchLog.length, 0, 'run 2 must not refetch anything fresh');
    assert.equal(run2.exitReason, 'convergence');
    assert.equal(run2.delta!.changedNodes, 0);
    assert.equal(run2.delta!.skippedResearched, stored.filter(n => n.status === 'complete').length);
    assert.equal(run2.nodesComplete, run1.nodesComplete);
  });

  test('stale node with changed page re-enters research (delta reports it)', async () => {
    const storePath = tempStorePath();
    const targetUrl = 'https://site.test/p-topic-beta';
    let mutated = false;
    const original = BIGRAM_RICH('memory consolidation', 'beta original prose.');
    const changed = BIGRAM_RICH('memory consolidation', 'beta COMPLETELY rewritten prose v2.');
    const pages = new Map<string, () => string>([
      [targetUrl, () => (mutated ? changed : original)],
    ]);

    await dive('topic beta', { storePath, maxNodes: 4 }, makeDeps({ pages }).deps);

    // Second run: ttl=0 makes everything stale; flip content before fetching
    mutated = true;
    const fetchLog: FetchCall[] = [];
    const run2 = await dive('topic beta', { storePath, resume: true, stalenessTtlMs: 0 }, makeDeps({ pages, fetchLog }).deps);

    assert.equal(run2.delta!.revalidated >= 1, true);
    assert.equal(run2.delta!.changedNodes, 1);
    assert.ok(fetchLog.length >= 1, 'staleness check must refetch');

    // The changed node was reprocessed and persisted with new hash
    const store2 = new Store(storePath);
    const row = store2.getNodeByTopic('topic beta');
    assert.equal(row?.status, 'complete');
    assert.ok(row?.content?.includes('rewritten'));
    store2.close();
  });

  test('multi-source node unchanged → NOT flagged changed (probe-to-probe)', async () => {
    // Regression: live Wikipedia runs flagged every node changed because
    // staleness compared the COMBINED node hash against a single-page
    // refetch. The probe hash must cover source[0] alone.
    const storePath = tempStorePath();
    const twoResultSearch: EngineDeps = {
      search: async (query: string) => [
        { title: 'a', url: `https://site.test/p-${slug(query)}-a`, description: 'a' },
        { title: 'b', url: `https://site.test/p-${slug(query)}-b`, description: 'b' },
      ],
      fetchPage: async (url, recipe) => {
        const key = url.slice('https://site.test/p-'.length);
        const base = key.replace(/-[ab]$/, '');
        const content = `${base} source text ${key.endsWith('-a') ? 'alpha variant' : 'beta variant'} `.repeat(30);
        return okResult(url, content);
      },
    };

    await dive('topic multi', { storePath, maxNodes: 3 }, twoResultSearch);
    const run2 = await dive('topic multi', { storePath, resume: true, stalenessTtlMs: 0 }, twoResultSearch);
    assert.equal(run2.delta!.revalidated >= 1, true);
    assert.equal(run2.delta!.changedNodes, 0, 'stable two-source nodes must not be flagged changed');
  });


  test('unchanged stale page is touched, not requeued', async () => {
    const storePath = tempStorePath();
    const pages = new Map<string, () => string>();
    pages.set('https://site.test/p-topic-gamma', () => BIGRAM_RICH('vector databases', 'gamma stable prose.'));

    await dive('topic gamma', { storePath, maxNodes: 3 }, makeDeps({ pages }).deps);
    const store1 = new Store(storePath);
    const before = store1.getNodeByTopic('topic gamma')?.updatedAt;
    store1.close();

    const fetchLog: FetchCall[] = [];
    const run2 = await dive('topic gamma', { storePath, resume: true, stalenessTtlMs: 0 }, makeDeps({ pages, fetchLog }).deps);
    assert.equal(run2.delta!.revalidated >= 1, true);
    assert.equal(run2.delta!.changedNodes, 0, 'identical content must not requeue');

    const store2 = new Store(storePath);
    const after = store2.getNodeByTopic('topic gamma')?.updatedAt;
    store2.close();
    assert.ok((after ?? 0) >= (before ?? 0), 'touched node leaves the stale window');
  });

  test('cross-run dedup: topic stored under another root is never re-explored', async () => {
    const storePath = tempStorePath();
    const pages = new Map<string, () => string>();

    // Root A's page breeds child "quantum computing"
    pages.set('https://site.test/p-root-a', () =>
      BIGRAM_RICH('quantum computing', 'root a context.'));
    await dive('root a', { storePath, maxNodes: 4 }, makeDeps({ pages }).deps);

    // Root B's page repeats the same bigram — but it is already researched
    pages.set('https://site.test/p-root-b', () =>
      BIGRAM_RICH('quantum computing', 'root b tries to revisit.'));
    const runB = await dive('root b', { storePath, maxNodes: 6 }, makeDeps({ pages }).deps);

    const topics = runB.nodes.map(n => normalizeTopic(n.topic));
    assert.ok(!topics.includes('quantum computing'), 'stored topic must not respawn under a new root');
  });

  test('recipes flow: learned in run 1, delivered to fetcher in run 2', async () => {
    const storePath = tempStorePath();
    const url = 'https://site.test/p-topic-delta';
    const pages = new Map<string, () => string>([
      [url, () => BIGRAM_RICH('graph embeddings', 'delta prose.')],
    ]);

    // Fake page reports it was generically extracted with a winning selector
    const mk = (log: FetchCall[]): EngineDeps => {
      const d = makeDeps({ pages, fetchLog: log });
      const inner = d.deps.fetchPage!;
      d.deps.fetchPage = async (url2, recipe) => {
        const r = await inner(url2, recipe);
        // Simulate generic extraction finding a stable container
        return r.success ? { ...r, selector: 'article.prose', usedRecipe: false } : r;
      };
      return d.deps;
    };

    const log1: FetchCall[] = [];
    await dive('topic delta', { storePath, maxNodes: 3 }, mk(log1));
    const store1 = new Store(storePath);
    const recipe = store1.getRecipe('site.test');
    store1.close();
    assert.ok(recipe, 'recipe must be learned from generic extraction');
    assert.equal(recipe.selector, 'article.prose');

    const log2: FetchCall[] = [];
    await dive('topic epsilon', { storePath, maxNodes: 3 }, mk(log2));
    assert.ok(log2.every(c => c.recipe !== null), 'second run passes stored recipe to fetcher');
    const got = log2[0]?.recipe;
    assert.equal(got?.selector, 'article.prose');
  });

  test('fresh (non-resume) dive still flushes to store', async () => {
    const storePath = tempStorePath();
    const pages = new Map<string, () => string>();
    pages.set('https://site.test/p-topic-zeta', () => BIGRAM_RICH('spike sorting', 'zeta prose.'));
    const run = await dive('topic zeta', { storePath, maxNodes: 3 }, makeDeps({ pages }).deps);
    assert.ok(run.delta);
    const store = new Store(storePath);
    assert.ok(store.getNodesByRoot('topic zeta').length >= 1);
    assert.ok(store.getLastRun('topic zeta'));
    store.close();
  });

  test('searchQuery anchors the root search while the topic stays the root', async () => {
    const storePath = tempStorePath();
    const queries: string[] = [];
    const deps: EngineDeps = {
      search: async (query: string) => {
        queries.push(query);
        return [{ title: 'result', url: 'https://site.test/anchored', description: 'desc' }];
      },
      fetchPage: async (url: string) => okResult(url, 'short prose without repeated bigrams'),
    };

    const topic = 'grounding context about Vault token renewal and policy';
    const run = await dive(topic, { storePath, maxNodes: 1, searchQuery: 'vault token renewal' }, deps);
    assert.deepEqual(queries, ['vault token renewal']);
    assert.equal(run.nodes[0].topic, topic);
    assert.equal(run.nodesComplete, 1);
  });
});
