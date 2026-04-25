/**
 * Rabbit Hole Engine — Recursive, self-expanding research.
 *
 * Algorithm:
 *   1. Ignition: topic provided
 *   2. Search: Brave Search finds relevant pages
 *   3. Tunnel: fetch content with jitter + privacy
 *   4. Extract: pull sub-topics from content
 *   5. Mitosis: spawn child nodes for sub-topics
 *   6. Repeat until MAX_DEPTH, MAX_NODES, or convergence
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

import { braveSearch, type SearchResult } from './brave.js';
import { tunnel } from './tunnel.js';
import {
  resetDAG, createRootNode, addChildNode, markResearching,
  updateNodeWithResults, markFailed, getPendingNodes,
  getStats, canAddNode, exportToMarkdown, getAllNodes, getNode,
  type ResearchNode, type DAGStats, MAX_DEPTH, MAX_NODES,
} from './dag.js';

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
  /** Model ID for LLM extraction (default: full mlx-community DeepSeek-R1 path) */
  llmModel?: string;
  /** Called each time a node completes — enables live streaming. */
  onNodeComplete?: (node: ResearchNode, stats: DAGStats) => void;
}

export interface DiveResult {
  topic: string;
  nodesExplored: number;
  nodesComplete: number;
  maxDepthReached: number;
  markdown: string;
  nodes: ResearchNode[];
  exitReason: 'convergence' | 'max_depth' | 'max_nodes' | 'no_pending';
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
};

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════

let config: RabbitHoleConfig = { ...DEFAULT_CONFIG };
let activeRequests = 0;
const researchedTopics = new Set<string>();

// ═══════════════════════════════════════════════════════════════════
// JITTER
// ═══════════════════════════════════════════════════════════════════

function jitterMs(): number {
  return Math.floor(Math.random() * (config.maxJitter - config.minJitter)) + config.minJitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════
// SUB-TOPIC EXTRACTION
// ═══════════════════════════════════════════════════════════════════

/**
 * LLM-guided sub-topic extraction.
 * Calls the local model (rapid-mlx at localhost:8000) to read the page
 * and return semantically meaningful next research branches.
 * Falls back to bigram heuristic if the LLM is unavailable.
 */
async function extractSubTopicsLLM(
  content: string,
  parentTopic: string,
  limit = 3,
): Promise<string[]> {
  if (!config.llmBaseUrl) return extractSubTopics(content, parentTopic, limit);

  const prompt = [
    `You are a research navigator. Given a page about "${parentTopic}", identify exactly ${limit} specific sub-topics worth exploring next.`,
    `Rules: each sub-topic must be 2-5 words, concrete and distinct, not already covered by "${parentTopic}".`,
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
    // Extract JSON array from response (may have thinking tokens around it)
    const match = raw.match(/\[([^\]]+)\]/);
    if (!match) throw new Error('no array in response');
    const topics = JSON.parse(`[${match[1]}]`) as string[];
    return topics
      .map((t: string) => t.trim().toLowerCase())
      .filter((t: string) => t.length > 3 && !researchedTopics.has(t))
      .slice(0, limit);
  } catch {
    // LLM unavailable or malformed — fall back to bigram
    return extractSubTopics(content, parentTopic, limit);
  }
}

/**
 * Extract sub-topics from content using keyword frequency heuristic.
 * Not AI-powered — uses term frequency to find candidate topics.
 */
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

