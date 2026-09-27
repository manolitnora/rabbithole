/**
 * Rabbit Hole Engine — Recursive, self-expanding, COMPOUNDING research.
 *
 * Algorithm:
 *   1. Ignition: topic provided
 *   2. Search: Brave Search finds relevant pages
 *   3. Tunnel: fetch content with jitter + privacy + per-domain recipes
 *   4. Extract: pull sub-topics from content (deterministic bigrams)
 *   5. Mitosis: spawn child nodes for sub-topics
 *   6. Repeat until MAX_DEPTH, MAX_NODES, or convergence
 *   7. Persist: every node lands in SQLite; the next dive resumes
 *
 * Compounding semantics (the point of v2):
 *   - Topics are durable keys: a topic researched in ANY run is never
 *     re-explored unless invalidated.
 *   - resume=true reloads the stored DAG; complete nodes are skipped;
 *     nodes older than stalenessTtlMs get revalidated (content-hash compare,
 *     capped at maxRevalidate per run); changed pages re-enter processing.
 *   - The second dive on the same topic reports a delta instead of redoing work.
 *
 * Constraints:
 *   MAX_DEPTH:      3  (prevent infinite recursion)
 *   MAX_NODES:      20 (prevent explosion)
 *   MAX_CONCURRENT: 3  (enforced SOLELY by tunnel — engine keeps no counter)
 *   JITTER:         2-5s (anti-bot behavior)
 *
 * Zero LLM calls anywhere in this file.
 */

import { createHash } from 'node:crypto';

import { braveSearch, type SearchResult } from './brave.js';
import { tunnel, configureTunnel, type TunnelResult } from './tunnel.js';
import { domainOf, nextRecipe, type RecipeLike, type RecipeOutcome } from './extract.js';
import {
  resetDAG, createRootNode, addChildNode, markResearching,
  updateNodeWithResults, markFailed, requeueNode, getPendingNodes,
  getStats, canAddNode, exportToMarkdown, getAllNodes, getNode,
  type ResearchNode, MAX_DEPTH, MAX_NODES,
} from './dag.js';
import {
  Store, defaultStorePath, normalizeTopic,
  type RunDelta, type StoredNode,
} from './store.js';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface RabbitHoleConfig {
  maxDepth: number;
  maxNodes: number;
  maxConcurrent: number;
  minJitter: number;
  maxJitter: number;
  maxContentPerPage: number;
  searchResultsPerQuery: number;
  /** Reload persisted DAG and only explore frontier/stale nodes. */
  resume: boolean;
  /** Complete nodes older than this become revalidation candidates. */
  stalenessTtlMs: number;
  /** Max refetch-based revalidations per run (bounds cost). */
  maxRevalidate: number;
  /** SQLite path; null → defaultStorePath(). */
  storePath: string | null;
}

export interface DiveResult {
  topic: string;
  nodesExplored: number;
  nodesComplete: number;
  maxDepthReached: number;
  markdown: string;
  nodes: ResearchNode[];
  exitReason: 'convergence' | 'max_depth' | 'max_nodes' | 'no_pending';
  delta: RunDelta | null;
}

/** Injection seam for tests — defaults hit the real network. */
export interface EngineDeps {
  search?: (query: string, count: number) => Promise<SearchResult[]>;
  fetchPage?: (url: string, recipe: RecipeLike | null) => Promise<TunnelResult>;
}

// ═══════════════════════════════════════════════════════════════════
// DEFAULTS
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: RabbitHoleConfig = {
  maxDepth: MAX_DEPTH,
  maxNodes: MAX_NODES,
  maxConcurrent: 3,
  minJitter: 2000,
  maxJitter: 5000,
  maxContentPerPage: 5000,
  searchResultsPerQuery: 5,
  resume: false,
  stalenessTtlMs: 7 * 24 * 3600_000,
  maxRevalidate: 5,
  storePath: null,
};

// ═══════════════════════════════════════════════════════════════════
// STATE — module-global working set; one dive at a time by design
// ═══════════════════════════════════════════════════════════════════

const researchedTopics = new Set<string>();

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// ═══════════════════════════════════════════════════════════════════
// SUB-TOPIC EXTRACTION — deterministic bigram heuristic (unchanged)
// ═══════════════════════════════════════════════════════════════════

