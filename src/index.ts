/**
 * rabbithole — Privacy-tunneled recursive research for LLM agents.
 *
 * Public API usage and the separate host-gated review flow: README.md.
 */

export { braveSearch, type SearchResult } from './brave.js';
export { tunnel, tunnelBatch, configureTunnel, getTunnelStats, type TunnelResult, type TunnelConfig } from './tunnel.js';
export { extractGeneric, extract, nextRecipe, domainOf, type Extraction, type RecipeLike, type ElementFingerprint } from './extract.js';
export {
  previewJevResearch, evaluateJevResearch,
  type JevResearchPreview, type JevResearchApproval, type JevResearchHost,
  type JevResearchResult, type JevResearchReceipt, type JevResearchAnswer,
} from './research-advisory.js';
export { Store, defaultStorePath, normalizeTopic, type StoredNode, type Recipe, type RunDelta } from './store.js';
export { dive, extractSubTopics, isValidTopic, type RabbitHoleConfig, type DiveOptions, type DiveResult, type EngineDeps } from './rabbithole.js';
export {
  resetDAG, createRootNode, addChildNode, getStats, exportToMarkdown,
  getAllNodes, requeueNode, type ResearchNode, type DAGStats, MAX_DEPTH, MAX_NODES,
} from './dag.js';
