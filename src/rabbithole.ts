/**
 * Rabbit Hole Engine — Recursive, self-expanding research.
 *
 * Algorithm:
 *   1. Ignition: topic provided
 *   2. Search: Brave Search finds relevant pages
 *   3. Tunnel: fetch content with jitter + privacy + structure-aware extract
 *   4. Extract: pull sub-topics (LLM if available, else tightened bigrams)
 *   5. Mitosis: spawn child nodes (skipped entirely in kill mode)
 *   6. Repeat until MAX_DEPTH, MAX_NODES, or convergence
 *   7. Persist: every node lands in SQLite; the next dive can resume
 *
 * Constraints:
 *   MAX_DEPTH:      3  (prevent infinite recursion)
 *   MAX_NODES:      20 (prevent explosion)
 *   MAX_CONCURRENT: 3  (prevent rate-limiting)
 *   JITTER:         2-5s (anti-bot behavior)
 *
 * Ported from HybridEngineV3/src/lib/cognition/rabbitHole.ts
 * Stripped of Supabase, CognitiveEventBus, DirichletGate.
 * Pure Node.js — search, fetch, build DAG, return markdown.
 */

import { createHash } from 'node:crypto';

import { braveSearch, type SearchResult } from './brave.js';
import { tunnel, configureTunnel, type TunnelResult } from './tunnel.js';
import { domainOf, nextRecipe, type RecipeLike } from './extract.js';
import {
  resetDAG, createRootNode, addChildNode, markResearching,
  updateNodeWithResults, markFailed, requeueNode, getPendingNodes,
  getStats, canAddNode, exportToMarkdown, getAllNodes, getNode,
  type ResearchNode, type DAGStats, MAX_DEPTH, MAX_NODES,
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
  /** Optional: LLM endpoint for semantic sub-topic extraction.
   *  If set (e.g. "http://localhost:8000/v1"), uses the local model
   *  instead of bigram frequency. Makes mitosis semantically driven. */
  llmBaseUrl?: string;
  /** Model ID for LLM extraction (default: Llama-3.2-3B) */
  llmModel?: string;
  /** Called each time a node completes — enables live streaming. */
  onNodeComplete?: (node: ResearchNode, stats: DAGStats) => void;
  /** 'kill' = search+tunnel only, no mitosis. Default 'dive'. */
  mode: 'kill' | 'dive';
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

/** Per-call options that override config */
export interface DiveOptions extends Partial<RabbitHoleConfig> {
  /** Search query sent to Brave for the ROOT node only.
   *  Lets callers anchor the dive in a focused phrase while keeping `topic`
   *  rich with grounding context for the LLM sub-topic extractor. Without
   *  this split, long context-strings poison Brave (e.g. trigger words like
   *  "Vault" magnet to HashiCorp). Child nodes always search by their own
   *  sub-topic phrase, so this only affects depth=0. */
  searchQuery?: string;
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
  llmBaseUrl: undefined,
  // Llama-3.2-3B is non-thinking and reliably returns JSON in <120 tokens.
  // R1 and Qwen3.5 both have reasoning chains that blow the token budget
  // and fall through to bigram. Llama is the right tool for sub-topic extraction.
  llmModel: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
  onNodeComplete: undefined,
  mode: 'dive',
  resume: false,
  stalenessTtlMs: 7 * 24 * 3600_000,
  maxRevalidate: 5,
  storePath: null,
};

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════

let config: RabbitHoleConfig = { ...DEFAULT_CONFIG };
let activeRequests = 0;
const researchedTopics = new Set<string>();

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const CHROME_TOKENS = new Set([
  'span', 'class', 'div', 'href', 'wiki', 'jump', 'content', 'pages', 'using',
  'click', 'share', 'listen', 'cookie', 'privacy', 'navigation', 'footer',
  'header', 'script',
]);

function isCleanWord(w: string): boolean {
  return w.length >= 4 && /^[a-z]+$/.test(w) && !CHROME_TOKENS.has(w);
}

/** True iff the phrase is 2-5 alphabetic words, each length>=4, no chrome. */
export function isValidTopic(phrase: string): boolean {
  const words = phrase.trim().toLowerCase().split(/\s+/);
  return words.length >= 2 && words.length <= 5 && words.every(isCleanWord);
}

// ═══════════════════════════════════════════════════════════════════
// SUB-TOPIC EXTRACTION
// ═══════════════════════════════════════════════════════════════════

/**
 * LLM-guided sub-topic extraction.
 * Calls the local model (rapid-mlx at localhost:8000) to read the page
 * and return semantically meaningful next research branches.
 * Falls back to the tightened bigram heuristic if the LLM is unavailable
 * or returns chrome. Never uses the old unfiltered chrome bigrams.
 */
async function extractSubTopicsLLM(
  content: string,
  parentTopic: string,
  limit = 3,
): Promise<string[]> {
  if (!config.llmBaseUrl) return extractSubTopics(content, parentTopic, limit);

  const prompt = [
    `You are a research navigator. Given a page about "${parentTopic}", identify exactly ${limit} specific sub-topics worth exploring next.`,
    `Rules: each sub-topic must be 2-5 words, concrete and distinct, not already covered by "${parentTopic}". Never emit HTML, CSS, wiki chrome, or navigation labels.`,
    `Return ONLY a JSON array of strings. No explanation. Example: ["memory consolidation", "replay buffers", "episodic encoding"]`,
    ``,
    `Page content (first 1500 chars):`,
    content.slice(0, 1500),
  ].join('\n');

  try {
    const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer not-needed' },
      body: JSON.stringify({
        model: config.llmModel ?? "mlx-community/DeepSeek-R1-0528-Qwen3-8B-4bit",
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 120,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}`);
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content ?? '';
    const match = raw.match(/\[([^\]]+)\]/);
    if (!match) throw new Error('no array in response');
    const topics = JSON.parse(`[${match[1]}]`) as string[];
    const cleaned = topics
      .map((t: string) => t.trim().toLowerCase())
      .filter((t: string) => isValidTopic(t) && !researchedTopics.has(t));
    if (cleaned.length > 0) return cleaned.slice(0, limit);
    return extractSubTopics(content, parentTopic, limit);
  } catch {
    return extractSubTopics(content, parentTopic, limit);
  }
}

/**
 * Extract sub-topics from content using a tightened bigram heuristic.
 * Rejects HTML/chrome tokens (span, class, pages using, ...). Both words
 * must be alphabetic and length>=4. If nothing real survives, returns [].
 */
export function extractSubTopics(content: string, parentTopic: string, limit = 3): string[] {
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

  const words = content.toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => isCleanWord(w) && !stopwords.has(w));

  const bigramCounts = new Map<string, number>();
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i];
    const b = words[i + 1];
    if (parentWords.has(a) && parentWords.has(b)) continue;
    const bigram = `${a} ${b}`;
    bigramCounts.set(bigram, (bigramCounts.get(bigram) ?? 0) + 1);
  }

  return Array.from(bigramCounts.entries())
    .filter(([bg, count]) => count >= 2 && isValidTopic(bg) && !researchedTopics.has(bg))
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
  deps: {
    search: (query: string, count: number) => Promise<SearchResult[]>;
    fetchPage: (url: string, recipe: RecipeLike | null) => Promise<TunnelResult>;
  };
  delta: RunDelta;
  expandedCount: { n: number };
  rootTopicN: string;
}

async function processNode(node: ResearchNode, ctx: NodeContext): Promise<void> {
  const { cfg, store, deps, delta, rootTopicN } = ctx;

  if (activeRequests >= cfg.maxConcurrent) return;

  activeRequests++;
  markResearching(node.id);

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

  let probeContent: string | null = null;

  try {
    const query = node.searchQuery ?? node.topic;
    const searchResults = await deps.search(query, cfg.searchResultsPerQuery);

    if (searchResults.length === 0) {
      markFailed(node.id);
      delta.failedNodes++;
      flush('failed', 'search returned no results');
      return;
    }

    const contents: string[] = [];
    const sources: string[] = [];
    const errors: string[] = [];
    const recipeOutcomes = new Map<string, {
      prev: RecipeLike | null;
      usedRecipe: boolean;
      recipeYield: number;
      genericYield: number;
      genericSelector: string | null;
    }>();

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
            usedRecipe: !!res.usedRecipe,
            recipeYield: res.usedRecipe ? (res.yieldChars ?? res.content.length) : 0,
            genericYield: res.usedRecipe ? 0 : (res.yieldChars ?? res.content.length),
            genericSelector: res.usedRecipe ? null : (res.selector ?? null),
          });
        }
      } else if (res.error) {
        errors.push(`${result.url}: ${res.error}`);
      }
    }

    for (const [domain, oc] of recipeOutcomes) {
      const next = nextRecipe(domain, oc.prev, {
        usedRecipe: oc.usedRecipe,
        recipeYield: oc.recipeYield,
        genericYield: oc.genericYield,
        genericSelector: oc.genericSelector,
      });
      store.saveRecipe({
        domain,
        selector: next.selector,
        yieldChars: next.yieldChars,
        fallbackStreak: next.fallbackStreak,
        wins: next.wins,
        updatedAt: Date.now(),
      });
    }

    const fetchError: string | null = errors.length > 0 ? errors.join('; ') : null;

    if (contents.length === 0) {
      const fallbackContent = searchResults
        .map(r => `${r.title}: ${r.description}`)
        .join('\n');
      contents.push(fallbackContent);
      sources.push(...searchResults.map(r => r.url));
    }

    const combinedContent = contents.join('\n\n');
    const storedContent = combinedContent.substring(0, cfg.maxContentPerPage);

    // Kill mode: never extract sub-topics or spawn children.
    const subTopics = cfg.mode === 'kill'
      ? []
      : await extractSubTopicsLLM(storedContent, node.topic);

    updateNodeWithResults(node.id, storedContent, sources, subTopics);
    researchedTopics.add(normalizeTopic(node.topic));

    const completedNode = getNode(node.id);
    if (completedNode && cfg.onNodeComplete) {
      cfg.onNodeComplete(completedNode, getStats());
    }

    if (cfg.mode !== 'kill' && subTopics.length > 0 && canAddNode() && getStats().totalNodes < cfg.maxNodes) {
      for (const sub of subTopics) {
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
  } finally {
    activeRequests--;
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
      if (!parentId) continue;
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
        break;
    }
  }
  return idByTopic;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN API
// ═══════════════════════════════════════════════════════════════════

/**
 * Dive into a topic. Recursive, self-expanding research.
 *
 * @param topic The starting topic
 * @param options Override default config (mode: 'kill' skips mitosis)
 * @param deps Optional injection seams for tests
 * @returns Research results as DAG + markdown
 */
export async function dive(
  topic: string,
  options?: DiveOptions,
  deps?: EngineDeps,
): Promise<DiveResult> {
  const { searchQuery, ...cfgOverrides } = options ?? {};
  config = { ...DEFAULT_CONFIG, ...cfgOverrides };
  configureTunnel({ minJitter: config.minJitter, maxJitter: config.maxJitter, maxConcurrent: config.maxConcurrent });

  const search = deps?.search ?? braveSearch;
  const fetchPage = deps?.fetchPage ?? ((url: string, recipe: RecipeLike | null) => tunnel(url, recipe));

  researchedTopics.clear();
  resetDAG();
  activeRequests = 0;

  const rootTopicN = normalizeTopic(topic);
  const startedAt = Date.now();
  const delta: RunDelta = { skippedResearched: 0, revalidated: 0, changedNodes: 0, expandedNodes: 0, failedNodes: 0 };

  const store = new Store(config.storePath ?? defaultStorePath());

  try {
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
      root = searchQuery ? createRootNode(topic, searchQuery) : createRootNode(topic);
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
      cfg: config,
      store,
      deps: { search, fetchPage },
      delta,
      expandedCount: { n: 0 },
      rootTopicN,
    };

    const requeuedIds: string[] = [];
    if (config.resume && priorRows.length > 0) {
      const stale = store.getStaleCandidates(rootTopicN, config.stalenessTtlMs, config.maxRevalidate);
      for (const row of stale) {
        const dagId = idByTopic.get(normalizeTopic(row.topic));
        if (!dagId) continue;
        delta.revalidated++;
        const sourceUrl = row.sources[0];
        if (!sourceUrl) continue;
        const recipe = store.getRecipe(domainOf(sourceUrl));
        const res = await fetchPage(sourceUrl, recipe);
        if (!res.success) continue;
        const newProbe = sha256(res.content.substring(0, config.maxContentPerPage));
        if (row.probeHash && newProbe !== row.probeHash) {
          requeueNode(dagId);
          requeuedIds.push(dagId);
          delta.changedNodes++;
          store.upsertNode({ ...row, status: 'pending', updatedAt: Date.now() });
        } else {
          store.touchNode(normalizeTopic(row.topic), Date.now());
        }
      }
    }

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

    let iterations = 0;
    let exitReason: DiveResult['exitReason'] = 'convergence';

    while (iterations < config.maxNodes) {
      const pending = getPendingNodes();
      if (pending.length === 0) {
        exitReason = 'convergence';
        break;
      }
      const batch = pending.slice(0, Math.max(1, config.maxConcurrent - activeRequests));
      await Promise.all(batch.map(n => processNode(n, ctx)));
      iterations++;
    }

    if (getPendingNodes().length > 0) {
      const stats = getStats();
      exitReason = stats.maxDepth >= config.maxDepth ? 'max_depth' : 'max_nodes';
    }

    delta.expandedNodes = ctx.expandedCount.n;
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

/**
 * Configure the rabbithole.
 */
export function configure(newConfig: Partial<RabbitHoleConfig>): void {
  config = { ...config, ...newConfig };
}