function extractSubTopics(content: string, parentTopic: string, limit = 3): string[] {
  const stopwords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'and', 'but', 'or', 'not', 'this',
    'that', 'these', 'those', 'it', 'its', 'they', 'them', 'we', 'you',
    'about', 'which', 'when', 'where', 'who', 'what', 'how', 'than',
    'more', 'also', 'other', 'some', 'such', 'into', 'over', 'after',
  ]);

  const parentWords = new Set(parentTopic.toLowerCase().split(/\s+/));

  // Extract 2-grams (bigrams) as candidate topics
  const words = content.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopwords.has(w));

  const bigramCounts = new Map<string, number>();
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = `${words[i]} ${words[i + 1]}`;
    // Skip if both words are in parent topic
    if (parentWords.has(words[i]) && parentWords.has(words[i + 1])) continue;
    bigramCounts.set(bigram, (bigramCounts.get(bigram) ?? 0) + 1);
  }

  // Sort by frequency, take top N that aren't already researched
  return Array.from(bigramCounts.entries())
    .filter(([bg, count]) => count >= 2 && !researchedTopics.has(bg))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([bg]) => bg);
}

// ═══════════════════════════════════════════════════════════════════
// NODE PROCESSING
// ═══════════════════════════════════════════════════════════════════

interface NodeContext {
  cfg: RabbitHoleConfig;
  store: Store;
  deps: { search: (query: string, count: number) => Promise<SearchResult[]>; fetchPage: (url: string, recipe: RecipeLike | null) => Promise<TunnelResult> };
  delta: RunDelta;
  expandedCount: { n: number };
  rootTopicN: string;
}

async function processNode(node: ResearchNode, ctx: NodeContext): Promise<void> {
  const { cfg, store, deps, delta, rootTopicN } = ctx;

  markResearching(node.id);

  // Persist this node's durable state. Topic is the key; created_at is
  // preserved across overwrites by the store's conflict rule.
  const flush = (status: StoredNode['status'], fetchError: string | null, probeHash?: string | null): void => {
    const parent = node.parentId ? getNode(node.parentId) : null;
    const now = Date.now();
    store.upsertNode({
      topic: normalizeTopic(node.topic),
      rootTopic: rootTopicN,
      parentTopic: parent ? normalizeTopic(parent.topic) : null,
      depth: node.depth,
      status,
      contentHash: node.content ? sha256(node.content) : null,
      probeHash: probeHash ?? null,
      content: node.content || null,
      sources: node.sources,
      subtopics: node.subTopics,
      fetchError,
      createdAt: now,
      updatedAt: now,
    });
  };

  // Probe = first successful source's extracted text. Its hash (not the
  // combined node hash) is what staleness revalidation compares against.
  let probeContent: string | null = null;

  try {
    // Search for the topic
    const searchResults = await deps.search(node.topic, cfg.searchResultsPerQuery);

    if (searchResults.length === 0) {
      markFailed(node.id);
      delta.failedNodes++;
      flush('failed', 'search returned no results');
    }

    // Tunnel into top results and extract content (recipes per domain)
    const contents: string[] = [];
    const sources: string[] = [];
    const errors: string[] = [];
    const recipeOutcomes = new Map<string, RecipeOutcome & { prev: RecipeLike | null }>();

    for (const result of searchResults.slice(0, 3)) {
      const domain = domainOf(result.url);
      const recipe = domain ? store.getRecipe(domain) : null;
      const res = await deps.fetchPage(result.url, recipe);

      if (res.success) {
        if (probeContent === null) probeContent = res.content;
        contents.push(res.content.substring(0, cfg.maxContentPerPage));
        sources.push(result.url);
        if (domain) {
          recipeOutcomes.set(domain, {
            prev: recipe,
            usedRecipe: res.usedRecipe,
            recipeYield: res.usedRecipe ? res.yieldChars : 0,
            genericYield: res.usedRecipe ? 0 : res.yieldChars,
            genericSelector: res.usedRecipe ? null : res.selector,
            matchedSelector: res.usedRecipe ? res.selector : null,
            fingerprint: res.fingerprint ?? null,
          });
        }
      } else {
        errors.push(`${result.url}: ${res.error ?? 'unknown error'}`);
      }
    }

    // Persist recipe learning for every domain touched this node
    for (const [domain, oc] of recipeOutcomes) {
      const next = nextRecipe(domain, oc.prev, {
        usedRecipe: oc.usedRecipe,
        recipeYield: oc.recipeYield,
        genericYield: oc.genericYield,
        genericSelector: oc.genericSelector,
        matchedSelector: oc.matchedSelector,
        fingerprint: oc.fingerprint,
      });
      store.saveRecipe({
        domain,
        selector: next.selector,
        yieldChars: next.yieldChars,
        fallbackStreak: next.fallbackStreak,
        wins: next.wins,
        fingerprint: next.fingerprint,
        updatedAt: Date.now(),
      });
    }

    const fetchError: string | null = errors.length > 0 ? errors.join('; ') : null;

    if (contents.length === 0) {
      // Fall back to search descriptions as content
      const fallbackContent = searchResults
        .map(r => `${r.title}: ${r.description}`)
        .join('\n');
      contents.push(fallbackContent);
      sources.push(...searchResults.map(r => r.url));
    }

    const combinedContent = contents.join('\n\n');
    const storedContent = combinedContent.substring(0, cfg.maxContentPerPage);

    // Extract sub-topics for deeper research
    const subTopics = extractSubTopics(combinedContent, node.topic);

    // Update in-memory DAG
    updateNodeWithResults(node.id, storedContent, sources, subTopics);
    researchedTopics.add(normalizeTopic(node.topic));

    // Mitosis: spawn child nodes. Each child is flushed to the store AS
    // PENDING immediately — an unprocessed frontier must survive the run
    // (and reserve its topic against other roots) even if this run exits
    // before reaching it.
    if (subTopics.length > 0 && canAddNode() && getStats().totalNodes < cfg.maxNodes) {
      for (const sub of subTopics) {
        // cfg.maxNodes / cfg.maxDepth gate SPAWNING here — dag's MAX_NODES /
        // MAX_DEPTH are hard backstops; the configured budget is authoritative.
        if (
          canAddNode()
          && getStats().totalNodes < cfg.maxNodes
          && node.depth + 1 <= cfg.maxDepth
          && !researchedTopics.has(normalizeTopic(sub))
        ) {
          const child = addChildNode(node.id, sub);
          if (child) {
            researchedTopics.add(normalizeTopic(sub));
            ctx.expandedCount.n++;
            const now = Date.now();
            store.upsertNode({
              topic: normalizeTopic(child.topic),
              rootTopic: rootTopicN,
              parentTopic: normalizeTopic(node.topic),
              depth: child.depth,
              status: 'pending',
              contentHash: null,
              probeHash: null,
              content: null,
              sources: [],
              subtopics: [],
              fetchError: null,
              createdAt: now,
              updatedAt: now,
            });
          }
        }
      }
    }

    flush('complete', fetchError, probeContent ? sha256(probeContent.substring(0, cfg.maxContentPerPage)) : null);
  } catch (err) {
    markFailed(node.id);
    delta.failedNodes++;
    flush('failed', err instanceof Error ? err.message : String(err));
  }
}

