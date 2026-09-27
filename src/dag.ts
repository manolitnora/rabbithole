/**
 * Research DAG — Directed Acyclic Graph of knowledge.
 *
 * The rabbithole builds a DAG as it researches. Each node is a topic,
 * edges connect parent topics to sub-topics. The DAG enforces:
 * - MAX_DEPTH: no infinite recursion
 * - MAX_NODES: no explosion
 * - No duplicate topics
 *
 * Ported from HybridEngineV3/src/lib/cognition/researchDAG.ts
 * Stripped of UI/React dependencies — pure data structure.
 */

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface ResearchNode {
  id: string;
  topic: string;
  /** Optional override sent to search instead of `topic`. When the topic
   *  carries grounding context, the literal string can poison web search;
   *  searchQuery anchors the search while `topic` stays for downstream use. */
  searchQuery?: string;
  parentId: string | null;
  depth: number;
  status: 'pending' | 'researching' | 'complete' | 'failed';
  content: string;
  sources: string[];
  subTopics: string[];
  timestamp: number;
}

export interface DAGStats {
  totalNodes: number;
  completeNodes: number;
  pendingNodes: number;
  failedNodes: number;
  maxDepth: number;
}

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

export const MAX_DEPTH = 3;
export const MAX_NODES = 20;

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════

let nodes: Map<string, ResearchNode> = new Map();
let topicIndex: Set<string> = new Set();

// ═══════════════════════════════════════════════════════════════════
// OPERATIONS
// ═══════════════════════════════════════════════════════════════════

export function resetDAG(): void {
  nodes = new Map();
  topicIndex = new Set();
}

export function canAddNode(): boolean {
  return nodes.size < MAX_NODES;
}

export function createRootNode(topic: string, searchQuery?: string): ResearchNode | null {
  if (!canAddNode()) return null;
  const normalized = topic.toLowerCase().trim();
  if (topicIndex.has(normalized)) return null;

  const node: ResearchNode = {
    id: crypto.randomUUID(),
    topic,
    searchQuery,
    parentId: null,
    depth: 0,
    status: 'pending',
    content: '',
    sources: [],
    subTopics: [],
    timestamp: Date.now(),
  };

  nodes.set(node.id, node);
  topicIndex.add(normalized);
  return node;
}

export function addChildNode(parentId: string, topic: string): ResearchNode | null {
  if (!canAddNode()) return null;

  const parent = nodes.get(parentId);
  if (!parent) return null;

  const depth = parent.depth + 1;
  if (depth > MAX_DEPTH) return null;

  const normalized = topic.toLowerCase().trim();
  if (topicIndex.has(normalized)) return null;

  const node: ResearchNode = {
    id: crypto.randomUUID(),
    topic,
    parentId,
    depth,
    status: 'pending',
    content: '',
    sources: [],
    subTopics: [],
    timestamp: Date.now(),
  };

  nodes.set(node.id, node);
  topicIndex.add(normalized);
  return node;
}

export function markResearching(id: string): void {
  const node = nodes.get(id);
  if (node) node.status = 'researching';
}

export function updateNodeWithResults(
  id: string,
  content: string,
  sources: string[],
  subTopics: string[],
): void {
  const node = nodes.get(id);
  if (!node) return;
  node.content = content;
  node.sources = sources;
  node.subTopics = subTopics;
  node.status = 'complete';
}

export function markFailed(id: string): void {
  const node = nodes.get(id);
  if (node) node.status = 'failed';
}

/** Flip a complete/failed node back to pending (staleness invalidation). */
export function requeueNode(id: string): void {
  const node = nodes.get(id);
  if (node) node.status = 'pending';
}

export function getPendingNodes(): ResearchNode[] {
  return Array.from(nodes.values()).filter(n => n.status === 'pending');
}

export function getNode(id: string): ResearchNode | null {
  return nodes.get(id) ?? null;
}

export function getAllNodes(): ResearchNode[] {
  return Array.from(nodes.values());
}

export function getStats(): DAGStats {
  const all = Array.from(nodes.values());
  return {
    totalNodes: all.length,
    completeNodes: all.filter(n => n.status === 'complete').length,
    pendingNodes: all.filter(n => n.status === 'pending').length,
    failedNodes: all.filter(n => n.status === 'failed').length,
    maxDepth: all.reduce((max, n) => Math.max(max, n.depth), 0),
  };
}

/**
 * Export the DAG as a markdown report.
 */
export function exportToMarkdown(): string {
  const lines: string[] = ['# Research DAG', ''];

  const roots = Array.from(nodes.values()).filter(n => n.parentId === null);

  function renderNode(node: ResearchNode, indent: number): void {
    const prefix = '  '.repeat(indent);
    const status = node.status === 'complete' ? '[done]' : node.status === 'failed' ? '[failed]' : '[pending]';
    lines.push(`${prefix}- ${status} **${node.topic}**`);
    if (node.content) {
      lines.push(`${prefix}  ${node.content.substring(0, 200)}`);
    }
    if (node.sources.length > 0) {
      lines.push(`${prefix}  Sources: ${node.sources.slice(0, 3).join(', ')}`);
    }

    // Render children
    const children = Array.from(nodes.values()).filter(n => n.parentId === node.id);
    for (const child of children) {
      renderNode(child, indent + 1);
    }
  }

  for (const root of roots) {
    renderNode(root, 0);
  }

  const stats = getStats();
  lines.push('', `---`, `Nodes: ${stats.totalNodes} | Complete: ${stats.completeNodes} | Depth: ${stats.maxDepth}`);

  return lines.join('\n');
}
