# Compounding Research Engine — Design

Date: 2026-08-22
Status: Approved (chat gates: approach + design + scope, 2026-08-22)

## Problem

Every deep-research tool (STORM, GPT Researcher, hosted "deep research") is
LLM-per-step and stateless between runs. Every memory engine (Cognee, Graphiti)
persists knowledge but never traverses the live web. Scrapling heals known
selectors but has no search/topic concept. Nobody builds research that
compounds: persistent topic DAGs, incremental frontier expansion, and
self-healing extraction — all deterministic (zero LLM).

Rabbithole already owns the novel traversal shape (search-driven mitosis,
topic DAG, zero-LLM heuristics). It is stateless: every dive starts from zero.
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

Tables:

```sql
nodes(id TEXT PRIMARY KEY, root_topic TEXT NOT NULL, parent_id TEXT,
      topic TEXT NOT NULL UNIQUE, status TEXT NOT NULL, depth INTEGER NOT NULL,
      content_hash TEXT, content TEXT, sources TEXT/*JSON*/, subtopics TEXT/*JSON*/,
      fetch_error TEXT, created_at INTEGER, updated_at INTEGER);
recipes(domain TEXT PRIMARY KEY, selector TEXT, yield_chars INTEGER,
        fallback_streak INTEGER DEFAULT 0, wins INTEGER DEFAULT 0,
        updated_at INTEGER);
runs(id TEXT PRIMARY KEY, root_topic TEXT, started_at INTEGER,
     finished_at INTEGER, delta TEXT/*JSON*/);
```

Topic uniqueness across runs = cross-run dedup. dag.ts stays a pure in-memory
working set; store is the durable layer bridged in `rabbithole.ts`
(load-before / save-after, per-node incremental saves).

### extract.ts

- Parse with `linkedom.parseHTML`.
- Strip script/style/nav/footer/header/aside.
- Candidate containers scored by `textLen / (1 + linkTextLen)`; winner must
  beat body-generic extraction by ≥1.5× to be adopted.
- Recipe = winning selector (`tag#id` or `tag.class`) persisted per domain.
- Heal rule: recipe yield < 200 chars → generic pipeline this run;
  generic ≥ 2× recipe yield twice consecutively → recipe replaced
  (`fallback_streak` counter). Deterministic.

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
propagated into `TunnelResult.error` / `nodes.fetch_error`; retry once on
429/5xx/network with jitter backoff; single concurrency counter in tunnel
(was double-counted with processNode).

## Testing (local, no network)

- store: round-trip, unique-topic constraint, staleness query, runs delta.
- extract: canned HTML incl. malformed; script/style stripped; container
  scoring picks article over nav; heal streak logic unit-tested directly.
- rabbithole: injected fake search/tunnel drives full loop offline —
  run 1 explores, run 2 skips everything (delta), mutated page hash triggers
  re-research of exactly one node.
- Existing 11 DAG tests untouched and green.

## Verification

Suite green; live smoke (if BRAVE_API_KEY): tiny real dive ×2, show delta.