// ═══════════════════════════════════════════════════════════════════
// DAG REBUILD FROM STORE
// ═══════════════════════════════════════════════════════════════════

function rebuildDagFromStore(rows: StoredNode[]): Map<string, string> {
  const idByTopic = new Map<string, string>();
  for (const row of rows) {
    let nodeId: string;
    if (row.depth === 0) {
      const rootNode = createRootNode(row.topic);
      if (!rootNode) continue;
      nodeId = rootNode.id;
    } else {
      const parentId = row.parentTopic ? idByTopic.get(row.parentTopic) : undefined;
      if (!parentId) continue; // orphaned edge — skip
      const child = addChildNode(parentId, row.topic);
      if (!child) continue;
      nodeId = child.id;
    }
    idByTopic.set(normalizeTopic(row.topic), nodeId);
    switch (row.status) {
      case 'complete':
        updateNodeWithResults(nodeId, row.content ?? '', row.sources, row.subtopics);
        break;
      case 'failed':
        markFailed(nodeId);
        break;
      default:
        break; // pending / interrupted researching → retry as pending
    }
  }
  return idByTopic;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN API
// ═══════════════════════════════════════════════════════════════════

/**
 * Dive into a topic. Recursive, self-expanding, resumable research.
 *
 * @param topic Root research topic
 * @param options Config overrides (resume: true → incremental run)
 * @param deps Optional injection seams for tests
 */
export async function dive(
  topic: string,
  options?: Partial<RabbitHoleConfig>,
  deps?: EngineDeps,
): Promise<DiveResult> {
  const cfg: RabbitHoleConfig = { ...DEFAULT_CONFIG, ...options };
  configureTunnel({ minJitter: cfg.minJitter, maxJitter: cfg.maxJitter, maxConcurrent: cfg.maxConcurrent });

  const search = deps?.search ?? braveSearch;
  const fetchPage = deps?.fetchPage ?? tunnel;

  researchedTopics.clear();
  resetDAG();

  const rootTopicN = normalizeTopic(topic);
  const startedAt = Date.now();
  const delta: RunDelta = { skippedResearched: 0, revalidated: 0, changedNodes: 0, expandedNodes: 0, failedNodes: 0 };

  const store = new Store(cfg.storePath ?? defaultStorePath());

  try {
    // Cross-run dedup: every topic ever stored is off-limits for expansion.
    for (const t of store.knownTopics()) researchedTopics.add(t);

    const priorRows = store.getNodesByRoot(rootTopicN);
    const priorCompleteIds = new Set<string>();

    let idByTopic = new Map<string, string>();
    let root: ResearchNode | null;

    if (priorRows.length > 0) {
      idByTopic = rebuildDagFromStore(priorRows);
      const rootId = idByTopic.get(rootTopicN);
      root = rootId ? getNode(rootId) : null;
      for (const row of priorRows) {
        if (row.status === 'complete') {
          const dagId = idByTopic.get(normalizeTopic(row.topic));
          if (dagId) priorCompleteIds.add(dagId);
        }
      }
    } else {
      root = createRootNode(topic);
    }

    if (!root) {
      return {
        topic,
        nodesExplored: 0,
        nodesComplete: 0,
        maxDepthReached: 0,
        markdown: '# No results\n\nFailed to create root node.',
        nodes: [],
        exitReason: 'no_pending',
        delta,
      };
    }

    researchedTopics.add(rootTopicN);

    const ctx: NodeContext = {
      cfg,
      store,
      deps: { search, fetchPage },
      delta,
      expandedCount: { n: 0 },
      rootTopicN,
    };

    const requeuedIds: string[] = [];
    // ── Staleness pass (resume only): bounded revalidation ─────────
    if (cfg.resume && priorRows.length > 0) {
      const stale = store.getStaleCandidates(rootTopicN, cfg.stalenessTtlMs, cfg.maxRevalidate);
      for (const row of stale) {
        const dagId = idByTopic.get(normalizeTopic(row.topic));
        if (!dagId) continue;
        delta.revalidated++;

        const sourceUrl = row.sources[0];
        if (!sourceUrl) continue;

        const recipe = store.getRecipe(domainOf(sourceUrl));
        const res = await fetchPage(sourceUrl, recipe);
        if (!res.success) continue; // unreachable this run — leave as-is

        // Probe-to-probe: the stored hash is of source[0]'s extracted
        // content alone (NOT the combined multi-source node content,
        // which can never match a single-page refetch).
        const newProbe = sha256(res.content.substring(0, cfg.maxContentPerPage));
        if (row.probeHash && newProbe !== row.probeHash) {
          requeueNode(dagId); // changed page → re-research this node
          requeuedIds.push(dagId);
          delta.changedNodes++;
          // Persist the invalidation NOW so a crash can't leave the store
          // claiming "complete" while the DAG says pending.
          store.upsertNode({ ...row, status: 'pending', updatedAt: Date.now() });
        } else {
          store.touchNode(normalizeTopic(row.topic), Date.now());
        }
      }
    }

    // ── Fresh runs: reserve the root in the store BEFORE processing so a
    // crash mid-root still leaves the topic key claimed. Resumed roots
    // come from the store already.
    if (priorRows.length === 0) {
      const now = Date.now();
      store.upsertNode({
        topic: rootTopicN,
        rootTopic: rootTopicN,
        parentTopic: null,
        depth: 0,
        status: 'pending',
        contentHash: null,
        probeHash: null,
        content: null,
        sources: [],
        subtopics: [],
        fetchError: null,
        createdAt: now,
        updatedAt: now,
      });
      await processNode(root, ctx);
    }

    // Process pending nodes (breadth-first)
    let iterations = 0;
    let exitReason: DiveResult['exitReason'] = 'convergence';

    // Drain the pending frontier. Capacity is enforced at SPAWN time
    // (mitosis gates on cfg.maxNodes / cfg.maxDepth), so existing pending
    // nodes are always processed — a full DAG must not strand its own
    // frontier. Exit reason reflects why the frontier stopped growing.
    while (iterations < cfg.maxNodes) {
      const pending = getPendingNodes();

      if (pending.length === 0) {
        exitReason = 'convergence';
        break;
      }

      // Process next batch — concurrency lives inside tunnel now
      const batch = pending.slice(0, cfg.maxConcurrent);
      await Promise.all(batch.map(node => processNode(node, ctx)));

      iterations++;
    }

    if (getPendingNodes().length > 0) {
      const stats = getStats();
      exitReason = stats.maxDepth >= cfg.maxDepth ? 'max_depth' : 'max_nodes';
    }

    delta.expandedNodes = ctx.expandedCount.n;

    // Honest skip accounting: complete-before-this-run nodes that were not
    // invalidated (changed) and did not end failed after reprocessing.
    const reprocessedThenFailed = requeuedIds.filter(id => getNode(id)?.status === 'failed').length;
    delta.skippedResearched = Math.max(0, priorCompleteIds.size - delta.changedNodes - reprocessedThenFailed);

    store.saveRun({
      id: `run-${startedAt}`,
      rootTopic: rootTopicN,
      startedAt,
      finishedAt: Date.now(),
      delta,
    });

    const finalStats = getStats();

    return {
      topic,
      nodesExplored: finalStats.totalNodes,
      nodesComplete: finalStats.completeNodes,
      maxDepthReached: finalStats.maxDepth,
      markdown: exportToMarkdown(),
      nodes: getAllNodes(),
      exitReason,
      delta,
    };
  } finally {
    store.close();
  }
}