async function processNode(node: ResearchNode): Promise<void> {
  if (activeRequests >= config.maxConcurrent) return;

  activeRequests++;
  markResearching(node.id);

  try {
    // Search for the topic. Use searchQuery override if provided (root only).
    const query = node.searchQuery ?? node.topic;
    const searchResults = await braveSearch(query, config.searchResultsPerQuery);

    if (searchResults.length === 0) {
      markFailed(node.id);
      return;
    }

    // Tunnel into top results and extract content
    const contents: string[] = [];
    const sources: string[] = [];

    for (const result of searchResults.slice(0, 3)) {
      const tunnelResult = await tunnel(result.url);
      if (tunnelResult.success) {
        contents.push(tunnelResult.content.substring(0, config.maxContentPerPage));
        sources.push(result.url);
      }
    }

    if (contents.length === 0) {
      // Fall back to search descriptions as content
      const fallbackContent = searchResults
        .map(r => `${r.title}: ${r.description}`)
        .join('\n');
      contents.push(fallbackContent);
      sources.push(...searchResults.map(r => r.url));
    }

    const combinedContent = contents.join('\n\n');

    // Extract sub-topics — LLM-guided if available, bigram fallback
    const subTopics = await extractSubTopicsLLM(combinedContent, node.topic);

    // Update node
    updateNodeWithResults(node.id, combinedContent.substring(0, 5000), sources, subTopics);
    researchedTopics.add(node.topic.toLowerCase());

    // Fire live streaming callback
    const completedNode = getNode(node.id);
    if (completedNode && config.onNodeComplete) {
      config.onNodeComplete(completedNode, getStats());
    }

    // Mitosis: spawn child nodes
    if (subTopics.length > 0 && canAddNode()) {
      for (const sub of subTopics) {
        if (canAddNode() && !researchedTopics.has(sub.toLowerCase())) {
          addChildNode(node.id, sub);
        }
      }
    }
  } catch (err) {
    markFailed(node.id);
  } finally {
    activeRequests--;
  }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN API
// ═══════════════════════════════════════════════════════════════════

/**
 * Dive into a topic. Recursive, self-expanding research.
 *
 * @param topic The starting topic
 * @param options Override default config
 * @returns Research results as DAG + markdown
 */
export async function dive(
  topic: string,
  options?: DiveOptions,
): Promise<DiveResult> {
  // Apply config overrides (strip our extra keys before merging into config)
  const { searchQuery, ...cfgOverrides } = options ?? {};
  config = { ...DEFAULT_CONFIG, ...cfgOverrides };
  researchedTopics.clear();
  resetDAG();
  activeRequests = 0;

  // Create root node — searchQuery overrides what brave sees for depth=0
  // while `topic` remains the LLM-context handle through the dive.
  const root = searchQuery ? createRootNode(topic, searchQuery) : createRootNode(topic);
  if (!root) {
    return {
      topic,
      nodesExplored: 0,
      nodesComplete: 0,
      maxDepthReached: 0,
      markdown: '# No results\n\nFailed to create root node.',
      nodes: [],
      exitReason: 'no_pending',
    };
  }

  // Process root
  await processNode(root);

  // Process pending nodes (breadth-first)
  let iterations = 0;
  let exitReason: DiveResult['exitReason'] = 'no_pending';

  while (iterations < config.maxNodes) {
    const pending = getPendingNodes();

    if (pending.length === 0) {
      exitReason = 'convergence';
      break;
    }

    const stats = getStats();
    if (stats.totalNodes >= config.maxNodes) {
      exitReason = 'max_nodes';
      break;
    }
    if (stats.maxDepth >= config.maxDepth) {
      exitReason = 'max_depth';
      break;
    }

    // Process next batch
    const batch = pending.slice(0, config.maxConcurrent - activeRequests);
    await Promise.all(batch.map(node => processNode(node)));

    iterations++;
  }

  const finalStats = getStats();

  return {
    topic,
    nodesExplored: finalStats.totalNodes,
    nodesComplete: finalStats.completeNodes,
    maxDepthReached: finalStats.maxDepth,
    markdown: exportToMarkdown(),
    nodes: getAllNodes(),
    exitReason,
  };
}

/**
 * Configure the rabbithole.
 */
export function configure(newConfig: Partial<RabbitHoleConfig>): void {
  config = { ...config, ...newConfig };
}
