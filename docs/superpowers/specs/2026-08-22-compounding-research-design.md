# Compounding Research Engine — Design

Date: 2026-08-22
Status: Approved (chat gates: approach + design + scope, 2026-08-22)

## Problem

Every deep-research tool (STORM, GPT Researcher, hosted "deep research") is
LLM-per-step and stateless between runs. Every memory engine (Cognee, Graphiti)
persists knowledge but never traverses the live web. Scrapling heals known
selectors but has no search/topic concept. Nobody builds research that
compounds: persistent topic DAGs, incremental frontier expansion, and
self-healing extraction. See [Sub-topic extraction](../../../README.md#sub-topic-extraction)
for the current extraction modes and fallback contract.

At the time of this design, Rabbithole already owned the novel traversal shape
(search-driven mitosis, topic DAG). It was stateless: every dive started from zero.
This design makes state the product.

## Goals

1. `dive(topic)` twice → second run skips researched nodes, revalidates stale
   ones, expands only new frontier. Delta reported.
2. Per-domain extraction recipes that persist and heal when yield collapses.
3. Zero runtime deps beyond `linkedom`; SQLite via `node:sqlite`.
4. Honest failure reporting (`fetch_error` on nodes).

## Non-goals (v1)

Link-graph node spawning from `<a href>`, stealth/proxies (scrapling sidecar),
LLM summarization, MCP server.

## Architecture

```
src/
  brave.ts      unchanged
  tunnel.ts     fixes: full Chrome UA, 429/5xx retry w/ backoff, error strings,
                concurrency owned solely by tunnel (slot fix)
  dag.ts        unchanged (in-memory working set per run)
+ store.ts      node:sqlite persistence (.rabbithole/state.db, WAL)
+ extract.ts    linkedom parse; readability-lite scoring; recipe load/heal/save
  rabbithole.ts resumable dive: load store → seed DAG → expand → flush;
                delta stats; DI seam for search/tunnel (testability)
  index.ts      exports
```

### store.ts

The authoritative SQLite schema and migrations are in [src/store.ts](../../../src/store.ts).

Topic uniqueness across runs = cross-run dedup. dag.ts stays a pure in-memory
working set; store is the durable layer bridged in `rabbithole.ts`
(load-before / save-after, per-node incremental saves).

### extract.ts

See [When a site changes](../../../README.md#when-a-site-changes) for the current recipe, relocation, healing, and hidden-content rules.

### Resumable dive

`dive(topic, { resume })`:
- `resume=false`: fresh run (existing behavior) but flushed to store.
- `resume=true`: load DAG from store; skip nodes whose status=complete unless
  stale; staleness = node older than `stalenessTtlMs` (default 7d), checked
  oldest-first, capped at `maxRevalidate` (default 5) refetches per run;
  changed content hash → node re-enters processing.
- Frontier = pending ∪ invalidated ∪ unresearched subtopics.
- `DiveResult.delta = { skippedResearched, revalidated, changedNodes,
  expandedNodes, failedNodes }`.

### Defect fixes riding along (required by honest delta report)

Full Chrome UA string (truncated UA was itself a fingerprint); error strings
propagated into `TunnelResult.error` / `nodes.fetch_error`; fetch policy documented in
[Bounded fetching](../../../README.md#bounded-fetching); single concurrency counter in tunnel
(was double-counted with processNode).

## Testing

- store: round-trip, unique-topic constraint, staleness query, runs delta.
- extract: canned HTML incl. malformed; script/style stripped; container
  scoring picks article over nav; heal streak logic unit-tested directly.
- rabbithole: injected fake search/tunnel drives full loop offline —
  run 1 explores, run 2 skips everything (delta), mutated page hash triggers
  re-research of exactly one node.

For current test commands and transport scope, see [Test](../../../README.md#test).

## Verification

Suite green; live smoke: tiny real dive ×2, show delta. See [Environment](../../../README.md#environment) for search prerequisites.
