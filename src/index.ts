/**
 * rabbithole — Privacy-tunneled recursive research for LLM agents.
 *
 * Three primitives:
 *   SEARCH  — Brave Search API (no tracking)
 *   TUNNEL  — Fetch with jitter + privacy
 *   DAG     — Directed Acyclic Graph of knowledge
 *
 * One entry point:
 *   dive(topic) → { markdown, nodes, stats }
 */

export { braveSearch, type SearchResult } from './brave.js';
export { tunnel, tunnelBatch, configureTunnel, getTunnelStats, type TunnelResult, type TunnelConfig } from './tunnel.js';
export { dive, configure, type RabbitHoleConfig, type DiveResult } from './rabbithole.js';
export {
  resetDAG, createRootNode, addChildNode, getStats, exportToMarkdown,
  getAllNodes, type ResearchNode, type DAGStats, MAX_DEPTH, MAX_NODES,
} from './dag.js';
